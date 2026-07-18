import crypto from 'node:crypto';

// The ONLY integration point for the sourced-listing relay lane. Talks to Apify (the raw
// data-fetch layer — Bosun's only cost), canonicalizes/​hashes listing URLs for dedup, and signs
// the relay payload with the org's shared HMAC secret. Every network path degrades to a safe empty
// result (mirrors utils/figma.js returning null) so a bad fetch never blocks the schedule.

const APIFY_BASE = 'https://api.apify.com/v2';
const KEEP_QUERY_KEYS = new Set(['story_fbid', 'fbid', 'id', 'v', 'groupid']); // stable FB permalink ids

/** Mint a fresh HMAC secret for an org's sourcing relay (shared with the customer's webhook). */
export function generateSourcingSecret() {
  return crypto.randomBytes(32).toString('hex');
}

// Default recency window for a sourcing run, in months. Only listings posted within this many
// months are fetched (Google `tbs=qdr:m{n}`). Overridable per org via `freshnessMonths` config.
export const DEFAULT_FRESHNESS_MONTHS = 3;

// How many Google SERP pages to pull per query (each ~up to resultsPerPage results). More pages =
// more raw supply per locality. Overridable per org via sourcing.maxPagesPerQuery.
export const DEFAULT_SERP_PAGES = 4;

/**
 * Build Google's `tbs` recency value from a month count — the human-friendly form of `freshness`.
 * `qdr:m` = past month, `qdr:m3` = past 3 months. Clamps to a sane [1, 60] range and floors to an
 * integer; anything unparseable falls back to DEFAULT_FRESHNESS_MONTHS.
 */
export function freshnessForMonths(months) {
  const n = Math.floor(Number(months));
  const clamped = Number.isFinite(n) && n >= 1 ? Math.min(n, 60) : DEFAULT_FRESHNESS_MONTHS;
  return clamped === 1 ? 'qdr:m' : `qdr:m${clamped}`;
}

/**
 * Google's `tbs` recency value as a VALID custom date range for the last N months, computed from now:
 * `cdr:1,cd_min:M/D/YYYY,cd_max:M/D/YYYY`. Use this instead of `freshnessForMonths` for the SERP query —
 * `qdr:m3` (multi-month) is NOT a real Google operator and gets ignored, letting any-age posts through.
 * Best-effort only (Google dates facebook.com by index time); the hard post-date filter is the real gate.
 */
export function tbsForMonths(months) {
  const n = Math.min(60, Math.max(1, Math.floor(Number(months)) || DEFAULT_FRESHNESS_MONTHS));
  const now = new Date();
  const min = new Date(now);
  min.setMonth(min.getMonth() - n);
  const fmt = (d) => `${d.getMonth() + 1}/${d.getDate()}/${d.getFullYear()}`;
  return `cdr:1,cd_min:${fmt(min)},cd_max:${fmt(now)}`;
}

// Per-intent freshness policy defaults: how old a lead may be by listing intent (rent leads go
// stale much faster than sale leads), plus how many stale leads a target may fall back to when
// NOTHING fresh survives the gate. The platform's query-matrix response can override any field
// via `policy: { saleMonths, rentMonths, fallbackMaxLeads }`.
/**
 * Cheap deterministic "is this plausibly an INDIAN property post" check — the gate for classifier
 * fail-open. Any of: an Indian mobile, an Indian price idiom (₹ / lakh / crore), or the target
 * locality named in the text. Keeps degraded-mode relays from billing US/global noise.
 */
export function hasIndiaSignal(text, locality) {
  const t = String(text || '');
  if (/(?:\+?91[\s-]?|0)?[6-9]\d{9}(?!\d)/.test(t.replace(/[^\d+]/g, ''))) return true;
  if (/₹|\b(?:lakh|lakhs|lac|crore|crores)\b/i.test(t)) return true;
  const loc = String(locality || '').trim();
  if (loc && t.toLowerCase().includes(loc.toLowerCase())) return true;
  return false;
}

export const DEFAULT_SOURCING_POLICY = { saleMonths: 3, rentMonths: 1, fallbackMaxLeads: 3 };

/**
 * Merge a matrix `policy` over DEFAULT_SOURCING_POLICY, dropping unparseable values (degrade-safe:
 * a missing/garbled policy just means the defaults). Months clamp to >= 1; fallbackMaxLeads may be
 * 0 (an org can disable the stale fallback entirely).
 */
export function normalizeSourcingPolicy(raw) {
  const pick = (v, min, dflt) => {
    const n = Math.floor(Number(v));
    return Number.isFinite(n) && n >= min ? n : dflt;
  };
  return {
    saleMonths: pick(raw?.saleMonths, 1, DEFAULT_SOURCING_POLICY.saleMonths),
    rentMonths: pick(raw?.rentMonths, 1, DEFAULT_SOURCING_POLICY.rentMonths),
    fallbackMaxLeads: pick(raw?.fallbackMaxLeads, 0, DEFAULT_SOURCING_POLICY.fallbackMaxLeads),
  };
}

/** Milliseconds cutoff for "posted within the last N months" — the hard recency gate. */
export function cutoffMsForMonths(months) {
  const n = Math.min(60, Math.max(1, Math.floor(Number(months)) || DEFAULT_FRESHNESS_MONTHS));
  return Date.now() - Math.round(n * 30.44 * 24 * 60 * 60 * 1000);
}

/**
 * Run an Apify actor synchronously and return its dataset items, normalized to
 * `[{ url, title, snippet }]`. Uses run-sync-get-dataset-items so one HTTPS call both runs the
 * actor and returns results. `freshness` is Google's `tbs` value (e.g. 'qdr:d' = last 24h). Any
 * failure (missing config, non-2xx, network, bad JSON) returns `[]`.
 */
export async function callSerpActor({ apifyToken, actorId, query, freshness, maxPages, extraInput = {} }) {
  if (!apifyToken || !actorId || !query) return [];
  const url = `${APIFY_BASE}/acts/${encodeURIComponent(actorId)}/run-sync-get-dataset-items?token=${encodeURIComponent(apifyToken)}`;
  const input = {
    queries: query,          // apify/google-search-scraper accepts newline-separated queries
    maxPagesPerQuery: Math.max(1, Math.floor(Number(maxPages) || DEFAULT_SERP_PAGES)),
    resultsPerPage: 100,
    ...(freshness ? { tbs: freshness } : {}),
    ...extraInput,
  };
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(input),
    });
    if (!resp.ok) {
      console.error('callSerpActor:http', actorId, resp.status);
      return [];
    }
    const items = await resp.json();
    return normalizeSerpItems(items);
  } catch (e) {
    console.error('callSerpActor:err', actorId, e?.message || e);
    return [];
  }
}

/**
 * Parse Google's relative "lastUpdated" string ("2 days ago", "10 months ago", "yesterday") into an
 * APPROXIMATE ms timestamp — the YOUNGEST plausible instant for the phrase, so a coarse bucket never
 * DROPS a borderline-fresh post (we under-age on purpose; the authoritative FB-post date stays the
 * real gate). `lastUpdated` is Google's last-seen-update, not the post's creation date — good enough
 * to SKIP a confidently-old post before paying to enrich, never to relay on. Unparseable → null
 * (fail-open: keep + enrich). See the SERP-date pre-filter in runSourcingJobs.
 */
const DAY_MS = 24 * 60 * 60 * 1000;
export function parseRelativeAge(text, nowMs = Date.now()) {
  const s = String(text || '').trim().toLowerCase();
  if (!s || s === 'undefined') return null;
  if (/^(just now|now|today)$/.test(s)) return nowMs;
  if (s === 'yesterday') return nowMs - DAY_MS;
  const m = s.match(/^(?:a|an|(\d+))\s*(second|minute|hour|day|week|month|year)s?\s+ago$/);
  if (!m) return null;
  const n = m[1] ? parseInt(m[1], 10) : 1;
  if (!Number.isFinite(n) || n < 0) return null;
  const unit = { second: 1000, minute: 60000, hour: 3600000, day: DAY_MS, week: 7 * DAY_MS, month: 30.44 * DAY_MS, year: 365 * DAY_MS }[m[2]];
  return nowMs - Math.round(n * unit);
}

/**
 * Flatten Apify Google-SERP dataset items (organic results) into
 * `[{ url, title, snippet, serpAgeText, serpAgeMs }]`. `serpAgeText` is Google's raw relative
 * "lastUpdated" ("10 months ago"); `serpAgeMs` is its parsed youngest-instant timestamp (null when
 * absent/unparseable). Both power the cheap pre-enrichment recency skip.
 */
export function normalizeSerpItems(items) {
  const out = [];
  const arr = Array.isArray(items) ? items : [];
  const push = (u, title, snippet, ageText) => {
    if (!u) return;
    out.push({
      url: String(u),
      title: String(title || ''),
      snippet: String(snippet || ''),
      serpAgeText: ageText ? String(ageText) : null,
      serpAgeMs: parseRelativeAge(ageText),
    });
  };
  for (const it of arr) {
    const organic = Array.isArray(it?.organicResults) ? it.organicResults
      : Array.isArray(it?.results) ? it.results
      : null;
    if (organic) {
      for (const r of organic) {
        push(r?.url || r?.link, r?.title, r?.description || r?.snippet, r?.lastUpdated || r?.date);
      }
    } else if (it?.url || it?.link) {
      push(it.url || it.link, it.title, it.description || it.snippet, it.lastUpdated || it.date);
    }
  }
  return out;
}

/** Canonicalize a URL for dedup: lowercase host+path, drop tracking params, keep stable FB ids. */
export function canonicalizeUrl(url) {
  try {
    const u = new URL(String(url));
    u.hash = '';
    u.hostname = u.hostname.replace(/^www\./i, ''); // www.facebook.com === facebook.com for dedup
    const keep = new URLSearchParams();
    for (const [k, v] of u.searchParams) {
      if (KEEP_QUERY_KEYS.has(k.toLowerCase())) keep.set(k.toLowerCase(), v);
    }
    u.search = keep.toString();
    return u.toString().toLowerCase().replace(/\/$/, '');
  } catch {
    return String(url || '').trim().toLowerCase();
  }
}

/** Stable dedup id for a listing URL (sha256 hex of its canonical form). */
export function listingKey(url) {
  return crypto.createHash('sha256').update(canonicalizeUrl(url)).digest('hex');
}

/** Last-10-digit form of an Indian mobile, or '' when the input isn't one. Owner identity is the
 *  number, not its +91/0/spacing formatting, so we normalize before using it as a dedup component. */
function normalizePhoneDigits(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  const last10 = d.length > 10 ? d.slice(-10) : d;
  return /^[6-9]\d{9}$/.test(last10) ? last10 : '';
}

/**
 * A cross-run OWNER dedup id: the same owner (phone) reposting the SAME property (same coarse
 * price/BHK/type fingerprint) in a different group/locality on a different day gets a NEW post URL
 * every time, so URL dedup can't see it — but the phone can. Returns `owner_<sha256>` or null.
 *
 * null (→ no dedup, relay as normal) unless we have BOTH a real phone AND at least one substantive
 * property field (priceText or bhk). The fingerprint is deliberately STRICT — a false MERGE silently
 * buries a broker's genuinely distinct listing (same number, different property), which is far worse
 * than relaying an occasional dupe, so we only collapse when phone + all present fields line up. Two
 * copy-pasted reposts match verbatim; a broker's second, differently-priced flat does not.
 */
export function ownerListingKey({ phone, priceText, bhk, propertyType } = {}) {
  const ph = normalizePhoneDigits(phone);
  const norm = (v) => String(v || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const price = norm(priceText);
  const rooms = norm(bhk);
  if (!ph || (!price && !rooms)) return null;
  const sig = [ph, rooms, norm(propertyType), price].join('|');
  return `owner_${crypto.createHash('sha256').update(sig).digest('hex')}`;
}

// Facebook path/query markers that identify an INDIVIDUAL post. Individual posts are the real
// listings and enrich cleanly (full description + phone); group/page LANDING pages can't be enriched
// and aren't listings anyway, so we drop them upstream.
const POST_MARKERS = [
  '/posts/', '/permalink/', '/permalink.php', '/story.php',
  '/videos/', '/photos/', '/marketplace/item/', '/share/p/', '/share/v/',
];

/** True if the URL is an individual FB post (keep) vs a group/page landing page (drop). */
export function isIndividualPost(url) {
  try {
    const u = new URL(String(url));
    const host = u.hostname.replace(/^www\./i, '').toLowerCase();
    // Non-Facebook URLs: don't filter (our queries are site:facebook.com, but be safe).
    if (host !== 'facebook.com' && host !== 'm.facebook.com' && !host.endsWith('.facebook.com')) return true;
    if (u.searchParams.has('story_fbid')) return true;
    const s = (u.pathname + u.search).toLowerCase();
    return POST_MARKERS.some((m) => s.includes(m));
  } catch {
    return false;
  }
}

/**
 * Sign a relay body with the org's HMAC secret. The signature covers `${timestamp}.${body}` so the
 * receiver can reject replays by checking the timestamp. Returns headers the receiver recomputes.
 */
export function signPayload(secret, bodyString, timestamp = Date.now()) {
  const ts = String(timestamp);
  const mac = crypto.createHmac('sha256', String(secret)).update(`${ts}.${bodyString}`).digest('hex');
  return { signature: `sha256=${mac}`, timestamp: ts };
}

/**
 * Pull the platform's demand-ranked sourcing matrix — the localities to source, each already expanded
 * into search queries and ordered best-first. HMAC-signs `${timestamp}.query-matrix` with the org's
 * shared secret (the same secret the relay webhook verifies on the platform side). `dryRun` asks the
 * platform NOT to advance each target's refresh schedule — right for manual / top-target testing so a
 * dry run never consumes a locality's cadence. Returns the parsed body ({ targets: [...], policy })
 * with `policy` normalized over DEFAULT_SOURCING_POLICY (the platform sets the per-intent freshness
 * windows; defaults cover an older platform that doesn't send one), or null on any failure
 * (degrade-safe: a bad pull just means nothing to source).
 */
export async function fetchQueryMatrix({ matrixUrl, secret, limit, maxTargets, dryRun = true, runId }) {
  if (!matrixUrl || !secret) return null;
  const { signature, timestamp } = signPayload(secret, 'query-matrix');
  let url;
  try {
    url = new URL(matrixUrl);
  } catch {
    console.error('fetchQueryMatrix:bad-url', matrixUrl);
    return null;
  }
  if (dryRun) url.searchParams.set('dryRun', 'true');
  if (limit) url.searchParams.set('limit', String(limit));
  // Ask the platform to serve (and stamp) no more targets than we will actually source this run.
  // Without this, a non-dry pull advances lastServedAt on ~limit/2 targets while we consume topN,
  // burning the due pool days ahead of real scraping. An older platform ignores the param.
  if (maxTargets) url.searchParams.set('maxTargets', String(maxTargets));
  // Audit provenance: our sourcingRuns/{runId} doc id rides along so the platform can stamp WHICH
  // Bosun run served each target (lastRunId) — the admin's "did it really run?" link back to the
  // Bosun run funnel. An older platform ignores the param.
  if (runId) url.searchParams.set('runId', String(runId));
  try {
    const resp = await fetch(url.toString(), {
      method: 'GET',
      headers: { 'x-bosun-signature': signature, 'x-bosun-timestamp': timestamp },
    });
    if (!resp.ok) {
      console.error('fetchQueryMatrix:http', resp.status);
      return null;
    }
    const body = await resp.json();
    if (!body || typeof body !== 'object') return null;
    return { ...body, policy: normalizeSourcingPolicy(body.policy) };
  } catch (e) {
    console.error('fetchQueryMatrix:err', e?.message || e);
    return null;
  }
}

const FB_POSTS_ACTOR = 'apify~facebook-posts-scraper';

/** Extract + normalize an Indian mobile number from free text → `+91XXXXXXXXXX` or null. */
export function extractPhone(text) {
  const m = String(text || '').replace(/[^\d+]/g, ' ').match(/(?:\+?91|0)?\s*([6-9]\d{9})(?!\d)/);
  return m ? `+91${m[1]}` : null;
}

// How many post photos we relay per listing — enough for a property gallery preview without
// bloating the webhook body.
const MAX_POST_IMAGES = 5;

/**
 * Collect up to MAX_POST_IMAGES https image URLs from a facebook-posts-scraper dataset item.
 * The actor's media shape varies by post type, so probe every plausible field defensively:
 * `media[].photo_image.uri` / `media[].image.uri` (image sometimes a bare string), `attachments`
 * (same entry shapes), `images[]` / `photos[]`, and flat `imageUrl` / `thumbnail` fields.
 * Deliberately ignores generic `url` fields — on media entries those are facebook.com permalinks,
 * not image files. Dedups exact URLs; returns [] when nothing usable is found.
 */
export function extractPostImages(it, max = MAX_POST_IMAGES) {
  const seen = new Set();
  const out = [];
  const push = (u) => {
    if (typeof u !== 'string') return;
    const s = u.trim();
    if (!/^https:\/\//i.test(s) || seen.has(s)) return;
    seen.add(s);
    if (out.length < max) out.push(s);
  };
  const pushEntry = (m) => {
    if (!m) return;
    if (typeof m === 'string') return push(m);
    push(m.photo_image?.uri);
    push(typeof m.image === 'string' ? m.image : m.image?.uri);
    push(m.imageUrl);
    push(m.uri);
    push(m.thumbnail);
  };
  for (const field of ['media', 'attachments', 'images', 'photos']) {
    const arr = it?.[field];
    if (Array.isArray(arr)) for (const m of arr) pushEntry(m);
  }
  pushEntry(it?.image);
  push(it?.imageUrl);
  push(it?.thumbnail);
  return out;
}

/**
 * Enrich ONE sourced listing by fetching its full Facebook post — the SERP snippet is truncated
 * ("…Read more"), so we scrape the post for the complete description + the owner phone. Video
 * captions come back on `previewDescription`, regular posts on `text`; we take the richest string.
 * Post photos are relayed too (see extractPostImages) — `images` is present only when found.
 * Priced into the sourcing cost baseline. Best-effort: returns { text, phone, postedAt, images? }
 * or null on any miss, so the caller falls back to the SERP snippet.
 */
/**
 * Parse ONE facebook-posts-scraper dataset item into the enrichment shape
 * `{ text, phone, postedAt, images? }` (or null when the item carries nothing usable). Video posts
 * come back as a raw GraphQL video object — caption on `previewDescription`, date on `publish_time`
 * (epoch seconds) — while regular posts use `text` + `time` (ISO); probe all shapes defensively.
 */
export function parseEnrichedItem(it) {
  if (!it) return null;
  const text = [it.previewDescription, it.text, it.message, it.postText]
    .filter((t) => typeof t === 'string' && t.trim())
    .sort((a, b) => b.length - a.length)[0] || '';
  // Authoritative post date: regular posts carry `time`/`timestamp` (ISO or epoch), video posts
  // `publish_time` (epoch SECONDS). This is how we ENFORCE the recency window — Google's SERP date
  // filter is unreliable for facebook.com. Null when the post carries no parseable timestamp.
  const rawTime = it.time || it.timestamp || it.date || it.publishTime || it.publish_time || null;
  let parsed = NaN;
  if (typeof rawTime === 'number') {
    parsed = rawTime < 1e12 ? rawTime * 1000 : rawTime; // epoch seconds vs ms
  } else if (rawTime) {
    parsed = Date.parse(rawTime);
    if (!Number.isFinite(parsed) && /^\d+$/.test(String(rawTime))) {
      const n = Number(rawTime);
      parsed = n < 1e12 ? n * 1000 : n;
    }
  }
  const postedAt = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  const images = extractPostImages(it);
  const withImages = images.length ? { images } : {}; // omit entirely when none — no empty arrays on the relay body
  if (!text) return (postedAt || images.length) ? { text: '', phone: null, postedAt, ...withImages } : null;
  return { text: text.slice(0, 2000), phone: extractPhone(text), postedAt, ...withImages };
}

export async function enrichPost({ apifyToken, url, actorId = FB_POSTS_ACTOR }) {
  if (!apifyToken || !url) return null;
  const endpoint = `${APIFY_BASE}/acts/${encodeURIComponent(actorId)}/run-sync-get-dataset-items?token=${encodeURIComponent(apifyToken)}`;
  try {
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ startUrls: [{ url }], resultsLimit: 1 }),
    });
    if (!resp.ok) {
      console.error('enrichPost:http', resp.status, url);
      return null;
    }
    const items = await resp.json();
    return parseEnrichedItem(Array.isArray(items) ? items[0] : null);
  } catch (e) {
    console.error('enrichPost:err', e?.message || e);
    return null;
  }
}

/**
 * Enrich MANY posts in ONE actor run — the scraper bills a flat "actor-start" event per run on top
 * of the per-post fee, so batching N urls into one run pays that start fee once instead of N times
 * (~15% off the per-post cost, plus one HTTP round-trip instead of N). Returns a Map keyed by the
 * INPUT url → enrichment (same shape as enrichPost); urls the run couldn't scrape are simply absent
 * (caller falls back to the SERP snippet, same as a single-run miss). Matching relies on the actor
 * echoing the input url verbatim on `facebookUrl` (verified live 2026-07-14); `url` is probed as a
 * fallback since it can be rewritten (e.g. /videos/… → /reel/…). Any failure returns an empty Map.
 */
export async function enrichPosts({ apifyToken, urls, actorId = FB_POSTS_ACTOR }) {
  const out = new Map();
  const list = (Array.isArray(urls) ? urls : []).filter(Boolean);
  if (!apifyToken || !list.length) return out;
  const endpoint = `${APIFY_BASE}/acts/${encodeURIComponent(actorId)}/run-sync-get-dataset-items?token=${encodeURIComponent(apifyToken)}`;
  try {
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ startUrls: list.map((url) => ({ url })), resultsLimit: list.length }),
    });
    if (!resp.ok) {
      console.error('enrichPosts:http', resp.status, list.length);
      return out;
    }
    const items = await resp.json();
    if (!Array.isArray(items)) return out;
    // Canonical input-url index — the actor echoes the input on `facebookUrl`.
    const byCanon = new Map(list.map((u) => [canonicalizeUrl(u), u]));
    let unmatched = 0;
    for (const it of items) {
      const enriched = parseEnrichedItem(it);
      if (!enriched) continue;
      const inputUrl = [it?.facebookUrl, it?.inputUrl, it?.url, it?.topLevelUrl]
        .filter(Boolean)
        .map((u) => byCanon.get(canonicalizeUrl(u)))
        .find(Boolean);
      if (inputUrl && !out.has(inputUrl)) out.set(inputUrl, enriched);
      else if (!inputUrl) unmatched += 1;
    }
    if (unmatched) console.warn('enrichPosts:unmatched-items', JSON.stringify({ unmatched, batch: list.length, matched: out.size }));
    return out;
  } catch (e) {
    console.error('enrichPosts:err', e?.message || e);
    return out;
  }
}
