import { onSchedule } from 'firebase-functions/v2/scheduler';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { callSerpActor, listingKey, signPayload, enrichPost, isIndividualPost, tbsForMonths, cutoffMsForMonths, DEFAULT_FRESHNESS_MONTHS, fetchQueryMatrix } from '../utils/sourcing.js';
import { classifyListing, hasPropertySignal } from '../utils/classifyListing.js';
import { buildSourcingQueries } from '../utils/queryGen.js';
import { priceForSourcedBatch } from '../utils/billing.js';
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

// When a run targets a specific locality, enrich a larger pool so the Gemini gate can drop off-target
// posts and still fill maxPerRun. Bounds the extra Apify enrichment cost to OVERSAMPLE × maxPerRun.
const CLASSIFY_OVERSAMPLE = 3;

// Scheduled sourced-listing relay (see utils/sourcing.js). Once a day, for every org with
// sourcing.enabled: fetch listings via Apify across the org's query matrix, dedup them FOREVER
// against sourcingSeen/{orgId}/keys, HMAC-sign + POST each NEW one to the org's webhook, and debit
// the org wallet a small per-listing fee for the ones that were accepted (2xx). This is a separate,
// near-zero-COGS metered lane — it never touches the managed-agent pipeline or finalize.js.

const RELAY_CONCURRENCY = 5;
const RELAY_TIMEOUT_MS = 15000;
const GETALL_CHUNK = 300; // Firestore getAll batch size for the dedup lookup

export const runSourcingJobs = onSchedule(
  {
    region: 'asia-south1',
    schedule: 'every day 07:00',
    timeZone: 'Asia/Kolkata',
    secrets: [APIFY_TOKEN],
    timeoutSeconds: 540,
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
          });
        } else {
          await runForOrg(db, apifyToken, orgDoc.id, cfg);
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
  { fetchSerp = callSerpActor, rng, queries: queriesOverride, freshness: freshnessOverride, target } = {},
) {
  const secretSnap = await db.collection('orgSecrets').doc(orgId).get();
  const secret = secretSnap.exists ? secretSnap.data()?.sourcing?.secret : null;
  if (!secret) {
    console.error('runSourcingJobs:no-secret', orgId);
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
  if (!actorId || !webhookUrl || !queries.length) return { relayed: 0, amountInr: 0 };

  // 1) Fetch every query, flatten the results. `maxPages` controls SERP depth per query (supply).
  const maxPages = cfg.maxPagesPerQuery;
  const all = [];
  for (const query of queries) {
    const items = await fetchSerp({ apifyToken, actorId, query, freshness, maxPages });
    all.push(...items);
  }

  // 2) Keep only individual posts (real listings that enrich); drop group/page landing pages. Then
  // dedup WITHIN this run by canonical listing key.
  const posts = all.filter((it) => it?.url && isIndividualPost(it.url));
  console.log('runSourcingJobs:filter', orgId, JSON.stringify({ fetched: all.length, posts: posts.length }));
  const local = new Map();
  for (const it of posts) {
    const key = listingKey(it.url);
    if (!local.has(key)) local.set(key, it);
  }
  if (!local.size) {
    console.log('runSourcingJobs:no-results', orgId);
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
  if (!allNew.length) {
    console.log('runSourcingJobs:all-seen', orgId);
    return { relayed: 0, amountInr: 0 };
  }

  // Per-run cap: relay at most `maxPerRun` NEW listings (0 / unset = no cap). Normally applied BEFORE
  // enrichment so a run's Apify enrichment cost + wallet debit are bounded. When a target is set (the
  // classify path), we enrich a LARGER pool (OVERSAMPLE × cap) so the Gemini gate can drop off-target
  // posts and still fill the cap — then trim to `cap` after filtering. Overflow isn't marked seen, so
  // the next run picks it up.
  const cap = Math.max(0, Math.floor(Number(cfg.maxPerRun) || 0));
  const classifying = !!(target && target.locality);
  const poolSize = cap > 0 ? (classifying ? cap * CLASSIFY_OVERSAMPLE : cap) : allNew.length;
  let candidates = poolSize > 0 ? allNew.slice(0, poolSize) : allNew;

  // 3b) Enrich each new listing with the FULL Facebook post (the SERP snippet is truncated). Adds
  // the complete description + the owner phone; priced into the sourcing baseline. Best-effort and
  // bounded — a miss just leaves the SERP snippet in place.
  await mapLimit(candidates, RELAY_CONCURRENCY, async (c) => {
    const enriched = await enrichPost({ apifyToken, url: c.listing.url });
    if (enriched?.text && enriched.text.length > String(c.listing.snippet || '').length) {
      c.listing.snippet = enriched.text;
    }
    if (enriched?.phone) c.listing.phone = enriched.phone;
    if (enriched?.postedAt) c.listing.postedAt = enriched.postedAt;
  });

  // 3b2) HARD recency gate on the actual FB post date. Drop anything we KNOW is older than the window
  // (this is what actually enforces "posted in the last N months"). Fail-OPEN when the date is unknown
  // (enrichment miss) so a scrape hiccup doesn't silently lose fresh leads. postedAt rides to the
  // webhook so the platform can enforce/display it too.
  if (cutoffMs) {
    const before = candidates.length;
    candidates = candidates.filter((c) => !(c.listing.postedAt && c.listing.postedAt < cutoffMs));
    const dropped = before - candidates.length;
    if (dropped) console.log('runSourcingJobs:stale-drop', orgId, JSON.stringify({ dropped, keptAfter: candidates.length, cutoff: new Date(cutoffMs).toISOString().slice(0, 10) }));
    if (!candidates.length) {
      console.log('runSourcingJobs:none-after-recency', orgId);
      return { relayed: 0, amountInr: 0 };
    }
  }

  // 3c) Relevance gate (only when targeting a specific locality): a cheap deterministic pre-filter,
  // then a Gemini classify that drops posts that aren't genuine listings in/around the target and
  // attaches extracted fields. Fails OPEN per-post (keep) so a classifier hiccup never loses leads.
  if (classifying) {
    await mapLimit(candidates, RELAY_CONCURRENCY, async (c) => {
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
      if (verdict.extracted?.phone && !c.listing.phone) c.listing.phone = verdict.extracted.phone;
      if (verdict.extracted) c.listing.extracted = verdict.extracted;
    });
    const kept = candidates.filter((c) => !c.drop);
    console.log('runSourcingJobs:classify', orgId, JSON.stringify({ pool: candidates.length, kept: kept.length, target: target.locality }));
    candidates = cap > 0 ? kept.slice(0, cap) : kept;
  }
  if (!candidates.length) {
    console.log('runSourcingJobs:none-after-classify', orgId);
    return { relayed: 0, amountInr: 0 };
  }

  // 4) Relay each new listing; mark it seen ONLY on a 2xx (charge-on-delivery).
  let relayed = 0;
  const relayedDates = [];
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
    }
  });
  if (!relayed) {
    console.log('runSourcingJobs:relayed-0', orgId);
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
  return { relayed, amountInr };
}

// Source the org's top demand-ranked target(s) from the platform matrix — the SMART path shared by
// the daily cron (dryRun:false, advances cadence) and the manual adminSourceTopTarget probe
// (dryRun:true, leaves cadence untouched). Pulls the demand-ranked matrix, takes the top `topN`
// targets, builds Gemini bilingual queries (full English name + the locality's own regional script,
// language chosen by Gemini per target) per target, and runs
// the normal fetch → dedup → enrich → relevance-gate → signed relay for each. Wallet debits aggregate
// across targets. Degrade-safe: a null matrix or a target with no queries is skipped, not fatal.
export async function sourceTopTargets(db, apifyToken, orgId, cfg, { topN = 1, dryRun = true } = {}) {
  if (!cfg.matrixUrl) return { ok: true, relayed: 0, amountInr: 0, note: 'no matrixUrl' };
  const secretSnap = await db.collection('orgSecrets').doc(orgId).get();
  const secret = secretSnap.exists ? secretSnap.data()?.sourcing?.secret : null;
  if (!secret) return { ok: false, relayed: 0, amountInr: 0, note: 'no secret' };

  const limit = Math.max(1, Math.floor(Number(cfg.matrixLimit) || DEFAULT_MATRIX_LIMIT));
  const matrix = await fetchQueryMatrix({ matrixUrl: cfg.matrixUrl, secret, limit, dryRun });
  const targets = (Array.isArray(matrix?.targets) ? matrix.targets : []).filter(isPlausibleTarget);
  if (!targets.length) return { ok: true, relayed: 0, amountInr: 0, note: 'no due targets' };

  const chosen = targets.slice(0, topN);
  let relayed = 0;
  let amountInr = 0;
  const perTarget = [];
  for (const t of chosen) {
    const smart = await buildSourcingQueries({ locality: t.locality, city: t.city, shape: t.dominantShape });
    const queries = smart.queries.length ? smart.queries : (Array.isArray(t.queries) ? t.queries : []);
    // Log the generated queries + the regional language Gemini chose, for offline analysis of query
    // quality/recall per region (this is the only place the built queries surface — the cron discards
    // sourceTopTargets' return value).
    console.log('runSourcingJobs:queries', orgId, JSON.stringify({
      locality: t.locality, city: t.city, category: smart.category,
      englishName: smart.englishName, regionalLanguage: smart.regionalLanguage, regionalName: smart.regionalName,
      queries,
    }));
    if (!queries.length) {
      perTarget.push({ locality: t.locality, city: t.city, relayed: 0, note: 'no queries' });
      continue;
    }
    // Deliberately ignore the target's per-target freshness (the platform stamps a tight qdr:d /
    // 24h window). The requirement is "posted in the last 3 months", so let runForOrg use the org's
    // freshness window (cfg.freshness = qdr:m3) uniformly across every target.
    const r = await runForOrg(db, apifyToken, orgId, cfg, {
      queries,
      target: { locality: t.locality, city: t.city, shape: shapeLabel(t) },
    });
    relayed += r.relayed || 0;
    amountInr += r.amountInr || 0;
    perTarget.push({
      locality: t.locality, city: t.city,
      englishName: smart.englishName, regionalLanguage: smart.regionalLanguage, regionalName: smart.regionalName, queries, ...r,
    });
  }
  return { ok: true, targeted: perTarget, relayed, amountInr };
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
