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

/**
 * Run an Apify actor synchronously and return its dataset items, normalized to
 * `[{ url, title, snippet }]`. Uses run-sync-get-dataset-items so one HTTPS call both runs the
 * actor and returns results. `freshness` is Google's `tbs` value (e.g. 'qdr:d' = last 24h). Any
 * failure (missing config, non-2xx, network, bad JSON) returns `[]`.
 */
export async function callSerpActor({ apifyToken, actorId, query, freshness, extraInput = {} }) {
  if (!apifyToken || !actorId || !query) return [];
  const url = `${APIFY_BASE}/acts/${encodeURIComponent(actorId)}/run-sync-get-dataset-items?token=${encodeURIComponent(apifyToken)}`;
  const input = {
    queries: query,          // apify/google-search-scraper accepts newline-separated queries
    maxPagesPerQuery: 1,
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

/**
 * Sign a relay body with the org's HMAC secret. The signature covers `${timestamp}.${body}` so the
 * receiver can reject replays by checking the timestamp. Returns headers the receiver recomputes.
 */
export function signPayload(secret, bodyString, timestamp = Date.now()) {
  const ts = String(timestamp);
  const mac = crypto.createHmac('sha256', String(secret)).update(`${ts}.${bodyString}`).digest('hex');
  return { signature: `sha256=${mac}`, timestamp: ts };
}
