/**
 * Lead call-brief — on-demand "Prep call" for a website-captured lead.
 *
 * The admin is about to phone a lead that was born on the site (browse capture, enquiry, tool
 * signal…). They tap "Prep call"; the platform bundles that lead's session context — what they
 * searched, the listings they viewed, why we captured them, live inventory in their area — signs
 * it, and POSTs here. Gemini Flash turns it into a tight call brief:
 *   - summary       : one or two lines — who this is and what they want
 *   - actionItems[] : the concrete next steps for THIS call
 *   - howToCapture  : the approach — what to lead with, what to offer, how to handle "just looking"
 *   - opener        : a ready-to-say first line
 *
 * Billed 3× our Gemini cost (LEAD_BRIEF_PRICE_PAISE) per generation, settled in-process with the
 * same paise-accrual discipline as the other lanes; idempotencyKey = the platform-supplied brief
 * key, so re-opening a cached brief never double-charges and only a REGENERATE bills again.
 *
 * Auth: HMAC over the raw body with the org's sourcing secret (same scheme the platform's ingest
 * verifies in reverse) — this endpoint moves money, so it is not open like blogClassifyNow.
 */
import { onRequest } from 'firebase-functions/v2/https';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import crypto from 'node:crypto';
import { generateJson, GEMINI_FLASH, geminiConfigured } from '../utils/gemini.js';
import { LEAD_BRIEF_PRICE_PAISE, accrueComposeCharge, isServicePaused } from '../shared/billing.js';

const REGION = 'asia-south1';
const METER_LOG = 'usage_meter_log';

function verifyHmac(rawBody, signature, timestamp, secret) {
  if (!signature || !timestamp || !secret) return false;
  const mac = crypto.createHmac('sha256', String(secret)).update(`${timestamp}.${rawBody}`).digest('hex');
  const expected = `sha256=${mac}`;
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(signature)));
  } catch {
    return false;
  }
}

const BRIEF_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    actionItems: { type: 'array', items: { type: 'string' } },
    howToCapture: { type: 'string' },
    opener: { type: 'string' },
  },
  required: ['summary', 'actionItems', 'howToCapture', 'opener'],
};

function briefPrompt(lead) {
  const L = lead || {};
  const lines = [
    'You are briefing a real-estate call agent who is about to phone a lead in the next few minutes.',
    'The lead was captured on our property website. Write a SHORT, practical call brief — no fluff,',
    'no greetings, just what helps them convert this call. Indian real-estate context, ₹.',
    '',
    'Return JSON:',
    '- summary: 1–2 sentences — who this person is and what they are after, and how warm they are.',
    '- actionItems: 3–5 imperative bullets for THIS call (verify budget, share the N matching',
    '  listings, book a viewing, set a follow-up…). Be specific to their context.',
    '- howToCapture: 2–3 sentences on the APPROACH — what to lead with given how they were captured,',
    '  what to offer (we-find-it-for-you when supply is thin, owner-direct/no-brokerage, WhatsApp',
    '  photos), and how to handle "just looking".',
    '- opener: one natural first line the agent can say, referencing what they browsed.',
    '',
    '── LEAD CONTEXT ──',
    L.name ? `Name: ${L.name}` : '',
    L.phone ? `Phone: ${L.phone}` : '',
    L.capture ? `How captured: ${L.capture}` : '',
    L.wants ? `Looking for: ${L.wants}` : '',
    L.place ? `Area: ${L.place}` : '',
    L.budget ? `Budget: ${L.budget}` : '',
    Array.isArray(L.searches) && L.searches.length ? `Searched: ${L.searches.map((s) => `"${s}"`).join(', ')}` : '',
    typeof L.viewedCount === 'number' ? `Property pages viewed this session: ${L.viewedCount}` : '',
    typeof L.inventoryCount === 'number' ? `Live matching listings we have in their area: ${L.inventoryCount}` : '',
    L.notes ? `Notes: ${L.notes}` : '',
  ].filter(Boolean);
  return lines.join('\n');
}

export const leadBriefNow = onRequest(
  { region: REGION, timeoutSeconds: 60, memory: '512MiB', cors: false },
  async (req, res) => {
    try {
      if (req.method !== 'POST') {
        res.status(405).json({ error: 'POST only' });
        return;
      }
      if (!geminiConfigured()) {
        res.status(503).json({ error: 'gemini-not-configured' });
        return;
      }
      const rawBody = req.rawBody ? req.rawBody.toString('utf8') : JSON.stringify(req.body || {});
      const body = req.body || JSON.parse(rawBody || '{}');
      const orgId = String(body.orgId || '');
      const leadId = String(body.leadId || '').replace(/[^A-Za-z0-9_:-]/g, '').slice(0, 120);
      const briefKey = String(body.briefKey || leadId).replace(/[^A-Za-z0-9_:.-]/g, '').slice(0, 160);
      if (!orgId || !leadId) {
        res.status(400).json({ error: 'orgId and leadId required' });
        return;
      }

      const db = getFirestore();
      const secretSnap = await db.collection('orgSecrets').doc(orgId).get();
      const secret = secretSnap.exists ? secretSnap.data()?.sourcing?.secret : null;
      if (!verifyHmac(rawBody, req.get('x-bosun-signature'), req.get('x-bosun-timestamp'), secret)) {
        res.status(401).json({ error: 'invalid_signature' });
        return;
      }

      // Generate the brief.
      const out = await generateJson({
        model: GEMINI_FLASH,
        prompt: briefPrompt(body.lead),
        schema: BRIEF_SCHEMA,
        temperature: 0.4,
        maxOutputTokens: 700,
        thinkingBudget: 0,
      });
      if (!out || !out.summary) {
        res.status(502).json({ error: 'generation-failed' });
        return;
      }
      const brief = {
        summary: String(out.summary || '').slice(0, 600),
        actionItems: (Array.isArray(out.actionItems) ? out.actionItems : []).map((s) => String(s).slice(0, 200)).slice(0, 6),
        howToCapture: String(out.howToCapture || '').slice(0, 700),
        opener: String(out.opener || '').slice(0, 300),
      };

      // Settle — flat LEAD_BRIEF_PRICE_PAISE per generation, idempotent on briefKey (re-open = ₹0,
      // regenerate passes a fresh key and bills again). Same paise-accrual discipline as the other
      // lanes; a paused org is waived+logged, never charged.
      const logRef = db.collection(METER_LOG).doc(`${orgId}:lead_brief:${briefKey}`);
      let charged = 0;
      let alreadyBilled = false;
      await db.runTransaction(async (tx) => {
        const orgRef = db.collection('organisations').doc(orgId);
        const orgSnap = await tx.get(orgRef);
        if (!orgSnap.exists) return;
        if ((await tx.get(logRef)).exists) {
          alreadyBilled = true;
          return;
        }
        const org = orgSnap.data();
        if (isServicePaused(org, 'lead_brief')) {
          tx.set(logRef, {
            orgId, service: 'lead_brief', idempotencyKey: briefKey, leadId, qty: 1,
            pricePaise: LEAD_BRIEF_PRICE_PAISE, debitInr: 0, waived: true, waivedPaise: LEAD_BRIEF_PRICE_PAISE,
            createdAt: FieldValue.serverTimestamp(),
          });
          return;
        }
        const { debitInr, accrualPaise } = accrueComposeCharge(org.leadBriefAccrualPaise, LEAD_BRIEF_PRICE_PAISE);
        const update = { leadBriefAccrualPaise: accrualPaise };
        if (debitInr > 0) {
          update.balance = Number(org.balance ?? 0) - debitInr;
          tx.set(db.collection('transactions').doc(), {
            orgId, type: 'debit', kind: 'lead_brief', amount: debitInr, count: 1,
            description: `Lead call-brief (${leadId}, ₹${(LEAD_BRIEF_PRICE_PAISE / 100).toFixed(2)})`,
            createdAt: FieldValue.serverTimestamp(),
          });
        }
        tx.update(orgRef, update);
        tx.set(logRef, {
          orgId, service: 'lead_brief', idempotencyKey: briefKey, leadId, qty: 1,
          pricePaise: LEAD_BRIEF_PRICE_PAISE, debitInr, createdAt: FieldValue.serverTimestamp(),
        });
        charged = LEAD_BRIEF_PRICE_PAISE;
      });

      res.json({ ok: true, brief, billing: { pricePaise: LEAD_BRIEF_PRICE_PAISE, chargedPaise: charged, alreadyBilled } });
    } catch (e) {
      console.error('leadBriefNow:err', e?.message || e);
      res.status(500).json({ error: e?.message || String(e) });
    }
  },
);
