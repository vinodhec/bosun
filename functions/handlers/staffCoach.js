/**
 * staffCoach — the customer's ADMIN training help: grade written assessment answers, and answer staff
 * questions ("Ask MaadiVeedu Admin"). The platform hosts the training content (static) and sends the
 * relevant text with every call, so Bosun holds no customer content and the answers stay grounded.
 *
 *   action:'grade' { orgId, attemptId, module, answers:[{ id, question, ideal, answer }] }
 *                  → { items:[{ id, score (0–10), feedback }], overall, charged }
 *   action:'chat'  { orgId, conversationId, knowledge, history:[{ role:'user'|'assistant', text }], message }
 *                  → { reply, charged }
 *
 * Auth: the org's sourcing secret (same HMAC as assistantChat). Billing (shared/billing.js "Staff
 * coach"): one `staff_assessment` per attempt id, one `staff_chat` per conversation id (the first
 * delivered reply; later replies in that conversation are free, capped STAFF_CHAT_MAX_REPLIES a day).
 * A failed model call is never charged. Refuses work for an org whose billing is paused / negative.
 */
import { onRequest } from 'firebase-functions/v2/https';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { verifyCustomerSignature, logReject } from '../utils/customerAuth.js';
import { settleMetered } from '../utils/meter.js';
import { blocksNewWork, STAFF_CHAT_MAX_REPLIES } from '../shared/billing.js';
import { generateJson, GEMINI_FLASH } from '../utils/gemini.js';

const REGION = 'asia-south1';
const USAGE = 'staffCoachUsage';
const clip = (s, n) => String(s ?? '').slice(0, n);

function istDayKey(ms = Date.now()) {
  const d = new Date(ms + 5.5 * 3600 * 1000);
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
}

const GRADE_SYSTEM = `You grade short answers written by staff of an Indian real-estate platform (MaadiVeedu) in training.
Each item has the question, the model answer and the staff member's answer. Score 0-10 for how well the
answer would work on a real phone call: correct facts (prices, plan names, what is included), polite and
clear, asks for consent before sharing numbers, never promises what the platform does not do.
Be fair to Tamil, Tanglish or broken English — judge the substance, not the grammar.
Feedback: one or two short sentences, plain English, telling them what to add or change. Never rude.`;

const CHAT_SYSTEM = `You are "Ask MaadiVeedu Admin", a helper for the platform's own staff (callers, admins).
Answer ONLY from the TRAINING NOTES given. If the notes do not cover it, say so and suggest asking the
owner or a superadmin — never invent prices, rules or features. Short, practical answers: what to say
on the call, which screen and which button. Reply in the language the staff member used (English,
Tamil or Tanglish). No markdown headings; short lines or a few bullets are fine.`;

export const staffCoach = onRequest({ region: REGION, timeoutSeconds: 60, memory: '512MiB', cors: false }, async (req, res) => {
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
  const orgId = String(body.orgId || '');
  const action = ['grade', 'chat'].includes(body.action) ? body.action : '';
  if (!orgId || !action) {
    res.status(400).json({ error: 'orgId and action are required' });
    return;
  }

  const db = getFirestore();
  const [secretSnap, orgSnap] = await Promise.all([db.collection('orgSecrets').doc(orgId).get(), db.collection('organisations').doc(orgId).get()]);
  const secret = secretSnap.exists ? secretSnap.data()?.sourcing?.secret : null;
  if (!secret) {
    logReject('staffCoach', { orgId, status: 403, reason: 'org-has-no-sourcing-secret', extra: {} });
    res.status(403).json({ error: 'not configured for this org' });
    return;
  }
  const auth = verifyCustomerSignature(raw, req.get('x-bosun-signature'), req.get('x-bosun-timestamp'), secret);
  if (!auth.ok) {
    logReject('staffCoach', { orgId, status: 401, reason: auth.reason, extra: { skewMs: auth.skewMs ?? null } });
    res.status(401).json({ error: 'bad signature' });
    return;
  }
  const org = orgSnap.exists ? orgSnap.data() : {};
  if (blocksNewWork(org)) {
    logReject('staffCoach', { orgId, status: 402, reason: 'negative-balance', extra: { balance: org.balance ?? null } });
    res.status(402).json({ error: 'balance' });
    return;
  }

  try {
    if (action === 'grade') {
      const attemptId = clip(body.attemptId, 80).replace(/[^A-Za-z0-9_:-]/g, '');
      const answers = (Array.isArray(body.answers) ? body.answers : []).slice(0, 6).map((a) => ({
        id: clip(a.id, 40),
        question: clip(a.question, 600),
        ideal: clip(a.ideal, 1200),
        answer: clip(a.answer, 1500),
      }));
      if (!attemptId || !answers.length) {
        res.status(400).json({ error: 'attemptId and answers are required' });
        return;
      }
      const prompt = `MODULE: ${clip(body.module, 120)}\n\n${answers
        .map((a, i) => `ITEM ${i + 1} (id ${a.id})\nQUESTION: ${a.question}\nMODEL ANSWER: ${a.ideal}\nSTAFF ANSWER: ${a.answer || '(blank)'}`)
        .join('\n\n')}`;
      const out = await generateJson({
        model: GEMINI_FLASH,
        system: GRADE_SYSTEM,
        prompt,
        maxOutputTokens: 1200,
        thinkingBudget: 0,
        schema: {
          type: 'object',
          properties: {
            items: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, score: { type: 'number' }, feedback: { type: 'string' } }, required: ['id', 'score', 'feedback'] } },
            overall: { type: 'string' },
          },
          required: ['items', 'overall'],
        },
      });
      const items = (out?.items || []).map((x) => ({ id: clip(x.id, 40), score: Math.max(0, Math.min(10, Math.round(Number(x.score) || 0))), feedback: clip(x.feedback, 400) }));
      if (!items.length) throw new Error('empty grade');
      const settled = await settleMetered({
        db, orgId, service: 'staff_assessment',
        idempotencyKey: attemptId,
        description: `Staff training assessment graded (${clip(body.module, 40)})`,
        extra: { attemptId, module: clip(body.module, 80), items: items.length },
      });
      res.json({ ok: true, items, overall: clip(out.overall, 500), charged: settled.charged });
      return;
    }

    // chat
    const conversationId = clip(body.conversationId, 64).replace(/[^A-Za-z0-9_-]/g, '');
    const message = clip(body.message, 1500).trim();
    if (!conversationId || !message) {
      res.status(400).json({ error: 'conversationId and message are required' });
      return;
    }
    const usageRef = db.collection(USAGE).doc(`${orgId}__${conversationId}__${istDayKey()}`);
    const used = Number((await usageRef.get()).data()?.replies) || 0;
    if (used >= STAFF_CHAT_MAX_REPLIES) {
      res.status(429).json({ error: 'conversation cap' });
      return;
    }
    const history = (Array.isArray(body.history) ? body.history : []).slice(-10).map((h) => `${h.role === 'assistant' ? 'HELPER' : 'STAFF'}: ${clip(h.text, 800)}`);
    const out = await generateJson({
      model: GEMINI_FLASH,
      system: CHAT_SYSTEM,
      prompt: `TRAINING NOTES:\n${clip(body.knowledge, 24000)}\n\nCONVERSATION SO FAR:\n${history.join('\n') || '(none)'}\n\nSTAFF: ${message}`,
      maxOutputTokens: 700,
      thinkingBudget: 0,
      schema: { type: 'object', properties: { reply: { type: 'string' } }, required: ['reply'] },
    });
    const reply = clip(out?.reply, 2500).trim();
    if (!reply) throw new Error('empty reply');
    await usageRef.set({ orgId, conversationId, replies: FieldValue.increment(1), updatedAtMs: Date.now() }, { merge: true });
    const settled = await settleMetered({
      db, orgId, service: 'staff_chat',
      idempotencyKey: conversationId,
      description: `Ask MaadiVeedu Admin conversation (${conversationId.slice(0, 8)}…)`,
      extra: { conversationId },
    });
    res.json({ ok: true, reply, charged: settled.charged });
  } catch (e) {
    console.error('staffCoach:err', orgId, action, e instanceof Error ? e.message : e);
    res.status(502).json({ error: 'upstream' });
  }
});
