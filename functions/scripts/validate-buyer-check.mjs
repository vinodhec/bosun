/**
 * Drive the REAL buyer-check lane (handlers/buyerChecks.js + utils/buyerCheck.js + utils/meter.js)
 * against an in-memory Firestore with the model, Google, the Facebook profile and the platform all
 * stubbed. Pins the money rules and the lifecycle:
 *   - enqueue → batch → Sonnet verdict with evidence → ONE buyer_check (₹12) settled, idempotent
 *   - a torn check → Opus re-judges → ONE buyer_check_deep (₹36), never both lines
 *   - nothing found → unclear, FREE, on watch; behaviour on a watched buyer re-queues it
 *   - override → recorded, acted on, reviewed after 14 days for free → confirmed / challenged + task
 *   - staff call outcome wins the effective verdict and is evidence next time
 *   - the batch cap (5), pick order, delivery retry, and the Telegram digest text
 *
 * No Firebase, no network. Run:  cd functions && node scripts/validate-buyer-check.mjs
 * Live model loop:                cd functions && ANTHROPIC_API_KEY=… node scripts/validate-buyer-check.mjs --live
 */
import assert from 'node:assert/strict';
import { handleAction, runBatchForOrg, pickDue, formatTelegram, buildDailyReport, RECORDS, TIMELINE, RUNS, DAYS } from '../handlers/buyerChecks.js';
import { buyerKeyFor, recordId, serpEvidence, profileEvidence, verdictFromScore, behaviourTrips, DEFAULTS } from '../utils/buyerCheck.js';

// ── In-memory Admin SDK: enough of the query surface for this lane (equality / in / limit / orderBy / count).
const getPath = (o, dotted) => dotted.split('.').reduce((x, k) => (x == null ? undefined : x[k]), o);
const setPath = (obj, dotted, v) => { const ks = dotted.split('.'); let o = obj; for (const k of ks.slice(0, -1)) o = o[k] = { ...(o[k] || {}) }; o[ks.at(-1)] = v; };
const isDelete = (v) => v && typeof v === 'object' && v.__delete;
const isInc = (v) => v && typeof v === 'object' && typeof v.__inc === 'number';
// structuredClone refuses functions (the Timestamp stubs' toMillis), so copy by hand.
const copy = (v) => (Array.isArray(v) ? v.map(copy) : v && typeof v === 'object' && !v.toMillis ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, copy(x)])) : v);
const applyMerge = (prev, data) => {
  const out = copy(prev || {});
  for (const [k, v] of Object.entries(data)) {
    if (isDelete(v)) { const ks = k.split('.'); let o = out; for (const kk of ks.slice(0, -1)) o = o?.[kk]; if (o) delete o[ks.at(-1)]; continue; }
    if (isInc(v)) { setPath(out, k, (Number(getPath(out, k)) || 0) + v.__inc); continue; }
    if (v && typeof v === 'object' && !Array.isArray(v) && v.__ts) { setPath(out, k, { toMillis: () => Date.now() }); continue; }
    if (k.includes('.')) setPath(out, k, v); else out[k] = v;
  }
  return out;
};
class Snap { constructor(id, d, ref) { this.id = id; this.exists = d !== undefined; this._d = d; this.ref = ref; } data() { return this._d; } get(k) { return getPath(this._d, k); } }
class Ref {
  constructor(db, path) { this.db = db; this.path = path; this.id = path.split('/').pop(); }
  async get() { return new Snap(this.id, this.db.store.get(this.path), this); }
  async set(data, opts) { this.db.store.set(this.path, opts?.merge ? applyMerge(this.db.store.get(this.path), data) : applyMerge({}, data)); }
  async update(data) { if (!this.db.store.has(this.path)) throw new Error('update on missing ' + this.path); this.db.store.set(this.path, applyMerge(this.db.store.get(this.path), data)); }
  collection(n) { return new Col(this.db, `${this.path}/${n}`); }
}
class Query {
  constructor(db, path, filters = [], lim = null, order = null) { this.db = db; this.path = path; this.filters = filters; this.lim = lim; this.order = order; }
  where(k, op, v) { return new Query(this.db, this.path, [...this.filters, [k, op, v]], this.lim, this.order); }
  limit(n) { return new Query(this.db, this.path, this.filters, n, this.order); }
  orderBy(k, dir = 'asc') { return new Query(this.db, this.path, this.filters, this.lim, [k, dir]); }
  _rows() {
    const depth = this.path.split('/').length + 1;
    let rows = [...this.db.store.entries()].filter(([p]) => p.startsWith(this.path + '/') && p.split('/').length === depth);
    for (const [k, op, v] of this.filters) {
      rows = rows.filter(([, d]) => { const x = getPath(d, k); return op === '==' ? x === v : op === 'in' ? v.includes(x) : op === '>=' ? x >= v : op === '<=' ? x <= v : false; });
    }
    if (this.order) { const [k, dir] = this.order; rows.sort((a, b) => ((getPath(a[1], k) || 0) - (getPath(b[1], k) || 0)) * (dir === 'desc' ? -1 : 1)); }
    if (this.lim) rows = rows.slice(0, this.lim);
    return rows;
  }
  async get() { const rows = this._rows(); return { docs: rows.map(([p, d]) => new Snap(p.split('/').pop(), d, new Ref(this.db, p))), size: rows.length, empty: !rows.length }; }
  count() { return { get: async () => ({ data: () => ({ count: this._rows().length }) }) }; }
}
class Col extends Query {
  doc(id) { return new Ref(this.db, `${this.path}/${id || `auto${++this.db.n}`}`); }
}
class FakeDb {
  constructor() { this.store = new Map(); this.n = 0; }
  collection(n) { return new Col(this, n); }
  async getAll(...refs) { return Promise.all(refs.map((r) => r.get())); }
  batch() { const ops = []; return { set: (ref, d, o) => ops.push(() => ref.set(d, o)), commit: async () => { for (const op of ops) await op(); } }; }
  async runTransaction(fn) {
    const ops = [];
    const out = await fn({ get: (ref) => ref.get(), set: (ref, d, o) => ops.push(() => ref.set(d, o)), update: (ref, d) => ops.push(() => ref.update(d)) });
    for (const op of ops) await op();
    return out;
  }
  under(prefix) { return [...this.store.entries()].filter(([p]) => p.startsWith(prefix)).map(([p, v]) => ({ path: p, ...v })); }
}
// firebase-admin's FieldValue / Timestamp are imported by the handler; the fake only needs their SHAPE to survive merges.
import * as fsMod from 'firebase-admin/firestore';
fsMod.FieldValue.increment = (n) => ({ __inc: n });
fsMod.FieldValue.delete = () => ({ __delete: true });
fsMod.FieldValue.serverTimestamp = () => ({ __ts: true });

const DAY = 24 * 3600 * 1000;
const ORG = 'org1';
const LIVE = process.argv.includes('--live');
const db = new FakeDb();
db.store.set(`organisations/${ORG}`, { name: 'MaadiVeedu', balance: 5000, buyerCheck: { enabled: true, maxPerBatch: 5, verdictUrl: 'https://platform.test/api/ingest/buyer-verdict', snapshotUrl: 'https://platform.test/api/sourcing/buyer-snapshot', telegram: { enabled: true, chatId: '123' } } });
db.store.set(`orgSecrets/${ORG}`, { sourcing: { secret: 'shh' }, buyerCheck: { telegramBotToken: 'tok' } });
// A seller phone we relayed twice — the "selling and buying at once" signal.
db.store.set(`sourcingSeen/${ORG}/keys/owner_a`, { owner: true, phone: '+919876543210', url: 'https://facebook.com/groups/g/posts/1', relayedAt: { toMillis: () => Date.now() - 20 * DAY } });
db.store.set(`sourcingSeen/${ORG}/keys/owner_b`, { owner: true, phone: '+919876543210', url: 'https://facebook.com/groups/g/posts/2', relayedAt: { toMillis: () => Date.now() - 3 * DAY } });

const cfg = db.store.get(`organisations/${ORG}`).buyerCheck;
const act = (action, body) => handleAction({ db, orgId: ORG, cfg, action, body: { orgId: ORG, ...body } });
const rec = (key) => db.store.get(`${RECORDS}/${recordId(ORG, key)}`);
const timeline = (key) => db.under(`${RECORDS}/${recordId(ORG, key)}/${TIMELINE}/`).sort((a, b) => a.atMs - b.atMs);
const txns = () => db.under('transactions/');
const delivered = [];

// ── Stubs. The model answers from a script keyed on the buyer's name; everything else is canned.
const script = {
  Kavitha: { verdict: 'buyer', agentScore: 0.12, confidence: 0.85, torn: false, summary: 'One enquiry, one area, phone confirmed — a buyer.', reasons: ['Enquired on one listing [0]', 'Phone confirmed [2]'], signals: [{ evidenceIndex: 0, supports: 'buyer', note: 'one listing' }] },
  Raju: { verdict: 'agent', agentScore: 0.9, confidence: 0.9, torn: false, summary: 'Same phone sells two properties and a realty page on Google.', reasons: ['Seller phone [1]', 'Realty page [4]'], signals: [] },
  Suresh: { verdict: 'possible_agent', agentScore: 0.5, confidence: 0.4, torn: true, summary: 'Busy across areas but could be relocating.', reasons: ['3 areas'], signals: [] },
  SureshDeep: { verdict: 'possible_agent', agentScore: 0.55, confidence: 0.8, torn: false, summary: 'Leaning agent: 12 enquiries in a week across 4 areas, no requirement.', reasons: ['Enquiries [3]'], signals: [] },
  Priya: { verdict: 'buyer', agentScore: 0.2, confidence: 0.8, torn: false, summary: 'Ordinary buyer behaviour since the override.', reasons: [], signals: [] },
  Mani: { verdict: 'agent', agentScore: 0.85, confidence: 0.85, torn: false, summary: 'Posted 8 listings since the override.', reasons: ['Listings [2]'], signals: [] },
};
const stubGenerate = async ({ model, prompt }) => {
  const name = Object.keys(script).find((n) => prompt.includes(`Buyer: ${n}`));
  const key = model.includes('opus') ? `${name}Deep` : name;
  const data = script[key] || script[name];
  return data ? { data, usage: { input_tokens: 8000, output_tokens: model.includes('opus') ? 2500 : 900 }, model } : null;
};
const stubSearch = async ({ query, rec }) => (rec.name === 'Raju'
  ? [{ url: 'https://99acres.com/agent/raju-realty', title: 'Raju Realty — Chennai property agent', snippet: 'Flats, plots for sale in Tambaram. Call 98765 43210' }]
  : []);
const stubProfile = async (url, rec) => (rec.name === 'Raju' ? { name: 'Raju Realty', intro: 'Property consultant · Tambaram Promoters', followers: 1200, posts: ['2BHK available Tambaram DM for details', 'Plot for sale Perungalathur'] } : null);
const snapshots = {
  Kavitha: { accountAgeDays: 40, phoneVerified: true, enquiriesTotal: 1, enquiries30d: 1, distinctAreas30d: 1, requirementsFiled: 1, requirementAreas: ['Velachery'], listingsPosted: 0 },
  Raju: { accountAgeDays: 300, phoneVerified: true, enquiriesTotal: 25, enquiries30d: 12, distinctAreas30d: 5, listingsPosted: 3, sellersContacted1d: 11 },
  Suresh: { accountAgeDays: 10, phoneVerified: false, enquiriesTotal: 12, enquiries7d: 12, enquiries30d: 12, distinctAreas30d: 4, listingsPosted: 0 },
  Ghost: null,
};
const deps = {
  generate: LIVE ? undefined : stubGenerate,
  searchGoogle: stubSearch,
  fetchProfile: stubProfile,
  fetchSnapshot: async (r) => snapshots[r.name] ?? null,
  deliver: async (payload) => { delivered.push(payload); return { ok: !payload.buyerId?.startsWith('fail'), status: 200 }; },
};

// ── 1. Enqueue four buyers; keys are deterministic and a repeat is not a second record.
const k1 = (await act('enqueue', { buyerId: 'SP-1', phone: '9123456780', name: 'Kavitha', city: 'Chennai', source: 'enquiry', sourceRef: { listingId: 'P1', title: '2BHK Velachery', url: 'https://maadiveedu.com/p/P1' } })).body;
assert.equal(k1.buyerKey, 'lead:SP-1'); assert.equal(k1.status, 'due'); assert.equal(k1.existing, false);
assert.equal((await act('enqueue', { buyerId: 'SP-1', name: 'Kavitha' })).body.existing, true, 'same buyer → same record');
assert.equal(buyerKeyFor({ userId: 'u9' }), 'user:u9'); assert.equal(buyerKeyFor({ phone: '+91 98765 43210' }), 'phone:9876543210'); assert.equal(buyerKeyFor({}), '');
await act('enqueue', { buyerId: 'SP-2', phone: '+919876543210', name: 'Raju', city: 'Chennai', source: 'sourced', profileUrl: 'https://facebook.com/raju.realty', author: 'Raju R', sourceRef: { groupName: 'Tambaram Buyers', title: 'Wanted 2BHK Tambaram', url: 'https://facebook.com/groups/g/posts/9' }, activityAtMs: Date.now() - DAY });
await act('enqueue', { buyerId: 'SP-3', name: 'Suresh', city: 'Chennai', source: 'requirement', sourceRef: { text: '2BHK anywhere in south Chennai under 25k' }, activityAtMs: Date.now() - 2 * DAY });
await act('enqueue', { buyerId: 'SP-4', name: 'Ghost', source: 'sourced', sourceRef: { groupName: 'Velachery Buyers', title: 'need 1bhk' }, activityAtMs: Date.now() - 3 * DAY });
assert.equal(timeline('lead:SP-2')[0].type, 'arrived');
assert.ok(timeline('lead:SP-2')[0].evidence[0].url.includes('posts/9'), 'the origin post link rides on the arrival line');

// ── 2. Pick order: new buyers newest-activity first; cap honoured.
const order = (await pickDue(db, ORG, cfg)).map((it) => it.rec.name);
assert.deepEqual(order, ['Kavitha', 'Raju', 'Suresh', 'Ghost']);
db.store.get(`organisations/${ORG}`).buyerCheck.maxPerBatch = 3;
let run = await runBatchForOrg(db, ORG, { trigger: 'test', deps });
assert.equal(run.status, 'ok'); assert.equal(run.picked, 3); assert.equal(run.queued, 4);
assert.equal(db.under(`${RUNS}/`).length, 1, 'one run doc');

// ── 3. Kavitha: clean buyer → ₹12 once, badge granted (phone confirmed), delivered with evidence + tasks none.
const kav = rec('lead:SP-1');
assert.equal(kav.verdict, 'buyer'); assert.equal(kav.status, 'done'); assert.equal(kav.badge, true); assert.equal(kav.checkCount, 1);
assert.ok(kav.nextDueMs > Date.now() + 89 * DAY, 'badge renewal due in 90 days');
const kavTxn = txns().filter((t) => t.description?.includes('Kavitha'));
assert.equal(kavTxn.length, 1); assert.equal(kavTxn[0].kind, 'buyer_check'); assert.equal(kavTxn[0].amount, 12);
const kavVerdict = timeline('lead:SP-1').find((e) => e.type === 'verdict');
assert.equal(kavVerdict.chargeInr, 12); assert.ok(kavVerdict.text.startsWith('Buyer (12% agent)'));
assert.ok(timeline('lead:SP-1').some((e) => e.type === 'badge' && e.extra?.granted !== false));
const kavPayload = delivered.find((p) => p.buyerId === 'SP-1');
assert.equal(kavPayload.kind, 'verdict'); assert.equal(kavPayload.charge.inr, 12); assert.equal(kavPayload.tasks.length, 0);
assert.ok(kavPayload.evidence.some((e) => e.source === 'portal' && /phone confirmed/.test(e.quote)));
assert.ok(kavPayload.evidence.some((e) => e.source === 'source' && e.url === 'https://maadiveedu.com/p/P1'), 'origin listing link is evidence');

// ── 4. Raju: our history (phone sold twice) + Google agent page + FB page → agent, ₹12, agent tag, no badge.
const raju = rec('lead:SP-2');
assert.equal(raju.verdict, 'agent'); assert.equal(raju.agent, true); assert.equal(raju.badge, false);
const rajuPayload = delivered.find((p) => p.buyerId === 'SP-2');
assert.ok(rajuPayload.evidence.some((e) => e.source === 'history' && /2 property listings/.test(e.quote) && e.url?.includes('posts/1')), 'seller history carries a link');
assert.ok(rajuPayload.evidence.some((e) => e.source === 'google' && e.url?.includes('99acres') && e.signal === 'agent'));
assert.ok(rajuPayload.evidence.some((e) => e.source === 'facebook' && e.url === 'https://facebook.com/raju.realty' && e.signal === 'agent'));
assert.ok(rajuPayload.evidence.some((e) => e.source === 'facebook' && e.kind === 'post'));

// ── 5. Suresh: torn → Opus re-judged → ONE ₹36 line, no ₹12; possible agent → "confirm by call" task.
const sur = rec('lead:SP-3');
assert.equal(sur.verdict, 'possible_agent'); assert.equal(sur.deep, true);
const surTxns = txns().filter((t) => t.description?.includes('Suresh'));
assert.equal(surTxns.length, 1); assert.equal(surTxns[0].kind, 'buyer_check_deep'); assert.equal(surTxns[0].amount, 36);
assert.ok(timeline('lead:SP-3').some((e) => e.type === 'deep_check'));
const surPayload = delivered.find((p) => p.buyerId === 'SP-3');
assert.deepEqual(surPayload.tasks.map((t) => t.type), ['buyer_verify_call']);
assert.ok(surPayload.tasks[0].questions.length >= 2);
assert.equal(surPayload.deep, true);
const day = db.store.get(`${DAYS}/${ORG}:${new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 10).replace(/-/g, '')}`);
assert.equal(day.checked, 3); assert.equal(day.deep, 1); assert.equal(day.revenueInr, 60); assert.equal(day.tasks, 1); assert.equal(day.enqueued, 4);

// ── 6. Ghost: nothing anywhere → unclear, FREE, on watch, no model call; behaviour re-queues it.
db.store.get(`organisations/${ORG}`).buyerCheck.maxPerBatch = 5;
run = await runBatchForOrg(db, ORG, { trigger: 'test', deps });
assert.equal(run.picked, 1);
const ghost = rec('lead:SP-4');
assert.equal(ghost.verdict, 'unclear'); assert.equal(ghost.status, 'watch'); assert.equal(ghost.checkCount, 1);
assert.equal(txns().filter((t) => t.description?.includes('Ghost')).length, 0, 'unclear is never billed');
assert.equal(run.results[0].model, null, 'no model call without substance');
const beh = (await act('behaviour', { buyerId: 'SP-4', snapshot: { phoneVerified: true, requirementsFiled: 1, enquiriesTotal: 2 }, event: { type: 'requirement', text: 'Filed a requirement: 1BHK Velachery ₹12k' } })).body;
assert.equal(beh.queued, true); assert.equal(rec('lead:SP-4').status, 'due'); assert.equal(rec('lead:SP-4').dueReason, 'behaviour');
assert.ok(timeline('lead:SP-4').some((e) => e.type === 'behaviour' && /1BHK Velachery/.test(e.text)));

// ── 7. Idempotency: re-running Kavitha's check number can't bill twice (same key → duplicate).
await act('enqueue', { buyerId: 'SP-1', force: true });
assert.equal(rec('lead:SP-1').dueReason, 'manual');
db.store.set(`${RECORDS}/${recordId(ORG, 'lead:SP-1')}`, { ...rec('lead:SP-1'), checkCount: 0 }); // simulate a replay of check #1
run = await runBatchForOrg(db, ORG, { trigger: 'test', deps, limit: 1 });
assert.equal(run.results[0].buyerKey, 'lead:SP-1'); // manual outranks behaviour
assert.equal(run.results[0].charge.duplicate, true); assert.equal(run.results[0].charge.inr, 0);
assert.equal(txns().filter((t) => t.description?.includes('Kavitha')).length, 1, 'still exactly one ₹12 for check #1');
assert.equal(db.store.get(`organisations/${ORG}`).balance, 5000 - 12 - 12 - 36, 'wallet: Kavitha 12 + Raju 12 + Suresh 36');

// ── 8. Override: recorded with who/why, acted on at once, reviewed free after 14 days.
const ov = (await act('override', { buyerKey: 'lead:SP-2', verdict: 'buyer', by: 'adm1', byName: 'Priya', reason: 'spoke to him, relocating family, posts were for his brother' })).body;
assert.equal(ov.verdict, 'buyer'); assert.equal(ov.badge, true); assert.equal(ov.agent, false); assert.equal(ov.status, 'review_pending');
assert.equal((await act('override', { buyerKey: 'lead:SP-2', verdict: 'buyer', by: 'adm1', reason: 'no' })).httpStatus, 400, 'a reason is required');
const ovEvent = timeline('lead:SP-2').find((e) => e.type === 'override');
assert.ok(/Override by Priya: Agent → Buyer/.test(ovEvent.text)); assert.equal(ovEvent.by, 'adm1');
assert.equal((await pickDue(db, ORG, cfg)).some((it) => it.rec.buyerKey === 'lead:SP-2'), false, 'not due until the review date');
// 15 days later: the review. Raju's model script says agent again with high confidence → challenged.
db.store.get(`${RECORDS}/${recordId(ORG, 'lead:SP-2')}`).override.reviewDueMs = Date.now() - DAY;
db.store.get(`${RECORDS}/${recordId(ORG, 'lead:SP-2')}`).name = 'Mani';
run = await runBatchForOrg(db, ORG, { trigger: 'test', deps, limit: 1 });
assert.equal(run.results[0].dueReason, 'override_review'); assert.equal(run.results[0].reviewed, 'challenged');
assert.equal(run.results[0].charge.service, null, 'the review is free');
assert.equal(txns().length, 3, 'no new transaction for the review');
const mani = rec('lead:SP-2');
assert.equal(mani.override.reviewed, 'challenged'); assert.equal(mani.status, 'done');
const challenge = delivered.at(-1);
assert.equal(challenge.kind, 'override_review'); assert.deepEqual(challenge.tasks.map((t) => t.type), ['override_challenge']);
assert.equal(challenge.tasks[0].adminUid, 'adm1'); assert.equal(challenge.tasks[0].escalate, true);
assert.equal(challenge.verdict, 'buyer', 'the admin\'s verdict stands until the super-admin settles it');
assert.ok(timeline('lead:SP-2').some((e) => e.type === 'override_review' && /challenged/.test(e.text)));
// A second override whose review agrees → confirmed, no task.
await act('override', { buyerKey: 'lead:SP-2', verdict: 'buyer', by: 'adm1', byName: 'Priya', reason: 'super-admin agreed after the second call' });
db.store.get(`${RECORDS}/${recordId(ORG, 'lead:SP-2')}`).override.reviewDueMs = Date.now() - DAY;
db.store.get(`${RECORDS}/${recordId(ORG, 'lead:SP-2')}`).name = 'Priya';
run = await runBatchForOrg(db, ORG, { trigger: 'test', deps, limit: 1 });
assert.equal(run.results[0].reviewed, 'confirmed'); assert.equal(delivered.at(-1).tasks.length, 0);

// ── 9. Staff outcome: a call result wins the effective verdict and is evidence next time.
const so = (await act('staffOutcome', { buyerKey: 'lead:SP-3', outcome: 'agent', by: 'adm2', byName: 'Arun', note: 'runs a brokerage in Tambaram' })).body;
assert.equal(so.verdict, 'agent'); assert.equal(so.label, 'Agent');
assert.equal((await act('status', { buyerKey: 'lead:SP-3' })).body.label, 'Agent');
const hist = (await act('history', { buyerKey: 'lead:SP-3' })).body;
assert.ok(hist.timeline.some((e) => e.type === 'staff_outcome' && /Arun called: an agent/.test(e.text)));
assert.ok(hist.timeline.every((e, i, a) => i === 0 || a[i - 1].atMs <= e.atMs), 'history is in order');

// ── 10. Delivery failure is retried next batch, never re-billed.
await act('enqueue', { buyerId: 'fail-5', phone: '9000000005', name: 'Kavitha', source: 'enquiry', sourceRef: { listingId: 'P2', title: 'Plot' } });
run = await runBatchForOrg(db, ORG, { trigger: 'test', deps, limit: 1 });
assert.equal(run.results[0].delivered, false); assert.equal(rec('lead:fail-5').deliveryPending, true);
assert.ok(timeline('lead:fail-5').some((e) => e.type === 'delivery_failed'));
const before = txns().length;
db.store.get(`${RECORDS}/${recordId(ORG, 'lead:fail-5')}`).buyerId = 'ok-5';
db.store.get(`${RECORDS}/${recordId(ORG, 'lead:fail-5')}`).pendingPayload = JSON.stringify({ ...JSON.parse(rec('lead:fail-5').pendingPayload), buyerId: 'ok-5' });
// The retry path POSTs for real (no deps hook) — stub fetch for it.
globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) });
run = await runBatchForOrg(db, ORG, { trigger: 'test', deps, limit: 1 });
assert.equal(run.redelivered, 1); assert.equal(rec('lead:fail-5').deliveryPending, false);
assert.equal(txns().length, before, 'redelivery bills nothing');

// ── 11. Guards: disabled org / negative balance skip the batch; the endpoint's list filters.
db.store.get(`organisations/${ORG}`).balance = -1;
assert.equal((await runBatchForOrg(db, ORG, { deps })).reason, 'negative-balance');
db.store.get(`organisations/${ORG}`).balance = 100;
db.store.get(`organisations/${ORG}`).buyerCheck.enabled = false;
assert.equal((await runBatchForOrg(db, ORG, { deps })).reason, 'disabled');
db.store.get(`organisations/${ORG}`).buyerCheck.enabled = true;
const agents = (await act('list', { verdict: 'agent' })).body.records;
assert.ok(agents.every((r) => r.verdict === 'agent') && agents.length >= 1);

// ── 12. Pure helpers.
assert.equal(verdictFromScore(0.8), 'agent'); assert.equal(verdictFromScore(0.5), 'possible_agent'); assert.equal(verdictFromScore(0.2), 'buyer'); assert.equal(verdictFromScore(null), 'unclear');
assert.deepEqual(behaviourTrips({ listingsPosted: 1, enquiries30d: 2 }), ['posted a listing']);
assert.equal(serpEvidence([{ url: 'https://x', title: 'Cricket scores', snippet: 'IPL' }], { query: 'q' })[0].meta.empty, true, 'non-property hits are not evidence');
assert.equal(profileEvidence(null, 'https://facebook.com/p')[0].signal, 'neutral', 'a private profile is no evidence');
assert.equal(DEFAULTS.maxPerBatch, 5);

// ── 13. The Telegram digest reads from the counters + counts; no network.
const stats = await buildDailyReport(db, ORG, db.store.get(`organisations/${ORG}`));
assert.equal(stats.overrides, 2); assert.equal(stats.reviewsChallenged, 1); assert.equal(stats.reviewsConfirmed, 1); assert.equal(stats.staffAgent, 1);
assert.ok(stats.revenueInr >= 72);
const text = formatTelegram(stats);
assert.ok(text.includes('Buyer checks · MaadiVeedu') && text.includes('Overrides: <b>2</b>') && /Revenue <b>₹\d+<\/b>/.test(text));
console.log('\n' + text.replace(/<[^>]+>/g, '') + '\n');

const recordCount = db.under(`${RECORDS}/`).filter((r) => r.path.split('/').length === 2).length;
console.log(`validate-buyer-check: OK (${LIVE ? 'live model' : 'stubbed model'}) — ${recordCount} records, ${txns().length} transactions, ${delivered.length} deliveries`);
