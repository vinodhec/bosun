/**
 * POST /dmCompose — write the Facebook DM a phone-hunter sends to a seller whose post carries no
 * phone number.
 *
 * WHY THIS EXISTS: on the customer's platform, a large share of sourced leads have no number at
 * all — nobody can call them, so they sit in `pending` forever. The phone-hunt lane puts a human on
 * the original post to find the number in the video, the photos or the comments; when there is
 * nothing to find, the only way through is a DM. This endpoint writes that DM.
 *
 * WHY IT LIVES HERE and not on the platform: same reason as waCompose — the Gemini call runs on
 * BOSUN's billing (utils/gemini.js), and no Vertex credential exists on the customer's side. Unlike
 * waCompose, composition here IS the billable service rather than a cost folded into a per-message
 * rate: DM_COMPOSE_PRICE_PAISE, flat, once per lead per IST day, settled in-process below.
 *
 * DEGRADED IS FREE. A model failure returns `{ composed: false }` and charges nothing; the platform
 * falls back to its own deterministic template. We bill for a composed message, not for an attempt.
 *
 * NO URL, EVER. The platform appends the complete-your-listing magic link itself, byte-exact, after
 * this returns — a model that "improves" a token in a magic link produces a dead link and a seller
 * who thinks we wasted their time. The prompt forbids URLs and the output is stripped as a
 * belt-and-braces check, mirroring the same guard on the platform side.
 *
 * Auth mirrors waCompose/sourcingCompose/usageMeter exactly: HMAC over `${timestamp}.${rawBody}`
 * with the org's relay secret from the vault.
 *
 * Request  { orgId, leadId, lead: { refId, title, locality, city, propertyType?, listingType? }, ask }
 *          ask = 'number' | 'complete_link'      headers: x-bosun-signature, x-bosun-timestamp
 * Response { composed: true, message } | { composed: false }
 */
import { onRequest } from 'firebase-functions/v2/https';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { verifyCustomerSignature, logReject } from '../utils/customerAuth.js';
import { generateJson, GEMINI_FLASH } from '../utils/gemini.js';
import { METER_LOG } from '../utils/meter.js';
import { DM_COMPOSE_PRICE_PAISE, accrueComposeCharge, isServicePaused } from '../shared/billing.js';

const REGION = 'asia-south1';

/** IST date key — the billing window. One composed DM per lead per day is one charge. */
function istDateKey(nowMs) {
  const ist = new Date(nowMs + 5.5 * 3600 * 1000);
  return ist.toISOString().slice(0, 10);
}

/**
 * Strip anything link-shaped. The prompt already forbids URLs; this is the guard that actually
 * holds, because a prompt is a request and a regex is a rule.
 */
function stripUrls(text) {
  return String(text || '')
    .replace(/\bhttps?:\/\/\S+/gi, '')
    .replace(/\bwww\.\S+/gi, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

export const dmCompose = onRequest({ region: REGION, cors: false }, async (req, res) => {
  if (req.method !== 'POST') {
    logReject('dmCompose', { status: 405, reason: 'non-POST-method', extra: { method: req.method } });
    res.status(405).json({ error: 'POST only' });
    return;
  }
  const raw = req.rawBody ? req.rawBody.toString('utf8') : '';
  let body;
  try {
    body = JSON.parse(raw || '{}');
  } catch {
    logReject('dmCompose', { status: 400, reason: 'body-not-valid-json', extra: { bytes: raw.length } });
    res.status(400).json({ error: 'invalid JSON' });
    return;
  }

  const orgId = String(body.orgId || '');
  const leadId = String(body.leadId || '');
  const lead = body.lead && typeof body.lead === 'object' ? body.lead : {};
  const ask = body.ask === 'complete_link' ? 'complete_link' : 'number';
  const refId = String(lead.refId || '').slice(0, 40);
  const title = String(lead.title || '').slice(0, 300);
  const locality = String(lead.locality || '').slice(0, 120);
  const city = String(lead.city || '').slice(0, 120);
  const propertyType = String(lead.propertyType || '').slice(0, 60);
  const listingType = String(lead.listingType || '').slice(0, 40);

  if (!orgId || !leadId || (!title && !locality)) {
    logReject('dmCompose', {
      orgId,
      status: 400,
      reason: 'missing-required-field',
      extra: { hasLeadId: !!leadId, hasTitle: !!title, hasLocality: !!locality },
    });
    res.status(400).json({ error: 'orgId, leadId and one of lead.title / lead.locality are required' });
    return;
  }

  const db = getFirestore();
  const secretSnap = await db.collection('orgSecrets').doc(orgId).get();
  const secret = secretSnap.exists ? secretSnap.data()?.sourcing?.secret : null;
  if (!secret) {
    logReject('dmCompose', { orgId, status: 403, reason: 'org-has-no-sourcing-secret', extra: {} });
    res.status(403).json({ error: 'sourcing not configured for this org' });
    return;
  }
  const auth = verifyCustomerSignature(raw, req.get('x-bosun-signature'), req.get('x-bosun-timestamp'), secret);
  if (!auth.ok) {
    logReject('dmCompose', { orgId, status: 401, reason: auth.reason, extra: { bytes: raw.length } });
    res.status(401).json({ error: 'bad signature' });
    return;
  }

  const place = [locality, city].filter(Boolean).join(', ');
  const what = [listingType, propertyType].filter(Boolean).join(' ');
  const askLine =
    ask === 'complete_link'
      ? `Ask them to tap the link we will paste right after this message to finish listing the property themselves — it takes a minute and needs no signup.`
      : `Ask for a phone number we can call them on about this property.`;

  // Flash, not lite: this is written in the seller's own language off a scraped Tamil/Tanglish post,
  // which is nuance work (see utils/gemini.js model note). thinkingBudget 0 — measured on the
  // WhatsApp composer: thinking adds seconds and truncation risk and buys nothing for a short message.
  const prompt =
    `You write first-contact Facebook Messenger DMs for an Indian real-estate marketplace called MaadiVeedu.\n` +
    `We found this property post publicly on Facebook and want to help the owner reach buyers on our site.\n\n` +
    `Property post title: "${title}"\n` +
    (place ? `Place: ${place}\n` : '') +
    (what ? `Kind: ${what}\n` : '') +
    `\nWrite the DM we should send.\n` +
    `Rules:\n` +
    `- Reply in the SAME language/style as the post title (Tamil→Tamil, Tanglish→Tanglish, Hindi→Hindi, else English).\n` +
    `- Open by naming their property so they know exactly which post we mean.\n` +
    `- Say who we are in a few words: MaadiVeedu, a property site, and that listing is free.\n` +
    `- ${askLine}\n` +
    `- At most 3 short sentences. At most one emoji. Polite, not salesy, no pressure.\n` +
    `- Do NOT invent price, size, or any fact that is not in the title above.\n` +
    `- Do NOT include any URL, link, phone number or email — those are added afterwards.\n`;

  let message = '';
  try {
    const parsed = await generateJson({
      model: GEMINI_FLASH,
      prompt,
      schema: { type: 'OBJECT', properties: { message: { type: 'STRING' } }, required: ['message'] },
      temperature: 0.5,
      maxOutputTokens: 260,
      thinkingBudget: 0,
    });
    message = stripUrls(parsed?.message).slice(0, 700);
  } catch (e) {
    console.error('dmCompose:gemini', orgId, leadId, e?.message || e);
    res.status(200).json({ composed: false });
    return;
  }
  if (!message) {
    res.status(200).json({ composed: false });
    return;
  }

  // The ref is what makes the seller's reply findable days later: the hunter pastes it into the
  // lane's search box. Appended here rather than prompted, so the model cannot mangle it.
  if (refId && !message.includes(refId)) message = `${message}\n\n(Ref: ${refId})`;

  // ── Settle: flat, once per lead per IST day. Composed = billable, degraded = free (returned above).
  const dateKey = istDateKey(Date.now());
  const idempotencyKey = `${leadId}:${dateKey}`;
  const logRef = db.collection(METER_LOG).doc(`${orgId}:dm_compose:${idempotencyKey}`);
  try {
    await db.runTransaction(async (tx) => {
      const orgRef = db.collection('organisations').doc(orgId);
      const orgSnap = await tx.get(orgRef);
      if (!orgSnap.exists) return;
      const dupe = await tx.get(logRef);
      if (dupe.exists) return; // re-copied the same message today — one charge, not two
      const org = orgSnap.data();

      if (isServicePaused(org, 'dm_compose')) {
        tx.set(logRef, {
          orgId,
          service: 'dm_compose',
          idempotencyKey,
          qty: 1,
          leadId,
          ask,
          pricePaise: DM_COMPOSE_PRICE_PAISE,
          debitInr: 0,
          waived: true,
          waivedPaise: DM_COMPOSE_PRICE_PAISE,
          createdAt: FieldValue.serverTimestamp(),
        });
        return;
      }

      const { debitInr, accrualPaise } = accrueComposeCharge(org.dmComposeAccrualPaise, DM_COMPOSE_PRICE_PAISE);
      const update = { dmComposeAccrualPaise: accrualPaise };
      if (debitInr > 0) {
        update.balance = Number(org.balance ?? 0) - debitInr;
        tx.set(db.collection('transactions').doc(), {
          orgId,
          type: 'debit',
          kind: 'dm_compose',
          amount: debitInr,
          count: 1, // one composed DM — adminMetrics sums `count` for the lane's Units column
          description: `Phone-hunt DM composed (${refId || leadId})`,
          createdAt: FieldValue.serverTimestamp(),
        });
      }
      tx.update(orgRef, update);
      tx.set(logRef, {
        orgId,
        service: 'dm_compose',
        idempotencyKey,
        qty: 1,
        leadId,
        ask,
        pricePaise: DM_COMPOSE_PRICE_PAISE,
        debitInr,
        createdAt: FieldValue.serverTimestamp(),
      });
    });
  } catch (e) {
    // The hunter already has their message; a failed settle must not turn into an error they see.
    // The log row is the ledger's idempotency key, so a missing row simply means this compose was
    // never billed — under-billing on our own infrastructure fault is the right way to fail.
    console.error('dmCompose:settle', orgId, leadId, e?.message || e);
  }

  res.status(200).json({ composed: true, message });
});
