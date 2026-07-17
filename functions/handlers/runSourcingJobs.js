import { onSchedule } from 'firebase-functions/v2/scheduler';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { callSerpActor, listingKey, signPayload, enrichPosts, isIndividualPost, tbsForMonths, cutoffMsForMonths, DEFAULT_FRESHNESS_MONTHS, fetchQueryMatrix, normalizeSourcingPolicy, hasIndiaSignal } from '../utils/sourcing.js';
import { classifyListing, hasPropertySignal } from '../utils/classifyListing.js';
import { buildSourcingQueries } from '../utils/queryGen.js';
import { priceForSourcedBatch } from '../utils/billing.js';
import { startRun, NULL_LEG } from '../utils/sourcingRun.js';
import { APIFY_TOKEN } from '../utils/secrets.js';

// How many demand-ranked targets the DAILY cron sources per org when a matrixUrl is configured
// (each further bounded by the org's maxPerRun). Conservative by default so a day's spend stays
// small; an org can widen it via sourcing.topN. The manual adminSourceTopTarget probe passes its own.
const CRON_TOPN = 5;

// How many QUERIES the platform matrix may emit per pull (it caps queries, ~2 per target). The old
// hardcoded 12 throttled us to ~7 targets even when far more localities were due; default wide and
// let an org override via sourcing.matrixLimit.
const DEFAULT_MATRIX_LIMIT = 40;

// A demand-matrix target whose locality is really an intent phrase ("For Sale") or whose city is a
// comma-joined facet list is junk (upstream data leakage) — skip it so we never burn a run geocoding
// it. Mirrors isPlausibleLocality on the platform; kept here as defence against a stale matrix.
function isPlausibleTarget(t) {
  const loc = String(t?.locality || '').trim();
  if (!loc) return false;
  if (/^for\s+(sale|rent|lease)$/i.test(loc) || /^(sale|rent|lease)$/i.test(loc)) return false;
  if (String(t?.city || '').includes(',')) return false;
  return true;
}
// Gemini auth is Vertex/ADC (the runtime service account) — no bound secret needed. VERTEX_PROJECT /
// VERTEX_LOCATION come from .env; see utils/gemini.js.

// When a run targets a specific locality, enrich a slightly larger pool than the cap so the residual
// authoritative-date drop (after the cheap SERP-date + Gemini snippet gates) can still fill maxPerRun.
// Lowered 3→2 now that the relevance + coarse-date gates run BEFORE enrichment (see 3a/3b): far less
// junk reaches the paid scraper, so a smaller buffer suffices. Bounds extra Apify cost to 2× maxPerRun.
const CLASSIFY_OVERSAMPLE = 2;

// Scheduled sourced-listing relay (see utils/sourcing.js). Every 30 MINUTES AROUND THE CLOCK (48
// runs/day — tightened from every-2h on 2026-07-17 alongside topN 5→3: smaller, faster runs that
// check for DUE targets far more often, pushing toward the 500-leads/day target. A run with no due
// targets no-ops in ~2s, so the extra frequency is near-free when the matrix has nothing fresh), for
// every org with sourcing.enabled: fetch listings via Apify across the org's query matrix, dedup them
// FOREVER against sourcingSeen/{orgId}/keys, HMAC-sign + POST each NEW one to the org's webhook, and
// debit the org wallet a small per-listing fee for the ones that were accepted (2xx). Each pull
// serves the next DUE targets (the platform stamps lastServedAt), so intra-day runs rotate through
// different localities rather than re-hitting the morning's. This is a separate, near-zero-COGS
// metered lane — it never touches the managed-agent pipeline or finalize.js.

const RELAY_CONCURRENCY = 10;
// Separate, LOWER fan-out for the Gemini classify gate. The webhook relay (RELAY_CONCURRENCY) is our
// own endpoint and tolerates 10 in flight, but the classify pool hammers Vertex — 10 concurrent
// flash-lite calls per target, bursting across every target, is what trips the per-minute quota and
// returns 429 RESOURCE_EXHAUSTED (which fails a lead OPEN to 'unverified'). 4 keeps throughput healthy
// while staying under the quota; raise it only alongside a Vertex quota increase.
const CLASSIFY_CONCURRENCY = 4;
const RELAY_TIMEOUT_MS = 15000;
// Wall-clock budget for one cron invocation. A scheduled function is HARD-capped at 1800s (30 min);
// each demand-matrix target is a slow serial chain (SERP fetch → Gemini classify → paid FB enrich →
// webhook relay), so a full topN batch can blow past that wall and be KILLED mid-run — which strands
// the run doc at status:'running' FOREVER, because finish() (which writes the funnel + flips status)
// only runs after the target loop. Stop STARTING new targets once we've spent this budget and finish()
// cleanly as 'partial'; the untouched targets are re-served next run (seen/dead dedup keeps their
// marginal cost ~0). 20 min sits under the 25-min hard timeout AND well under the 30-min cron cadence,
// so a run always finishes before the next one fires (no overlap) with room for finish()'s writes.
const RUN_BUDGET_MS = 20 * 60 * 1000;
// FB enrichment batching: URLs per actor run × concurrent runs. 10/run keeps each run-sync call
// fast (a 2-post batch measured ~7s; 10 stays well inside the sync window) while paying the flat
// actor-start fee once per 10 posts instead of per post. 3 concurrent runs ≈ the old effective
// throughput without holding 10 sockets open.
const ENRICH_BATCH_SIZE = 10;
const ENRICH_BATCH_CONCURRENCY = 3;
// Grace applied to the cheap SERP-date pre-filter so Google's coarse relative buckets never
// false-drop a borderline-fresh post before the authoritative FB-date gate sees it (~1 month).
const SERP_DATE_GRACE_MS = 30 * 24 * 60 * 60 * 1000;
const GETALL_CHUNK = 300; // Firestore getAll batch size for the dedup lookup

export const runSourcingJobs = onSchedule(
  {
    region: 'asia-south1',
    schedule: '*/30 * * * *', // every 30 min, 24h — 48 runs/day (topN 3 → each run ~8 min)
    timeZone: 'Asia/Kolkata',
    secrets: [APIFY_TOKEN],
    // 1500s (25 min) < the 30-min cadence, so a slow run can never overlap the next tick. A topN-3 run
    // measures ~8 min; the 20-min RUN_BUDGET_MS caps it well below this anyway. If a run ever hits the
    // wall, the every-30-min cadence + seen/dead dedup pick up the remaining due targets next run — no
    // lead is lost, just deferred.
    timeoutSeconds: 1500,
    memory: '512MiB',
  },
  async () => {
    const db = getFirestore();
    const apifyToken = process.env.APIFY_TOKEN;
    const snap = await db.collection('organisations').where('sourcing.enabled', '==', true).get();
    for (const orgDoc of snap.docs) {
      try {
        const cfg = orgDoc.data().sourcing || {};
        // Smart path when the org has a demand matrix: source the top due target(s) via the
        // platform's demand ranking + Gemini bilingual queries + relevance gate (dryRun:false so the
        // platform advances each target's cadence, rotating through localities day to day). Orgs with
        // only static `queries` fall back to the flat fetch → relay path.
        if (cfg.matrixUrl) {
          await sourceTopTargets(db, apifyToken, orgDoc.id, cfg, {
            topN: Math.max(1, Math.floor(Number(cfg.topN) || CRON_TOPN)),
            dryRun: false,
            trigger: 'cron',
          });
        } else {
          // Static-query org: no matrix, so no per-target legs — the run is one leg over cfg.queries.
          const run = startRun(db, orgDoc.id, 'cron');
          try {
            await runForOrg(db, apifyToken, orgDoc.id, cfg, {
              leg: run.leg({ queries: cfg.queries || [] }),
            });
            await run.finish();
          } catch (e) {
            await run.finish({ status: 'error', error: e?.message || String(e) });
            throw e;
          }
        }
      } catch (e) {
        // Best-effort per org — one org's Apify/webhook failure must not block the others.
        console.error('runSourcingJobs:org', orgDoc.id, e?.message || e);
      }
    }
  },
);

// Exported for the emulator/E2E test harness (lets tests inject a stubbed serp fetcher + rng).
// `queries`/`freshness` overrides let a caller source a SPECIFIC set of queries (e.g. the top target
// pulled from the platform matrix) instead of the org's static cfg.queries — see adminSourceTopTarget.
export async function runForOrg(
  db,
  apifyToken,
  orgId,
  cfg,
  { fetchSerp = callSerpActor, rng, queries: queriesOverride, freshness: freshnessOverride, target, policy, leg = NULL_LEG } = {},
) {
  const secretSnap = await db.collection('orgSecrets').doc(orgId).get();
  const secret = secretSnap.exists ? secretSnap.data()?.sourcing?.secret : null;
  if (!secret) {
    console.error('runSourcingJobs:no-secret', orgId);
    leg.done({ note: 'no secret' });
    return { relayed: 0, amountInr: 0 };
  }
  const { actorId, webhookUrl } = cfg;
  const queries = queriesOverride && queriesOverride.length ? queriesOverride : (cfg.queries || []);
  // Recency window (last N months). Google's `tbs` is a VALID custom date range computed at runtime —
  // the old stored `qdr:m3` was silently ignored by Google (only qdr:d/w/m/y exist), so any-age posts
  // leaked through. That SERP filter is best-effort; the AUTHORITATIVE gate is `cutoffMs`, applied to
  // each post's real FB timestamp after enrichment (see step 3b2).
  const months = Math.min(60, Math.max(1, Math.floor(Number(cfg.freshnessMonths)) || DEFAULT_FRESHNESS_MONTHS));
  const freshness = freshnessOverride ?? tbsForMonths(months);
  const cutoffMs = cutoffMsForMonths(months);
  if (!actorId || !webhookUrl || !queries.length) {
    leg.done({ note: 'not configured (actorId / webhookUrl / queries)' });
    return { relayed: 0, amountInr: 0 };
  }

  // 1) Fetch every query, flatten the results. `maxPages` controls SERP depth per query (supply).
  const maxPages = cfg.maxPagesPerQuery;
  const all = [];
  for (const query of queries) {
    const items = await fetchSerp({ apifyToken, actorId, query, freshness, maxPages });
    // Query provenance — relayed with the listing so the receiver can audit WHY a lead was fetched.
    for (const it of items) if (it && !it.sourceQuery) it.sourceQuery = query;
    all.push(...items);
  }

  // 2) Keep only individual posts (real listings that enrich); drop group/page landing pages. Then
  // dedup WITHIN this run by canonical listing key.
  const posts = all.filter((it) => it?.url && isIndividualPost(it.url));
  console.log('runSourcingJobs:filter', orgId, JSON.stringify({ fetched: all.length, posts: posts.length }));
  leg.count('fetched', all.length);
  leg.count('posts', posts.length);
  const local = new Map();
  for (const it of posts) {
    const key = listingKey(it.url);
    if (!local.has(key)) local.set(key, it);
  }
  leg.count('dupInRun', posts.length - local.size);
  if (!local.size) {
    console.log('runSourcingJobs:no-results', orgId);
    leg.done({ note: 'no individual posts in SERP results' });
    return { relayed: 0, amountInr: 0 };
  }

  // 3) Drop keys we've EVER relayed for this org (dedup forever).
  const seenCol = db.collection('sourcingSeen').doc(orgId).collection('keys');
  const keys = [...local.keys()];
  const already = new Set();
  for (let i = 0; i < keys.length; i += GETALL_CHUNK) {
    const refs = keys.slice(i, i + GETALL_CHUNK).map((k) => seenCol.doc(k));
    const snaps = await db.getAll(...refs);
    for (const s of snaps) if (s.exists) already.add(s.id);
  }
  const allNew = keys.filter((k) => !already.has(k)).map((k) => ({ key: k, listing: local.get(k) }));
  leg.count('seenBefore', already.size);
  leg.count('newProspects', allNew.length);
  if (!allNew.length) {
    console.log('runSourcingJobs:all-seen', orgId);
    leg.done({ note: 'every result already seen (dedup-forever)' });
    return { relayed: 0, amountInr: 0 };
  }

  // Dead-link dedup: a listing that we ENRICH and then drop for a PERMANENT reason (too old, no
  // property signal, or a confident off-target classify) is written to sourcingSeen too — so the
  // expensive FB enrichment is paid ONCE, never re-paid on the next run for the same dead post. Safe
  // because a post only gets older and a deterministic/confident reject won't change. We DELIBERATELY
  // do NOT record transient drops — a degraded-classifier fail-open or a failed relay must retry, so
  // a Gemini outage never permanently buries a good lead (cf. the 2026-07-13 classify incident).
  const dead = new Map();
  const markDead = (c, reason) => {
    if (c?.key && c.listing?.url && !dead.has(c.key)) {
      dead.set(c.key, { url: c.listing.url, dropReason: reason, postedAt: c.listing.postedAt || null });
    }
  };
  const flushDead = async () => {
    if (!dead.size) return;
    const entries = [...dead.entries()];
    for (let i = 0; i < entries.length; i += 400) {
      const batch = db.batch();
      for (const [k, info] of entries.slice(i, i + 400)) {
        batch.set(seenCol.doc(k), {
          url: info.url,
          dropped: true, // distinguishes an enriched-but-dropped record from a relayed one
          dropReason: info.dropReason,
          postedAt: info.postedAt,
          examinedAt: FieldValue.serverTimestamp(),
        });
      }
      await batch.commit();
    }
    console.log('runSourcingJobs:dead-marked', orgId, JSON.stringify({ count: dead.size }));
    dead.clear(); // idempotent across the multiple flush sites below
  };

  // Per-run cap: relay at most `maxPerRun` NEW listings (0 / unset = no cap). The vetting gates below
  // (cheap SERP-date skip + Gemini relevance on the free snippet) run BEFORE the paid enrichment now,
  // so we only ever scrape posts we actually intend to relay — plus a small OVERSAMPLE buffer to cover
  // the residual authoritative-date drop. Overflow isn't marked seen, so the next run picks it up.
  const cap = Math.max(0, Math.floor(Number(cfg.maxPerRun) || 0));
  const classifying = !!(target && target.locality);

  // 3a) CHEAP SERP-date pre-filter (fail-open). Google's SERP already carries a coarse relative
  // "lastUpdated" (parsed to serpAgeMs = the youngest plausible instant for the phrase). Skip posts it
  // reports as older than the window BEFORE paying to enrich — this is what removes the bulk of the
  // "enrich a post just to read a stale date, then discard it" spend. serpAgeMs is Google's last-seen-
  // update, NOT the true post date, so we only DROP the confidently-old and KEEP everything
  // unknown/recent for the authoritative FB-date gate (3d) below. NOT marked dead (coarse, non-
  // authoritative): a cheap SERP re-fetch next run just re-skips it, and we never permanently bury a
  // lead on a non-authoritative date.
  let prospects = allNew;
  if (cutoffMs) {
    // Grace margin: Google's relative buckets are coarse ("3 months ago" can be a post still inside a
    // 3-month window), so only skip when the SERP age is CLEARLY past the cutoff — ~one month beyond.
    // Borderline posts fall through to the authoritative FB-date gate (3d) rather than being dropped
    // here unseen. Cheap-to-catch clearly-old posts (4+ months for a 3-month window) still get skipped.
    const serpSkipBefore = cutoffMs - SERP_DATE_GRACE_MS;
    const before = prospects.length;
    const kept = [];
    for (const c of prospects) {
      if (c.listing.serpAgeMs && c.listing.serpAgeMs < serpSkipBefore) {
        leg.lead({ key: c.key, listing: c.listing, stage: 'dropped', dropStage: 'serp-date', dropReason: 'serp-stale' });
      } else kept.push(c);
    }
    prospects = kept;
    const dropped = before - prospects.length;
    leg.count('serpStaleSkipped', dropped);
    if (dropped) console.log('runSourcingJobs:serp-stale-skip', orgId, JSON.stringify({ dropped, kept: prospects.length, cutoff: new Date(serpSkipBefore).toISOString().slice(0, 10) }));
  }
  if (!prospects.length) {
    console.log('runSourcingJobs:none-after-serp-date', orgId);
    leg.done({ note: 'all prospects skipped by the SERP-date pre-filter' });
    return { relayed: 0, amountInr: 0 };
  }

  // 3b) Relevance gate (only when targeting a specific locality) — MOVED AHEAD of enrichment. A cheap
  // deterministic pre-filter, then a Gemini classify on the FREE SERP snippet, so the paid FB scrape
  // only runs on plausible on-target listings (kills the ~29% we used to enrich then reject). Fails
  // OPEN per-post (keep) so a classifier hiccup never loses leads; Gemini COGS is negligible vs an
  // Apify post scrape, so classifying the whole prospect pool is cheap.
  if (classifying) {
    await mapLimit(prospects, CLASSIFY_CONCURRENCY, async (c) => {
      if (!hasPropertySignal(c.listing.snippet)) {
        c.drop = true;
        c.dropReason = 'no-signal';
        return;
      }
      const verdict = await classifyListing({
        text: c.listing.snippet,
        locality: target.locality,
        city: target.city,
        shape: target.shape,
      });
      if (!verdict.keep && !verdict.degraded) {
        c.drop = true;
        c.dropReason = verdict.reason || 'off-target';
        return;
      }
      // Degraded fail-open is SIGNAL-GATED: when the classifier is down we still relay plausible
      // Indian listings (Indian mobile / ₹-lakh-crore price / the target locality named in the text)
      // but drop everything else — a Gemini outage must not relay+bill US solar-contract posts.
      if (verdict.degraded && !hasIndiaSignal(`${c.listing.title || ''} ${c.listing.snippet || ''}`, target.locality)) {
        c.drop = true;
        c.dropReason = 'degraded-no-india-signal';
        return;
      }
      // Provenance for the receiver: 'verified' = Gemini confirmed the lead; 'unverified' = the
      // classifier errored and the fail-open kept it (human consent call is the backstop).
      c.listing.classifyStatus = verdict.degraded ? 'unverified' : 'verified';
      if (verdict.extracted?.phone && !c.listing.phone) c.listing.phone = verdict.extracted.phone;
      if (verdict.extracted) c.listing.extracted = verdict.extracted;
    });
    // Only a CONFIDENT off-target reject is dead — never enrich it again. Two rejects are deliberately
    // NOT recorded so they retry: the transient 'degraded-no-india-signal' fail-open (classifier down),
    // and 'no-signal' — because that deterministic pre-filter now sees only the short SERP snippet, so
    // a genuine listing with a sparse Google description must get another chance, not be buried unseen.
    const RETRYABLE_DROP = new Set(['degraded-no-india-signal', 'no-signal']);
    for (const c of prospects) {
      if (c.drop && !RETRYABLE_DROP.has(c.dropReason)) markDead(c, c.dropReason || 'off-target');
    }
    for (const c of prospects) {
      if (!c.drop) continue;
      // Split the three classify rejects apart: they mean very different things. 'no-signal' is our
      // own cheap filter, 'off-target' is Gemini rejecting a real listing, and the degraded drop
      // means the classifier was DOWN — a spike there is an incident, not a dry locality.
      if (c.dropReason === 'no-signal') leg.bump('noSignalDropped');
      else if (c.dropReason === 'degraded-no-india-signal') leg.bump('degradedDropped');
      else leg.bump('offTargetDropped');
      leg.lead({ key: c.key, listing: c.listing, stage: 'dropped', dropStage: 'classify', dropReason: c.dropReason || 'off-target' });
    }
    const kept = prospects.filter((c) => !c.drop);
    console.log('runSourcingJobs:classify', orgId, JSON.stringify({ pool: prospects.length, kept: kept.length, target: target.locality }));
    prospects = kept;
  }
  if (!prospects.length) {
    console.log('runSourcingJobs:none-after-classify', orgId);
    await flushDead();
    leg.done({ note: 'all prospects rejected by the relevance gate' });
    return { relayed: 0, amountInr: 0 };
  }

  // 3c) Trim to the enrichment pool, THEN pay to enrich. Only vetted prospects reach the paid FB
  // scraper; a small OVERSAMPLE covers the residual authoritative-date drop below.
  const poolSize = cap > 0 ? (classifying ? cap * CLASSIFY_OVERSAMPLE : cap) : prospects.length;
  let candidates = poolSize > 0 ? prospects.slice(0, poolSize) : prospects;
  // Vetted prospects we chose not to enrich this run. Recorded as 'deferred', NOT 'dropped' — they
  // aren't marked seen, so the next run re-fetches and relays them. Reading these as losses would
  // badly understate the pipeline.
  for (const c of prospects.slice(candidates.length)) {
    leg.bump('poolDeferred');
    leg.lead({ key: c.key, listing: c.listing, stage: 'deferred', dropStage: 'pool-cap', dropReason: 'over enrich pool for this run' });
  }

  // 3c1) Enrich the surviving listings with the FULL Facebook post (the SERP snippet is truncated) —
  // the complete description, the owner phone, the post photos, and the AUTHORITATIVE post date.
  // BATCHED: the scraper bills a flat actor-start fee per run on top of the per-post fee, so we send
  // chunks of URLs per run instead of one run per post (~15% cheaper + far fewer HTTP round-trips).
  // Chunks stay small so each run-sync call finishes well inside its window. Best-effort — a post the
  // batch couldn't scrape just keeps its SERP snippet (same fail-open as the old single-run miss).
  const chunks = [];
  for (let i = 0; i < candidates.length; i += ENRICH_BATCH_SIZE) chunks.push(candidates.slice(i, i + ENRICH_BATCH_SIZE));
  await mapLimit(chunks, ENRICH_BATCH_CONCURRENCY, async (chunk) => {
    const enrichedByUrl = await enrichPosts({ apifyToken, urls: chunk.map((c) => c.listing.url) });
    for (const c of chunk) {
      const enriched = enrichedByUrl.get(c.listing.url);
      // An enrich miss is the paid scrape we bought and got nothing for — the direct Apify-waste
      // signal, and the reason a lead can reach the webhook with only its SERP snippet.
      if (!enriched) {
        leg.bump('enrichMissed');
        continue;
      }
      if (enriched.text && enriched.text.length > String(c.listing.snippet || '').length) {
        c.listing.snippet = enriched.text;
      }
      if (enriched.phone) c.listing.phone = enriched.phone;
      if (enriched.postedAt) c.listing.postedAt = enriched.postedAt;
      // Post photos ride to the webhook on the listing itself; only set when found (no empty arrays).
      if (enriched.images?.length) c.listing.images = enriched.images;
    }
  });
  const withImages = candidates.filter((c) => c.listing.images?.length).length;
  console.log('runSourcingJobs:images', orgId, JSON.stringify({ withImages, enriched: candidates.length }));
  leg.count('enriched', candidates.length);
  leg.count('withImages', withImages);
  leg.count('withPhone', candidates.filter((c) => c.listing.phone).length);

  // 3d) AUTHORITATIVE recency gate on the actual FB post date (the SERP skip in 3a was only a coarse
  // pre-filter). Drop anything we now KNOW is older than the window. Fail-OPEN when the date is unknown
  // (enrichment miss) so a scrape hiccup doesn't silently lose fresh leads. The `dropped` count here is
  // a FREE quality signal — it's exactly what the cheap SERP date under-caught, so it tells us how
  // reliable `lastUpdated` is. postedAt rides to the webhook so the platform can enforce/display it too.
  if (cutoffMs) {
    const before = candidates.length;
    const keptRecent = [];
    for (const c of candidates) {
      // Known-old post (fail-open on unknown date) — permanently dead: it can only get older.
      if (c.listing.postedAt && c.listing.postedAt < cutoffMs) {
        markDead(c, 'stale-recency');
        leg.bump('recencyDropped');
        leg.lead({ key: c.key, listing: c.listing, stage: 'dropped', dropStage: 'recency', dropReason: 'stale-recency' });
      } else keptRecent.push(c);
    }
    candidates = keptRecent;
    const dropped = before - candidates.length;
    if (dropped) console.log('runSourcingJobs:stale-drop', orgId, JSON.stringify({ dropped, keptAfter: candidates.length, cutoff: new Date(cutoffMs).toISOString().slice(0, 10) }));
    if (!candidates.length) {
      console.log('runSourcingJobs:none-after-recency', orgId);
      await flushDead();
      leg.done({ note: 'every enriched post was older than the org freshness window' });
      return { relayed: 0, amountInr: 0 };
    }
  }

  // 3e) Per-intent freshness gate (classify path) — the org-level cutoff above (3d) is the OUTER
  // bound; this tightens it per listing intent now that classify told us Sale vs Rent. Rent/lease
  // leads go stale fast (rentMonths); sale or UNKNOWN intent gets the wider saleMonths window (fail-
  // open to the wider window, mirroring the classify philosophy). Unknown postedAt is kept (same
  // fail-open as 3d — never drop on a missing date).
  if (classifying) {
    const pol = normalizeSourcingPolicy(policy);
    const saleCutoff = cutoffMsForMonths(pol.saleMonths);
    const rentCutoff = cutoffMsForMonths(pol.rentMonths);
    const fresh = [];
    const staleDropped = [];
    for (const c of candidates) {
      const intent = String(c.listing.extracted?.listingType || '');
      const intentCutoff = /rent|lease/i.test(intent) ? rentCutoff : saleCutoff;
      if (c.listing.postedAt && c.listing.postedAt < intentCutoff) staleDropped.push(c);
      else fresh.push(c);
    }
    for (const c of fresh) c.listing.freshness = 'fresh';

    // Stale fallback: a target with ZERO fresh survivors still deserves its best stale leads —
    // re-admit up to fallbackMaxLeads, most-recent first, marked so the receiver can badge them.
    let gated = fresh;
    let readmitted = 0;
    if (!fresh.length && staleDropped.length) {
      staleDropped.sort((a, b) => b.listing.postedAt - a.listing.postedAt); // postedAt always set here
      gated = staleDropped.slice(0, pol.fallbackMaxLeads);
      for (const c of gated) c.listing.freshness = 'stale-fallback';
      readmitted = gated.length;
    }
    if (staleDropped.length) {
      console.log('runSourcingJobs:intent-stale-drop', orgId, JSON.stringify({
        dropped: staleDropped.length, readmitted, fresh: fresh.length,
        saleMonths: pol.saleMonths, rentMonths: pol.rentMonths, target: target.locality,
      }));
    }
    candidates = cap > 0 ? gated.slice(0, cap) : gated;
    leg.count('staleReadmitted', readmitted);
    // Intent-stale posts that survive neither the fresh cut nor the stale-fallback re-admit are dead
    // (recency-based, only get older). Anything still in the final relay set is spared.
    const survivorKeys = new Set(candidates.map((c) => c.key));
    for (const c of staleDropped) {
      if (!survivorKeys.has(c.key)) {
        markDead(c, 'stale-intent');
        leg.bump('intentStaleDropped');
        leg.lead({
          key: c.key, listing: c.listing, stage: 'dropped', dropStage: 'intent-freshness',
          dropReason: `stale-intent (${c.listing.extracted?.listingType || 'unknown intent'})`,
        });
      }
    }
    // Fresh-and-vetted leads left on the floor purely by maxPerRun — not seen, so the next run
    // relays them. 'deferred', never a drop.
    for (const c of gated.slice(candidates.length)) {
      leg.bump('capDeferred');
      leg.lead({ key: c.key, listing: c.listing, stage: 'deferred', dropStage: 'max-per-run', dropReason: 'over maxPerRun for this run' });
    }
  }
  if (!candidates.length) {
    console.log('runSourcingJobs:none-after-freshness', orgId);
    await flushDead();
    leg.done({ note: 'no leads survived the per-intent freshness gate' });
    return { relayed: 0, amountInr: 0 };
  }

  // 4) Relay each new listing; mark it seen ONLY on a 2xx (charge-on-delivery).
  let relayed = 0;
  const relayedDates = [];
  leg.count('relayAttempted', candidates.length);
  await mapLimit(candidates, RELAY_CONCURRENCY, async ({ key, listing }) => {
    const ok = await relayOne({ webhookUrl, secret, orgId, listing });
    if (ok) {
      await seenCol.doc(key).set({
        url: listing.url,
        title: listing.title || '',
        postedAt: listing.postedAt || null, // FB post date (for recency audits)
        relayedAt: FieldValue.serverTimestamp(),
      });
      if (listing.postedAt) relayedDates.push(listing.postedAt);
      relayed += 1;
      leg.lead({ key, listing, stage: 'relayed' });
    } else {
      // A webhook reject is the one drop that costs us everything (SERP + classify + the paid FB
      // scrape) and earns nothing — it must be visible, not buried in a log line.
      leg.bump('relayFailed');
      leg.lead({ key, listing, stage: 'dropped', dropStage: 'relay', dropReason: 'webhook did not return 2xx' });
    }
  });
  leg.count('relayed', relayed);
  // Persist the enriched-but-dropped links so they're never re-enriched (covers the normal path and
  // the relayed-0 path below). Runs after relay so a listing is never both relayed and marked dead.
  await flushDead();
  if (!relayed) {
    console.log('runSourcingJobs:relayed-0', orgId);
    leg.done({ note: 'every relay attempt was rejected by the webhook' });
    return { relayed: 0, amountInr: 0 };
  }
  // Audit: the date span of what we relayed — proves the recency gate holds in the real relay path.
  if (relayedDates.length) {
    relayedDates.sort((a, b) => a - b);
    console.log('runSourcingJobs:relayed-dates', orgId, JSON.stringify({
      withDate: relayedDates.length, total: relayed,
      oldest: new Date(relayedDates[0]).toISOString().slice(0, 10),
      newest: new Date(relayedDates[relayedDates.length - 1]).toISOString().slice(0, 10),
    }));
  }

  // 5) One transactional debit for the whole batch (org may go negative — operator reconciles).
  const { amountInr, unitPrices } = priceForSourcedBatch(relayed, rng ? { rng } : {});
  if (amountInr > 0) {
    await db.runTransaction(async (tx) => {
      const orgRef = db.collection('organisations').doc(orgId);
      const orgSnap = await tx.get(orgRef);
      if (!orgSnap.exists) return;
      const balance = Number(orgSnap.data().balance ?? 0);
      tx.update(orgRef, { balance: balance - amountInr });
      tx.set(db.collection('transactions').doc(), {
        orgId,
        type: 'debit',
        kind: 'sourcing',
        amount: amountInr,
        count: relayed,
        unitPrices,
        createdAt: FieldValue.serverTimestamp(),
      });
    });
  }
  console.log('runSourcingJobs:done', orgId, JSON.stringify({ relayed, amountInr }));
  leg.done({ relayed, amountInr });
  return { relayed, amountInr };
}

// Source the org's top demand-ranked target(s) from the platform matrix — the SMART path shared by
// the daily cron (dryRun:false, advances cadence) and the manual adminSourceTopTarget probe
// (dryRun:true, leaves cadence untouched). Pulls the demand-ranked matrix, takes the top `topN`
// targets, builds Gemini bilingual queries (full English name + the locality's own regional script,
// language chosen by Gemini per target) per target, and runs
// the normal fetch → dedup → enrich → relevance-gate → signed relay for each. Wallet debits aggregate
// across targets. Degrade-safe: a null matrix or a target with no queries is skipped, not fatal.
export async function sourceTopTargets(db, apifyToken, orgId, cfg, { topN = 1, dryRun = true, trigger = 'admin-top-target' } = {}) {
  if (!cfg.matrixUrl) return { ok: true, relayed: 0, amountInr: 0, note: 'no matrixUrl' };
  const secretSnap = await db.collection('orgSecrets').doc(orgId).get();
  const secret = secretSnap.exists ? secretSnap.data()?.sourcing?.secret : null;
  if (!secret) return { ok: false, relayed: 0, amountInr: 0, note: 'no secret' };

  // Recording starts only once we know the run will really pull the matrix — a no-matrixUrl / no-
  // secret org is a config state, not a run, and would just litter the panel with empty rows.
  const run = startRun(db, orgId, trigger);
  try {
    const limit = Math.max(1, Math.floor(Number(cfg.matrixLimit) || DEFAULT_MATRIX_LIMIT));
    const matrix = await fetchQueryMatrix({ matrixUrl: cfg.matrixUrl, secret, limit, maxTargets: topN, dryRun });
    const returned = Array.isArray(matrix?.targets) ? matrix.targets : [];
    const targets = returned.filter(isPlausibleTarget);
    // Per-intent freshness policy — the platform sends it alongside the targets (fetchQueryMatrix
    // already normalized it over DEFAULT_SOURCING_POLICY, so an older platform just yields defaults).
    const policy = matrix.policy;
    const chosen = targets.slice(0, topN);
    run.matrix({
      limit,
      dryRun,
      topN,
      targetsReturned: returned.length,
      // A junk target (an intent phrase like "For Sale" as a locality) means upstream data leakage —
      // worth showing rather than silently filtering, since it's a bug signal on the platform side.
      targetsSkippedAsJunk: returned.length - targets.length,
      junkExamples: returned.filter((t) => !isPlausibleTarget(t)).slice(0, 5)
        .map((t) => `${t?.locality ?? '?'} / ${t?.city ?? '?'}`),
      targetsChosen: chosen.length,
      policy: policy || null,
    });

    if (!targets.length) {
      run.note('matrix returned no plausible due targets');
      await run.finish();
      return { ok: true, relayed: 0, amountInr: 0, note: 'no due targets' };
    }

    let relayed = 0;
    let amountInr = 0;
    const perTarget = [];
    const startedMs = Date.now();
    let budgetHit = false;
    for (const t of chosen) {
      // Never START a target we can't afford to finish before the 30-min scheduler wall kills us —
      // a killed run never reaches finish() and strands its doc at status:'running'. The remaining
      // targets aren't lost: they're the next-due ones and get re-served on the following cron.
      if (Date.now() - startedMs > RUN_BUDGET_MS) {
        budgetHit = true;
        run.note(`wall-clock budget reached after ${perTarget.length}/${chosen.length} targets — the rest are deferred to the next run`);
        console.warn('runSourcingJobs:budget-stop', orgId, JSON.stringify({ done: perTarget.length, total: chosen.length }));
        break;
      }
      const smart = await buildSourcingQueries({ locality: t.locality, city: t.city, shape: t.dominantShape });
      const queries = smart.queries.length ? smart.queries : (Array.isArray(t.queries) ? t.queries : []);
      // Log the generated queries + the regional language Gemini chose, for offline analysis of query
      // quality/recall per region.
      console.log('runSourcingJobs:queries', orgId, JSON.stringify({
        locality: t.locality, city: t.city, category: smart.category,
        englishName: smart.englishName, regionalLanguage: smart.regionalLanguage, regionalName: smart.regionalName,
        queries,
      }));
      const target = { locality: t.locality, city: t.city, shape: shapeLabel(t) };
      const leg = run.leg({ target, queries, meta: smart });
      if (!queries.length) {
        leg.done({ note: 'query generation produced nothing' });
        perTarget.push({ locality: t.locality, city: t.city, relayed: 0, note: 'no queries' });
        continue;
      }
      // Deliberately ignore the target's per-target freshness (the platform stamps a tight qdr:d /
      // 24h window). The requirement is "posted in the last 3 months", so let runForOrg use the org's
      // freshness window (cfg.freshness = qdr:m3) uniformly across every target.
      const r = await runForOrg(db, apifyToken, orgId, cfg, { queries, target, policy, leg });
      relayed += r.relayed || 0;
      amountInr += r.amountInr || 0;
      perTarget.push({
        locality: t.locality, city: t.city,
        englishName: smart.englishName, regionalLanguage: smart.regionalLanguage, regionalName: smart.regionalName, queries, ...r,
      });
    }
    await run.finish({ status: budgetHit ? 'partial' : 'done' });
    return { ok: true, runId: run.id, targeted: perTarget, relayed, amountInr, partial: budgetHit };
  } catch (e) {
    // Record the failure, then rethrow — the cron's per-org catch still isolates it from other orgs.
    await run.finish({ status: 'error', error: e?.message || String(e) });
    throw e;
  }
}

// Build a short "2BHK · Villa / House · Sale" hint from a matrix target's dominant shape, if present.
function shapeLabel(t) {
  const s = t.dominantShape || t.shape || {};
  return [s.bhkType, s.propertyType, s.listingType].filter(Boolean).join(' · ') || undefined;
}

// HMAC-sign and POST one listing to the org's webhook. Returns true on a 2xx, false on anything
// else (so the caller does NOT mark it seen and does NOT charge — Bosun retries it next run).
async function relayOne({ webhookUrl, secret, orgId, listing }) {
  const body = JSON.stringify({ orgId, listing, source: { via: 'bosun', url: listing.url } });
  const { signature, timestamp } = signPayload(secret, body);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), RELAY_TIMEOUT_MS);
  try {
    const resp = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-bosun-signature': signature,
        'x-bosun-timestamp': timestamp,
      },
      body,
      signal: ctrl.signal,
    });
    return resp.ok;
  } catch (e) {
    console.error('relayOne:err', orgId, e?.message || e);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// Minimal bounded-concurrency map (no dep). Runs `fn` over `items`, at most `limit` in flight.
async function mapLimit(items, limit, fn) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      await fn(item);
    }
  });
  await Promise.all(workers);
}
