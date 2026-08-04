/**
 * POST /usageMeter — receive a usage event from a customer's platform, price it, and bill it.
 *
 * Second inbound customer→Bosun endpoint (after sourcingCompose) and the first METERED one: the
 * service was rendered on the CUSTOMER's infrastructure (their sweep auto-published a Bosun-sourced
 * listing), so there is no in-request work to settle — the customer reports what happened and this
 * endpoint prices it. Events carry no price on the wire by design; the rate lives in
 * shared/billing.js (AUTOPOST_USAGE_PRICE_PAISE) and nowhere on the customer's side.
 *
 * Auth mirrors sourcingCompose exactly: the customer signs `${timestamp}.${rawBody}` with the same
 * per-org relay secret from the vault (orgSecrets/{orgId}.sourcing.secret).
 *
 * Idempotent per (orgId, service, idempotencyKey): the customer's key is their lead id, and their
 * claim transaction guarantees one publish per lead — so a redelivered or replayed event is a
 * charged:0 no-op. This is what makes historical replay safe: a customer can re-send its whole
 * ledger after an outage and only unbilled events settle.
 *
 * Billing: the service table, the prices and the settle transaction all live in utils/meter.js —
 * amounts are held in paise, accrued on the org, and whole rupees debited as the accrual crosses
 * ₹1 ("sum, then round once", see shared/billing.js). A price is never read from the request: the
 * customer reports WHAT happened, Bosun alone decides what it costs, and an org carrying a
 * `pricing[service]` override is billed that instead of the default.
 *
 * Request  { orgId, service:'auto_post', qty, idempotencyKey, leadId, refId, propertyId, displayId }
 *          headers: x-bosun-signature: sha256=…, x-bosun-timestamp: <ms>
 * Response { ok, charged, duplicate? }
 */
import { onRequest } from 'firebase-functions/v2/https';
import { getFirestore } from 'firebase-admin/firestore';
import { SERVICE_DEFS, settleMetered } from '../utils/meter.js';
import { verifyCustomerSignature, logReject } from '../utils/customerAuth.js';

const REGION = 'asia-south1';

export const usageMeter = onRequest({ region: REGION, cors: false }, async (req, res) => {
  if (req.method !== 'POST') {
    logReject('usageMeter', { status: 405, reason: 'non-POST-method', extra: { method: req.method } });
    res.status(405).json({ error: 'POST only' });
    return;
  }

  // The signature covers the EXACT bytes sent — rawBody, never a re-serialised req.body.
  const raw = req.rawBody ? req.rawBody.toString('utf8') : '';
  let body;
  try {
    body = JSON.parse(raw || '{}');
  } catch {
    logReject('usageMeter', { status: 400, reason: 'body-not-valid-json', extra: { bytes: raw.length } });
    res.status(400).json({ error: 'invalid JSON' });
    return;
  }

  const orgId = String(body.orgId || '');
  // The WhatsApp meter reports service:'whatsapp_outreach' with the billable event name in `event`
  // and its dedupe key in `eventId` — normalise both to the generic (service, idempotencyKey) pair.
  let service = String(body.service || '');
  if (service === 'whatsapp_outreach' && body.event) service = String(body.event);
  const idempotencyKey = String(body.idempotencyKey || body.eventId || '');
  const qty = Math.min(10, Math.max(1, Math.floor(Number(body.qty) || 1)));
  if (!orgId || !service || !idempotencyKey) {
    logReject('usageMeter', {
      orgId,
      status: 400,
      reason: 'missing-required-field',
      extra: { hasOrgId: !!orgId, hasService: !!service, hasIdempotencyKey: !!idempotencyKey },
    });
    res.status(400).json({ error: 'orgId, service and idempotencyKey are required' });
    return;
  }
  // The service must be KNOWN here, but its price can only be resolved once we have the org doc —
  // an org may override any line (priceForService). So this gate checks existence only; the live
  // unit price is read inside the settle transaction, from the same org snapshot the debit uses.
  const def = SERVICE_DEFS[service];
  if (!def) {
    logReject('usageMeter', {
      orgId,
      status: 400,
      reason: 'unknown-service',
      extra: { service, known: Object.keys(SERVICE_DEFS) },
    });
    res.status(400).json({ error: `unknown service: ${service}` });
    return;
  }

  const db = getFirestore();

  // Auth: the org's own relay secret, straight from the vault — never readable by a browser.
  const secretSnap = await db.collection('orgSecrets').doc(orgId).get();
  const secret = secretSnap.exists ? secretSnap.data()?.sourcing?.secret : null;
  if (!secret) {
    logReject('usageMeter', { orgId, status: 403, reason: 'org-has-no-sourcing-secret', extra: { orgSecretsDocExists: secretSnap.exists } });
    res.status(403).json({ error: 'sourcing not configured for this org' });
    return;
  }
  const auth = verifyCustomerSignature(raw, req.get('x-bosun-signature'), req.get('x-bosun-timestamp'), secret);
  if (!auth.ok) {
    // The reason stays in OUR logs only — the response is a flat 401 so a caller can't probe which
    // half of the credential was wrong.
    logReject('usageMeter', { orgId, status: 401, reason: auth.reason, extra: { skewMs: auth.skewMs ?? null, bytes: raw.length } });
    res.status(401).json({ error: 'bad signature' });
    return;
  }

  // Settle: idempotency row + accrual + debit, atomically (utils/meter.js). The customer keys
  // events by lead id and their own claim transaction guarantees one publish per lead, so an
  // already-logged key is a redelivery — acknowledged, unbilled, and the reason a full historical
  // ledger replay after an outage settles only what was never billed.
  let result;
  try {
    result = await settleMetered({
      db,
      orgId,
      service,
      idempotencyKey,
      qty,
      extra: {
        leadId: String(body.leadId || ''),
        refId: String(body.refId || ''),
        propertyId: String(body.propertyId || ''),
        displayId: String(body.displayId || ''),
      },
    });
  } catch (e) {
    // The event is the customer telling us work already happened — failing the request makes them
    // retry, which the idempotency key absorbs. Fail loudly so it's visible.
    console.error('usageMeter:bill:err', orgId, service, idempotencyKey, e?.message || e);
    res.status(500).json({ error: 'billing failed — retry' });
    return;
  }

  if (result.duplicate) {
    // Not an error — this is the idempotency guarantee doing its job, and during a historical
    // ledger replay it's the signal that the already-billed events are being skipped correctly.
    console.log('usageMeter:duplicate', orgId, JSON.stringify({ service, idempotencyKey }));
    res.status(200).json({ ok: true, duplicate: true, charged: 0 });
    return;
  }

  const charged = result.charged;
  console.log('usageMeter:ok', orgId, service, JSON.stringify({ idempotencyKey, qty, charged }));
  res.status(200).json({ ok: true, charged });
});
