/**
 * POST /waCompose — reword one WhatsApp bot reply for a customer's outreach conversation.
 *
 * Why this lives HERE and not on the customer's platform: the flat ₹0.25/message WhatsApp fee is
 * priced on Bosun bearing the AI cost of composition (owner decision 2026-08-02). So the Gemini
 * call runs on Bosun's billing (utils/gemini.js — GEMINI_API_KEY or Bosun's own Vertex project),
 * and the platform calls this endpoint instead of any model directly. No per-call charge is
 * levied — composition is a cost of the wa_message_delivered service, not a service of its own.
 *
 * The platform's reducer has ALREADY decided what the reply means; this endpoint only rewords it —
 * warmer, conversational, in the owner's own language (Tamil/Hindi/Tanglish/English). The platform
 * re-validates the output (digit guard, pinned opt-out, length) before sending, so a bad rewrite
 * here degrades to their canned text, never to a wrong message.
 *
 * Auth mirrors sourcingCompose/usageMeter exactly: HMAC over `${timestamp}.${rawBody}` with the
 * org's relay secret from the vault.
 *
 * Request  { orgId, leadId, ownerText, core }   headers: x-bosun-signature, x-bosun-timestamp
 * Response { composed: true, reply } | { composed: false } (degraded — caller uses canned text)
 */
import { onRequest } from 'firebase-functions/v2/https';
import { getFirestore } from 'firebase-admin/firestore';
import { verifyCustomerSignature, logReject } from '../utils/customerAuth.js';
import { generateJson, GEMINI_FLASH } from '../utils/gemini.js';

const REGION = 'asia-south1';

export const waCompose = onRequest({ region: REGION, cors: false }, async (req, res) => {
  if (req.method !== 'POST') {
    logReject('waCompose', { status: 405, reason: 'non-POST-method', extra: { method: req.method } });
    res.status(405).json({ error: 'POST only' });
    return;
  }
  const raw = req.rawBody ? req.rawBody.toString('utf8') : '';
  let body;
  try {
    body = JSON.parse(raw || '{}');
  } catch {
    logReject('waCompose', { status: 400, reason: 'body-not-valid-json', extra: { bytes: raw.length } });
    res.status(400).json({ error: 'invalid JSON' });
    return;
  }
  const orgId = String(body.orgId || '');
  const core = String(body.core || '').slice(0, 600);
  const ownerText = String(body.ownerText || '').slice(0, 300);
  if (!orgId || !core) {
    logReject('waCompose', { orgId, status: 400, reason: 'missing-required-field', extra: { hasCore: !!core } });
    res.status(400).json({ error: 'orgId and core are required' });
    return;
  }

  const db = getFirestore();
  const secretSnap = await db.collection('orgSecrets').doc(orgId).get();
  const secret = secretSnap.exists ? secretSnap.data()?.sourcing?.secret : null;
  if (!secret) {
    logReject('waCompose', { orgId, status: 403, reason: 'org-has-no-sourcing-secret', extra: {} });
    res.status(403).json({ error: 'sourcing not configured for this org' });
    return;
  }
  const auth = verifyCustomerSignature(raw, req.get('x-bosun-signature'), req.get('x-bosun-timestamp'), secret);
  if (!auth.ok) {
    logReject('waCompose', { orgId, status: 401, reason: auth.reason, extra: { bytes: raw.length } });
    res.status(401).json({ error: 'bad signature' });
    return;
  }

  const prompt =
    `You are a real-estate marketplace's WhatsApp assistant talking to a property owner in India.\n` +
    `The owner's last message: "${ownerText}"\n` +
    `Rewrite this reply so it feels warm, human and conversational on WhatsApp:\n` +
    `"${core}"\n` +
    `Rules:\n` +
    `- Reply in the SAME language/style the owner used (Tamil→Tamil, Hindi→Hindi, Tanglish→Tanglish, else English).\n` +
    `- Keep the exact same meaning, request and question. Do NOT add facts, prices, numbers, offers or promises.\n` +
    `- At most 2 short sentences plus the question. At most one emoji.\n`;

  // Flash, not lite: rewording across TA/HI/Tanglish is nuance work (see utils/gemini.js model note);
  // thinkingBudget 0 — measured: thinking adds seconds + truncation risk and buys nothing here.
  const parsed = await generateJson({
    model: GEMINI_FLASH,
    prompt,
    schema: { type: 'OBJECT', properties: { reply: { type: 'STRING' } }, required: ['reply'] },
    temperature: 0.4,
    maxOutputTokens: 220,
    thinkingBudget: 0,
  });
  const reply = String(parsed?.reply || '').trim();
  if (!reply) {
    res.status(200).json({ composed: false });
    return;
  }
  res.status(200).json({ composed: true, reply });
});
