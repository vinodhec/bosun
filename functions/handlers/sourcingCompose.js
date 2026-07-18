/**
 * POST /sourcingCompose — compose the WhatsApp message for a customer's self-post link, and bill it.
 *
 * This is the FIRST inbound HTTP endpoint in Bosun, and the first customer→Bosun call: every other
 * sourcing path is Bosun→customer (the signed relay in runSourcingJobs.js) or Bosun pulling the
 * customer's demand matrix. So the trust direction is reversed here — the CUSTOMER signs and we
 * verify, using the same `${timestamp}.${body}` HMAC and the same per-org secret from the vault
 * (orgSecrets/{orgId}.sourcing.secret) that `utils/sourcing.js: signPayload` uses outbound.
 *
 * Because the customer calls US, the charge is settled synchronously inside this request — there is
 * no meter callback to stand up and nothing to reconcile later.
 *
 * Billing (see shared/billing.js): ₹0.25 per COMPOSE, held in paise and accrued on the org so the
 * whole-rupee wallet is never over-billed (a naive per-call ceil would charge ₹1 = 4×). Idempotent
 * per (leadId, sendCount): a retry or a double-tap returns the SAME message and charges nothing, so
 * the customer can safely retry a timeout.
 *
 * Degrade: if Gemini can't produce a usable message we return 200 `{ composed: false }` and charge
 * ₹0. The customer falls back to their own template — an owner must never miss a message because our
 * LLM blinked, and we must never bill for a message we didn't write.
 *
 * Two message modes, one lane:
 *   - mode:'seller' (default) — the owner self-post invite (missingFieldLabels + lead{}).
 *   - mode:'buyer'            — a pitch to a "wanted / looking for" poster: we have N matching
 *                               listings, browse them all at `url` (a consolidated /properties link).
 * Same HMAC, same ₹0.25 charge, same idempotency — the buyer key is namespaced so a buyer pitch and a
 * seller invite for the same lead can never collide in the compose log.
 *
 * Request  seller: { orgId, leadId, sendCount, opened, url, missingFieldLabels[], lead{…} }
 *          buyer:  { orgId, leadId, sendCount, mode:'buyer', url, buyer{…}, listings[], count,
 *                    language?, variant?, single? }
 *          headers: x-bosun-signature: sha256=…, x-bosun-timestamp: <ms>
 * Response { composed, message, language, cached, charged }
 *
 * Buyer extensions (all optional, all backwards-compatible):
 *   - language: force the compose language ('en'|'ta'|'hi'|'te'|'kn'|'ml') instead of mirroring the post.
 *   - variant:  extra idempotency namespace within the lead (e.g. 'lang:ta', 'listing:<id>:ta') — the
 *               customer caches per language / per listing, so two different composes at the same
 *               sendCount must not resolve to one log row.
 *   - single:   the url is ONE property's page, not the consolidated browse link; the pitch must not
 *               promise multiple listings.
 */
import { onRequest } from 'firebase-functions/v2/https';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { composeSelfPostMessage, composeBuyerPitch } from '../utils/composeSelfPost.js';
import { SELFPOST_COMPOSE_PRICE_PAISE, accrueComposeCharge } from '../shared/billing.js';
import { verifyCustomerSignature, logReject } from '../utils/customerAuth.js';

const REGION = 'asia-south1';
const COMPOSE_LOG = 'selfpost_compose_log';

export const sourcingCompose = onRequest({ region: REGION, cors: false }, async (req, res) => {
  if (req.method !== 'POST') {
    logReject('sourcingCompose', { status: 405, reason: 'non-POST-method', extra: { method: req.method } });
    res.status(405).json({ error: 'POST only' });
    return;
  }

  // The signature covers the EXACT bytes sent. Express has already parsed the body, so re-serialising
  // it would risk a key-order mismatch — `rawBody` is the only safe input to the HMAC.
  const raw = req.rawBody ? req.rawBody.toString('utf8') : '';
  let body;
  try {
    body = JSON.parse(raw || '{}');
  } catch {
    logReject('sourcingCompose', { status: 400, reason: 'body-not-valid-json', extra: { bytes: raw.length } });
    res.status(400).json({ error: 'invalid JSON' });
    return;
  }

  const orgId = String(body.orgId || '');
  const leadId = String(body.leadId || '');
  const mode = body.mode === 'buyer' ? 'buyer' : 'seller';
  const sendCount = Math.max(1, Math.floor(Number(body.sendCount) || 1));
  const url = String(body.url || '');
  // Buyer extensions — sanitised hard, they end up inside a Firestore doc id (variant) and a prompt.
  const variant = String(body.variant || '').replace(/[^A-Za-z0-9:_-]/g, '').slice(0, 120);
  const forceLanguage = String(body.language || '').trim().toLowerCase().slice(0, 8);
  const single = body.single === true;
  if (!orgId || !leadId || !url) {
    logReject('sourcingCompose', {
      orgId,
      status: 400,
      reason: 'missing-required-field',
      extra: { hasOrgId: !!orgId, hasLeadId: !!leadId, hasUrl: !!url },
    });
    res.status(400).json({ error: 'orgId, leadId and url are required' });
    return;
  }

  const db = getFirestore();

  // Auth: the org's own relay secret, straight from the vault — never readable by a browser.
  const secretSnap = await db.collection('orgSecrets').doc(orgId).get();
  const secret = secretSnap.exists ? secretSnap.data()?.sourcing?.secret : null;
  if (!secret) {
    logReject('sourcingCompose', { orgId, status: 403, reason: 'org-has-no-sourcing-secret', extra: { orgSecretsDocExists: secretSnap.exists } });
    res.status(403).json({ error: 'sourcing not configured for this org' });
    return;
  }
  const auth = verifyCustomerSignature(raw, req.get('x-bosun-signature'), req.get('x-bosun-timestamp'), secret);
  if (!auth.ok) {
    // Reason to our logs only; the response stays a flat 401 so it can't be used to probe.
    logReject('sourcingCompose', { orgId, status: 401, reason: auth.reason, extra: { skewMs: auth.skewMs ?? null, bytes: raw.length } });
    res.status(401).json({ error: 'bad signature' });
    return;
  }

  // Idempotency: one compose per (lead, mode, variant, attempt). A retried timeout must return the
  // first message and must not bill twice — the customer cannot tell a lost response from a lost
  // request. The buyer key is namespaced so a buyer pitch never collides with a seller invite for the
  // same lead+sendCount; `variant` further namespaces per-language / per-listing composes (the
  // customer caches each separately, so each is its own attempt). Keys without a variant are left
  // unchanged so pre-variant history keeps resolving.
  const logKey = mode === 'buyer'
    ? `${orgId}:${leadId}:buyer:${variant ? `${variant}:` : ''}${sendCount}`
    : `${orgId}:${leadId}:${sendCount}`;
  const logRef = db.collection(COMPOSE_LOG).doc(logKey);
  const existing = await logRef.get();
  if (existing.exists) {
    const d = existing.data();
    res.status(200).json({
      composed: true,
      message: d.message,
      language: d.language || 'en',
      cached: true,
      charged: 0,
    });
    return;
  }

  let composed = null;
  try {
    composed = mode === 'buyer'
      ? await composeBuyerPitch({
          buyer: body.buyer || {},
          listings: Array.isArray(body.listings) ? body.listings.slice(0, 10) : [],
          count: Math.max(0, Math.floor(Number(body.count) || 0)),
          url,
          city: String(body.city || body.buyer?.city || ''),
          sendCount,
          forceLanguage,
          single,
        })
      : await composeSelfPostMessage({
          lead: body.lead || {},
          url,
          missingFieldLabels: Array.isArray(body.missingFieldLabels) ? body.missingFieldLabels.slice(0, 12).map(String) : [],
          sendCount,
          opened: Boolean(body.opened),
        });
  } catch (e) {
    console.error('sourcingCompose:gemini:err', mode, e?.message || e);
  }

  if (!composed) {
    // No message, no charge. The customer's template takes over.
    console.log('sourcingCompose:degraded', orgId, leadId, JSON.stringify({ mode, sendCount }));
    res.status(200).json({ composed: false, charged: 0 });
    return;
  }

  // Settle: accrue the paise, debit whole rupees when they cross ₹1, and write the log row — all in
  // ONE transaction, so the accrual carry can never drift from the money. The log row doubles as the
  // idempotency key, which is why it is created here and not before the compose.
  let charged = 0;
  try {
    charged = await db.runTransaction(async (tx) => {
      const orgRef = db.collection('organisations').doc(orgId);
      const orgSnap = await tx.get(orgRef);
      if (!orgSnap.exists) return 0;
      const dupe = await tx.get(logRef);
      if (dupe.exists) return 0; // raced with a concurrent identical request

      const org = orgSnap.data();
      const { debitInr, accrualPaise } = accrueComposeCharge(org.composeAccrualPaise, SELFPOST_COMPOSE_PRICE_PAISE);

      const update = { composeAccrualPaise: accrualPaise };
      if (debitInr > 0) {
        // Org may go negative — same policy as the sourcing batch debit; the operator reconciles.
        update.balance = Number(org.balance ?? 0) - debitInr;
        tx.set(db.collection('transactions').doc(), {
          orgId,
          type: 'debit',
          // Same metered lane + price for both modes, so metrics stay one line; `mode` disambiguates.
          kind: 'selfpost_compose',
          mode,
          amount: debitInr,
          // 4 composes per ₹1 — the ledger row covers several, so record what it settled.
          count: Math.round(100 / SELFPOST_COMPOSE_PRICE_PAISE),
          description: `${mode === 'buyer' ? 'Buyer pitch' : 'Self-post'} message composition (₹${(SELFPOST_COMPOSE_PRICE_PAISE / 100).toFixed(2)} × ${Math.round(100 / SELFPOST_COMPOSE_PRICE_PAISE)})`,
          createdAt: FieldValue.serverTimestamp(),
        });
      }
      tx.update(orgRef, update);
      tx.set(logRef, {
        orgId,
        leadId,
        mode,
        ...(variant ? { variant } : {}),
        sendCount,
        message: composed.message,
        language: composed.language,
        pricePaise: SELFPOST_COMPOSE_PRICE_PAISE,
        debitInr,
        createdAt: FieldValue.serverTimestamp(),
      });
      return debitInr;
    });
  } catch (e) {
    // The message exists and is going out; losing the charge is the lesser evil versus making the
    // owner wait or sending nothing. Logged loudly so it is reconcilable.
    console.error('sourcingCompose:bill:err', orgId, leadId, e?.message || e);
  }

  console.log('sourcingCompose:ok', orgId, leadId, JSON.stringify({ mode, variant: variant || undefined, sendCount, language: composed.language, charged }));
  res.status(200).json({
    composed: true,
    message: composed.message,
    language: composed.language,
    cached: false,
    charged,
  });
});
