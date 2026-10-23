/**
 * POST /sourcingBlocklist — the platform's "never fetch this number again" list (customer→Bosun, HMAC).
 *
 * The customer's admins keep the list on their own Blocked numbers page (the platform owns the
 * metadata: who blocked it, why, when). Every change there pushes the WHOLE list here, which lands
 * on `organisations/{orgId}.sourcing.blockedPhones` — the list runSourcingJobs reads at 3a1 (SERP
 * text) and 3g (full post text, right before the webhook), and adminSourcingRelayLead refuses on.
 * Whole-list replace, not add/remove, because the platform is the source of truth: a redelivered or
 * out-of-order push converges on the latest list instead of drifting.
 *
 * Auth: the per-org relay secret over `${timestamp}.${rawBody}` (utils/customerAuth.js), like every
 * other customer→Bosun call.
 *
 * Request  { orgId, action: 'set', phones: ['9876543210', '+91 98765 43210', …] }  → { ok, blockedPhones }
 *          { orgId, action: 'list' }                                              → { ok, blockedPhones }
 */
import { onRequest } from 'firebase-functions/v2/https';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { verifyCustomerSignature, logReject } from '../utils/customerAuth.js';
import { parseBlockedPhones } from '../utils/sourcing.js';

const MAX_PHONES = 5000;

export const sourcingBlocklist = onRequest({ region: 'asia-south1', cors: false }, async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' });
    return;
  }
  const raw = req.rawBody ? req.rawBody.toString('utf8') : '';
  let body;
  try {
    body = JSON.parse(raw || '{}');
  } catch {
    res.status(400).json({ error: 'invalid JSON' });
    return;
  }
  const orgId = String(body.orgId || '').trim();
  if (!orgId) {
    res.status(400).json({ error: 'orgId required' });
    return;
  }

  const db = getFirestore();
  const secretSnap = await db.collection('orgSecrets').doc(orgId).get();
  const secret = secretSnap.exists ? secretSnap.data()?.sourcing?.secret : null;
  const auth = verifyCustomerSignature(raw, req.get('x-bosun-signature'), req.get('x-bosun-timestamp'), secret);
  if (!auth.ok) {
    logReject('sourcingBlocklist', { orgId, status: 401, reason: auth.reason });
    res.status(401).json({ error: 'bad signature' });
    return;
  }

  const ref = db.collection('organisations').doc(orgId);
  const snap = await ref.get();
  if (!snap.exists) {
    res.status(404).json({ error: 'organisation not found' });
    return;
  }

  if (body.action === 'list') {
    res.json({ ok: true, blockedPhones: snap.data().sourcing?.blockedPhones || [] });
    return;
  }
  if (body.action !== 'set') {
    res.status(400).json({ error: "action must be 'set' or 'list'" });
    return;
  }
  let phones;
  try {
    phones = parseBlockedPhones(body.phones);
  } catch (e) {
    res.status(400).json({ error: e.message });
    return;
  }
  if (phones.length > MAX_PHONES) {
    res.status(400).json({ error: `at most ${MAX_PHONES} numbers` });
    return;
  }
  await ref.update({ 'sourcing.blockedPhones': phones, 'sourcing.blockedPhonesUpdatedAt': FieldValue.serverTimestamp() });
  console.log('sourcingBlocklist:set', orgId, JSON.stringify({ count: phones.length }));
  res.json({ ok: true, blockedPhones: phones });
});
