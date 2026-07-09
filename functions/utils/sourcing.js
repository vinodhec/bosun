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

/** Flatten Apify Google-SERP dataset items (organic results) into `[{ url, title, snippet }]`. */
export function normalizeSerpItems(items) {
  const out = [];
  const arr = Array.isArray(items) ? items : [];
  for (const it of arr) {
    const organic = Array.isArray(it?.organicResults) ? it.organicResults
      : Array.isArray(it?.results) ? it.results
      : null;
    if (organic) {
      for (const r of organic) {
        const u = r?.url || r?.link;
        if (u) out.push({ url: String(u), title: String(r?.title || ''), snippet: String(r?.description || r?.snippet || '') });
      }
    } else if (it?.url || it?.link) {
      out.push({ url: String(it.url || it.link), title: String(it.title || ''), snippet: String(it.description || it.snippet || '') });
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
 * dry run never consumes a locality's cadence. Returns the parsed body ({ targets: [...] }) or null on
 * any failure (degrade-safe: a bad pull just means nothing to source).
 */
export async function fetchQueryMatrix({ matrixUrl, secret, limit, dryRun = true }) {
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
  try {
    const resp = await fetch(url.toString(), {
      method: 'GET',
      headers: { 'x-bosun-signature': signature, 'x-bosun-timestamp': timestamp },
    });
    if (!resp.ok) {
      console.error('fetchQueryMatrix:http', resp.status);
      return null;
    }
    return await resp.json();
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

/**
 * Enrich ONE sourced listing by fetching its full Facebook post — the SERP snippet is truncated
 * ("…Read more"), so we scrape the post for the complete description + the owner phone. Video
 * captions come back on `previewDescription`, regular posts on `text`; we take the richest string.
 * Priced into the sourcing cost baseline. Best-effort: returns { text, phone } or null on any miss,
 * so the caller falls back to the SERP snippet.
 */
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
    const it = Array.isArray(items) ? items[0] : null;
    if (!it) return null;
    const text = [it.previewDescription, it.text, it.message, it.postText]
      .filter((t) => typeof t === 'string' && t.trim())
      .sort((a, b) => b.length - a.length)[0] || '';
    // Authoritative post date: the FB-posts scraper returns `time` (ISO). This is how we ENFORCE the
    // recency window — Google's SERP date filter is unreliable for facebook.com (index date, and
    // multi-month qdr values are ignored). Null when the post carries no parseable timestamp.
    const rawTime = it.time || it.timestamp || it.date || it.publishTime || null;
    const parsed = rawTime ? Date.parse(rawTime) : NaN;
    const postedAt = Number.isFinite(parsed) ? parsed : null;
    if (!text) return postedAt ? { text: '', phone: null, postedAt } : null;
    return { text: text.slice(0, 2000), phone: extractPhone(text), postedAt };
  } catch (e) {
    console.error('enrichPost:err', e?.message || e);
    return null;
  }
}
