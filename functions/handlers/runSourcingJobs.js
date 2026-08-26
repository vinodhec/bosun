import { onSchedule } from 'firebase-functions/v2/scheduler';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { callSerpActor, listingKey, ownerListingKey, signPayload, enrichPosts, isIndividualPost, tbsForMonths, cutoffMsForMonths, DEFAULT_FRESHNESS_MONTHS, fetchQueryMatrix, normalizeSourcingPolicy, hasIndiaSignal } from '../utils/sourcing.js';
import { classifyListing, hasPropertySignal, MIN_CONFIDENCE } from '../utils/classifyListing.js';
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
  { fetchSerp = callSerpActor, rng, classify = classifyListing, queries: queriesOverride, freshness: freshnessOverride, target, policy, leg = NULL_LEG } = {},
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
  // Salvage lanes for what the classify gate used to throw away — both OPT-IN per org, because each
  // relays a lead the platform webhook must know how to route (`listing.leadType`). Flip them on only
  // once the receiver handles the tag; until then the posts keep their current fate.
  //   buyerLeads      — a genuine "wanted / looking for" post (side:'seeking') relays as leadType
  //                     'buyer' instead of being dropped. Usually phone-less (the 2026-07-17
  //                     experiment measured 0/4 with a number — buyers say "DM me"), so the lead's
  //                     value is the post link + request text, not a callable number.
  //   offTargetLeads  — a CONFIDENT genuine listing whose only failure is the locality relays as
  //                     leadType 'off-target' (its real place rides in extracted.locality) instead
  //                     of being buried dead. Real inventory is inventory wherever it sits.
  const harvestBuyers = classifying && !!cfg.buyerLeads;
  const salvageOffTarget = classifying && !!cfg.offTargetLeads;
  // Only a CONFIDENT off-target reject is dead — never enrich it again. Four rejects are deliberately
  // NOT recorded so they retry: the transient 'degraded-no-india-signal' fail-open (classifier down),
  // 'no-signal' — because that deterministic pre-filter now sees only the short SERP snippet, so
  // a genuine listing with a sparse Google description must get another chance, not be buried unseen —
  // 'buyer-post', a flag-off policy drop: burying it would blind the org to every buyer post
  // still live the day it turns sourcing.buyerLeads on (cheap to retry — it never reached enrichment) —
  // and 'locality-unresolved', a locality-unknown lead whose enrichment returned no text: the full-
  // text pass never got to judge it, so a scrape hiccup must not bury it.
  const RETRYABLE_DROP = new Set(['degraded-no-india-signal', 'no-signal', 'buyer-post', 'locality-unresolved']);

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
      // Title + snippet, not snippet alone: on FB group pages Google often serves a snippet lifted
      // from an ADJACENT post, while the title still names the locality/intent — snippet-only
      // classification was killing genuine on-target leads as "off-target" (and marking them dead).
      const serpText = [c.listing.title, c.listing.snippet].filter(Boolean).join('\n');
      if (!hasPropertySignal(serpText)) {
        c.drop = true;
        c.dropReason = 'no-signal';
        return;
      }
      const verdict = await classify({
        text: serpText,
        locality: target.locality,
        city: target.city,
        shape: target.shape,
      });
      const side = verdict.side || 'offering'; // degraded verdicts carry no side — fail toward supply
      if (!verdict.keep && !verdict.degraded) {
        // Locality-UNKNOWN is not locality-WRONG. Google truncates titles right where Indian posts
        // put the place ("...for Sale near ...") and group-page snippets are often lifted from an
        // ADJACENT post — so a genuine listing can reach this gate with no locality visible at all
        // (the 2026-07-17 Karamadai DTCP-plot miss). Detour it into the paid enrichment and let the
        // FULL post text decide (pass 3c2 below) instead of burying it dead on evidence that was
        // never in front of the model.
        if (verdict.isListing && verdict.localityNamed === false && verdict.confidence >= MIN_CONFIDENCE) {
          c.localityPending = true;
          return;
        }
        // Off-target salvage: a confident genuine LISTING whose only failure is the locality is real
        // inventory, not junk — relay it tagged instead of burying it. Requires the extracted
        // locality (a lead the platform can't place is worthless) and the same confidence bar as
        // `keep`. Seeking-side off-target posts stay dropped (a buyer for somewhere else is noise).
        const salvageable = salvageOffTarget && side === 'offering' && verdict.isListing
          && !verdict.localityMatches && verdict.confidence >= MIN_CONFIDENCE
          && verdict.extracted?.locality;
        if (!salvageable) {
          c.drop = true;
          c.dropReason = verdict.reason || 'off-target';
          return;
        }
        c.listing.leadType = 'off-target';
      }
      if (!c.drop && side === 'seeking' && !verdict.degraded) {
        // A genuine on-target "wanted" post. Without the org opt-in it's dropped as before — but
        // RETRYABLY (see RETRYABLE_DROP below), so enabling the flag later still catches live posts.
        if (!harvestBuyers) {
          c.drop = true;
          c.dropReason = 'buyer-post';
          return;
        }
        c.listing.leadType = 'buyer';
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
    for (const c of prospects) {
      if (c.drop && !RETRYABLE_DROP.has(c.dropReason)) markDead(c, c.dropReason || 'off-target');
    }
    for (const c of prospects) {
      if (!c.drop) continue;
      // Split the classify rejects apart: they mean very different things. 'no-signal' is our
      // own cheap filter, 'off-target' is Gemini rejecting a real listing, 'buyer-post' is a genuine
      // buyer lead the org hasn't opted into harvesting, and the degraded drop means the classifier
      // was DOWN — a spike there is an incident, not a dry locality.
      if (c.dropReason === 'no-signal') leg.bump('noSignalDropped');
      else if (c.dropReason === 'degraded-no-india-signal') leg.bump('degradedDropped');
      else if (c.dropReason === 'buyer-post') leg.bump('buyerDropped');
      else leg.bump('offTargetDropped');
      leg.lead({ key: c.key, listing: c.listing, stage: 'dropped', dropStage: 'classify', dropReason: c.dropReason || 'off-target' });
    }
    const kept = prospects.filter((c) => !c.drop);
    // Lane priority under the enrich-pool / maxPerRun caps: verified on-target listings first, then
    // locality-unknown pendings (probably on-target, not yet proven), then buyer leads, then
    // off-target salvage — the uncertain/salvage lanes are bonus yield and must never displace
    // the inventory the target was actually sourced for. Stable sort keeps SERP order within a lane.
    const laneRank = (c) => (c.listing.leadType === 'off-target' ? 3 : c.listing.leadType === 'buyer' ? 2 : c.localityPending ? 1 : 0);
    kept.sort((a, b) => laneRank(a) - laneRank(b));
    leg.count('localityPending', kept.filter((c) => c.localityPending).length);
    console.log('runSourcingJobs:classify', orgId, JSON.stringify({
      pool: prospects.length, kept: kept.length, target: target.locality,
      pending: kept.filter((c) => c.localityPending).length,
      buyers: kept.filter((c) => c.listing.leadType === 'buyer').length,
      offTarget: kept.filter((c) => c.listing.leadType === 'off-target').length,
    }));
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
        // The paid scrape returned nothing, so this lead relays with its SERP snippet standing in
        // for the post body — text Google may well have lifted from a neighbouring post. Say so on
        // the wire: the platform's own bleed guard (web/src/lib/snippetBleed.ts) can only GUESS
        // whether a body belongs to its title, and this flag turns that guess into a fact it is
        // told. Additive field; an older platform build ignores it harmlessly.
        c.listing.snippetOnly = true;
        continue;
      }
      if (enriched.text) c.enrichedText = true; // the full-text pass (3c2) needs to know real text arrived
      // ALWAYS prefer the scraped post over the SERP snippet — never "only if it is longer".
      //
      // The two texts are not comparable in quality. `enriched.text` was fetched from THIS post's
      // own URL and is definitionally the right body. The snippet came off a Google results page,
      // where (as the classify step above already notes) Google routinely lifts the text from an
      // ADJACENT post. Ranking them by length let a long wrong snippet beat a short right post.
      //
      // That is how MaadiVeedu published `SP-009676`: the real post is the one line "House for
      // Sales salem junction", the snippet Google served was a long Saligramam commercial-land ad,
      // the length test kept the ad and discarded the post, and the listing went live in Chennai
      // with somebody else's property in its description. `SP-009532` is the same shape — a Madurai
      // plot that published as Madhavaram, Chennai, 450km away. Reported 2026-08-26.
      //
      // A scrape that returns EMPTY text still falls through to the snippet below, which is the
      // honest fail-open: we have nothing better. It is marked as such so the platform can distrust it.
      if (enriched.text) {
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

  // 3c2) Full-text pass for the locality-unknown detour (3b). Those leads were never JUDGED — the
  // SERP text simply named no place — so now that the paid enrichment brought the real post text,
  // classify them for real. Mirrors 3b's branch logic exactly (salvage bar, buyer lane, degraded
  // fail-open), but a confident reject here IS authoritative: the model saw the full post, so the
  // drop is dead. An enrichment miss leaves us no better text than pass 1 had — retryable, not dead.
  if (classifying) {
    const pending = candidates.filter((c) => c.localityPending);
    if (pending.length) {
      await mapLimit(pending, CLASSIFY_CONCURRENCY, async (c) => {
        if (!c.enrichedText) {
          c.drop = true;
          c.dropReason = 'locality-unresolved';
          return;
        }
        const verdict = await classify({
          text: [c.listing.title, c.listing.snippet].filter(Boolean).join('\n'),
          locality: target.locality,
          city: target.city,
          shape: target.shape,
        });
        const side = verdict.side || 'offering';
        if (verdict.degraded) {
          // Same signal-gated fail-open as 3b — a classifier outage mid-run must not flip fate.
          if (!hasIndiaSignal(`${c.listing.title || ''} ${c.listing.snippet || ''}`, target.locality)) {
            c.drop = true;
            c.dropReason = 'degraded-no-india-signal';
            return;
          }
          c.listing.classifyStatus = 'unverified';
          return;
        }
        if (!verdict.keep) {
          const salvageable = salvageOffTarget && side === 'offering' && verdict.isListing
            && !verdict.localityMatches && verdict.confidence >= MIN_CONFIDENCE
            && verdict.extracted?.locality;
          if (!salvageable) {
            c.drop = true;
            // The full post may STILL name no place ("DM for details") — a lead nobody can locate
            // is unrelayable either way, and the post won't grow a locality later: dead.
            c.dropReason = verdict.reason || 'off-target';
            return;
          }
          c.listing.leadType = 'off-target';
        }
        if (!c.drop && side === 'seeking') {
          if (!harvestBuyers) {
            c.drop = true;
            c.dropReason = 'buyer-post';
            return;
          }
          c.listing.leadType = 'buyer';
        }
        c.listing.classifyStatus = 'verified';
        if (verdict.extracted?.phone && !c.listing.phone) c.listing.phone = verdict.extracted.phone;
        if (verdict.extracted) c.listing.extracted = verdict.extracted;
      });
      for (const c of pending) {
        if (!c.drop) {
          leg.bump('fullTextConfirmed');
          continue;
        }
        if (!RETRYABLE_DROP.has(c.dropReason)) markDead(c, c.dropReason || 'off-target');
        if (c.dropReason === 'locality-unresolved') leg.bump('localityUnresolved');
        else if (c.dropReason === 'degraded-no-india-signal') leg.bump('degradedDropped');
        else if (c.dropReason === 'buyer-post') leg.bump('buyerDropped');
        else leg.bump('fullTextDropped');
        leg.lead({ key: c.key, listing: c.listing, stage: 'dropped', dropStage: 'classify-full', dropReason: c.dropReason });
      }
      const settled = candidates.filter((c) => !c.drop);
      console.log('runSourcingJobs:classify-full', orgId, JSON.stringify({
        pending: pending.length, confirmed: pending.filter((c) => !c.drop).length, target: target.locality,
      }));
      candidates = settled;
    }
  }

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

  // 3f) OWNER dedup — collapse the same owner reposting the SAME property. URL dedup (steps 2-3) can't
  // see this: a reposted property gets a fresh post URL in every group/locality, so daily reposts sail
  // through as distinct leads (the Kavitha "3 property same property" complaint). The phone is the
  // stable identity; we key on phone + a coarse price/BHK/type fingerprint (ownerListingKey), which is
  // only knowable HERE — after enrichment + classify populate listing.phone/extracted. A phone-less
  // lead (many buyer posts) or one with no property fields yields a null key and is never deduped.
  // A collapsed repost is PERMANENT (that URL will always be a dupe of an already-known property), so
  // its URL key is marked dead — it's never re-enriched next run.
  {
    const withOwner = candidates.map((c) => ({
      c,
      owner: ownerListingKey({
        phone: c.listing.phone,
        priceText: c.listing.extracted?.priceText,
        bhk: c.listing.extracted?.bhk,
        propertyType: c.listing.extracted?.propertyType,
      }),
    }));
    // In-run: two reposts of one property caught in the same run — keep the first, drop the rest.
    const seenThisRun = new Set();
    const survived = [];
    let dupInRun = 0;
    for (const { c, owner } of withOwner) {
      if (owner && seenThisRun.has(owner)) {
        markDead(c, 'duplicate-owner');
        leg.bump('ownerDupInRun');
        leg.lead({ key: c.key, listing: c.listing, stage: 'dropped', dropStage: 'owner-dedup', dropReason: 'duplicate-owner (same run)' });
        dupInRun += 1;
        continue;
      }
      if (owner) seenThisRun.add(owner);
      survived.push({ c, owner });
    }
    // Cross-run: an owner+property fingerprint we've relayed on ANY prior run for this org. Stored as
    // `owner_*` docs alongside the URL keys in the same seen collection.
    const ownerKeys = [...new Set(survived.map((s) => s.owner).filter(Boolean))];
    const relayedOwners = new Set();
    for (let i = 0; i < ownerKeys.length; i += GETALL_CHUNK) {
      const refs = ownerKeys.slice(i, i + GETALL_CHUNK).map((k) => seenCol.doc(k));
      const snaps = await db.getAll(...refs);
      for (const s of snaps) if (s.exists) relayedOwners.add(s.id);
    }
    const kept = [];
    let dupSeen = 0;
    for (const { c, owner } of survived) {
      if (owner && relayedOwners.has(owner)) {
        markDead(c, 'duplicate-owner');
        leg.bump('ownerDupSeen');
        leg.lead({ key: c.key, listing: c.listing, stage: 'dropped', dropStage: 'owner-dedup', dropReason: 'duplicate-owner (prior run)' });
        dupSeen += 1;
        continue;
      }
      c.ownerKey = owner; // carried into step 4 so a successful relay records it
      kept.push(c);
    }
    if (dupInRun || dupSeen) {
      console.log('runSourcingJobs:owner-dedup', orgId, JSON.stringify({ dupInRun, dupSeen, kept: kept.length, target: target.locality }));
    }
    leg.count('ownerDeduped', dupInRun + dupSeen);
    candidates = kept;
  }
  if (!candidates.length) {
    console.log('runSourcingJobs:none-after-owner-dedup', orgId);
    await flushDead();
    leg.done({ note: 'every survivor was a repost of an already-known property (owner dedup)' });
    return { relayed: 0, amountInr: 0 };
  }

  // 4) Relay each new listing; mark it seen ONLY on a 2xx (charge-on-delivery).
  let relayed = 0;
  const relayedDates = [];
  leg.count('relayAttempted', candidates.length);
  await mapLimit(candidates, RELAY_CONCURRENCY, async ({ key, listing, ownerKey }) => {
    const ok = await relayOne({ webhookUrl, secret, orgId, listing });
    if (ok) {
      await seenCol.doc(key).set({
        url: listing.url,
        title: listing.title || '',
        postedAt: listing.postedAt || null, // FB post date (for recency audits)
        leadType: listing.leadType || null, // 'buyer' / 'off-target' salvage lanes; null = supply
        relayedAt: FieldValue.serverTimestamp(),
      });
      // Record the owner+property fingerprint so a future run's repost (a NEW URL for the SAME
      // property) is caught by the cross-run owner dedup (3f). Only a RELAYED lead writes this — a
      // failed relay leaves the owner un-recorded so the retry can still deliver.
      if (ownerKey) {
        await seenCol.doc(ownerKey).set({
          owner: true,
          url: listing.url,
          phone: listing.phone || null,
          relayedAt: FieldValue.serverTimestamp(),
        });
      }
      if (listing.postedAt) relayedDates.push(listing.postedAt);
      relayed += 1;
      if (listing.leadType === 'buyer') leg.bump('buyerRelayed');
      else if (listing.leadType === 'off-target') leg.bump('offTargetRelayed');
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
    const matrix = await fetchQueryMatrix({ matrixUrl: cfg.matrixUrl, secret, limit, maxTargets: topN, dryRun, runId: run.id });
    // Backpressure: the platform PAUSES sourcing once its pending-lead queue hits the cap (default
    // 3000) — it serves no targets and stamps no cadence. Honour that here, BEFORE any Apify/SERP/
    // classify spend, so a full queue costs nothing and leaves a clear "paused" note in the run panel.
    // (The platform also returns empty `targets` while paused, so the stop holds even without this
    // check; this just makes the reason explicit instead of looking like "no due targets".)
    if (matrix?.pauseSourcing) {
      const cap = matrix.pendingCap ?? '?';
      const pending = matrix.pendingBacklog ?? '?';
      run.note(`sourcing paused — ${pending} pending leads ≥ cap ${cap}; nothing sourced or charged`);
      console.warn('runSourcingJobs:paused', orgId, JSON.stringify({ pending, cap }));
      await run.finish();
      return { ok: true, runId: run.id, relayed: 0, amountInr: 0, paused: true, pendingBacklog: matrix.pendingBacklog ?? null };
    }
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
// Exported for the operator's manual per-lead relay (adminSourcing.js#adminSourcingRelayLead).
export async function relayOne({ webhookUrl, secret, orgId, listing }) {
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
