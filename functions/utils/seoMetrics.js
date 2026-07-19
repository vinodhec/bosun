/**
 * Pure, deterministic metric math for the weekly SEO report (handlers/seoWeeklyReport.js).
 * No I/O, no clocks other than the nowMs argument — every function here is unit-testable and the
 * ONLY place the report's numbers are computed. Gemini never invents figures; it narrates these.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function ymd(d) {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}
function yyyymmdd(d) {
  return ymd(d).replaceAll('-', '');
}

/**
 * The report week: the most recent full Mon–Sun that ended at least 3 days before the run date
 * (IST) — Search Analytics data lags ~2–3 days, so this range is always complete. On a Monday
 * 05:00 IST run this is the week BEFORE last. periodKey = yyyymmdd of the week's Monday.
 */
export function reportWeekRange(nowMs) {
  const ist = new Date(nowMs + IST_OFFSET_MS);
  const today = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()));
  const cutoff = new Date(today.getTime() - 3 * DAY_MS);
  // Most recent Sunday on or before the cutoff (getUTCDay: Sun=0).
  const end = new Date(cutoff.getTime() - cutoff.getUTCDay() * DAY_MS);
  const start = new Date(end.getTime() - 6 * DAY_MS);
  const prevEnd = new Date(end.getTime() - 7 * DAY_MS);
  const prevStart = new Date(start.getTime() - 7 * DAY_MS);
  return {
    startDate: ymd(start),
    endDate: ymd(end),
    prevStartDate: ymd(prevStart),
    prevEndDate: ymd(prevEnd),
    periodKey: yyyymmdd(start),
    prevPeriodKey: yyyymmdd(prevStart),
  };
}

/**
 * Join current-week rows with previous-week rows on keyFn and stamp week-over-week deltas.
 * Rows missing from the previous week get prev* = 0 (position 0 = "not ranked").
 */
export function joinWithPrev(rows, prevRows, keyFn) {
  const prev = new Map(prevRows.map((r) => [keyFn(r), r]));
  return rows.map((r) => {
    const p = prev.get(keyFn(r));
    return {
      ...r,
      prevClicks: p?.clicks ?? 0,
      prevImpressions: p?.impressions ?? 0,
      prevPosition: p?.position ?? 0,
      deltaClicks: r.clicks - (p?.clicks ?? 0),
      deltaImpressions: r.impressions - (p?.impressions ?? 0),
      // Negative = moved UP the rankings. 0 when the row is new (no prior position to compare).
      deltaPosition: p?.position ? r.position - p.position : 0,
    };
  });
}

/** Top-N gainers and decliners by clicks delta (rows with no movement excluded). */
export function pickWinnersLosers(joined, n = 5) {
  const moved = joined.filter((r) => r.deltaClicks !== 0);
  const byDelta = [...moved].sort((a, b) => b.deltaClicks - a.deltaClicks);
  return {
    winners: byDelta.filter((r) => r.deltaClicks > 0).slice(0, n),
    losers: byDelta
      .filter((r) => r.deltaClicks < 0)
      .sort((a, b) => a.deltaClicks - b.deltaClicks)
      .slice(0, n),
  };
}

/**
 * Striking distance: query+page rows ranking just off page 1 (position 8–20) with real demand —
 * the highest-leverage SEO work, sorted by impressions.
 */
export function pickStrikingDistance(
  rows,
  { minPosition = 8, maxPosition = 20, minImpressions = 50, limit = 15 } = {},
) {
  return rows
    .filter((r) => r.position >= minPosition && r.position <= maxPosition && r.impressions >= minImpressions)
    .sort((a, b) => b.impressions - a.impressions)
    .slice(0, limit);
}

/**
 * Score one prior action item against this week's metrics for its target.
 * improved  — position dropped ≥0.5 OR clicks up ≥20% (with real volume)
 * declined  — the inverse
 * unmeasurable — technical items, or too little data on either side to judge
 */
export function scoreActionItem(before, now) {
  if (!before || !now) return 'unmeasurable';
  const bImp = Number(before.impressions) || 0;
  const nImp = Number(now.impressions) || 0;
  if (bImp < 10 && nImp < 10) return 'unmeasurable';
  const posDelta = (Number(before.position) || 0) - (Number(now.position) || 0); // positive = moved up
  const bClicks = Number(before.clicks) || 0;
  const nClicks = Number(now.clicks) || 0;
  const clicksUp = bClicks > 0 ? (nClicks - bClicks) / bClicks : nClicks > 0 ? 1 : 0;
  if (posDelta >= 0.5 || clicksUp >= 0.2) return 'improved';
  if (posDelta <= -0.5 || clicksUp <= -0.2) return 'declined';
  return 'no_change';
}

/**
 * Deterministic action-item candidates: striking-distance rows (the wins waiting to happen),
 * biggest decliners (the bleeding to stop), and indexing problems (technical). Code owns the ids
 * and targets — Gemini only writes title/why/expected prose against a candidateId.
 */
export function buildActionCandidates(periodKey, { strikingDistance = [], losers = [], indexing = {} } = {}) {
  const candidates = [];
  const metricOf = (r) => ({ clicks: r.clicks, impressions: r.impressions, position: r.position });

  for (const r of strikingDistance.slice(0, 5)) {
    candidates.push({
      target: { type: 'query', query: r.keys[0] || '', page: r.keys[1] || '', metricAtCreation: metricOf(r) },
      hint: `Striking distance: "${r.keys[0]}" at position ${r.position.toFixed(1)} with ${r.impressions} impressions`,
    });
  }
  for (const r of losers.slice(0, 3)) {
    candidates.push({
      target: { type: 'page', page: r.keys[0] || '', metricAtCreation: metricOf(r) },
      hint: `Declining page: ${r.keys[0]} lost ${-r.deltaClicks} clicks week-over-week`,
    });
  }
  const sitemapErrors = (indexing.sitemaps || []).filter((s) => s.errors > 0 || s.warnings > 0);
  if (sitemapErrors.length) {
    candidates.push({
      target: { type: 'technical', page: sitemapErrors[0].path, metricAtCreation: null },
      hint: `Sitemap issues: ${sitemapErrors.map((s) => `${s.path} (${s.errors} errors, ${s.warnings} warnings)`).join('; ')}`,
    });
  }
  const notIndexed = (indexing.inspectedSample || []).filter(
    (u) => u.verdict && u.verdict !== 'PASS' && u.verdict !== 'VERDICT_UNSPECIFIED',
  );
  if (notIndexed.length) {
    candidates.push({
      target: { type: 'technical', page: notIndexed[0].url, metricAtCreation: null },
      hint: `Pages with indexing problems: ${notIndexed.map((u) => `${u.url} (${u.coverageState || u.verdict})`).join('; ')}`,
    });
  }

  return candidates.slice(0, 10).map((c, idx) => ({ id: `ai_${periodKey}_${idx}`, ...c }));
}
