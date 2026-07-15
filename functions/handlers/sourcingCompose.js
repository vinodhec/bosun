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
 * Request  { orgId, leadId, sendCount, opened, url, missingFieldLabels[], lead{…} }
 *          headers: x-bosun-signature: sha256=…, x-bosun-timestamp: <ms>
 * Response { composed, message, language, cached, charged }
 */
import { onRequest } from 'firebase-functions/v2/https';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import crypto from 'node:crypto';
import { composeSelfPostMessage } from '../utils/composeSelfPost.js';
import { SELFPOST_COMPOSE_PRICE_PAISE, accrueComposeCharge } from '../shared/billing.js';

const REGION = 'asia-south1';
const MAX_SIGNATURE_AGE_MS = 5 * 60 * 1000; // reject replays — mirrors the customer's own verify
const COMPOSE_LOG = 'selfpost_compose_log';

/**
 * Constant-time check of the customer's HMAC over `${timestamp}.${rawBody}`. Mirror of
 * `utils/sourcing.js: signPayload` — same scheme, opposite direction.
 */
function verifyCustomerSignature(rawBody, signature, timestamp, secret) {
  if (!signature || !timestamp || !secret) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > MAX_SIGNATURE_AGE_MS) return false;
  const expected = 'sha256=' + crypto.createHmac('sha256', String(secret)).update(`${ts}.${rawBody}`).digest('hex');
  const a = Buffer.from(String(signature));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export const sourcingCompose = onRequest({ region: REGION, cors: false }, async (req, res) => {
  if (req.method !== 'POST') {
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
    res.status(400).json({ error: 'invalid JSON' });
    return;
  }

  const orgId = String(body.orgId || '');
  const leadId = String(body.leadId || '');
  const sendCount = Math.max(1, Math.floor(Number(body.sendCount) || 1));
  const url = String(body.url || '');
  if (!orgId || !leadId || !url) {
    res.status(400).json({ error: 'orgId, leadId and url are required' });
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

  // Idempotency: one compose per (lead, attempt). A retried timeout must return the first message and
  // must not bill twice — the customer cannot tell a lost response from a lost request.
  const logRef = db.collection(COMPOSE_LOG).doc(`${orgId}:${leadId}:${sendCount}`);
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
    composed = await composeSelfPostMessage({
      lead: body.lead || {},
      url,
      missingFieldLabels: Array.isArray(body.missingFieldLabels) ? body.missingFieldLabels.slice(0, 12).map(String) : [],
      sendCount,
      opened: Boolean(body.opened),
    });
  } catch (e) {
    console.error('sourcingCompose:gemini:err', e?.message || e);
  }

  if (!composed) {
    // No message, no charge. The customer's template takes over.
    console.log('sourcingCompose:degraded', orgId, leadId, JSON.stringify({ sendCount }));
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
          kind: 'selfpost_compose',
          amount: debitInr,
          // 4 composes per ₹1 — the ledger row covers several, so record what it settled.
          count: Math.round(100 / SELFPOST_COMPOSE_PRICE_PAISE),
          description: `Self-post message composition (₹${(SELFPOST_COMPOSE_PRICE_PAISE / 100).toFixed(2)} × ${Math.round(100 / SELFPOST_COMPOSE_PRICE_PAISE)})`,
          createdAt: FieldValue.serverTimestamp(),
        });
      }
      tx.update(orgRef, update);
      tx.set(logRef, {
        orgId,
        leadId,
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

  console.log('sourcingCompose:ok', orgId, leadId, JSON.stringify({ sendCount, language: composed.language, charged }));
  res.status(200).json({
    composed: true,
    message: composed.message,
    language: composed.language,
    cached: false,
    charged,
  });
});
