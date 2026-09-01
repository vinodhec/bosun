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
  await classifyLanesScenario();
  await localityUnknownScenario();
  await ownerDedupScenario();
  await buyerLaneScenario();
  await buyerDedupScenario();
  await queryShapeScenario();
  console.log('\n✅ all funnel, billing, lead-row and dedup assertions passed');
}

/**
 * OWNER dedup (3f): the same owner reposting the SAME property in a new group/locality gets a fresh
 * post URL every time, so URL dedup can't see it (the "3 property same property" complaint). We key
 * on phone + a coarse price/BHK/type fingerprint AFTER enrichment/classify populate them. Pins: an
 * in-run repost collapses (one relays), a broker's DIFFERENT property under the SAME number is
 * spared, a phone-less lead is never deduped, and a repost on a LATER run is caught cross-run and
 * marked dead so it's never re-enriched a third time.
 */
async function ownerDedupScenario() {
  const TARGET = { locality: 'Velachery', city: 'Chennai' };
  const classifyStub = async ({ text }) => {
    // A1/A2 share phone + fingerprint (a repost); B shares the phone but is a distinct property;
    // D carries no phone. Phone rides in via verdict.extracted.phone (runSourcingJobs.js:368).
    if (text.includes('propA')) return { keep: true, side: 'offering', isListing: true, localityMatches: true, confidence: 0.9, extracted: { listingType: 'Sale', locality: 'Velachery', propertyType: 'flat', bhk: '2', priceText: '50 lakh', phone: '9876543210' } };
    if (text.includes('propB')) return { keep: true, side: 'offering', isListing: true, localityMatches: true, confidence: 0.9, extracted: { listingType: 'Sale', locality: 'Velachery', propertyType: 'flat', bhk: '3', priceText: '80 lakh', phone: '9876543210' } };
    return { keep: true, side: 'offering', isListing: true, localityMatches: true, confidence: 0.9, extracted: { listingType: 'Sale', locality: 'Velachery', propertyType: 'plot', bhk: '', priceText: '30 lakh' } };
  };

  const db = new FakeDb();
  db.store.set(`orgSecrets/${ORG}`, { sourcing: { secret: 's3cret' } });
  db.store.set(`organisations/${ORG}`, { balance: 1000, name: 'Test Org' });
  const relayBodies = [];
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('apify')) {
      const body = JSON.parse(opts.body);
      const items = body.startUrls.map(({ url: u }) => ({ facebookUrl: u, text: `full ${u}`, time: new Date(FRESH).toISOString() }));
      return { ok: true, status: 200, json: async () => items };
    }
    relayBodies.push(JSON.parse(opts.body));
    return { ok: true, status: 200 };
  };

  const { runForOrg } = await import('../handlers/runSourcingJobs.js');
  const { startRun } = await import('../utils/sourcingRun.js');
  const cfg = { actorId: 'a', webhookUrl: WEBHOOK, queries: ['q1'], freshnessMonths: 3, maxPerRun: 0 };
  const runOne = async (serp) => {
    const run = startRun(db, ORG, 'test');
    const leg = run.leg({ target: TARGET, queries: cfg.queries });
    await runForOrg(db, 'tok', ORG, cfg, { fetchSerp: async () => serp, classify: classifyStub, target: TARGET, leg });
    await run.finish();
    return db.store.get(`sourcingRuns/${run.id}`).funnel;
  };

  // Run 1: property A posted twice in one run + broker's other property + a phone-less lead.
  const f1 = await runOne([
    { url: P(401), title: 'propA repost one', snippet: 'flat for sale velachery' },
    { url: P(402), title: 'propA repost two', snippet: 'flat for sale velachery' },
    { url: P(403), title: 'propB other flat', snippet: 'flat for sale velachery' },
    { url: P(404), title: 'propD no phone', snippet: 'plot for sale velachery' },
  ]);
  assert.equal(f1.ownerDupInRun, 1, 'the in-run repost of property A collapses');
  assert.equal(f1.ownerDeduped, 1, 'exactly one lead deduped this run');
  assert.equal(f1.relayed, 3, 'A (once) + B + D relay');
  const r1 = new Set(relayBodies.map((b) => b.listing.url));
  assert.ok(r1.has(P(401)) && !r1.has(P(402)), 'the first repost wins, the second is dropped');
  assert.ok(r1.has(P(403)), "a broker's DIFFERENT property under the same number is spared");
  assert.ok(r1.has(P(404)), 'a phone-less lead is never deduped');
  const seen1 = db.under(`sourcingSeen/${ORG}/keys/`);
  assert.ok(seen1.some((d) => d.url === P(402) && d.dropped && d.dropReason === 'duplicate-owner'), 'the collapsed repost is marked dead');
  assert.ok(seen1.some((d) => d.owner === true), 'the relayed owner fingerprint is recorded for cross-run dedup');

  // Run 2: property A reposted AGAIN with a brand-new URL. URL dedup can't see it — owner dedup must.
  relayBodies.length = 0;
  const f2 = await runOne([{ url: P(405), title: 'propA repost three', snippet: 'flat for sale velachery' }]);
  assert.equal(f2.ownerDupSeen, 1, 'the later-run repost is caught by cross-run owner dedup');
  assert.equal(f2.relayed, 0, 'the same property is never delivered (or billed) a second time');
  assert.equal(relayBodies.length, 0, 'the repost never reaches the webhook');
  const seen2 = db.under(`sourcingSeen/${ORG}/keys/`);
  assert.ok(seen2.some((d) => d.url === P(405) && d.dropped && d.dropReason === 'duplicate-owner'), 'the cross-run repost is marked dead so it is not re-enriched a third time');

  console.log('\nowner-dedup scenario: same-owner reposts collapse in-run and cross-run, brokers and phone-less leads spared ✓');
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

/**
 * The classify gate's salvage lanes: a 'seeking' post becomes a buyer lead and a confident
 * wrong-locality listing becomes an off-target lead — but ONLY when the org opts in
 * (sourcing.buyerLeads / sourcing.offTargetLeads), because each tag must be routable by the
 * platform webhook. Three runs pin the flag-off fates (buyer retryable, off-target dead), the
 * flag-on relays (leadType on the wire, on the seen doc, and in the lane counters), and the lane
 * priority under maxPerRun (salvage never displaces on-target inventory).
 */
async function classifyLanesScenario() {
  const TARGET = { locality: 'Velachery', city: 'Chennai' };
  // Keyed off the SERP text the pipeline hands to classify (title + snippet) — the stub stands in
  // for Gemini, one verdict per post. Snippets carry a property keyword so hasPropertySignal passes.
  // A FACTORY, not a constant: the pipeline mutates listing objects in place (snippet enrichment,
  // leadType, extracted), so each run must get fresh copies or the runs contaminate each other.
  const serp4 = () => [
    { url: P(201), title: 'on-target listing', snippet: 'flat for sale velachery' },
    { url: P(202), title: 'buyer wanted', snippet: 'looking for 2bhk flat' },
    { url: P(203), title: 'offtarget listing', snippet: 'house for sale tambaram' },
    { url: P(204), title: 'junk shop ad', snippet: 'silk saree price offer' },
  ];
  const classifyStub = async ({ text }) => {
    if (text.includes('buyer wanted')) return { keep: true, side: 'seeking', isListing: true, localityMatches: true, confidence: 0.9, extracted: { listingType: 'Rent', locality: 'Velachery' } };
    if (text.includes('offtarget')) return { keep: false, side: 'offering', isListing: true, localityMatches: false, confidence: 0.9, reason: 'off-target', extracted: { listingType: 'Sale', locality: 'Tambaram' } };
    if (text.includes('junk')) return { keep: false, side: 'offering', isListing: false, localityMatches: false, confidence: 0.9, reason: 'not-a-listing' };
    return { keep: true, side: 'offering', isListing: true, localityMatches: true, confidence: 0.9, extracted: { listingType: 'Sale', locality: 'Velachery' } };
  };

  const runOnce = async (cfgExtra) => {
    const db = new FakeDb();
    db.store.set(`orgSecrets/${ORG}`, { sourcing: { secret: 's3cret' } });
    db.store.set(`organisations/${ORG}`, { balance: 1000, name: 'Test Org' });
    const relayBodies = [];
    globalThis.fetch = async (url, opts) => {
      if (String(url).includes('apify')) {
        const body = JSON.parse(opts.body);
        const items = body.startUrls.map(({ url: u }) => ({ facebookUrl: u, text: `full ${u}`, time: new Date(FRESH).toISOString() }));
        return { ok: true, status: 200, json: async () => items };
      }
      relayBodies.push(JSON.parse(opts.body));
      return { ok: true, status: 200 };
    };
    const { runForOrg } = await import('../handlers/runSourcingJobs.js');
    const { startRun } = await import('../utils/sourcingRun.js');
    const cfg = { actorId: 'a', webhookUrl: WEBHOOK, queries: ['q1'], freshnessMonths: 3, maxPerRun: 0, ...cfgExtra };
    const run = startRun(db, ORG, 'test');
    const leg = run.leg({ target: TARGET, queries: cfg.queries });
    await runForOrg(db, 'tok', ORG, cfg, { fetchSerp: async () => serp4(), classify: classifyStub, target: TARGET, leg });
    await run.finish();
    return { db, funnel: db.store.get(`sourcingRuns/${run.id}`).funnel, relayBodies };
  };

  // ── Flags OFF: today's behaviour, but the buyer post must stay retryable while off-target dies.
  {
    const { db, funnel: f } = await runOnce({});
    assert.equal(f.relayed, 1, 'flags off: only the on-target listing relays');
    assert.equal(f.buyerDropped, 1, 'flags off: the seeking post is counted as a buyer drop');
    assert.equal(f.offTargetDropped, 2, 'flags off: wrong-locality listing + junk both drop as off-target class');
    assert.equal(f.buyerRelayed, 0);
    assert.equal(f.offTargetRelayed, 0);
    const seen = db.under(`sourcingSeen/${ORG}/keys/`);
    assert.ok(!seen.some((d) => d.url === P(202)), 'flags off: buyer post is NOT buried — enabling the flag later must still catch it');
    assert.ok(seen.some((d) => d.url === P(203) && d.dropped), 'flags off: confident off-target listing stays dead');
    assert.ok(seen.some((d) => d.url === P(204) && d.dropped), 'junk is dead');
  }

  // ── Flags ON: both lanes relay, tagged on the wire, on the seen doc, and in the counters.
  {
    const { db, funnel: f, relayBodies } = await runOnce({ buyerLeads: true, offTargetLeads: true });
    assert.equal(f.relayed, 3, 'flags on: listing + buyer + off-target all relay');
    assert.equal(f.buyerRelayed, 1, 'buyer lane counted');
    assert.equal(f.offTargetRelayed, 1, 'off-target lane counted');
    assert.equal(f.buyerDropped, 0);
    assert.equal(f.offTargetDropped, 1, 'only the junk still drops');
    const byUrl = new Map(relayBodies.map((b) => [b.listing.url, b.listing]));
    assert.equal(byUrl.get(P(201)).leadType, undefined, 'supply lead carries no tag');
    assert.equal(byUrl.get(P(202)).leadType, 'buyer', 'buyer lead tagged on the wire');
    assert.equal(byUrl.get(P(203)).leadType, 'off-target', 'off-target lead tagged on the wire');
    assert.equal(byUrl.get(P(203)).extracted.locality, 'Tambaram', 'off-target lead carries its REAL locality');
    const seen = db.under(`sourcingSeen/${ORG}/keys/`);
    assert.equal(seen.find((d) => d.url === P(202))?.leadType, 'buyer', 'seen doc records the lane');
    // Billing treats the lanes like any relayed lead (v1 — one unit price for all three).
    const txns = db.under('transactions/');
    assert.equal(txns[0].count, 3, 'all three relayed leads billed');
  }

  // ── maxPerRun is the SUPPLY lane's budget, not a shared one. Supply and off-target compete for it
  // (off-target is inventory too, just elsewhere); the buyer lane draws on `buyerMaxPerRun`, which
  // defaults to UNCAPPED. Before this split, a run capped at 25 spent all 25 on inventory and left
  // the demand leads on the floor every single run — the lane could never fill.
  {
    const { funnel: f, relayBodies } = await runOnce({ buyerLeads: true, offTargetLeads: true, maxPerRun: 1 });
    const relayedUrls = relayBodies.map((b) => b.listing.url);
    assert.equal(f.relayed, 2, 'supply cap 1 + uncapped buyer lane: the listing and the buyer lead');
    assert.ok(relayedUrls.includes(P(201)), 'cap: the on-target listing takes the supply budget');
    assert.ok(!relayedUrls.includes(P(203)), 'cap: off-target salvage is the first to defer — it shares supply’s budget');
    assert.ok(relayedUrls.includes(P(202)), 'cap: the buyer lead is NOT starved by the supply cap');
    assert.equal(f.buyerRelayed, 1);
    assert.equal(f.offTargetRelayed, 0);
    assert.equal(f.capDeferred, 1, 'the deferred off-target is recorded as deferred, not lost');
  }

  // ── …and the buyer lane can still be bounded on purpose, independently of supply.
  {
    const { funnel: f, relayBodies } = await runOnce({ buyerLeads: true, offTargetLeads: true, buyerMaxPerRun: 0, maxPerRun: 0 });
    assert.equal(f.buyerRelayed, 1, 'buyerMaxPerRun 0 = uncapped (the default)');
    assert.equal(relayBodies.length, 3, 'nothing capped: all three lanes relay');
  }

  console.log('\nclassify-lanes scenario: buyer + off-target salvage flags, tagging, retryability and lane priority ✓');
}

/**
 * The locality-unknown detour (3b → 3c2): a genuine listing whose SERP text NAMES no place (Google
 * truncated the title / served an adjacent post's snippet) must NOT die at the snippet gate — it
 * goes through the paid enrichment and is re-classified on the FULL post text. Pins the three
 * outcomes: full text confirms on-target (relays), full text confidently rejects (dead), and an
 * enrichment miss (retryable, never buried) — the 2026-07-17 Karamadai DTCP-plot miss, as a test.
 */
async function localityUnknownScenario() {
  const TARGET = { locality: 'Karamadai', city: 'Coimbatore' };
  const serp3 = () => [
    { url: P(301), title: 'DTCP Plot for Sale near ...', snippet: 'plot for sale main road' },
    { url: P(302), title: 'House for Sale near ...', snippet: 'house for sale 2bhk' },
    { url: P(303), title: 'Land for Sale near ...', snippet: 'land for sale 5 cent' },
  ];
  // Pass 1 sees only SERP text (no FULLTEXT marker) → locality unknown; pass 2 sees the enriched
  // post text and gives the authoritative verdict.
  const stub = async ({ text }) => {
    if (text.includes('FULLTEXT karamadai')) {
      return { keep: true, side: 'offering', isListing: true, localityMatches: true, localityNamed: true, confidence: 0.9, extracted: { listingType: 'Sale', locality: 'Karamadai', phone: '9876543210' } };
    }
    if (text.includes('FULLTEXT tambaram')) {
      return { keep: false, side: 'offering', isListing: true, localityMatches: false, localityNamed: true, confidence: 0.9, reason: 'off-target', extracted: { listingType: 'Sale', locality: 'Tambaram' } };
    }
    return { keep: false, side: 'offering', isListing: true, localityMatches: false, localityNamed: false, confidence: 0.9, reason: 'no locality named in the text' };
  };
  const ENRICHED3 = {
    [P(301)]: { text: 'FULLTEXT karamadai DTCP plot 6.5 cent contact 9876543210', time: new Date(FRESH).toISOString() },
    [P(302)]: { text: 'FULLTEXT tambaram house 2bhk', time: new Date(FRESH).toISOString() },
    // P(303) deliberately absent → enrichMissed → locality never judged → retryable drop
  };

  const db = new FakeDb();
  db.store.set(`orgSecrets/${ORG}`, { sourcing: { secret: 's3cret' } });
  db.store.set(`organisations/${ORG}`, { balance: 1000, name: 'Test Org' });
  const relayBodies = [];
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('apify')) {
      const body = JSON.parse(opts.body);
      const items = body.startUrls.map(({ url: u }) => (ENRICHED3[u] ? { facebookUrl: u, ...ENRICHED3[u] } : null)).filter(Boolean);
      return { ok: true, status: 200, json: async () => items };
    }
    relayBodies.push(JSON.parse(opts.body));
    return { ok: true, status: 200 };
  };

  const { runForOrg } = await import('../handlers/runSourcingJobs.js');
  const { startRun } = await import('../utils/sourcingRun.js');
  const cfg = { actorId: 'a', webhookUrl: WEBHOOK, queries: ['q1'], freshnessMonths: 3, maxPerRun: 0 };
  const run = startRun(db, ORG, 'test');
  const leg = run.leg({ target: TARGET, queries: cfg.queries });
  await runForOrg(db, 'tok', ORG, cfg, { fetchSerp: async () => serp3(), classify: stub, target: TARGET, leg });
  await run.finish();

  const f = db.store.get(`sourcingRuns/${run.id}`).funnel;
  assert.equal(f.localityPending, 3, 'all three survive the snippet gate as locality-unknown, not dead');
  assert.equal(f.offTargetDropped, 0, 'nothing dies on the truncated snippet alone');
  assert.equal(f.enriched, 3, 'every pending lead is worth the paid scrape');
  assert.equal(f.enrichMissed, 1, 'P(303) paid and returned nothing');
  assert.equal(f.fullTextConfirmed, 1, 'the full post confirmed the Karamadai plot');
  assert.equal(f.fullTextDropped, 1, 'the full post confidently placed P(302) elsewhere');
  assert.equal(f.localityUnresolved, 1, 'the enrich miss never got judged');
  assert.equal(f.relayed, 1, 'only the confirmed lead relays');

  assert.equal(relayBodies.length, 1);
  assert.equal(relayBodies[0].listing.url, P(301), 'the confirmed lead is the one delivered');
  assert.equal(relayBodies[0].listing.classifyStatus, 'verified', 'a full-text confirm is a verified lead');
  assert.equal(relayBodies[0].listing.extracted.locality, 'Karamadai');

  // Dedup fates: confirmed → seen+relayed; full-text reject → dead; enrich miss → NOT buried.
  const seen = db.under(`sourcingSeen/${ORG}/keys/`);
  assert.ok(seen.some((d) => d.url === P(301) && d.relayedAt && !d.dropped), 'confirmed lead marked seen');
  assert.ok(seen.some((d) => d.url === P(302) && d.dropped), 'full-text reject is dead — the authoritative text was seen');
  assert.ok(!seen.some((d) => d.url === P(303)), 'an unresolved lead stays retryable — never buried on a scrape miss');

  const leads = db.under(`sourcingRuns/${run.id}/leads/`);
  const fullDrops = leads.filter((l) => l.dropStage === 'classify-full');
  assert.deepEqual(fullDrops.map((l) => l.dropReason).sort(), ['locality-unresolved', 'off-target'], 'full-text drops name their reasons');
  console.log('\nlocality-unknown scenario: truncated-snippet listings enrich, re-classify on full text, and only die on evidence ✓');
}


/**
 * The dedicated BUYER lane (mode:'buyer'). Same pipeline, inverted side gate: a 'seeking' post is
 * the product and an 'offering' post is by-catch. Pins the four things that make the lane safe to
 * run alongside supply — every kept lead is tagged 'buyer' on the wire, the org's buyerLeads flag is
 * NOT required (asking for a buyer run is the opt-in), the by-catch listing is dropped RETRYABLY so
 * a buyer run can never delete inventory the supply lane wants, and off-target salvage stays off.
 */
async function buyerLaneScenario() {
  const TARGET = { locality: 'Velachery', city: 'Chennai' };
  const serp = () => [
    { url: P(501), title: 'wanted 2bhk', snippet: 'looking for 2bhk flat velachery' },
    { url: P(502), title: 'wanted plot', snippet: 'need plot velachery urgent' },
    { url: P(503), title: 'seller listing', snippet: 'flat for sale velachery' },
    { url: P(504), title: 'buyer elsewhere', snippet: 'looking for house tambaram' },
  ];
  const stub = async ({ text }) => {
    if (text.includes('wanted')) return { keep: true, side: 'seeking', isListing: true, localityMatches: true, confidence: 0.9, extracted: { listingType: 'Rent', locality: 'Velachery', bhk: '2' } };
    if (text.includes('seller listing')) return { keep: true, side: 'offering', isListing: true, localityMatches: true, confidence: 0.9, extracted: { listingType: 'Sale', locality: 'Velachery' } };
    return { keep: false, side: 'seeking', isListing: true, localityMatches: false, confidence: 0.9, reason: 'off-target', extracted: { listingType: 'Rent', locality: 'Tambaram' } };
  };

  const db = new FakeDb();
  db.store.set(`orgSecrets/${ORG}`, { sourcing: { secret: 's3cret' } });
  db.store.set(`organisations/${ORG}`, { balance: 1000, name: 'Test Org' });
  const relayBodies = [];
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('apify')) {
      const body = JSON.parse(opts.body);
      // Distinct posters, so buyer dedup (exercised in its own scenario) never fires here.
      const items = body.startUrls.map(({ url: u }) => ({ facebookUrl: u, text: `full ${u}`, time: new Date(FRESH).toISOString(), user: { id: `u${u.slice(-3)}` } }));
      return { ok: true, status: 200, json: async () => items };
    }
    relayBodies.push(JSON.parse(opts.body));
    return { ok: true, status: 200 };
  };

  const { runForOrg } = await import('../handlers/runSourcingJobs.js');
  const { startRun } = await import('../utils/sourcingRun.js');
  // buyerLeads deliberately UNSET and offTargetLeads ON: the mode must not need the by-product flag,
  // and must not pick up the off-target salvage lane either.
  const cfg = { actorId: 'a', webhookUrl: WEBHOOK, queries: ['q1'], freshnessMonths: 3, maxPerRun: 0, offTargetLeads: true };
  const run = startRun(db, ORG, 'test');
  const leg = run.leg({ target: TARGET, queries: cfg.queries, mode: 'buyer' });
  await runForOrg(db, 'tok', ORG, cfg, { fetchSerp: async () => serp(), classify: stub, target: TARGET, leg, mode: 'buyer' });
  await run.finish();

  const f = db.store.get(`sourcingRuns/${run.id}`).funnel;
  assert.equal(f.relayed, 2, 'both on-target demand posts relay');
  assert.equal(f.buyerRelayed, 2, 'every buyer-lane lead is counted in the buyer lane');
  assert.equal(f.supplyDropped, 1, 'the seller post is by-catch, counted as such');
  assert.equal(f.buyerDropped, 0, 'a buyer run never drops a buyer post for want of the org flag');
  assert.equal(f.offTargetRelayed, 0, 'off-target salvage stays a SUPPLY lane — a buyer looking elsewhere is nothing to us');

  const byUrl = new Map(relayBodies.map((b) => [b.listing.url, b.listing]));
  assert.equal(relayBodies.length, 2);
  assert.equal(byUrl.get(P(501)).leadType, 'buyer', 'tagged on the wire so the platform routes it to the buyer queue');
  assert.equal(byUrl.get(P(502)).leadType, 'buyer');

  const seen = db.under(`sourcingSeen/${ORG}/keys/`);
  assert.equal(seen.find((d) => d.url === P(501))?.leadType, 'buyer', 'the seen doc records the lane');
  assert.ok(!seen.some((d) => d.url === P(503)), 'the by-catch listing is NEVER buried — the supply lane must still be able to sell it');
  assert.ok(seen.some((d) => d.url === P(504) && d.dropped), 'a confidently off-target demand post is dead, as in supply mode');

  const leads = db.under(`sourcingRuns/${run.id}/leads/`);
  assert.equal(leads.find((l) => l.url === P(503))?.dropReason, 'supply-post', 'the by-catch names its own reason, not a generic off-target');

  const txns = db.under('transactions/');
  assert.equal(txns[0].count, 2, 'the buyer lane bills like any other relayed lead');
  console.log('\nbuyer-lane scenario: demand relays tagged, seller by-catch stays retryable, salvage stays supply-only ✓');
}

/**
 * BUYER repost dedup. A seeker posting the SAME requirement into five neighbourhood groups gets a
 * fresh URL each time and — unlike an owner — usually carries no phone, so ownerListingKey returns
 * null and the cross-run guard never fires. Keyed on the POSTER instead. Pins: the same poster's
 * repeat collapses, a DIFFERENT poster wanting the same thing is spared, and a post with no
 * identifiable author at all still relays (never deduped) rather than being silently dropped.
 */
async function buyerDedupScenario() {
  const TARGET = { locality: 'Velachery', city: 'Chennai' };
  const stub = async () => ({ keep: true, side: 'seeking', isListing: true, localityMatches: true, confidence: 0.9, extracted: { listingType: 'Rent', locality: 'Velachery', bhk: '2', propertyType: 'flat' } });
  // Same requirement, three posts: two from one seeker (a repost), one from someone else. The
  // fourth carries no author fields at all.
  // P(605) is the SAME seeker again on a later run, with a brand-new post URL.
  const AUTHOR = { [P(601)]: 'fb.com/seeker-a', [P(602)]: 'fb.com/seeker-a', [P(603)]: 'fb.com/seeker-b', [P(605)]: 'fb.com/seeker-a' };

  const db = new FakeDb();
  db.store.set(`orgSecrets/${ORG}`, { sourcing: { secret: 's3cret' } });
  db.store.set(`organisations/${ORG}`, { balance: 1000, name: 'Test Org' });
  const relayBodies = [];
  globalThis.fetch = async (url, opts) => {
    if (String(url).includes('apify')) {
      const body = JSON.parse(opts.body);
      const items = body.startUrls.map(({ url: u }) => ({
        facebookUrl: u, text: `need 2bhk flat velachery`, time: new Date(FRESH).toISOString(),
        ...(AUTHOR[u] ? { user: { profileUrl: AUTHOR[u] } } : {}),
      }));
      return { ok: true, status: 200, json: async () => items };
    }
    relayBodies.push(JSON.parse(opts.body));
    return { ok: true, status: 200 };
  };

  const { runForOrg } = await import('../handlers/runSourcingJobs.js');
  const { startRun } = await import('../utils/sourcingRun.js');
  const cfg = { actorId: 'a', webhookUrl: WEBHOOK, queries: ['q1'], freshnessMonths: 3, maxPerRun: 0 };
  const runOne = async (serp) => {
    const run = startRun(db, ORG, 'test');
    const leg = run.leg({ target: TARGET, queries: cfg.queries, mode: 'buyer' });
    await runForOrg(db, 'tok', ORG, cfg, { fetchSerp: async () => serp, classify: stub, target: TARGET, leg, mode: 'buyer' });
    await run.finish();
    return db.store.get(`sourcingRuns/${run.id}`).funnel;
  };

  const f1 = await runOne([
    { url: P(601), title: 'need 2bhk', snippet: 'need 2bhk flat velachery' },
    { url: P(602), title: 'need 2bhk again', snippet: 'need 2bhk flat velachery' },
    { url: P(603), title: 'need 2bhk too', snippet: 'need 2bhk flat velachery' },
    { url: P(604), title: 'need 2bhk anon', snippet: 'need 2bhk flat velachery' },
  ]);
  assert.equal(f1.ownerDupInRun, 1, 'the same seeker’s in-run repost collapses');
  assert.equal(f1.relayed, 3, 'one of the repost pair + the other seeker + the anonymous post');
  const r1 = new Set(relayBodies.map((b) => b.listing.url));
  assert.ok(r1.has(P(601)) && !r1.has(P(602)), 'the first of the pair wins');
  assert.ok(r1.has(P(603)), 'a DIFFERENT person wanting the same flat is spared — two real leads, not a dupe');
  assert.ok(r1.has(P(604)), 'no identifiable poster = no dedup, and it still relays');

  // Cross-run: the same seeker posts the requirement again, new URL. URL dedup can't see it.
  relayBodies.length = 0;
  const f2 = await runOne([{ url: P(605), title: 'need 2bhk still', snippet: 'need 2bhk flat velachery' }]);
  assert.equal(f2.ownerDupSeen, 1, 'the same seeker’s later-run repost is caught cross-run — the phone-less case ownerListingKey could never see');
  assert.equal(f2.relayed, 0, 'the same requirement is never delivered (or billed) twice');
  assert.equal(relayBodies.length, 0, 'the repost never reaches the webhook');
  assert.ok(db.under(`sourcingSeen/${ORG}/keys/`).some((d) => d.url === P(605) && d.dropped), 'the cross-run repost is marked dead so it is never re-enriched');
  console.log('\nbuyer-dedup scenario: same-seeker reposts collapse, distinct seekers and anonymous posts relay ✓');
}


/**
 * The buyer query's SHAPE. Deterministic, no Gemini — it pins the two string transforms that decide
 * what the lane actually searches for, both of which were written against a measured live failure.
 */
async function queryShapeScenario() {
  const { dedupOrGroup, excludeClause, intentModeOf } = await import('../utils/queryGen.js');

  // Translation is many-to-one: "house"/"home" both come back as வீடு, and the buyer group's
  // "need"/"required"/"requirement" all collapse to தேவை. A group that is three copies of one word
  // matches nothing extra and reads as a broken translation in the run panel.
  assert.equal(dedupOrGroup('வீடு OR மனை OR வீடு'), 'வீடு OR மனை');
  assert.equal(dedupOrGroup('தேவை OR தேவை OR தேவை'), 'தேவை');
  assert.equal(dedupOrGroup('a OR "b c" OR A'), 'a OR "b c"', 'case-insensitive, first spelling wins, order kept');
  assert.equal(dedupOrGroup(''), '', 'an empty group stays empty rather than becoming a stray operator');

  // The recruitment exclusion. Measured 2026-09-01: without it a buyer run over a COMMERCIAL target
  // returned 98 prospects and 0 leads, because `(office OR shop) AND (wanted OR required)` is how
  // "staff wanted for shop" is written — nearly every survivor was a hiring ad.
  const ex = excludeClause(['hiring', 'job', 'work from home', 'hiring', 'வேலை']);
  assert.equal(ex, '-hiring -job -"work from home" -வேலை', 'dedups, quotes multi-word terms, keeps local-language terms');
  assert.equal(excludeClause([]), '', 'no terms = no clause (never a dangling "-")');
  assert.equal(excludeClause(['', '  ', null]), '', 'blank terms never become a bare "-"');

  assert.equal(intentModeOf('buyer'), 'buyer');
  assert.equal(intentModeOf('nonsense'), 'supply', 'an unknown mode degrades to supply, never to a broken query');
  console.log('\nquery-shape scenario: OR-group dedup + recruitment exclusion ✓');
}

main().catch((e) => { console.error('\n❌', e.message); console.error(e.stack); process.exit(1); });
