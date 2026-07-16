/**
 * Drive the REAL runForOrg through every funnel gate against an in-memory Firestore and a stubbed
 * network, then assert the recorded funnel matches what the pipeline actually did.
 *
 * The funnel counters are the whole point of the sourcing audit trail, and a miscount is invisible —
 * a wrong number looks exactly like a right one in the panel. This pins each gate to a scenario it
 * alone can produce, so a future edit that double-counts or skips a stage fails here instead of
 * quietly misreporting the business.
 *
 * No Firebase, no Apify, no network. Run:  cd functions && node scripts/validate-sourcing-funnel.mjs
 */
import assert from 'node:assert/strict';

// ── An in-memory stand-in for the Admin SDK surface runForOrg + the run recorder actually use.
class FakeRef {
  constructor(db, path) { this.db = db; this.path = path; this.id = path.split('/').pop(); }
  async get() { const d = this.db.store.get(this.path); return { exists: d !== undefined, id: this.id, data: () => d }; }
  async set(data, opts) {
    const prev = opts?.merge ? (this.db.store.get(this.path) || {}) : {};
    this.db.store.set(this.path, { ...prev, ...data });
  }
  async update(data) { this.db.store.set(this.path, { ...(this.db.store.get(this.path) || {}), ...data }); }
  collection(n) { return new FakeCol(this.db, `${this.path}/${n}`); }
}
class FakeCol {
  constructor(db, path) { this.db = db; this.path = path; }
  doc(id) { return new FakeRef(this.db, `${this.path}/${id || `auto${++this.db.n}`}`); }
}
class FakeDb {
  constructor() { this.store = new Map(); this.n = 0; }
  collection(n) { return new FakeCol(this, n); }
  async getAll(...refs) { return Promise.all(refs.map((r) => r.get())); }
  batch() {
    const ops = [];
    return { set: (ref, data) => ops.push([ref, data]), commit: async () => { for (const [ref, data] of ops) await ref.set(data); } };
  }
  async runTransaction(fn) {
    return fn({ get: (ref) => ref.get(), set: (ref, d) => ref.set(d), update: (ref, d) => ref.update(d) });
  }
  /** Every doc whose path sits under `prefix`. */
  under(prefix) { return [...this.store.entries()].filter(([p]) => p.startsWith(prefix)).map(([, v]) => v); }
}

const DAY = 24 * 60 * 60 * 1000;
const ORG = 'org1';
const WEBHOOK = 'https://example.test/hook';
const FRESH = Date.now() - 5 * DAY;   // comfortably inside a 3-month window
const ANCIENT = Date.now() - 400 * DAY; // far outside it

// The listings the stubbed SERP returns. Each one is here to trip exactly one gate.
const P = (n) => `https://facebook.com/groups/x/posts/${n}`;
const SERP = [
  { url: P(1), title: 'fresh 1', snippet: 'plot for sale' },
  { url: P(1), title: 'fresh 1 dup', snippet: 'plot for sale' },              // → dupInRun
  { url: P(2), title: 'fresh 2', snippet: 'house for sale' },
  { url: P(3), title: 'fresh 3', snippet: 'land for sale' },
  { url: P(4), title: 'fresh 4', snippet: 'villa for sale' },
  { url: P(5), title: 'seen before', snippet: 'old news' },                   // → seenBefore
  { url: P(6), title: 'serp stale', snippet: 'ancient', serpAgeMs: ANCIENT }, // → serpStaleSkipped
  { url: P(7), title: 'posted long ago', snippet: 'looks fresh to google' },  // → recencyDropped (real FB date is old)
  { url: 'https://facebook.com/groups/somegroup/', title: 'group landing' },  // → not an individual post
];

// What the stubbed Apify enrichment returns, in the ACTOR's real item shape — the actor echoes the
// input url on `facebookUrl`, carries the post date on `time`, and the phone is extracted from the
// text rather than sent as a field (see utils/sourcing.js: parseEnrichedItem).
const ENRICHED = {
  [P(1)]: { text: 'full text 1, contact 9876543210', time: new Date(FRESH).toISOString(), media: [{ photo_image: { uri: 'https://img.test/a.jpg' } }] },
  [P(2)]: { text: 'full text 2', time: new Date(FRESH).toISOString() },
  [P(3)]: { text: 'full text 3', time: new Date(FRESH).toISOString() },
  [P(7)]: { text: 'full text 7', time: new Date(ANCIENT).toISOString() },
  // P(4) deliberately absent → enrichMissed
};

const RELAY_REJECTS = new Set([P(3)]); // webhook says no → relayFailed

async function main() {
  const db = new FakeDb();
  db.store.set(`orgSecrets/${ORG}`, { sourcing: { secret: 's3cret' } });
  db.store.set(`organisations/${ORG}`, { balance: 1000, name: 'Test Org' });
  // Pre-seed the dedup ledger so P(5) is already known.
  const { listingKey } = await import('../utils/sourcing.js');
  db.store.set(`sourcingSeen/${ORG}/keys/${listingKey(P(5))}`, { url: P(5), relayedAt: 1 });

  // Stub the network: Apify enrichment and the customer webhook both go through global fetch.
  const relayed = [];
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('apify')) {
      const body = JSON.parse(opts.body);
      const items = body.startUrls.map(({ url: u }) => (ENRICHED[u] ? { facebookUrl: u, ...ENRICHED[u] } : null)).filter(Boolean);
      return { ok: true, status: 200, json: async () => items };
    }
    const body = JSON.parse(opts.body);
    const u = body.listing.url;
    if (RELAY_REJECTS.has(u)) return { ok: false, status: 500 };
    relayed.push(u);
    return { ok: true, status: 200 };
  };

  const { runForOrg } = await import('../handlers/runSourcingJobs.js');
  const { startRun } = await import('../utils/sourcingRun.js');

  const cfg = { actorId: 'a', webhookUrl: WEBHOOK, queries: ['q1'], freshnessMonths: 3, maxPerRun: 0 };
  const run = startRun(db, ORG, 'test');
  const leg = run.leg({ queries: cfg.queries });
  const result = await runForOrg(db, 'tok', ORG, cfg, { fetchSerp: async () => SERP, leg });
  await run.finish();

  const runDoc = db.store.get(`sourcingRuns/${run.id}`);
  const f = runDoc.funnel;
  const leads = db.under(`sourcingRuns/${run.id}/leads/`);
  const show = (o) => JSON.stringify(o, null, 2);

  console.log('funnel:', show(Object.fromEntries(Object.entries(f).filter(([, v]) => v > 0))));
  console.log('leads :', show(leads.map((l) => ({ url: l.url.slice(-8), stage: l.stage, why: l.dropStage || '' }))));

  // ── The funnel must describe what actually happened, stage by stage.
  assert.equal(f.fetched, 9, 'fetched = every SERP item');
  assert.equal(f.posts, 8, 'posts = fetched minus the group landing page');
  assert.equal(f.dupInRun, 1, 'dupInRun = the repeated P(1)');
  assert.equal(f.seenBefore, 1, 'seenBefore = the pre-seeded P(5)');
  assert.equal(f.newProspects, 6, 'newProspects = 7 unique posts minus the 1 already seen');
  assert.equal(f.serpStaleSkipped, 1, 'serpStaleSkipped = P(6), skipped before the paid scrape');
  assert.equal(f.enriched, 5, 'enriched = the 5 prospects that survived to the paid scrape');
  assert.equal(f.enrichMissed, 1, 'enrichMissed = P(4), paid for and returned nothing');
  assert.equal(f.withPhone, 1, 'withPhone = P(1)');
  assert.equal(f.withImages, 1, 'withImages = P(1)');
  assert.equal(f.recencyDropped, 1, 'recencyDropped = P(7), real FB date outside the window');
  assert.equal(f.relayAttempted, 4, 'relayAttempted = enriched minus the stale drop');
  assert.equal(f.relayFailed, 1, 'relayFailed = P(3), webhook rejected');
  assert.equal(f.relayed, 3, 'relayed = P(1), P(2), P(4)');

  // ── The funnel must agree with the pipeline's own return value and the money.
  assert.equal(result.relayed, 3, 'runForOrg agrees with the recorded relay count');
  assert.equal(runDoc.relayed, 3, 'run rollup agrees with its leg');
  assert.equal(relayed.length, 3, 'exactly the relayed leads hit the webhook');
  assert.ok(runDoc.amountInr > 0, 'a relayed batch bills the org');
  assert.equal(runDoc.status, 'done');

  // ── Billing must not drift from the funnel: one debit txn, count = leads relayed.
  const txns = db.under('transactions/');
  assert.equal(txns.length, 1, 'one batch debit');
  assert.equal(txns[0].count, 3, 'debit count = leads relayed');
  assert.equal(txns[0].amount, runDoc.amountInr, 'debit amount = the recorded amount');
  assert.equal(db.store.get(`organisations/${ORG}`).balance, 1000 - runDoc.amountInr, 'wallet debited exactly once');

  // ── Lead rows: one per examined listing, each labelled with the gate that ended it.
  const byStage = leads.reduce((m, l) => ({ ...m, [l.stage]: (m[l.stage] || 0) + 1 }), {});
  assert.equal(byStage.relayed, 3, 'a row per relayed lead');
  assert.equal(byStage.dropped, 3, 'a row per dropped lead (serp-date, recency, relay)');
  assert.deepEqual(
    leads.filter((l) => l.stage === 'dropped').map((l) => l.dropStage).sort(),
    ['recency', 'relay', 'serp-date'],
    'each drop names the gate that killed it',
  );
  for (const l of leads) assert.ok(l.url && l.query === 'q1', 'every row carries its URL and originating query');

  // ── Only relayed leads are marked seen. A transient failure (P(3)) must stay retryable, and a
  // permanent one (P(7), too old) must be marked dead so we never pay to scrape it twice.
  const seenDocs = db.under(`sourcingSeen/${ORG}/keys/`);
  const relayedSeen = seenDocs.filter((d) => d.relayedAt && !d.dropped);
  const deadSeen = seenDocs.filter((d) => d.dropped);
  assert.equal(relayedSeen.length, 4, '3 newly relayed + the 1 pre-seeded');
  assert.deepEqual(deadSeen.map((d) => d.dropReason), ['stale-recency'], 'only the known-old post is buried');
  assert.ok(!seenDocs.some((d) => d.url === P(3)), 'a webhook rejection stays retryable — never marked seen');
  assert.ok(!seenDocs.some((d) => d.url === P(6)), 'a coarse SERP-date skip stays retryable — never marked seen');

  await maxPerRunScenario();
  console.log('\n✅ all funnel, billing, lead-row and dedup assertions passed');
}

/**
 * maxPerRun trims the enrich pool. Those leftovers are DEFERRED, not dropped — they're never marked
 * seen, so the next run relays them. The panel colours the two differently and the distinction
 * decides whether a low relay count reads as lost supply or as throttling, so pin it down.
 */
async function maxPerRunScenario() {
  const db = new FakeDb();
  db.store.set(`orgSecrets/${ORG}`, { sourcing: { secret: 's3cret' } });
  db.store.set(`organisations/${ORG}`, { balance: 1000, name: 'Test Org' });

  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('apify')) {
      const body = JSON.parse(opts.body);
      const items = body.startUrls.map(({ url: u }) => ({ facebookUrl: u, text: `text ${u}`, time: new Date(FRESH).toISOString() }));
      return { ok: true, status: 200, json: async () => items };
    }
    return { ok: true, status: 200 };
  };

  const { runForOrg } = await import('../handlers/runSourcingJobs.js');
  const { startRun } = await import('../utils/sourcingRun.js');

  const serp = [1, 2, 3, 4, 5].map((n) => ({ url: P(100 + n), title: `p${n}`, snippet: 'plot for sale' }));
  const cfg = { actorId: 'a', webhookUrl: WEBHOOK, queries: ['q1'], freshnessMonths: 3, maxPerRun: 2 };
  const run = startRun(db, ORG, 'test');
  const leg = run.leg({ queries: cfg.queries });
  await runForOrg(db, 'tok', ORG, cfg, { fetchSerp: async () => serp, leg });
  await run.finish();

  const f = db.store.get(`sourcingRuns/${run.id}`).funnel;
  assert.equal(f.newProspects, 5, 'all 5 are new');
  assert.equal(f.poolDeferred, 3, 'maxPerRun=2 leaves 3 deferred');
  assert.equal(f.enriched, 2, 'only the capped pool is paid for');
  assert.equal(f.relayed, 2, 'only the capped pool relays');

  const leads = db.under(`sourcingRuns/${run.id}/leads/`);
  const deferred = leads.filter((l) => l.stage === 'deferred');
  assert.equal(deferred.length, 3, 'a row per deferred lead');
  assert.ok(deferred.every((l) => l.dropStage === 'pool-cap'), 'deferred rows name the cap that held them back');

  // The whole point: a deferred lead must stay unseen so the next run can still deliver and bill it.
  const seenUrls = new Set(db.under(`sourcingSeen/${ORG}/keys/`).map((d) => d.url));
  assert.equal(seenUrls.size, 2, 'only the 2 relayed leads are marked seen');
  for (const l of deferred) assert.ok(!seenUrls.has(l.url), 'a deferred lead is never marked seen — it must retry');
  console.log('\nmaxPerRun scenario: 5 new → 2 relayed, 3 deferred and still retryable ✓');
}

main().catch((e) => { console.error('\n❌', e.message); process.exit(1); });
