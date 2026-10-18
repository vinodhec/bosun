/**
 * Buyer background checks — the endpoint, the two daily batches, the daily Telegram status and the
 * operator callables. The judgement itself lives in utils/buyerCheck.js (pure, testable); this file
 * owns Firestore, the platform round-trips, scheduling and the money.
 *
 * RECORDS. `buyerChecks/{orgId__buyerKey}` is one buyer's current state (verdict, score, badge,
 * watch, override, next due); its `timeline` subcollection is every event with its evidence — the
 * same timeline the platform shows in the buyer bank. `buyerCheckRuns/{id}` is one batch's forensics
 * (what was searched, which model, tokens, COGS; 90-day TTL). `buyerCheckDays/{orgId}:{dateKey}` is
 * the day's counters for the Telegram digest — incremented as things happen, so the report is a
 * single read and needs no composite index.
 *
 * ENDPOINT (customer→Bosun, HMAC with the org's relay secret, `body.action`):
 *   enqueue      { buyerId|userId|phone, name, city, locality, source, sourceRef, profileUrl, author, snapshot, activityAtMs, force? }
 *   behaviour    { buyerKey|buyerId|userId|phone, snapshot, event:{type,text}? }   — may put the buyer back on the batch
 *   override     { buyerKey, verdict, by, byName, reason }                          — recorded, acted on at once, reviewed in 14 days
 *   staffOutcome { buyerKey, outcome:'buyer'|'agent'|'no_answer', by, byName, note } — a call's result; evidence for ever after
 *   history      { buyerKey }                                                      — record + timeline
 *   status       { buyerKey }   ·   list { status?, verdict?, limit? }
 *
 * BATCHES. `runBuyerChecks` at 10:00 and 22:00 IST takes, per org with `buyerCheck.enabled`, the due
 * records in this order — override reviews, manual "check again", new, behaviour trips, badge
 * renewals, watch expiries, backfill — newest activity first, capped at `buyerCheck.maxPerBatch`
 * (owner: 5). Each check: gather evidence → judge (Sonnet; Opus if torn) → settle exactly one line or
 * none → write the timeline → POST the verdict, evidence, events and any tasks to the platform's
 * `buyerCheck.verdictUrl`. A failed delivery is retried at the next batch; the charge never repeats
 * (idempotent on `${buyerKey}:${checkNo}`).
 *
 * MONEY RULES (shared/billing.js "Buyer background check"): ₹12 on a verdict with evidence, ₹36 when
 * Opus re-judged — one of the two, never both; `unclear`, the override review, watch and staff
 * outcomes are free. Waived by `buyer_check` / `agent_work` in billingPaused.
 *
 * TELEGRAM. `buyerCheckDailyReport` at 22:30 IST (after the evening batch) posts the day's numbers to
 * `buyerCheck.telegram.chatId` with the bot token from the vault (`orgSecrets/{orgId}.buyerCheck
 * .telegramBotToken`). Temporary by the founder's own words ("just for a few days") — one flag.
 */
import { onRequest, onCall, HttpsError } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { getFirestore, FieldValue, Timestamp } from 'firebase-admin/firestore';
import { verifyCustomerSignature, logReject } from '../utils/customerAuth.js';
import { settleMetered } from '../utils/meter.js';
import { requireAdmin } from '../utils/admin.js';
import { signPayload, callSerpActor } from '../utils/sourcing.js';
import { APIFY_TOKEN, ANTHROPIC_API_KEY } from '../utils/secrets.js';
import { isServicePaused, blocksNewWork } from '../shared/billing.js';
import {
  VERDICTS, DUE_REASONS, DEFAULTS, buyerKeyFor, recordId, newRecord, cleanSnapshot, behaviourTrips,
  quietBuyerOnBehaviour, labelFor, gatherEvidence, judge, serviceFor, event, verdictText, callQuestions,
} from '../utils/buyerCheck.js';

const REGION = 'asia-south1';
export const RECORDS = 'buyerChecks';
export const TIMELINE = 'timeline';
export const RUNS = 'buyerCheckRuns';
export const DAYS = 'buyerCheckDays';
/** Run docs expire — set the TTL once:
 *    gcloud firestore fields ttls update expiresAt --collection-group=buyerCheckRuns --enable-ttl */
export const TTL_DAYS = 90;
const IST_MS = 5.5 * 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;
const PLATFORM_TIMEOUT_MS = 30000;
const APIFY_BASE = 'https://api.apify.com/v2';
const DEFAULT_SERP_ACTOR = 'apify~google-search-scraper';
/** A record claimed by a batch this recently is skipped by a concurrent manual run. */
const CLAIM_MS = 20 * 60 * 1000;

function istDateKey(nowMs = Date.now()) {
  return new Date(nowMs + IST_MS).toISOString().slice(0, 10).replace(/-/g, '');
}
function istDayStartMs(nowMs = Date.now()) {
  const d = new Date(nowMs + IST_MS);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - IST_MS;
}
function s(v, max) {
  return String(v ?? '').trim().slice(0, max);
}
function cfgOf(org) {
  return org?.buyerCheck && typeof org.buyerCheck === 'object' ? org.buyerCheck : {};
}
function numOr(v, d) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : d;
}

// ── Records ────────────────────────────────────────────────────────────────────────────────────────

/** What the platform (and the operator panel) may see of a record. Evidence lives on the timeline. */
export function publicRecord(rec) {
  if (!rec) return null;
  return {
    buyerKey: rec.buyerKey, buyerId: rec.buyerId, userId: rec.userId, phone: rec.phone, name: rec.name,
    city: rec.city, locality: rec.locality, source: rec.source, sourceRef: rec.sourceRef || null,
    status: rec.status, dueReason: rec.dueReason || null,
    verdict: rec.verdict, label: rec.verdict ? labelFor(rec.verdict) : null,
    modelVerdict: rec.modelVerdict || null, agentScore: rec.agentScore, confidence: rec.confidence, summary: rec.summary,
    checkCount: rec.checkCount || 0, checkedAtMs: rec.checkedAtMs || null, nextDueMs: rec.nextDueMs || null,
    badge: rec.badge === true, agent: rec.agent === true,
    override: rec.override || null, staffOutcomes: rec.staffOutcomes || [],
    deliveryPending: rec.deliveryPending === true, activityAtMs: rec.activityAtMs || null,
    createdAtMs: rec.createdAtMs || null, updatedAtMs: rec.updatedAtMs || null,
  };
}

async function appendEvents(db, recRef, events) {
  const batch = db.batch();
  for (const e of events) batch.set(recRef.collection(TIMELINE).doc(e.id), e);
  await batch.commit();
}

async function bumpDay(db, orgId, counters, nowMs = Date.now()) {
  const inc = {};
  for (const [k, v] of Object.entries(counters)) if (v) inc[k] = FieldValue.increment(v);
  if (!Object.keys(inc).length) return;
  const dateKey = istDateKey(nowMs);
  await db.collection(DAYS).doc(`${orgId}:${dateKey}`).set({ orgId, dateKey, ...inc, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
}

/** The effective verdict: a staff call or an admin override wins over the model until the next check. */
function effective(rec) {
  const staff = (rec.staffOutcomes || []).slice(-1)[0];
  if (rec.override?.verdict && (!staff || staff.atMs < rec.override.atMs)) return rec.override.verdict;
  if (staff && ['buyer', 'agent'].includes(staff.outcome) && (!rec.checkedAtMs || staff.atMs > rec.checkedAtMs)) return staff.outcome;
  return rec.modelVerdict || rec.verdict || null;
}

// ── Platform round-trips ───────────────────────────────────────────────────────────────────────────

async function loadOrg(db, orgId) {
  const [orgSnap, secretSnap] = await Promise.all([
    db.collection('organisations').doc(orgId).get(),
    db.collection('orgSecrets').doc(orgId).get(),
  ]);
  return { org: orgSnap.exists ? orgSnap.data() : null, secrets: secretSnap.exists ? secretSnap.data() : null };
}

async function postSigned(url, secret, payload, timeoutMs = PLATFORM_TIMEOUT_MS) {
  const body = JSON.stringify(payload);
  const { signature, timestamp } = signPayload(secret, body);
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-bosun-signature': signature, 'x-bosun-timestamp': timestamp },
    body,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const ack = await resp.json().catch(() => null);
  return { ok: resp.ok, status: resp.status, ack };
}

/** GET the platform's behaviour snapshot for one buyer — signed `${ts}.buyer-snapshot` like work-state. */
async function fetchSnapshotFromPlatform({ cfg, secret, rec }) {
  if (!cfg.snapshotUrl || !secret) return null;
  const { signature, timestamp } = signPayload(secret, 'buyer-snapshot');
  const u = new URL(cfg.snapshotUrl);
  if (rec.buyerId) u.searchParams.set('buyerId', rec.buyerId);
  if (rec.userId) u.searchParams.set('userId', rec.userId);
  if (rec.phone) u.searchParams.set('phone', rec.phone);
  const resp = await fetch(u, { headers: { 'x-bosun-signature': signature, 'x-bosun-timestamp': timestamp }, signal: AbortSignal.timeout(20000) });
  if (!resp.ok) throw new Error(`snapshot http ${resp.status}`);
  const body = await resp.json().catch(() => null);
  return body?.snapshot && typeof body.snapshot === 'object' ? body.snapshot : null;
}

/** Our own records on this buyer: seller phones we relayed, other buyer records, poster sightings. */
async function lookupHistory(db, orgId, rec) {
  const out = { phoneChecked: false, sellerPostsRelayed: 0, sellerFirstAt: null, sellerLastAt: null, sellerSampleUrl: null, otherBuyerRecords: 0, posterPosts: 0, posterWanted: 0, posterAvailable: 0 };
  const seen = db.collection('sourcingSeen').doc(orgId).collection('keys');
  if (rec.phone) {
    out.phoneChecked = true;
    const forms = [`+91${rec.phone}`, rec.phone, `91${rec.phone}`, `0${rec.phone}`];
    const snap = await seen.where('phone', 'in', forms).limit(50).get();
    for (const d of snap.docs) {
      const x = d.data();
      if (!x.owner) continue;
      out.sellerPostsRelayed += 1;
      const at = x.relayedAt?.toMillis?.() || null;
      if (at && (!out.sellerFirstAt || at < out.sellerFirstAt)) out.sellerFirstAt = at;
      if (at && (!out.sellerLastAt || at > out.sellerLastAt)) out.sellerLastAt = at;
      if (!out.sellerSampleUrl && x.url) out.sellerSampleUrl = x.url;
    }
    const others = await db.collection(RECORDS).where('orgId', '==', orgId).where('phone', '==', rec.phone).limit(20).get();
    out.otherBuyerRecords = others.docs.filter((d) => d.data().buyerKey !== rec.buyerKey).length;
  }
  if (rec.profileUrl) {
    const byProfile = await db.collection(RECORDS).where('orgId', '==', orgId).where('profileUrl', '==', rec.profileUrl).limit(20).get();
    out.otherBuyerRecords += byProfile.docs.filter((d) => d.data().buyerKey !== rec.buyerKey && d.data().phone !== rec.phone).length;
  }
  if (rec.author) {
    const byAuthor = await db.collection(RECORDS).where('orgId', '==', orgId).where('author', '==', rec.author).limit(30).get();
    out.posterPosts = byAuthor.size;
    for (const d of byAuthor.docs) {
      const t = `${d.data().sourceRef?.title || ''} ${d.data().sourceRef?.text || ''}`;
      if (/\b(available|for sale|for rent)\b/i.test(t)) out.posterAvailable += 1;
      else out.posterWanted += 1;
    }
  }
  return out;
}

async function searchGoogle({ apifyToken, actorId, query }) {
  const items = await callSerpActor({ apifyToken, actorId, query, maxPages: 1, extraInput: { resultsPerPage: 10 }, deadlineMs: Date.now() + 4 * 60 * 1000 });
  return (items || []).slice(0, 10);
}

/** The actor the profile step was built and tested against (2026-10-18): details + posts are two "endpoints" of one actor. */
export const DEFAULT_PROFILE_ACTOR = 'cleansyntax~facebook-profile-posts-scraper';
const PROFILE_POSTS = 8;

async function apifySync({ apifyToken, actorId, input, timeoutS = 150 }) {
  const url = `${APIFY_BASE}/acts/${encodeURIComponent(actorId)}/run-sync-get-dataset-items?token=${encodeURIComponent(apifyToken)}&timeout=${timeoutS}`;
  const resp = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input), signal: AbortSignal.timeout((timeoutS + 20) * 1000) });
  if (!resp.ok) throw new Error(`profile http ${resp.status}`);
  const items = await resp.json().catch(() => []);
  return Array.isArray(items) ? items : [];
}

/**
 * One Facebook profile / page → `{ name, intro, category, followers, posts[] , url }` for profileEvidence.
 * The default actor answers in two calls (details, then the latest public posts); any other actor id is
 * tried with the common `startUrls` shape and parsed leniently. A profile the actor cannot read → null
 * ("no evidence"), never a throw past the caller's catch.
 */
async function fetchProfile({ apifyToken, actorId, profileUrl }) {
  if (actorId === DEFAULT_PROFILE_ACTOR) {
    const [details, posts] = await Promise.all([
      apifySync({ apifyToken, actorId, input: { endpoint: 'details_by_url', urls_text: profileUrl } }).catch(() => []),
      apifySync({ apifyToken, actorId, input: { endpoint: 'profile_posts_by_url', urls_text: profileUrl, max_posts: PROFILE_POSTS } }).catch(() => []),
    ]);
    const p = details.find((it) => it?.profile && typeof it.profile === 'object')?.profile || null;
    const texts = posts.map((it) => it?.message || it?.text || '').filter(Boolean).slice(0, PROFILE_POSTS);
    if (!p && !texts.length) return null;
    return {
      name: p?.name || null, intro: p?.intro || p?.about || null, category: p?.category || p?.categories || null,
      followers: Number(p?.followers ?? p?.followers_count ?? p?.likes) || 0, url: p?.url || profileUrl,
      type: p?.category ? 'page' : 'profile', posts: texts,
    };
  }
  const items = await apifySync({ apifyToken, actorId, input: { startUrls: [{ url: profileUrl }], profileUrls: [profileUrl], resultsLimit: 10, maxPosts: PROFILE_POSTS } });
  if (!items.length) return null;
  const first = items[0] && typeof items[0] === 'object' ? { ...items[0] } : null;
  if (!first) return null;
  // Some actors return one row per post rather than one profile row — fold the texts in.
  if (items.length > 1 && !first.posts) first.posts = items.map((it) => it?.text || it?.message || it?.postText || '').filter(Boolean);
  return first;
}

// ── One check ──────────────────────────────────────────────────────────────────────────────────────

/**
 * Run one buyer's check end to end. `deps` lets the validator stand in for every outside call.
 * Returns a compact summary for the run doc; never throws past the record (a failure is recorded on
 * it and the record stays due for the next batch).
 */
export async function checkOne({ db, orgId, org, secret, recRef, rec, deps = {}, apifyToken = null, nowMs = Date.now() }) {
  const cfg = cfgOf(org);
  const dueReason = DUE_REASONS.includes(rec.dueReason) ? rec.dueReason : 'new';
  const checkNo = (rec.checkCount || 0) + 1;
  const events = [];
  const out = { buyerKey: rec.buyerKey, buyerId: rec.buyerId, name: rec.name, dueReason, checkNo };
  const serpActor = cfg.serpActorId || org?.sourcing?.actorId || DEFAULT_SERP_ACTOR;
  const useDeps = {
    lookupHistory: deps.lookupHistory || ((r) => lookupHistory(db, orgId, r)),
    fetchSnapshot: deps.fetchSnapshot || ((r) => fetchSnapshotFromPlatform({ cfg, secret, rec: r })),
    searchGoogle: deps.searchGoogle || (apifyToken ? ({ query }) => searchGoogle({ apifyToken, actorId: serpActor, query }) : null),
    // The profile scrape is the dear one; the override review re-reads behaviour + search only.
    fetchProfile: dueReason === 'override_review' ? null : (deps.fetchProfile || (apifyToken && cfg.profileActorId !== false ? (profileUrl) => fetchProfile({ apifyToken, actorId: cfg.profileActorId || DEFAULT_PROFILE_ACTOR, profileUrl }) : null)),
  };
  events.push(event('check_started', { atMs: nowMs, text: `Check #${checkNo} started (${dueReason.replace('_', ' ')})`, checkNo }));

  const { evidence, searches, snapshot } = await gatherEvidence({ rec, cfg, deps: useDeps, opts: { skipOutside: dueReason === 'watch_expiry' } });
  events.push(event('evidence', { atMs: nowMs + 1, text: `${evidence.length} evidence line${evidence.length === 1 ? '' : 's'} gathered`, evidence, checkNo }));
  out.evidenceCount = evidence.length;
  out.searches = searches;

  const prior = rec.checkedAtMs ? { verdict: rec.modelVerdict || rec.verdict, agentScore: rec.agentScore, atMs: rec.checkedAtMs } : null;
  let result;
  if (dueReason === 'watch_expiry') {
    result = quietBuyerOnBehaviour(snapshot)
      ? { verdict: 'buyer', agentScore: 0.15, confidence: 0.6, torn: false, summary: 'Quiet for 90 days with ordinary buyer activity (a requirement, a few enquiries, no listings) — a buyer on behaviour.', reasons: ['No listings posted, one or two areas, no outside evidence against.'], signals: [], deep: false, model: 'rule', calls: [], cogsUsd: 0 }
      : { verdict: 'unclear', agentScore: null, confidence: 0, torn: false, summary: 'Still nothing to go on after 90 days — kept on watch.', reasons: [], signals: [], deep: false, model: null, calls: [], cogsUsd: 0 };
  } else {
    result = await judge({ rec, evidence, cfg, priorVerdict: prior, override: dueReason === 'override_review' ? rec.override : null, dueReason, generate: deps.generate, allowDeep: dueReason !== 'override_review' });
  }
  out.model = result.model; out.deep = result.deep; out.cogsUsd = result.cogsUsd; out.calls = result.calls?.map((c) => ({ model: c.model, input: c.usage?.input_tokens, output: c.usage?.output_tokens, cogsUsd: c.cogsUsd }));
  out.verdict = result.verdict; out.agentScore = result.agentScore; out.confidence = result.confidence;

  if (result.failed) {
    events.push(event('check_failed', { atMs: nowMs + 2, text: 'The check could not be completed; it will run again on the next batch.', checkNo }));
    await appendEvents(db, recRef, events);
    await recRef.set({ lastError: 'model-failed', claimedAtMs: null, updatedAtMs: nowMs }, { merge: true });
    out.failed = true;
    return out;
  }

  const patch = { claimedAtMs: null, lastError: null, updatedAtMs: nowMs, snapshot: snapshot || rec.snapshot || null };
  const tasks = [];
  let charge = { service: null, inr: 0 };

  if (dueReason === 'override_review') {
    // Free. Does the evidence since the override support the admin, or contradict them?
    const ov = rec.override || {};
    const contradicts = result.verdict !== 'unclear' && result.verdict !== ov.verdict && result.confidence >= 0.7
      && !(ov.verdict === 'buyer' && result.verdict === 'possible_agent' && result.agentScore < 0.6);
    const reviewed = contradicts ? 'challenged' : 'confirmed';
    patch.override = { ...ov, reviewed, reviewedAtMs: nowMs, reviewVerdict: result.verdict, reviewScore: result.agentScore, reviewSummary: result.summary };
    patch.status = 'done';
    patch.dueReason = null;
    events.push(event('override_review', { atMs: nowMs + 2, text: `Override review: ${reviewed} — ${result.summary}`, checkNo, verdict: result.verdict, agentScore: result.agentScore, extra: { reviewed, overrideBy: ov.by || null, overrideByName: ov.byName || null, overrideVerdict: ov.verdict || null } }));
    if (contradicts) {
      tasks.push({ type: 'override_challenge', adminUid: ov.by || null, adminName: ov.byName || null, escalate: true, title: `Override challenged: ${rec.name || rec.buyerKey}`, why: `${ov.byName || 'An admin'} marked this buyer "${labelFor(ov.verdict)}" (${ov.reason}); new evidence says ${labelFor(result.verdict)}: ${result.summary}`, questions: callQuestions(result, evidence) });
      events.push(event('task', { atMs: nowMs + 3, text: `Task: ${ov.byName || 'the admin'} to talk to the buyer again; super-admin to settle it`, checkNo }));
    }
    out.reviewed = reviewed;
    await bumpDay(db, orgId, { reviews: 1, [reviewed === 'challenged' ? 'reviewsChallenged' : 'reviewsConfirmed']: 1, cogsUsd1e6: Math.round(result.cogsUsd * 1e6) }, nowMs);
  } else {
    if (result.deep) events.push(event('deep_check', { atMs: nowMs + 2, text: 'Torn on the first reading — a stronger model re-judged the same evidence', checkNo }));
    const service = serviceFor(result, { dueReason });
    if (service) {
      const settled = await settleMetered({ orgId, service, idempotencyKey: `${rec.buyerKey}:${checkNo}`, description: `Buyer check #${checkNo} — ${rec.name || rec.buyerKey} (${labelFor(result.verdict)})`, extra: { buyerKey: rec.buyerKey, verdict: result.verdict, deep: result.deep, model: result.model }, db });
      charge = { service, inr: settled.charged, pricePaise: settled.pricePaise, waived: settled.waived, duplicate: settled.duplicate };
    }
    const wasBadge = rec.badge === true;
    const badge = result.verdict === 'buyer' && snapshot?.phoneVerified === true;
    patch.modelVerdict = result.verdict;
    patch.verdict = result.verdict;
    patch.agentScore = result.agentScore; patch.confidence = result.confidence; patch.summary = result.summary;
    patch.reasons = result.reasons || [];
    patch.checkCount = checkNo; patch.checkedAtMs = nowMs; patch.lastModel = result.model; patch.deep = result.deep;
    patch.badge = badge; patch.agent = result.verdict === 'agent';
    patch.override = null; // a fresh check supersedes an old override (it was reviewed, or it was before this check)
    if (dueReason === 'behaviour') patch.lastBehaviourCheckMs = nowMs;
    if (result.verdict === 'unclear') { patch.status = 'watch'; patch.nextDueMs = nowMs + numOr(cfg.watchDays, DEFAULTS.watchDays) * DAY_MS; }
    else if (badge) { patch.status = 'done'; patch.nextDueMs = nowMs + numOr(cfg.renewalDays, DEFAULTS.renewalDays) * DAY_MS; }
    else { patch.status = 'done'; patch.nextDueMs = null; }
    patch.dueReason = null;
    events.push(event('verdict', { atMs: nowMs + 3, text: verdictText(result), checkNo, verdict: result.verdict, agentScore: result.agentScore, chargeInr: charge.inr || 0, service: charge.service, extra: { reasons: result.reasons || [], signals: result.signals || [], model: result.model, deep: result.deep, confidence: result.confidence } }));
    if (badge && !wasBadge) events.push(event('badge', { atMs: nowMs + 4, text: 'Verified Buyer badge granted', checkNo, extra: { granted: true } }));
    if (!badge && wasBadge) events.push(event('badge', { atMs: nowMs + 4, text: `Verified Buyer badge withdrawn (${labelFor(result.verdict)})`, checkNo, extra: { granted: false } }));
    if (result.verdict === 'possible_agent') {
      tasks.push({ type: 'buyer_verify_call', title: `Confirm by call: ${rec.name || rec.buyerKey}`, why: result.summary, questions: callQuestions(result, evidence) });
      events.push(event('task', { atMs: nowMs + 5, text: 'Task: confirm by call (possible agent)', checkNo }));
    } else if (!badge && wasBadge && dueReason === 'renewal') {
      tasks.push({ type: 'buyer_verify_call', title: `Badge withdrawn on renewal: ${rec.name || rec.buyerKey}`, why: result.summary, questions: callQuestions(result, evidence) });
    }
    await bumpDay(db, orgId, { checked: 1, [result.verdict]: 1, deep: result.deep ? 1 : 0, revenueInr: charge.inr || 0, cogsUsd1e6: Math.round(result.cogsUsd * 1e6), badgesGranted: badge && !wasBadge ? 1 : 0, badgesWithdrawn: !badge && wasBadge ? 1 : 0, tasks: tasks.length }, nowMs);
  }
  out.charge = charge; out.tasks = tasks.map((t) => t.type);

  // Deliver to the platform — verdict, evidence, the new timeline lines, the tasks to create.
  const payload = {
    orgId, kind: dueReason === 'override_review' ? 'override_review' : 'verdict',
    buyerKey: rec.buyerKey, buyerId: rec.buyerId, userId: rec.userId, phone: rec.phone, checkNo, dueReason,
    verdict: dueReason === 'override_review' ? effective({ ...rec, ...patch }) : result.verdict,
    label: labelFor(dueReason === 'override_review' ? effective({ ...rec, ...patch }) : result.verdict),
    modelVerdict: result.verdict, agentScore: result.agentScore, confidence: result.confidence, summary: result.summary,
    reasons: result.reasons || [], evidence, events, charge, deep: result.deep,
    badge: patch.badge ?? rec.badge === true, agent: patch.agent ?? rec.agent === true,
    nextDueMs: patch.nextDueMs ?? rec.nextDueMs ?? null, tasks, override: patch.override ?? rec.override ?? null,
  };
  const verdictUrl = cfg.verdictUrl;
  let delivered = null;
  if (verdictUrl && secret) {
    try {
      const r = await (deps.deliver || ((p) => postSigned(verdictUrl, secret, p)))(payload);
      delivered = r.ok;
      if (!r.ok) console.warn('buyerChecks:deliver-http', orgId, rec.buyerKey, r.status);
    } catch (e) {
      delivered = false;
      console.warn('buyerChecks:deliver-err', orgId, rec.buyerKey, e?.message || e);
    }
  }
  if (delivered === false) {
    patch.deliveryPending = true;
    patch.pendingPayload = JSON.stringify(payload).slice(0, 900000);
    events.push(event('delivery_failed', { atMs: nowMs + 6, text: 'Could not reach the buyer bank — will retry on the next batch', checkNo }));
  } else {
    patch.deliveryPending = false;
    patch.pendingPayload = null;
  }
  out.delivered = delivered;
  await appendEvents(db, recRef, events);
  await recRef.set(patch, { merge: true });
  return out;
}

// ── A batch ────────────────────────────────────────────────────────────────────────────────────────

/** Everything due for this org right now, in pick order, before the cap. */
export async function pickDue(db, orgId, cfg, nowMs = Date.now()) {
  const col = db.collection(RECORDS);
  const [due, reviews, watch, badges] = await Promise.all([
    col.where('orgId', '==', orgId).where('status', '==', 'due').limit(3000).get(),
    col.where('orgId', '==', orgId).where('status', '==', 'review_pending').limit(500).get(),
    col.where('orgId', '==', orgId).where('status', '==', 'watch').limit(3000).get(),
    col.where('orgId', '==', orgId).where('badge', '==', true).limit(3000).get(),
  ]);
  const renewalMs = numOr(cfg.renewalDays, DEFAULTS.renewalDays) * DAY_MS;
  const items = [];
  const push = (d, reason) => items.push({ ref: d.ref, rec: { ...d.data(), dueReason: reason } });
  for (const d of due.docs) push(d, DUE_REASONS.includes(d.data().dueReason) ? d.data().dueReason : 'new');
  for (const d of reviews.docs) if (Number(d.data().override?.reviewDueMs) <= nowMs) push(d, 'override_review');
  for (const d of watch.docs) if (Number(d.data().nextDueMs) && Number(d.data().nextDueMs) <= nowMs) push(d, 'watch_expiry');
  for (const d of badges.docs) {
    const x = d.data();
    if (x.status === 'done' && Number(x.checkedAtMs) && nowMs - Number(x.checkedAtMs) >= renewalMs) push(d, 'renewal');
  }
  const seen = new Set();
  const uniq = items.filter((it) => !seen.has(it.ref.id) && seen.add(it.ref.id));
  const rank = (r) => DUE_REASONS.indexOf(r);
  uniq.sort((a, b) => rank(a.rec.dueReason) - rank(b.rec.dueReason) || (Number(b.rec.activityAtMs) || 0) - (Number(a.rec.activityAtMs) || 0));
  return uniq.filter((it) => !(Number(it.rec.claimedAtMs) && nowMs - Number(it.rec.claimedAtMs) < CLAIM_MS));
}

/** Retry deliveries that failed last time — before the new checks, so the platform sees things in order. */
async function retryDeliveries(db, orgId, cfg, secret) {
  if (!cfg.verdictUrl || !secret) return 0;
  const snap = await db.collection(RECORDS).where('orgId', '==', orgId).where('deliveryPending', '==', true).limit(50).get();
  let ok = 0;
  for (const d of snap.docs) {
    try {
      const payload = JSON.parse(d.data().pendingPayload || 'null');
      if (!payload) { await d.ref.set({ deliveryPending: false, pendingPayload: null }, { merge: true }); continue; }
      const r = await postSigned(cfg.verdictUrl, secret, payload);
      if (r.ok) { ok += 1; await d.ref.set({ deliveryPending: false, pendingPayload: null, updatedAtMs: Date.now() }, { merge: true }); }
    } catch (e) {
      console.warn('buyerChecks:retry-deliver', orgId, d.id, e?.message || e);
    }
  }
  return ok;
}

/** One org's batch. Returns the run summary (also written to buyerCheckRuns). Never throws. */
export async function runBatchForOrg(db, orgId, { trigger = 'cron', deps = {}, apifyToken = null, nowMs = Date.now(), limit = null } = {}) {
  const started = Date.now();
  const runRef = db.collection(RUNS).doc();
  const summary = { orgId, trigger, status: 'running', dateKey: istDateKey(nowMs), slot: new Date(nowMs + IST_MS).getUTCHours() < 16 ? 'morning' : 'evening', picked: 0, checked: 0, results: [], errors: [], chargedInr: 0, cogsUsd: 0, redelivered: 0 };
  await runRef.set({ ...summary, startedAt: FieldValue.serverTimestamp(), startedAtMs: nowMs, expiresAt: Timestamp.fromMillis(nowMs + TTL_DAYS * DAY_MS) }, { merge: true }).catch(() => {});
  try {
    const { org, secrets } = await loadOrg(db, orgId);
    const cfg = cfgOf(org);
    const secret = secrets?.sourcing?.secret || null;
    if (!org || cfg.enabled !== true) { summary.status = 'skipped'; summary.reason = 'disabled'; return summary; }
    if (!isServicePaused(org, 'buyer_check') && !isServicePaused(org, 'agent_work') && blocksNewWork(org.balance)) {
      summary.status = 'skipped'; summary.reason = 'negative-balance'; return summary;
    }
    summary.redelivered = await retryDeliveries(db, orgId, cfg, secret);
    const cap = Math.max(1, Math.floor(Number(limit) || numOr(cfg.maxPerBatch, DEFAULTS.maxPerBatch)));
    const due = await pickDue(db, orgId, cfg, nowMs);
    summary.queued = due.length;
    const picked = due.slice(0, cap);
    summary.picked = picked.length;
    for (const it of picked) {
      await it.ref.set({ claimedAtMs: Date.now(), dueReason: it.rec.dueReason }, { merge: true });
      try {
        const r = await checkOne({ db, orgId, org, secret, recRef: it.ref, rec: it.rec, deps, apifyToken, nowMs: Date.now() });
        summary.results.push(r);
        if (!r.failed) summary.checked += 1;
        summary.chargedInr += Number(r.charge?.inr) || 0;
        summary.cogsUsd += Number(r.cogsUsd) || 0;
      } catch (e) {
        console.error('buyerChecks:checkOne', orgId, it.rec.buyerKey, e?.message || e);
        summary.errors.push({ buyerKey: it.rec.buyerKey, error: String(e?.message || e).slice(0, 300) });
        await it.ref.set({ claimedAtMs: null, lastError: String(e?.message || e).slice(0, 300) }, { merge: true }).catch(() => {});
      }
    }
    summary.status = 'ok';
    return summary;
  } catch (e) {
    console.error('buyerChecks:batch', orgId, e?.message || e);
    summary.status = 'error';
    summary.error = String(e?.message || e).slice(0, 300);
    return summary;
  } finally {
    summary.ms = Date.now() - started;
    await runRef.set({ ...summary, finishedAt: FieldValue.serverTimestamp() }, { merge: true }).catch(() => {});
    console.log('buyerChecks:batch:done', orgId, JSON.stringify({ ...summary, results: summary.results.map((r) => ({ k: r.buyerKey, v: r.verdict, deep: r.deep, inr: r.charge?.inr, d: r.delivered })) }));
  }
}

async function enabledOrgs(db) {
  const snap = await db.collection('organisations').where('buyerCheck.enabled', '==', true).get();
  return snap.docs;
}

// 10:00 and 22:00 IST — the morning list is ready when staff start; the evening one catches the day.
export const runBuyerChecks = onSchedule(
  { region: REGION, schedule: '0 10,22 * * *', timeZone: 'Asia/Kolkata', secrets: [APIFY_TOKEN, ANTHROPIC_API_KEY], timeoutSeconds: 1800, memory: '512MiB' },
  async () => {
    const db = getFirestore();
    for (const orgDoc of await enabledOrgs(db)) {
      await runBatchForOrg(db, orgDoc.id, { trigger: 'cron', apifyToken: process.env.APIFY_TOKEN });
    }
  },
);

// ── Endpoint ───────────────────────────────────────────────────────────────────────────────────────

export const buyerChecks = onRequest(
  { region: REGION, timeoutSeconds: 30, memory: '256MiB', cors: false },
  async (req, res) => {
    if (req.method !== 'POST') { res.status(405).json({ error: 'POST only' }); return; }
    const raw = req.rawBody ? req.rawBody.toString('utf8') : '';
    let body;
    try { body = JSON.parse(raw || '{}'); } catch { res.status(400).json({ error: 'invalid JSON' }); return; }
    const orgId = s(body.orgId, 128);
    const action = ['enqueue', 'behaviour', 'override', 'staffOutcome', 'history', 'status', 'list'].includes(body.action) ? body.action : '';
    if (!orgId || !action) {
      logReject('buyerChecks', { orgId, status: 400, reason: 'missing-required-field', extra: { hasOrgId: !!orgId, action: body.action } });
      res.status(400).json({ error: 'orgId and a valid action are required' });
      return;
    }
    const db = getFirestore();
    const { org, secrets } = await loadOrg(db, orgId);
    const secret = secrets?.sourcing?.secret || null;
    if (!secret || !org) {
      logReject('buyerChecks', { orgId, status: 403, reason: 'org-has-no-sourcing-secret' });
      res.status(403).json({ error: 'buyer checks not configured for this org' });
      return;
    }
    const auth = verifyCustomerSignature(raw, req.get('x-bosun-signature'), req.get('x-bosun-timestamp'), secret);
    if (!auth.ok) {
      logReject('buyerChecks', { orgId, status: 401, reason: auth.reason, extra: { skewMs: auth.skewMs ?? null, bytes: raw.length } });
      res.status(401).json({ error: 'bad signature' });
      return;
    }
    const cfg = cfgOf(org);
    if (cfg.enabled !== true && action !== 'history' && action !== 'status' && action !== 'list') {
      logReject('buyerChecks', { orgId, status: 403, reason: 'buyer-checks-disabled-for-org' });
      res.status(403).json({ error: 'BUYER_CHECKS_DISABLED' });
      return;
    }
    try {
      const result = await handleAction({ db, orgId, cfg, action, body, nowMs: Date.now() });
      res.status(result.httpStatus || 200).json(result.body);
    } catch (e) {
      console.error('buyerChecks:action', orgId, action, e?.message || e);
      res.status(500).json({ error: 'internal' });
    }
  },
);

/** The action switch, separated from HTTP so the validator can call it directly. */
export async function handleAction({ db, orgId, cfg, action, body, nowMs = Date.now() }) {
  const col = db.collection(RECORDS);
  const keyOf = (b) => s(b.buyerKey, 160) || buyerKeyFor({ buyerId: b.buyerId, userId: b.userId, phone: b.phone });

  if (action === 'list') {
    let q = col.where('orgId', '==', orgId);
    if (['due', 'watch', 'done', 'review_pending'].includes(body.status)) q = q.where('status', '==', body.status);
    if (VERDICTS.includes(body.verdict)) q = q.where('verdict', '==', body.verdict);
    const snap = await q.limit(Math.min(500, Math.max(1, Number(body.limit) || 200))).get();
    return { body: { ok: true, records: snap.docs.map((d) => publicRecord(d.data())) } };
  }

  const buyerKey = keyOf(body);
  if (!buyerKey) return { httpStatus: 400, body: { error: 'buyerKey, buyerId, userId or phone required' } };
  const ref = col.doc(recordId(orgId, buyerKey));

  if (action === 'enqueue') {
    const snap = await ref.get();
    if (snap.exists) {
      const rec = snap.data();
      const patch = { updatedAtMs: nowMs };
      // Newer identity details are welcome; an existing verdict stays unless the caller forces a re-check.
      for (const k of ['buyerId', 'userId', 'name', 'city', 'locality', 'profileUrl', 'author']) if (body[k] && !rec[k]) patch[k] = s(body[k], 300);
      if (body.phone && !rec.phone) patch.phone = newRecord({ orgId, buyerKey, payload: body }).phone;
      if (body.snapshot) patch.snapshot = cleanSnapshot({ ...(rec.snapshot || {}), ...body.snapshot });
      if (Number(body.activityAtMs) > (rec.activityAtMs || 0)) patch.activityAtMs = Number(body.activityAtMs);
      if (body.force === true && rec.status !== 'due') { patch.status = 'due'; patch.dueReason = 'manual'; }
      await ref.set(patch, { merge: true });
      return { body: { ok: true, existing: true, ...publicRecord({ ...rec, ...patch }) } };
    }
    const rec = newRecord({ orgId, buyerKey, payload: body, nowMs });
    await ref.set(rec);
    await appendEvents(db, ref, [event('arrived', { atMs: nowMs, text: `Arrived · ${rec.source === 'sourced' ? `sourced from ${rec.sourceRef.groupName || 'a Facebook group'}` : rec.source === 'enquiry' ? 'enquired on a listing' : rec.source === 'requirement' ? 'filed a requirement' : rec.source === 'backfill' ? 'already in the buyer bank' : 'joined on the portal'}${rec.author ? ` · poster: ${rec.author}` : ''}`, evidence: rec.sourceRef.url ? [{ source: 'source', kind: 'fact', url: rec.sourceRef.url, quote: rec.sourceRef.title || rec.sourceRef.text || 'origin post', signal: 'neutral', meta: {} }] : [] })]);
    await bumpDay(db, orgId, { enqueued: 1 }, nowMs);
    return { body: { ok: true, existing: false, ...publicRecord(rec) } };
  }

  const snap = await ref.get();
  if (!snap.exists) return { httpStatus: 404, body: { error: 'unknown buyer' } };
  const rec = snap.data();

  if (action === 'status') return { body: { ok: true, ...publicRecord(rec), verdict: effective(rec), label: labelFor(effective(rec)) } };

  if (action === 'history') {
    const tl = await ref.collection(TIMELINE).orderBy('atMs', 'asc').limit(200).get();
    return { body: { ok: true, record: { ...publicRecord(rec), verdict: effective(rec), label: labelFor(effective(rec)) }, timeline: tl.docs.map((d) => d.data()) } };
  }

  if (action === 'behaviour') {
    const snapshot = body.snapshot ? cleanSnapshot({ ...(rec.snapshot || {}), ...body.snapshot }) : rec.snapshot || null;
    const patch = { snapshot, activityAtMs: nowMs, updatedAtMs: nowMs };
    const events = [];
    const ev = body.event && typeof body.event === 'object' ? body.event : null;
    const counters = {};
    if (ev?.text) events.push(event(ev.type === 'converted' ? 'converted' : 'behaviour', { atMs: nowMs, text: s(ev.text, 300), extra: { eventType: s(ev.type, 40) || null } }));
    if (ev?.type === 'converted') counters.converted = 1;
    const trips = behaviourTrips(snapshot);
    const cooldownMs = numOr(cfg.behaviourCooldownDays, DEFAULTS.behaviourCooldownDays) * DAY_MS;
    let nowDue = false;
    if (rec.status === 'watch') nowDue = true; // anything a watched buyer does is the evidence we were waiting for
    else if (rec.status === 'done' && trips.length && (!rec.lastBehaviourCheckMs || nowMs - rec.lastBehaviourCheckMs >= cooldownMs)) nowDue = true;
    if (nowDue && rec.status !== 'review_pending') {
      patch.status = 'due'; patch.dueReason = 'behaviour';
      events.push(event('due', { atMs: nowMs + 1, text: `Re-check queued: ${trips.length ? trips.join(', ') : 'new activity while on watch'}` }));
    }
    await ref.set(patch, { merge: true });
    if (events.length) await appendEvents(db, ref, events);
    await bumpDay(db, orgId, counters, nowMs);
    return { body: { ok: true, queued: nowDue, trips, ...publicRecord({ ...rec, ...patch }) } };
  }

  if (action === 'override') {
    const verdict = ['buyer', 'possible_agent', 'agent'].includes(body.verdict) ? body.verdict : '';
    const reason = s(body.reason, 400);
    const by = s(body.by, 128);
    if (!verdict || reason.length < 5 || !by) return { httpStatus: 400, body: { error: 'verdict, by and a reason (5+ chars) are required' } };
    const before = effective(rec);
    const override = { verdict, by, byName: s(body.byName, 80) || null, reason, atMs: nowMs, before, reviewDueMs: nowMs + numOr(cfg.overrideReviewDays, DEFAULTS.overrideReviewDays) * DAY_MS, reviewed: null };
    const patch = { override, verdict, badge: verdict === 'buyer' && rec.snapshot?.phoneVerified === true, agent: verdict === 'agent', status: 'review_pending', dueReason: null, updatedAtMs: nowMs };
    await ref.set(patch, { merge: true });
    await appendEvents(db, ref, [event('override', { atMs: nowMs, text: `Override by ${override.byName || by}: ${labelFor(before)} → ${labelFor(verdict)} · "${reason}"`, by, byName: override.byName, verdict, extra: { before, reviewDueMs: override.reviewDueMs } })]);
    await bumpDay(db, orgId, { overrides: 1 }, nowMs);
    return { body: { ok: true, ...publicRecord({ ...rec, ...patch }), label: labelFor(verdict) } };
  }

  if (action === 'staffOutcome') {
    const outcome = ['buyer', 'agent', 'no_answer'].includes(body.outcome) ? body.outcome : '';
    const by = s(body.by, 128);
    if (!outcome || !by) return { httpStatus: 400, body: { error: 'outcome and by are required' } };
    const o = { outcome, by, byName: s(body.byName, 80) || null, note: s(body.note, 300) || null, atMs: nowMs };
    const staffOutcomes = [...(rec.staffOutcomes || []), o].slice(-10);
    const patch = { staffOutcomes, updatedAtMs: nowMs };
    if (outcome !== 'no_answer') { patch.verdict = outcome; patch.badge = outcome === 'buyer' && rec.snapshot?.phoneVerified === true; patch.agent = outcome === 'agent'; }
    await ref.set(patch, { merge: true });
    await appendEvents(db, ref, [event('staff_outcome', { atMs: nowMs, text: `${o.byName || 'Staff'} called: ${outcome === 'agent' ? 'an agent' : outcome === 'buyer' ? 'a genuine buyer' : 'no answer'}${o.note ? ` — "${o.note}"` : ''}`, by, byName: o.byName, verdict: outcome !== 'no_answer' ? outcome : null })]);
    await bumpDay(db, orgId, { [outcome === 'agent' ? 'staffAgent' : outcome === 'buyer' ? 'staffBuyer' : 'staffNoAnswer']: 1 }, nowMs);
    return { body: { ok: true, ...publicRecord({ ...rec, ...patch }), label: labelFor(effective({ ...rec, ...patch })) } };
  }
  return { httpStatus: 400, body: { error: 'unknown action' } };
}

// ── Daily Telegram status ──────────────────────────────────────────────────────────────────────────

async function countWhere(col, filters) {
  let q = col;
  for (const [k, v] of filters) q = q.where(k, '==', v);
  const agg = await q.count().get();
  return agg.data().count || 0;
}

/** The day's numbers for one org — from the counters doc plus a handful of count() aggregations. */
export async function buildDailyReport(db, orgId, org, nowMs = Date.now()) {
  const dateKey = istDateKey(nowMs);
  const day = (await db.collection(DAYS).doc(`${orgId}:${dateKey}`).get()).data() || {};
  const col = db.collection(RECORDS);
  const cfg = cfgOf(org);
  const [queued, watch, review, tBuyer, tPossible, tAgent, tUnclear, badges] = await Promise.all([
    countWhere(col, [['orgId', orgId], ['status', 'due']]),
    countWhere(col, [['orgId', orgId], ['status', 'watch']]),
    countWhere(col, [['orgId', orgId], ['status', 'review_pending']]),
    countWhere(col, [['orgId', orgId], ['verdict', 'buyer']]),
    countWhere(col, [['orgId', orgId], ['verdict', 'possible_agent']]),
    countWhere(col, [['orgId', orgId], ['verdict', 'agent']]),
    countWhere(col, [['orgId', orgId], ['verdict', 'unclear']]),
    countWhere(col, [['orgId', orgId], ['badge', true]]),
  ]);
  const perDay = 2 * numOr(cfg.maxPerBatch, DEFAULTS.maxPerBatch);
  const n = (k) => Number(day[k]) || 0;
  const cogsInr = (n('cogsUsd1e6') / 1e6) * (Number(org?.fxRate) || 95);
  const stats = {
    dateKey, orgName: org?.name || orgId,
    checked: n('checked'), buyer: n('buyer'), possible_agent: n('possible_agent'), agent: n('agent'), unclear: n('unclear'), deep: n('deep'),
    enqueued: n('enqueued'), overrides: n('overrides'), reviewsConfirmed: n('reviewsConfirmed'), reviewsChallenged: n('reviewsChallenged'),
    staffBuyer: n('staffBuyer'), staffAgent: n('staffAgent'), staffNoAnswer: n('staffNoAnswer'), converted: n('converted'),
    badgesGranted: n('badgesGranted'), badgesWithdrawn: n('badgesWithdrawn'), tasks: n('tasks'),
    revenueInr: n('revenueInr'), cogsInr,
    queued, watch, review, perDay, daysToClear: perDay ? Math.ceil(queued / perDay) : null,
    totals: { buyer: tBuyer, possible_agent: tPossible, agent: tAgent, unclear: tUnclear, badges },
  };
  return stats;
}

export function formatTelegram(st) {
  const d = `${st.dateKey.slice(6, 8)}/${st.dateKey.slice(4, 6)}`;
  const line = (label, v) => `${label}: <b>${v}</b>`;
  const rows = [
    `🛡 <b>Buyer checks · ${esc(st.orgName)} · ${d}</b>`,
    line('Checked today', st.checked) + (st.deep ? ` (deep: ${st.deep})` : ''),
    `Verdicts: buyer <b>${st.buyer}</b> · possible agent <b>${st.possible_agent}</b> · agent <b>${st.agent}</b> · unclear <b>${st.unclear}</b>`,
    `Calls by staff: buyer <b>${st.staffBuyer}</b> · agent <b>${st.staffAgent}</b> · no answer <b>${st.staffNoAnswer}</b>`,
    `Overrides: <b>${st.overrides}</b> · reviews confirmed <b>${st.reviewsConfirmed}</b> / challenged <b>${st.reviewsChallenged}</b>`,
    `Converted today (checked buyers): <b>${st.converted}</b>`,
    `Badges: +${st.badgesGranted} / −${st.badgesWithdrawn} · tasks created <b>${st.tasks}</b>`,
    `Revenue <b>₹${Math.round(st.revenueInr)}</b> · COGS ≈ ₹${Math.round(st.cogsInr)}`,
    `Queue: <b>${st.queued}</b> waiting${st.daysToClear != null ? ` (~${st.daysToClear} day${st.daysToClear === 1 ? '' : 's'} at ${st.perDay}/day)` : ''} · on watch ${st.watch} · overrides pending review ${st.review}`,
    `Totals: buyer ${st.totals.buyer} · possible ${st.totals.possible_agent} · agent ${st.totals.agent} · unclear ${st.totals.unclear} · badges ${st.totals.badges}`,
  ];
  return rows.join('\n');
}
function esc(t) {
  return String(t || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export async function sendTelegram({ botToken, chatId, text }) {
  const resp = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    signal: AbortSignal.timeout(15000),
  });
  const body = await resp.json().catch(() => null);
  if (!resp.ok || body?.ok === false) throw new Error(`telegram ${resp.status} ${body?.description || ''}`.trim());
  return true;
}

export async function reportForOrg(db, orgId, { nowMs = Date.now(), send = sendTelegram } = {}) {
  const { org, secrets } = await loadOrg(db, orgId);
  const cfg = cfgOf(org);
  const tg = cfg.telegram || {};
  const botToken = secrets?.buyerCheck?.telegramBotToken || null;
  if (!tg.enabled || !tg.chatId || !botToken) return { orgId, status: 'skipped', reason: !tg.enabled ? 'telegram-off' : !tg.chatId ? 'no-chat-id' : 'no-bot-token' };
  const stats = await buildDailyReport(db, orgId, org, nowMs);
  const text = formatTelegram(stats);
  await send({ botToken, chatId: tg.chatId, text });
  return { orgId, status: 'sent', stats };
}

// 22:30 IST — after the evening batch, before the founder's last look at the phone.
export const buyerCheckDailyReport = onSchedule(
  { region: REGION, schedule: '30 22 * * *', timeZone: 'Asia/Kolkata', timeoutSeconds: 120, memory: '256MiB' },
  async () => {
    const db = getFirestore();
    for (const orgDoc of await enabledOrgs(db)) {
      const r = await reportForOrg(db, orgDoc.id).catch((e) => ({ orgId: orgDoc.id, status: 'error', error: e?.message || String(e) }));
      console.log('buyerCheckDailyReport', JSON.stringify(r));
    }
  },
);

// ── Operator callables ─────────────────────────────────────────────────────────────────────────────

/** Configure an org's buyer checks. Non-secret config on the org doc; the Telegram bot token in the vault. */
export const adminSetBuyerCheck = onCall({ region: REGION }, async (request) => {
  requireAdmin(request);
  const orgId = s(request.data?.orgId, 128);
  if (!orgId) throw new HttpsError('invalid-argument', 'orgId required.');
  const db = getFirestore();
  const ref = db.collection('organisations').doc(orgId);
  if (!(await ref.get()).exists) throw new HttpsError('not-found', 'Organisation not found.');
  const p = request.data?.patch && typeof request.data.patch === 'object' ? request.data.patch : {};
  const patch = {};
  if (typeof p.enabled === 'boolean') patch['buyerCheck.enabled'] = p.enabled;
  for (const k of ['maxPerBatch', 'behaviourCooldownDays', 'renewalDays', 'watchDays', 'overrideReviewDays']) {
    if (p[k] != null) patch[`buyerCheck.${k}`] = Math.max(1, Math.floor(Number(p[k]) || DEFAULTS[k]));
  }
  for (const k of ['verdictUrl', 'snapshotUrl']) {
    if (p[k] !== undefined) patch[`buyerCheck.${k}`] = /^https:\/\//i.test(s(p[k], 300)) ? s(p[k], 300) : FieldValue.delete();
  }
  for (const k of ['profileActorId', 'serpActorId']) {
    if (p[k] !== undefined) patch[`buyerCheck.${k}`] = s(p[k], 120) || FieldValue.delete();
  }
  if (p.telegram && typeof p.telegram === 'object') {
    if (typeof p.telegram.enabled === 'boolean') patch['buyerCheck.telegram.enabled'] = p.telegram.enabled;
    if (p.telegram.chatId !== undefined) patch['buyerCheck.telegram.chatId'] = s(p.telegram.chatId, 40) || FieldValue.delete();
  }
  if (Object.keys(patch).length) { patch['buyerCheck.updatedAt'] = FieldValue.serverTimestamp(); await ref.update(patch); }
  const token = s(request.data?.telegramBotToken, 120);
  if (token) await db.collection('orgSecrets').doc(orgId).set({ buyerCheck: { telegramBotToken: token } }, { merge: true });
  const after = (await ref.get()).data().buyerCheck || {};
  return { ok: true, buyerCheck: after, telegramTokenSet: !!token || !!(await db.collection('orgSecrets').doc(orgId).get()).data()?.buyerCheck?.telegramBotToken };
});

/** Run one org's batch now (operator testing). `limit` overrides maxPerBatch for this run only. */
export const adminRunBuyerChecksNow = onCall({ region: REGION, secrets: [APIFY_TOKEN, ANTHROPIC_API_KEY], timeoutSeconds: 540, memory: '512MiB' }, async (request) => {
  requireAdmin(request);
  const orgId = s(request.data?.orgId, 128);
  if (!orgId) throw new HttpsError('invalid-argument', 'orgId required.');
  const db = getFirestore();
  const summary = await runBatchForOrg(db, orgId, { trigger: 'manual', apifyToken: process.env.APIFY_TOKEN, limit: Number(request.data?.limit) || null });
  return { ok: true, summary };
});

/** Send today's Telegram digest now (operator testing). */
export const adminBuyerCheckReportNow = onCall({ region: REGION }, async (request) => {
  requireAdmin(request);
  const orgId = s(request.data?.orgId, 128);
  if (!orgId) throw new HttpsError('invalid-argument', 'orgId required.');
  const db = getFirestore();
  return reportForOrg(db, orgId);
});

/** The operator's view: today's numbers, the last runs, and the records (filterable) with a timeline on request. */
export const adminBuyerChecks = onCall({ region: REGION }, async (request) => {
  requireAdmin(request);
  const orgId = s(request.data?.orgId, 128);
  if (!orgId) throw new HttpsError('invalid-argument', 'orgId required.');
  const db = getFirestore();
  const { org } = await loadOrg(db, orgId);
  if (!org) throw new HttpsError('not-found', 'Organisation not found.');
  if (request.data?.buyerKey) {
    const ref = db.collection(RECORDS).doc(recordId(orgId, s(request.data.buyerKey, 160)));
    const snap = await ref.get();
    if (!snap.exists) throw new HttpsError('not-found', 'Unknown buyer.');
    const tl = await ref.collection(TIMELINE).orderBy('atMs', 'asc').limit(300).get();
    return { ok: true, record: publicRecord(snap.data()), timeline: tl.docs.map((d) => d.data()) };
  }
  const limit = Math.min(500, Math.max(1, Number(request.data?.limit) || 100));
  let q = db.collection(RECORDS).where('orgId', '==', orgId);
  if (['due', 'watch', 'done', 'review_pending'].includes(request.data?.status)) q = q.where('status', '==', request.data.status);
  if (VERDICTS.includes(request.data?.verdict)) q = q.where('verdict', '==', request.data.verdict);
  const [recs, runs, today] = await Promise.all([
    q.limit(limit).get(),
    db.collection(RUNS).where('orgId', '==', orgId).orderBy('startedAtMs', 'desc').limit(20).get().catch(() => ({ docs: [] })),
    buildDailyReport(db, orgId, org),
  ]);
  return {
    ok: true,
    config: cfgOf(org),
    today,
    runs: runs.docs.map((d) => { const x = d.data(); return { id: d.id, ...x, startedAt: undefined, finishedAt: undefined, expiresAt: undefined }; }),
    records: recs.docs.map((d) => publicRecord(d.data())).sort((a, b) => (b.updatedAtMs || 0) - (a.updatedAtMs || 0)),
  };
});
