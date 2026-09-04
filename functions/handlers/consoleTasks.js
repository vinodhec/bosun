/**
 * Chat & code — the live-preview lane, Bosun side.
 *
 * The work happens on Bosun's console box (console/server.mjs on EC2): a git worktree of the org's
 * repo, `claude -p` per turn, a dev server whose HMR shows each edit in the customer's browser
 * within seconds, and `ship` = one squashed commit pushed + a PR. The box is behind a Cloudflare
 * quick tunnel whose hostname changes on every restart, so it phones home.
 *
 * This file is Bosun's whole side of that contract:
 *   openConsoleSession   (callable) — the customer asks for a session (fresh, or `branch` to resume
 *                        a parked / shipped one); we check org + balance, sign the request with
 *                        CONSOLE_SECRET and forward it to the box. Everything after that (turns, the
 *                        event feed, the preview iframe) goes browser → box directly with the
 *                        per-session token the box hands back.
 *   consoleHook          (HTTP) — the box reports in: `url` at boot, `minute` once per minute a
 *                        session is live (the meter: console_minute, ₹13/min = ₹780/hour, minute 1
 *                        at start), `turn`, `ship` (→ a `tasks` card so the change gets the same
 *                        Preview / Deploy to testing / Go live rail as a fix), `parked` (an idle
 *                        session pushed its branch so it can be resumed) and `ended`.
 *   listMyConsoleSessions (callable) — the org's PARKED sessions, for the panel's Resume list.
 *
 * Billing is TIME: the dev server holds the box for the whole session, turns or no turns. Each
 * minute is one settleMetered call keyed `${sid}:m${k}`, so a redelivered tick is a charged:0 no-op
 * and a session that dies with the box bills only the minutes it served. When the org cannot pay
 * the next minute the hook answers `stop:true` and the box ends the session.
 */
import { onCall, onRequest, HttpsError } from 'firebase-functions/v2/https';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { signPayload } from '../utils/sourcing.js';
import { verifyCustomerSignature, logReject } from '../utils/customerAuth.js';
import { resolveOrgId } from '../utils/orgs.js';
import { settleMetered } from '../utils/meter.js';
import { CONSOLE_MINUTE_PRICE_PAISE, priceForService } from '../shared/billing.js';

const REGION = 'asia-south1';
const SESSIONS = 'consoleSessions';
const CONFIG_DOC = 'config/console';   // where the box last said it lives
const SESSION_TIMEOUT_MS = 20_000;

const consoleSecret = () => process.env.CONSOLE_SECRET || '';

/** Where the box is right now — the env override (local dev) or its last report. */
async function readConsoleUrl(db) {
  const override = (process.env.CONSOLE_URL || '').replace(/\/$/, '');
  if (override) return override;
  const snap = await db.doc(CONFIG_DOC).get();
  return snap.exists ? String(snap.data().url || '').replace(/\/$/, '') : '';
}

/** Rupees the org must hold to open a session: one minute at its live price. */
function minuteInr(org) {
  return priceForService(org, 'console_minute', CONSOLE_MINUTE_PRICE_PAISE) / 100;
}

/** One task card per BRANCH: ships from a resumed session update the same card. */
const taskIdForBranch = (branch) => `console-${String(branch).replace(/^chat\//, '')}`;

export const openConsoleSession = onCall({ region: REGION }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Please sign in.');
  const secret = consoleSecret();
  if (!secret) throw new HttpsError('failed-precondition', 'CONSOLE_NOT_CONFIGURED');

  const db = getFirestore();
  const userSnap = await db.collection('users').doc(uid).get();
  const orgId = resolveOrgId(userSnap.exists ? userSnap.data() : null, request.data?.orgId);
  if (!orgId) throw new HttpsError('failed-precondition', 'NO_ORG');
  const orgSnap = await db.collection('organisations').doc(orgId).get();
  if (!orgSnap.exists) throw new HttpsError('failed-precondition', 'NO_ORG');
  const org = orgSnap.data();
  const repo = org.github?.repoFullName;
  if (!repo) throw new HttpsError('failed-precondition', 'NO_REPO_CONNECTED');
  const floor = minuteInr(org);
  if (Number(org.balance ?? 0) < floor) {
    throw new HttpsError('failed-precondition', 'INSUFFICIENT_BALANCE', { needInr: floor });
  }

  // Resume: the branch must be one of THIS org's parked or shipped sessions.
  const branch = String(request.data?.branch || '').trim();
  let priorSid = null;
  if (branch) {
    if (!/^chat\/[a-f0-9]{8}$/.test(branch)) throw new HttpsError('invalid-argument', 'BAD_BRANCH');
    const prior = await db.collection(SESSIONS).where('orgId', '==', orgId).where('branch', '==', branch).limit(5).get();
    const ok = prior.docs.find((d) => ['parked', 'shipped', 'ended'].includes(d.data().status));
    if (!ok) throw new HttpsError('permission-denied', 'NOT_YOUR_BRANCH');
    priorSid = ok.id;
  }

  const consoleUrl = await readConsoleUrl(db);
  if (!consoleUrl) throw new HttpsError('unavailable', 'CONSOLE_OFFLINE');

  const owner = request.auth.token?.email || uid;
  const body = JSON.stringify({ owner, orgId, repo, branch: branch || undefined, ts: Date.now() });
  const { signature, timestamp } = signPayload(secret, body);
  let res;
  try {
    res = await fetch(`${consoleUrl}/__console/api/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bosun-signature': signature, 'x-bosun-timestamp': timestamp },
      body,
      signal: AbortSignal.timeout(SESSION_TIMEOUT_MS),
    });
  } catch (err) {
    console.error('openConsoleSession:fetch', err?.message || err);
    throw new HttpsError('unavailable', 'CONSOLE_OFFLINE');
  }
  let data = {};
  try { data = await res.json(); } catch { /* handled by status below */ }

  if (res.status === 409) {
    throw new HttpsError('resource-exhausted', 'BUSY', {
      owner: data.owner ? String(data.owner) : null,
      since: Number(data.since) || 0,
      lastActivity: Number(data.lastActivity) || 0,
      turns: Number(data.turns) || 0,
    });
  }
  if (res.status === 403 && data.error === 'wrong_repo') throw new HttpsError('failed-precondition', 'WRONG_REPO');
  if (!res.ok || !data.sid || !data.token) {
    console.error('openConsoleSession:bad', res.status, JSON.stringify(data).slice(0, 300));
    throw new HttpsError('unavailable', 'CONSOLE_REFUSED');
  }

  const sid = String(data.sid);
  const rejoined = Boolean(data.rejoined);
  if (!rejoined) {
    await db.collection(SESSIONS).doc(sid).set({
      orgId, userId: uid, owner, repo, branch: String(data.branch || branch || ''), consoleUrl,
      status: 'live', turns: Number(data.turns) || 0, minutes: 0, costUsd: 0, prUrls: [],
      resumedFrom: priorSid, createdAt: Number(data.createdAt) || Date.now(), updatedAt: FieldValue.serverTimestamp(),
    });
    // The parked record is consumed: it must not show up as resumable twice.
    if (priorSid) await db.collection(SESSIONS).doc(priorSid).set({ status: 'resumed', resumedBy: sid, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  }
  return {
    consoleUrl,
    sid,
    token: String(data.token),
    previewUrl: `${consoleUrl}${String(data.previewPath || '')}`,
    branch: String(data.branch || branch || ''),
    createdAt: Number(data.createdAt) || Date.now(),
    rejoined,
    resumed: Boolean(data.resumed),
    owner: data.owner ? String(data.owner) : owner,
    turns: Number(data.turns) || 0,
    started: Boolean(data.started),
    minuteInr: floor,
  };
});

export const consoleHook = onRequest({ region: REGION, cors: false }, async (req, res) => {
  if (req.method !== 'POST') {
    logReject('consoleHook', { status: 405, reason: 'non-POST-method', extra: { method: req.method } });
    res.status(405).json({ error: 'POST only' });
    return;
  }
  const raw = req.rawBody ? req.rawBody.toString('utf8') : '';
  const auth = verifyCustomerSignature(raw, req.get('x-bosun-signature'), req.get('x-bosun-timestamp'), consoleSecret());
  if (!auth.ok) {
    logReject('consoleHook', { status: 401, reason: auth.reason, extra: { skewMs: auth.skewMs } });
    res.status(401).json({ error: 'unauthorized' });
    return;
  }
  let body;
  try { body = JSON.parse(raw || '{}'); } catch {
    logReject('consoleHook', { status: 400, reason: 'body-not-valid-json' });
    res.status(400).json({ error: 'invalid JSON' });
    return;
  }

  const db = getFirestore();
  const type = String(body.type || '');
  const sid = String(body.sid || '');
  const sessionRef = sid ? db.collection(SESSIONS).doc(sid) : null;

  if (type === 'url') {
    const url = String(body.url || '').replace(/\/$/, '');
    if (!/^https?:\/\/[^\s/]+$/.test(url)) { res.status(400).json({ error: 'invalid url' }); return; }
    await db.doc(CONFIG_DOC).set({
      url, bootedAt: Number(body.bootedAt) || null, host: body.host ? String(body.host).slice(0, 80) : null,
      repo: body.repo ? String(body.repo).slice(0, 120) : null, receivedAt: Date.now(),
    }, { merge: true });
    console.log('consoleHook:url', url);
    res.json({ ok: true, url });
    return;
  }

  if (!sessionRef) { res.status(400).json({ error: 'sid required' }); return; }
  const orgId = String(body.orgId || '');

  if (type === 'minute') {
    // Minute k of session `sid`. Idempotent per (org, sid, k): the box retries a tick that was
    // not acked, and a replay settles nothing.
    const k = Math.max(1, Math.floor(Number(body.minute) || 0));
    if (!orgId || !k) { res.status(400).json({ error: 'orgId and minute required' }); return; }
    const out = await settleMetered({
      orgId, service: 'console_minute', idempotencyKey: `${sid}:m${k}`,
      description: `Chat & code session minute ${k}`,
      extra: { sid, minute: k },
    });
    await sessionRef.set({ minutes: k, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    // Can the org pay the NEXT minute? If not, the box ends the session on this answer.
    const orgSnap = await db.collection('organisations').doc(orgId).get();
    const org = orgSnap.exists ? orgSnap.data() : null;
    const stop = !org || Number(org.balance ?? 0) < minuteInr(org);
    if (stop) await sessionRef.set({ status: 'stopped', stopReason: 'balance', updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    res.json({ ok: true, charged: out.charged, duplicate: out.duplicate, stop, reason: stop ? 'balance' : null });
    return;
  }

  if (type === 'turn') {
    const n = Math.max(0, Math.floor(Number(body.n) || 0));
    await sessionRef.set({
      turns: n, costUsd: FieldValue.increment(Number(body.costUsd) || 0),
      lastPrompt: String(body.prompt || '').slice(0, 120),
      lastTurnAt: Date.now(), updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    await sessionRef.collection('turns').doc(String(n)).set({
      n, prompt: String(body.prompt || '').slice(0, 200), sha: String(body.sha || ''), stat: String(body.stat || '').slice(0, 120),
      costUsd: Number(body.costUsd) || 0, ms: Number(body.ms) || 0, err: Boolean(body.err), at: Number(body.at) || Date.now(),
    }, { merge: true });
    res.json({ ok: true });
    return;
  }

  if (type === 'ship') {
    // The shipped change becomes a card in "Fix something" with the ordinary rail: Preview
    // (Vercel PR preview, found by pollSessions via needsPreview), Deploy to testing (merge to
    // main), Go live. One card per branch; a later ship from a resumed session updates it.
    const prUrl = String(body.prUrl || '');
    const snap = await sessionRef.get();
    const sess = snap.exists ? snap.data() : {};
    const branch = String(body.branch || sess.branch || '');
    await sessionRef.set({
      prUrls: FieldValue.arrayUnion(prUrl), lastShipAt: Date.now(), status: 'shipped', shippedTitle: String(body.title || '').slice(0, 120),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    if (branch && (orgId || sess.orgId) && prUrl) {
      const taskRef = db.collection('tasks').doc(taskIdForBranch(branch));
      const existing = await taskRef.get();
      const title = String(body.title || sess.lastPrompt || 'Change made in Chat & code').slice(0, 200);
      const turns = Number(body.turns) || 0;
      await taskRef.set({
        orgId: orgId || sess.orgId,
        userId: sess.userId || null,
        repoFullName: sess.repo || null,
        kind: 'console',
        source: 'console',
        consoleSid: sid,
        branch,
        prompt: title,
        status: 'complete',
        approved: true,          // the owner watched it in the live preview and pressed Ship
        billed: true,            // time was metered per minute; the card itself charges nothing
        finalCharge: 0,
        prUrl,
        needsPreview: true,      // pollSessions fills previewUrl from the PR's Vercel deployment
        previewTries: 0,
        resultSummary: `Made live in Chat & code (${turns} turn${turns === 1 ? '' : 's'}), shipped as a pull request. Preview it, then deploy to testing or go live.`,
        filesChanged: [],
        shippedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
        ...(existing.exists ? {} : { createdAt: FieldValue.serverTimestamp() }),
      }, { merge: true });
    }
    res.json({ ok: true });
    return;
  }

  if (type === 'parked') {
    // Idle / max-age end with unsent turns: the box pushed the branch. Listed for Resume.
    await sessionRef.set({
      status: 'parked', branch: String(body.branch || ''), turns: Number(body.turns) || 0,
      title: String(body.title || '').slice(0, 120), lastPrompt: String(body.lastPrompt || '').slice(0, 120),
      parkReason: String(body.reason || '').slice(0, 40), parkedAt: Date.now(), updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    res.json({ ok: true });
    return;
  }

  if (type === 'ended') {
    const snap = await sessionRef.get();
    const cur = snap.exists ? snap.data().status : null;
    // `parked` arrives just before `ended` and must win; a shipped session stays `shipped`.
    const keep = cur === 'parked' || (cur === 'shipped' && !body.parked);
    await sessionRef.set({
      ...(keep ? {} : { status: 'ended' }),
      endReason: String(body.reason || '').slice(0, 80), endedAt: Date.now(), updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    res.json({ ok: true });
    return;
  }

  res.status(400).json({ error: 'unknown type' });
});

/** The org's parked sessions — unsent work an idle timeout put aside, resumable from the panel. */
export const listMyConsoleSessions = onCall({ region: REGION }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Please sign in.');
  const db = getFirestore();
  const userSnap = await db.collection('users').doc(uid).get();
  const orgId = resolveOrgId(userSnap.exists ? userSnap.data() : null, request.data?.orgId);
  if (!orgId) return { sessions: [] };
  // Equality filters only (no composite index); sorted here — an org parks a handful, not thousands.
  const snap = await db.collection(SESSIONS).where('orgId', '==', orgId).where('status', '==', 'parked').limit(50).get();
  const sessions = snap.docs
    .map((d) => {
      const s = d.data();
      return {
        id: d.id, owner: s.owner || null, branch: s.branch || '', title: s.title || s.lastPrompt || '',
        turns: s.turns || 0, minutes: s.minutes || 0, parkedAt: s.parkedAt || 0, createdAt: s.createdAt || 0,
      };
    })
    .filter((s) => s.branch)
    .sort((a, b) => b.parkedAt - a.parkedAt)
    .slice(0, 20);
  return { sessions };
});
