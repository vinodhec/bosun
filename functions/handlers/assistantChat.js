/**
 * POST /assistantChat — the website assistant's turn endpoint (customer→Bosun, HMAC-signed).
 *
 * The customer's platform mounts a chat widget on its public site and proxies every message here.
 * Bosun runs the brain (utils/assistant.js): it decides whether the message needs a TOOL (search,
 * enquiry, requirement, draft listing, my-listings, my-leads, my-plan) and hands the call back to the
 * platform, which executes it against its own data as the real signed-in user and posts the result;
 * when the model has what it needs it writes the reply, Bosun turns the `[[show:…]]` marker into
 * listing cards from the cached tool results, and meters ONE `assistant_message` for the delivered
 * reply. Tool hops within a message are not units; a degraded (fallback) reply is free.
 *
 * Three actions, one endpoint, same HMAC (the org's relay secret from the vault — the scheme every
 * customer→Bosun call uses, see utils/customerAuth.js):
 *
 *   action:'message'       { orgId, conversationId?, clientMessageId?, message, context }
 *                          → { kind:'reply', reply:{text,cards,suggestions}, charged, turn }
 *                          | { kind:'tool_calls', calls:[{id,name,args}], turn }
 *   action:'tool_results'  { orgId, conversationId, results:[{id,name,result}|{id,name,error}] }
 *                          → same two shapes
 *   action:'history'       { orgId, conversationId } → { transcript:[…] }
 *
 * `context` = { site:{name,cities[]}, user:{id,role,name,phone}|null, page:{path,propertyId},
 *               locale:'en'|'ta', capabilities:[tool names the platform implements] }. The platform
 * sends it on EVERY call (it always has it); Bosun stores only the non-secret parts on the doc.
 *
 * Guards, in order: HMAC → org enabled → wallet (a NEGATIVE balance stops this lane, because a public
 * widget is unbounded demand on the org's wallet; the operator waives it with `assistant_message` or
 * `agent_work` in billingPaused) → per-org daily cap → per-conversation daily cap. The platform is
 * expected to rate-limit per visitor in front of this — these are the backstops, not the policy.
 *
 * Idempotent per (conversation, clientMessageId): a retried delivery of the same message returns the
 * stored reply and the meter's own (conversation, turn) key makes the debit a charged:0 no-op.
 */
import { onRequest } from 'firebase-functions/v2/https';
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';
import { verifyCustomerSignature, logReject } from '../utils/customerAuth.js';
import { settleMetered } from '../utils/meter.js';
import { blocksNewWork, isServicePaused } from '../shared/billing.js';
import {
  MAX_TOOL_HOPS,
  toolsFor,
  buildSystemInstruction,
  modelStep,
  parseReply,
  listingsFromToolResult,
  rememberListings,
  cardsFor,
  scrubIds,
  toolResultsContent,
  trimHistory,
  degradedReply,
} from '../utils/assistant.js';

const REGION = 'asia-south1';
export const CONVERSATIONS = 'assistantConversations';
const USAGE = 'assistantUsage';

/** Retention for transcripts — set the TTL policy once:
 *    gcloud firestore fields ttls update expiresAt --collection-group=assistantConversations --enable-ttl */
export const TTL_DAYS = 30;
/** Replies per org per IST day before the lane refuses (the operator lifts it on the org doc). */
export const DEFAULT_ORG_DAILY_CAP = 3000;
/** Replies per conversation per IST day — a stuck script, not a person. */
export const DEFAULT_CONVERSATION_DAILY_CAP = 60;
/** Transcript rows kept on the doc (user + assistant, what the widget re-renders on reload). */
const MAX_TRANSCRIPT = 80;
/** Longest user message we accept — anything past this is not a property question. */
const MAX_MESSAGE_CHARS = 1500;

function istDayKey(nowMs = Date.now()) {
  return new Date(nowMs + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
}

function convDocId(orgId, conversationId) {
  return `${orgId}__${conversationId}`;
}

/** The non-secret slice of the platform's context we keep on the doc. Phone never lands here. */
function storableContext(ctx) {
  const c = ctx && typeof ctx === 'object' ? ctx : {};
  const u = c.user && typeof c.user === 'object' && c.user.id ? c.user : null;
  return {
    site: {
      name: String(c.site?.name || '').slice(0, 80),
      cities: Array.isArray(c.site?.cities) ? c.site.cities.slice(0, 20).map((x) => String(x).slice(0, 40)) : [],
    },
    user: u ? { id: String(u.id).slice(0, 128), role: String(u.role || 'user').slice(0, 24), name: String(u.name || '').slice(0, 60) } : null,
    page: { path: String(c.page?.path || '').slice(0, 160), propertyId: String(c.page?.propertyId || '').slice(0, 80) },
    locale: c.locale === 'ta' ? 'ta' : 'en',
    capabilities: Array.isArray(c.capabilities) ? c.capabilities.slice(0, 20).map(String) : [],
  };
}

/** Merge the request's context over the stored one — the request wins where it says anything. */
function liveContext(stored, incoming) {
  const s = stored || storableContext({});
  const i = incoming && typeof incoming === 'object' ? incoming : {};
  const merged = storableContext({
    site: i.site || s.site,
    user: i.user !== undefined ? i.user : s.user,
    page: i.page || s.page,
    locale: i.locale || s.locale,
    capabilities: Array.isArray(i.capabilities) && i.capabilities.length ? i.capabilities : s.capabilities,
  });
  // The phone rides only in memory for this request's system instruction.
  const phone = i.user && typeof i.user === 'object' && i.user.id ? String(i.user.phone || '').slice(0, 16) : '';
  return { ...merged, user: merged.user ? { ...merged.user, phone } : null };
}

function ok(res, payload) {
  res.status(200).json({ ok: true, ...payload });
}

export const assistantChat = onRequest(
  { region: REGION, timeoutSeconds: 60, memory: '512MiB', cors: false },
  async (req, res) => {
    if (req.method !== 'POST') {
      logReject('assistantChat', { status: 405, reason: 'non-POST-method', extra: { method: req.method } });
      res.status(405).json({ error: 'POST only' });
      return;
    }
    const raw = req.rawBody ? req.rawBody.toString('utf8') : '';
    let body;
    try {
      body = JSON.parse(raw || '{}');
    } catch {
      logReject('assistantChat', { status: 400, reason: 'body-not-valid-json', extra: { bytes: raw.length } });
      res.status(400).json({ error: 'invalid JSON' });
      return;
    }

    const orgId = String(body.orgId || '');
    const action = ['message', 'tool_results', 'history'].includes(body.action) ? body.action : '';
    const conversationId = String(body.conversationId || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
    if (!orgId || !action) {
      logReject('assistantChat', { orgId, status: 400, reason: 'missing-required-field', extra: { hasOrgId: !!orgId, action: body.action } });
      res.status(400).json({ error: 'orgId and a valid action are required' });
      return;
    }

    const db = getFirestore();
    const secretSnap = await db.collection('orgSecrets').doc(orgId).get();
    const secret = secretSnap.exists ? secretSnap.data()?.sourcing?.secret : null;
    if (!secret) {
      logReject('assistantChat', { orgId, status: 403, reason: 'org-has-no-sourcing-secret', extra: {} });
      res.status(403).json({ error: 'assistant not configured for this org' });
      return;
    }
    const auth = verifyCustomerSignature(raw, req.get('x-bosun-signature'), req.get('x-bosun-timestamp'), secret);
    if (!auth.ok) {
      logReject('assistantChat', { orgId, status: 401, reason: auth.reason, extra: { skewMs: auth.skewMs ?? null, bytes: raw.length } });
      res.status(401).json({ error: 'bad signature' });
      return;
    }

    try {
      if (action === 'history') {
        if (!conversationId) { res.status(400).json({ error: 'conversationId required' }); return; }
        const snap = await db.collection(CONVERSATIONS).doc(convDocId(orgId, conversationId)).get();
        const d = snap.exists ? snap.data() : null;
        ok(res, { conversationId, transcript: d ? (d.transcript || []).slice(-MAX_TRANSCRIPT) : [], turn: d?.turn || 0 });
        return;
      }

      // ── Org-level gates (message + tool_results alike) ──────────────────────────────────────
      const orgSnap = await db.collection('organisations').doc(orgId).get();
      if (!orgSnap.exists) { res.status(403).json({ error: 'unknown org' }); return; }
      const org = orgSnap.data();
      if (org.assistant?.enabled === false) {
        logReject('assistantChat', { orgId, status: 403, reason: 'assistant-disabled-for-org' });
        res.status(403).json({ error: 'ASSISTANT_DISABLED' });
        return;
      }
      const waived = isServicePaused(org, 'assistant_message') || isServicePaused(org, 'agent_work');
      if (!waived && blocksNewWork(org.balance)) {
        logReject('assistantChat', { orgId, status: 402, reason: 'negative-balance', extra: { balance: org.balance ?? null } });
        res.status(402).json({ error: 'LOW_BALANCE' });
        return;
      }
      const dayKey = istDayKey();
      const orgCap = Number(org.assistant?.dailyCap) > 0 ? Number(org.assistant.dailyCap) : DEFAULT_ORG_DAILY_CAP;
      const usageRef = db.collection(USAGE).doc(`${orgId}:${dayKey}`);
      const usageSnap = await usageRef.get();
      const usedToday = usageSnap.exists ? Number(usageSnap.data().replies) || 0 : 0;
      if (usedToday >= orgCap) {
        logReject('assistantChat', { orgId, status: 429, reason: 'org-daily-cap', extra: { usedToday, orgCap } });
        res.status(429).json({ error: 'DAILY_CAP' });
        return;
      }

      const convRef = db.collection(CONVERSATIONS).doc(convDocId(orgId, conversationId || db.collection(CONVERSATIONS).doc().id));
      const convId = convRef.id.slice(orgId.length + 2);
      const convSnap = await convRef.get();
      const conv = convSnap.exists ? convSnap.data() : null;
      const ctx = liveContext(conv?.context, body.context);
      const convCap = Number(org.assistant?.conversationDailyCap) > 0 ? Number(org.assistant.conversationDailyCap) : DEFAULT_CONVERSATION_DAILY_CAP;

      let contents = Array.isArray(conv?.contents) ? conv.contents : [];
      let remembered = Array.isArray(conv?.remembered) ? conv.remembered : [];
      let transcript = Array.isArray(conv?.transcript) ? conv.transcript : [];
      let turn = Number(conv?.turn) || 0;
      let hop = 0;
      let pending = conv?.pending || null;
      const turnEvents = conv?.turnEvents && Number(conv.turnEvents.turn) === turn ? conv.turnEvents : { turn, tools: [] };

      if (action === 'message') {
        const message = String(body.message || '').trim().slice(0, MAX_MESSAGE_CHARS);
        const clientMessageId = String(body.clientMessageId || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
        if (!message) { res.status(400).json({ error: 'message required' }); return; }

        // Retried delivery of a message we already answered → the same answer, no work, no charge.
        if (clientMessageId && conv?.lastClientMessageId === clientMessageId && conv?.lastReply) {
          ok(res, { kind: 'reply', conversationId: convId, turn, reply: conv.lastReply, charged: 0, duplicate: true });
          return;
        }
        const convDayTurns = conv?.dayKey === dayKey ? Number(conv.dayTurns) || 0 : 0;
        if (convDayTurns >= convCap) {
          logReject('assistantChat', { orgId, status: 429, reason: 'conversation-daily-cap', extra: { conversationId: convId, convDayTurns } });
          res.status(429).json({ error: 'CONVERSATION_CAP' });
          return;
        }

        // A message arriving while tool calls are outstanding abandons those calls — the visitor
        // moved on; Gemini must not see a dangling functionCall, so the pending model turn is dropped.
        if (pending?.calls?.length) contents = contents.slice(0, pending.contentIndex);

        turn += 1;
        hop = 0;
        pending = null;
        contents = trimHistory([...contents, { role: 'user', parts: [{ text: message }] }]);
        transcript = [...transcript, { role: 'user', text: message, at: Date.now() }].slice(-MAX_TRANSCRIPT);
        turnEvents.turn = turn;
        turnEvents.tools = [];

        await convRef.set({
          orgId, conversationId: convId, context: (({ user, ...rest }) => ({ ...rest, user: user ? { id: user.id, role: user.role, name: user.name } : null }))(ctx),
          contents, transcript, remembered, turn, hop, pending: null, turnEvents,
          lastClientMessageId: clientMessageId || null, lastReply: null,
          dayKey, dayTurns: (conv?.dayKey === dayKey ? Number(conv.dayTurns) || 0 : 0) + 1,
          createdAt: conv?.createdAt || FieldValue.serverTimestamp(),
          lastAt: FieldValue.serverTimestamp(),
          expiresAt: Timestamp.fromMillis(Date.now() + TTL_DAYS * 24 * 3600 * 1000),
        }, { merge: true });
      } else {
        // tool_results
        if (!conv) { res.status(404).json({ error: 'unknown conversation' }); return; }
        if (!pending?.calls?.length) {
          res.status(409).json({ error: 'NO_PENDING_CALLS' });
          return;
        }
        hop = Number(conv.hop) || 0;
        const results = Array.isArray(body.results) ? body.results : [];
        for (const r of results) {
          const call = pending.calls.find((c) => c.id === String(r?.id));
          if (!call) continue;
          const succeeded = r.result && typeof r.result === 'object' && r.result.ok !== false && !r.error;
          turnEvents.tools.push({ name: call.name, ok: !!succeeded });
          if (succeeded) remembered = rememberListings(remembered, listingsFromToolResult(call.name, r.result));
        }
        contents = [...contents, toolResultsContent(pending.calls, results)];
        pending = null;
      }

      // ── The model step ──────────────────────────────────────────────────────────────────────
      const signedIn = !!ctx.user?.id;
      const forceAnswer = hop >= MAX_TOOL_HOPS;
      const tools = forceAnswer ? [] : toolsFor({ capabilities: ctx.capabilities, signedIn });
      const systemInstruction = buildSystemInstruction({ site: ctx.site, user: ctx.user || {}, page: ctx.page, locale: ctx.locale });
      const step = await modelStep({ contents, systemInstruction, tools });

      if (!step) {
        // Model unavailable: a free, honest fallback. The user turn stays in history so a retry
        // of the next message still has the context; nothing is metered.
        const reply = { text: degradedReply(ctx.locale), cards: [], suggestions: [] };
        transcript = [...transcript, { role: 'assistant', text: reply.text, degraded: true, at: Date.now() }].slice(-MAX_TRANSCRIPT);
        await convRef.set({ contents, transcript, remembered, pending: null, hop: 0, lastReply: reply, lastAt: FieldValue.serverTimestamp() }, { merge: true });
        console.warn('assistantChat:degraded', orgId, JSON.stringify({ conversationId: convId, turn, hop }));
        ok(res, { kind: 'reply', conversationId: convId, turn, reply, charged: 0, degraded: true });
        return;
      }

      contents = [...contents, step.content];

      if (step.kind === 'tool_calls') {
        const calls = step.calls.map((c) => ({ id: c.id, name: c.name, args: c.args }));
        pending = { calls, contentIndex: contents.length - 1, turn };
        await convRef.set({ contents, remembered, pending, hop: hop + 1, turnEvents, lastAt: FieldValue.serverTimestamp() }, { merge: true });
        console.log('assistantChat:tool_calls', orgId, JSON.stringify({ conversationId: convId, turn, hop: hop + 1, tools: calls.map((c) => c.name), usage: step.usage }));
        ok(res, { kind: 'tool_calls', conversationId: convId, turn, calls });
        return;
      }

      // ── A delivered reply: cards from cached tool results, then meter ONE unit ─────────────
      const parsed = parseReply(step.text);
      let cards = cardsFor(parsed.showIds, remembered);
      if (!cards.length) {
        // Flash sometimes narrates a search instead of marking it — if this turn searched and got
        // rows, show the top few rather than a wall of text with nothing to tap.
        const searched = turnEvents.tools.some((t) => t.name === 'search_properties' && t.ok);
        if (searched && !parsed.text.trim().endsWith('?')) {
          cards = remembered.filter((l) => l.fromTool === 'search_properties').slice(-4).map(({ fromTool, ...c }) => c);
        }
      }
      const reply = {
        text: scrubIds(parsed.text, remembered) || degradedReply(ctx.locale),
        cards,
        suggestions: parsed.suggestions.map((s) => scrubIds(s, remembered).slice(0, 48)),
      };
      const events = turnEvents.tools.filter((t) => t.ok).map((t) => t.name);

      transcript = [...transcript, { role: 'assistant', text: reply.text, cards, suggestions: reply.suggestions, at: Date.now() }].slice(-MAX_TRANSCRIPT);

      let charged = 0;
      let waivedNow = false;
      try {
        const settled = await settleMetered({
          db, orgId, service: 'assistant_message',
          idempotencyKey: `${convId}:${turn}`,
          description: `Website assistant reply (${convId.slice(0, 8)}…#${turn})`,
          extra: { conversationId: convId, turn, tools: events, signedIn, locale: ctx.locale },
        });
        charged = settled.charged;
        waivedNow = settled.waived;
      } catch (e) {
        // The reply is already written; a billing hiccup must not turn into a blank widget. Loud.
        console.error('assistantChat:bill:err', orgId, convId, turn, e?.message || e);
      }

      await Promise.all([
        convRef.set({
          contents: trimHistory(contents), transcript, remembered, pending: null, hop: 0, turnEvents,
          lastReply: reply, lastAt: FieldValue.serverTimestamp(),
          stats: {
            replies: FieldValue.increment(1),
            searches: FieldValue.increment(events.filter((n) => n === 'search_properties').length),
            enquiries: FieldValue.increment(events.filter((n) => n === 'create_enquiry').length),
            requirements: FieldValue.increment(events.filter((n) => n === 'request_property').length),
            drafts: FieldValue.increment(events.filter((n) => n === 'draft_listing').length),
          },
        }, { merge: true }),
        usageRef.set({ orgId, dayKey, replies: FieldValue.increment(1), updatedAt: FieldValue.serverTimestamp() }, { merge: true }),
      ]);

      console.log('assistantChat:reply', orgId, JSON.stringify({ conversationId: convId, turn, hop, cards: cards.length, events, charged, waived: waivedNow, usage: step.usage }));
      ok(res, { kind: 'reply', conversationId: convId, turn, reply, events, charged });
    } catch (e) {
      console.error('assistantChat:err', orgId, action, e?.message || e);
      res.status(500).json({ error: 'assistant failed — retry' });
    }
  },
);
