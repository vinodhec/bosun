/**
 * Live-SERP snapshots for the weekly SEO report — the part GSC structurally cannot provide.
 *
 * GSC reports OUR average position; a live Google search shows the actual results a searcher sees
 * TODAY: which exact URL of ours ranks and WHERE (deep rank — "#37, page 4" — not just "absent
 * from page 1"), and the competitor pages sitting above us with their titles. The report uses this
 * to turn "optimize for this term" into "outrank this specific page", and to score REAL rank
 * movement week-over-week.
 *
 * One batched apify~google-search-scraper run per report (newline-separated queries, geo India) —
 * the same actor + APIFY_TOKEN lane sourcing already pays for. Google serves 10 results per page
 * (the num=100 parameter is dead), so depth costs pages: maxPages=5 → rank within the top 50 at
 * 5 page-fetches per query (~₹0.30/page). The run is started async and polled — a deep multi-page
 * sweep exceeds the run-sync endpoint's ceiling. Any failure returns an empty Map — the report
 * ships without the SERP layer, never blocks on it.
 */

const APIFY_BASE = 'https://api.apify.com/v2';
const POLL_MS = 8000;
const POLL_BUDGET_MS = 420000; // 7 min — inside the function's 900s ceiling with room to spare

const OUR_HOST_RE = /(^|\.)maadiveedu\.com$/i;

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, '');
  } catch {
    return '';
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function apifyJson(url, init) {
  const resp = await fetch(url, { ...init, signal: AbortSignal.timeout(60000) });
  if (!resp.ok) throw new Error(`apify-http-${resp.status}`);
  return resp.json();
}

/**
 * Run one live Google search per query (batched into a single actor run), `maxPages` deep.
 * Returns Map<queryLowercase, snapshot> where snapshot =
 *   { query, ourRank (global, 1-based across pages), ourPage, ourUrl, searchedDepth,
 *     results: [{ rank, url, domain, title }] (top 10 for display),
 *     above: competitors ranked above us on page 1 (or the whole page 1 when we're deeper/absent) }
 */
export async function serpSweep({ apifyToken, actorId, queries, countryCode = 'in', maxPages = 1 }) {
  const out = new Map();
  const list = [...new Set((queries || []).map((q) => String(q || '').trim()).filter(Boolean))];
  if (!apifyToken || !actorId || !list.length) return out;

  let items;
  try {
    const start = await apifyJson(
      `${APIFY_BASE}/acts/${encodeURIComponent(actorId)}/runs?token=${encodeURIComponent(apifyToken)}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          queries: list.join('\n'),
          maxPagesPerQuery: Math.max(1, Math.floor(maxPages)),
          resultsPerPage: 10,
          countryCode,
        }),
      },
    );
    const runId = start?.data?.id;
    let datasetId = start?.data?.defaultDatasetId;
    let status = start?.data?.status;
    if (!runId) return out;

    const deadline = Date.now() + POLL_BUDGET_MS;
    while ((status === 'READY' || status === 'RUNNING') && Date.now() < deadline) {
      await sleep(POLL_MS);
      const s = await apifyJson(`${APIFY_BASE}/actor-runs/${runId}?token=${encodeURIComponent(apifyToken)}`);
      status = s?.data?.status || status;
      datasetId = s?.data?.defaultDatasetId || datasetId;
    }
    if (status !== 'SUCCEEDED') console.error('serpSweep:run-status', status);
    if (!datasetId) return out;
    items = await apifyJson(
      `${APIFY_BASE}/datasets/${datasetId}/items?token=${encodeURIComponent(apifyToken)}&clean=true`,
    );
  } catch (e) {
    console.error('serpSweep:err', e?.message || e);
    return out;
  }

  // One dataset item per (query, page) — merge pages per term; global rank = (page-1)*10 + position.
  const byTerm = new Map();
  for (const it of Array.isArray(items) ? items : []) {
    const term = String(it?.searchQuery?.term || '').trim().toLowerCase();
    if (!term) continue;
    const page = Math.max(1, Number(it?.searchQuery?.page) || 1);
    const arr = byTerm.get(term) || [];
    for (const [i, r] of (Array.isArray(it?.organicResults) ? it.organicResults : []).entries()) {
      const url = String(r?.url || r?.link || '');
      if (!url) continue;
      arr.push({
        rank: (page - 1) * 10 + (Number(r?.position) || i + 1),
        url,
        domain: hostOf(url),
        title: String(r?.title || '').slice(0, 200),
      });
    }
    byTerm.set(term, arr);
  }

  const searchedDepth = Math.max(1, Math.floor(maxPages)) * 10;
  for (const [term, arr] of byTerm) {
    arr.sort((a, b) => a.rank - b.rank);
    const ours = arr.find((r) => OUR_HOST_RE.test(r.domain));
    const ourRank = ours?.rank ?? null;
    const page1 = arr.filter((r) => r.rank <= 10);
    const above = page1.filter((r) => !OUR_HOST_RE.test(r.domain) && (ourRank == null || r.rank < ourRank)).slice(0, 10);
    out.set(term, {
      query: term,
      ourRank,
      ourPage: ourRank ? Math.ceil(ourRank / 10) : null,
      ourUrl: ours?.url || null,
      searchedDepth,
      results: page1,
      above,
    });
  }
  return out;
}
