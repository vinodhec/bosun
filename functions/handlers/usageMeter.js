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
 * Billing: ₹0.50 per auto_post event, held in paise and accrued on the org
 * (`autopostAccrualPaise`) with whole rupees debited as the accrual crosses ₹1 — the same
 * "sum, then round once" discipline compose uses (see shared/billing.js).
 *
 * Request  { orgId, service:'auto_post', qty, idempotencyKey, leadId, refId, propertyId, displayId }
 *          headers: x-bosun-signature: sha256=…, x-bosun-timestamp: <ms>
 * Response { ok, charged, duplicate? }
 */
import { onRequest } from 'firebase-functions/v2/https';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import crypto from 'node:crypto';
import { AUTOPOST_USAGE_PRICE_PAISE, accrueComposeCharge } from '../shared/billing.js';

const REGION = 'asia-south1';
const MAX_SIGNATURE_AGE_MS = 5 * 60 * 1000; // reject replays — same window as sourcingCompose
const METER_LOG = 'usage_meter_log';

/** Per-service pricing. Unknown services are rejected, not defaulted — a typo must not bill. */
const SERVICE_PRICE_PAISE = {
  auto_post: AUTOPOST_USAGE_PRICE_PAISE,
};

/** Constant-time HMAC check over `${timestamp}.${rawBody}` — mirror of sourcingCompose. */
function verifyCustomerSignature(rawBody, signature, timestamp, secret) {
  if (!signature || !timestamp || !secret) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > MAX_SIGNATURE_AGE_MS) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', String(secret)).update(`${ts}.${rawBody}`).digest('hex');
  const a = Buffer.from(String(signature));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export const usageMeter = onRequest({ region: REGION, cors: false }, async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' });
    return;
  }

  // The signature covers the EXACT bytes sent — rawBody, never a re-serialised req.body.
  const raw = req.rawBody ? req.rawBody.toString('utf8') : '';
  let body;
  try {
    body = JSON.parse(raw || '{}');
  } catch {
    res.status(400).json({ error: 'invalid JSON' });
    return;
  }

  const orgId = String(body.orgId || '');
  const service = String(body.service || '');
  const idempotencyKey = String(body.idempotencyKey || '');
  const qty = Math.min(10, Math.max(1, Math.floor(Number(body.qty) || 1)));
  if (!orgId || !service || !idempotencyKey) {
    res.status(400).json({ error: 'orgId, service and idempotencyKey are required' });
    return;
  }
  const unitPaise = SERVICE_PRICE_PAISE[service];
  if (!unitPaise) {
    res.status(400).json({ error: `unknown service: ${service}` });
    return;
  }

  const db = getFirestore();

  // Auth: the org's own relay secret, straight from the vault — never readable by a browser.
  const secretSnap = await db.collection('orgSecrets').doc(orgId).get();
  const secret = secretSnap.exists ? secretSnap.data()?.sourcing?.secret : null;
  if (!secret) {
    res.status(403).json({ error: 'sourcing not configured for this org' });
    return;
  }
  if (!verifyCustomerSignature(raw, req.get('x-bosun-signature'), req.get('x-bosun-timestamp'), secret)) {
    res.status(401).json({ error: 'bad signature' });
    return;
  }

  // Idempotency: the customer keys events by lead id, and their own claim transaction guarantees a
  // lead publishes once — so an already-logged key is a redelivery, acknowledged and unbilled.
  const logRef = db.collection(METER_LOG).doc(`${orgId}:${service}:${idempotencyKey}`);
  const existing = await logRef.get();
  if (existing.exists) {
    res.status(200).json({ ok: true, duplicate: true, charged: 0 });
    return;
  }

  // Settle: accrue the paise, debit whole rupees when they cross ₹1, and write the log row — all in
  // ONE transaction, so the accrual carry can never drift from the money. The log row doubles as
  // the idempotency key, exactly like the compose log.
  let charged = 0;
  try {
    charged = await db.runTransaction(async (tx) => {
      const orgRef = db.collection('organisations').doc(orgId);
      const orgSnap = await tx.get(orgRef);
      if (!orgSnap.exists) return 0;
      const dupe = await tx.get(logRef);
      if (dupe.exists) return 0; // raced with a concurrent identical event

      const org = orgSnap.data();
      const { debitInr, accrualPaise } = accrueComposeCharge(org.autopostAccrualPaise, unitPaise * qty);

      const update = { autopostAccrualPaise: accrualPaise };
      if (debitInr > 0) {
        // Org may go negative — same policy as the sourcing batch debit; the operator reconciles.
        update.balance = Number(org.balance ?? 0) - debitInr;
        tx.set(db.collection('transactions').doc(), {
          orgId,
          type: 'debit',
          kind: 'autopost_usage',
          amount: debitInr,
          // 2 auto-posts per ₹1 — the ledger row covers several, so record what it settled.
          count: Math.round((debitInr * 100) / unitPaise),
          description: `Auto-posted listing service (₹${(unitPaise / 100).toFixed(2)} × ${Math.round((debitInr * 100) / unitPaise)})`,
          createdAt: FieldValue.serverTimestamp(),
        });
      }
      tx.update(orgRef, update);
      tx.set(logRef, {
        orgId,
        service,
        idempotencyKey,
        qty,
        leadId: String(body.leadId || ''),
        refId: String(body.refId || ''),
        propertyId: String(body.propertyId || ''),
        displayId: String(body.displayId || ''),
        pricePaise: unitPaise,
        debitInr,
        createdAt: FieldValue.serverTimestamp(),
      });
      return debitInr;
    });
  } catch (e) {
    // The event is the customer telling us work already happened — failing the request makes them
    // retry, which the idempotency key absorbs. Fail loudly so it's visible.
    console.error('usageMeter:bill:err', orgId, service, idempotencyKey, e?.message || e);
    res.status(500).json({ error: 'billing failed — retry' });
    return;
  }

  console.log('usageMeter:ok', orgId, service, JSON.stringify({ idempotencyKey, qty, charged }));
  res.status(200).json({ ok: true, charged });
});
