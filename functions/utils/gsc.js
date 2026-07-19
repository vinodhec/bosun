/**
 * Google Search Console client for the weekly SEO report agent (handlers/seoWeeklyReport.js).
 * Read-only, three endpoints:
 *   - searchAnalytics/query  — clicks/impressions/CTR/position by query/page over a date range
 *   - sitemaps list          — submitted sitemaps + error/warning counts (the `indexed` field has
 *                              been empty for years on most properties; render only when present)
 *   - urlInspection/index:inspect — coverage state per URL (quota 2,000/day — callers must cap)
 *
 * Auth: access is granted per EMAIL on the Search Console property, not per GCP project — so this
 * agent authenticates as its own service account added as a user on the customer's property.
 *   - GSC_SA_KEY_JSON set → JWT with the explicit webmasters.readonly scope (the primary path;
 *     a dedicated SA key in Secret Manager, bound to the function).
 *   - else → ADC with the scope requested (opportunistic; Cloud Run metadata tokens don't always
 *     honour scope narrowing, hence the key path is primary).
 * Every fetch fails soft (throws with a terse reason) — the caller owns the degrade path.
 */
import { JWT, GoogleAuth } from 'google-auth-library';

const GSC_SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
const SEARCH_ANALYTICS_BASE = 'https://searchconsole.googleapis.com/webmasters/v3';
const URL_INSPECTION_URL = 'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect';

let _auth = null;

/** Memoised auth client — JWT from GSC_SA_KEY_JSON when present, else scoped ADC. */
function gscAuth() {
  if (_auth) return _auth;
  const keyJson = process.env.GSC_SA_KEY_JSON;
  if (keyJson) {
    const key = JSON.parse(keyJson);
    _auth = new JWT({ email: key.client_email, key: key.private_key, scopes: [GSC_SCOPE] });
  } else {
    _auth = new GoogleAuth({ scopes: [GSC_SCOPE] });
  }
  return _auth;
}

async function gscToken() {
  const auth = gscAuth();
  if (auth instanceof JWT) {
    const { token } = await auth.getAccessToken();
    return token;
  }
  const client = await auth.getClient();
  const { token } = await client.getAccessToken();
  return token;
}

async function gscFetch(url, { method = 'GET', body } = {}) {
  const token = await gscToken();
  const resp = await fetch(url, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { 'content-type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30000),
  });
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`gsc-http-${resp.status}: ${text.slice(0, 200)}`);
  }
  return resp.json();
}

/**
 * Search Analytics query. Dates are YYYY-MM-DD (GSC's own timezone, PT — fine at week granularity).
 * Returns rows normalised to { keys, clicks, impressions, ctr, position } (empty array when the
 * range has no data).
 */
export async function querySearchAnalytics(
  siteUrl,
  { startDate, endDate, dimensions = [], rowLimit = 1000, dimensionFilterGroups },
) {
  const out = await gscFetch(
    `${SEARCH_ANALYTICS_BASE}/sites/${encodeURIComponent(siteUrl)}/searchAnalytics/query`,
    {
      method: 'POST',
      body: {
        startDate,
        endDate,
        dimensions,
        rowLimit,
        ...(dimensionFilterGroups ? { dimensionFilterGroups } : {}),
      },
    },
  );
  return (out.rows || []).map((r) => ({
    keys: r.keys || [],
    clicks: Number(r.clicks) || 0,
    impressions: Number(r.impressions) || 0,
    ctr: Number(r.ctr) || 0,
    position: Number(r.position) || 0,
  }));
}

/** Submitted sitemaps with error/warning counts and per-type submitted/indexed (when present). */
export async function listSitemaps(siteUrl) {
  const out = await gscFetch(`${SEARCH_ANALYTICS_BASE}/sites/${encodeURIComponent(siteUrl)}/sitemaps`);
  return (out.sitemap || []).map((s) => ({
    path: s.path || '',
    lastDownloaded: s.lastDownloaded || null,
    errors: Number(s.errors) || 0,
    warnings: Number(s.warnings) || 0,
    contents: (s.contents || []).map((c) => ({
      type: c.type || '',
      submitted: Number(c.submitted) || 0,
      indexed: c.indexed !== undefined ? Number(c.indexed) || 0 : null,
    })),
  }));
}

/**
 * Index-coverage state for one URL. Needs more than Restricted permission on the property and
 * draws on the 2,000/day inspection quota — callers cap their sample.
 */
export async function inspectUrl(siteUrl, inspectionUrl) {
  const out = await gscFetch(URL_INSPECTION_URL, {
    method: 'POST',
    body: { siteUrl, inspectionUrl },
  });
  const r = out.inspectionResult?.indexStatusResult || {};
  return {
    url: inspectionUrl,
    verdict: r.verdict || 'VERDICT_UNSPECIFIED',
    coverageState: r.coverageState || '',
    lastCrawlTime: r.lastCrawlTime || null,
  };
}
