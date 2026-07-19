/**
 * The weekly SEO report agent — the "watch the search engine for me" service line.
 *
 * Two entry points over ONE shared flow (`runSeoReportForOrg`):
 *   - `weeklySeoReport` — Monday 05:00 IST cron over every org with sourcing.seo.enabled
 *                         (90 min after weeklyIntelligence so the two report rails never contend).
 *   - `seoReportNow`    — HTTPS on-demand trigger (same HMAC handshake as sourcingPlanNow) so a
 *                         report can be produced/tested without waiting for Monday.
 *
 * Flow per org: pull Search Console data for the report week + the week before (utils/gsc.js) →
 * deterministic tables, deltas, winners/losers, striking distance (utils/seoMetrics.js — the ONLY
 * place numbers are computed) → re-check LAST week's action items against fresh GSC data and score
 * movement (the accountability loop: the report is a management tool, not a snapshot) → one Gemini
 * Flash narrative over the verified numbers (thinkingBudget 0; a Flash failure NEVER blocks the
 * report — deterministic fallback items ship instead) → POST to the platform's
 * /api/ingest/seo-report → settle billing on the 2xx ack.
 *
 * Billing: FLAT per report, drawn randomly in [SEO_REPORT_MIN, MAX] paise per run (the banded-flat
 * principle), settled in one transaction (accrual `seoReportAccrualPaise`, ledger kind
 * `seo_weekly_report`) — the daily_plan discipline. Idempotency: the settle writes
 * `usage_meter_log/{orgId}:seo_weekly_report:{periodKey}`; both entry points pre-check that doc, so
 * a scheduler retry or an on-demand call after a successful week are charged:0 no-ops. The
 * platform's ingest is first-report-wins on top.
 *
 * Report week: the most recent full Mon–Sun ending ≥3 days before the run (GSC data lags ~2–3
 * days) — see reportWeekRange. periodKey = that week's Monday (yyyymmdd).
 *
 * Config: organisations/{orgId}.sourcing.seo = { enabled, reportUrl, siteUrl } where siteUrl is the
 * EXACT Search Console property string ('sc-domain:example.com' or 'https://example.com/').
 * Secret: orgSecrets/{orgId}.sourcing.secret. Audit + loop state: seoRuns/{orgId}/reports/{periodKey}.
 * GSC auth: GSC_SA_KEY_JSON secret (utils/gsc.js) — the SA email must be added as a user on the
 * property (Full permission; URL Inspection needs more than Restricted).
 */
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { onRequest } from 'firebase-functions/v2/https';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import crypto from 'node:crypto';
import { signPayload } from '../utils/sourcing.js';
import { verifyCustomerSignature, logReject } from '../utils/customerAuth.js';
import { generateJson, GEMINI_FLASH } from '../utils/gemini.js';
import {
  randomSeoReportPricePaise,
  accrueComposeCharge,
  isServicePaused,
} from '../shared/billing.js';
import { querySearchAnalytics, listSitemaps, inspectUrl } from '../utils/gsc.js';
import { serpSweep } from '../utils/serpSweep.js';
import { APIFY_TOKEN } from '../utils/secrets.js';
import {
  reportWeekRange,
  joinWithPrev,
  pickWinnersLosers,
  pickStrikingDistance,
  scoreActionItem,
  buildActionCandidates,
} from '../utils/seoMetrics.js';

const REGION = 'asia-south1';
const METER_LOG = 'usage_meter_log';
const SERVICE = 'seo_weekly_report';
const SERP_QUERY_CAP = 12; // action-item queries: candidates + last week's items
const MARKET_QUERY_CAP = 100; // deep tier: all cities + config seeds + demand-derived
const LOCALITY_ROTATION_WEEKS = 4; // every locality gets a page-1 check once per rotation
const LOCALITY_SLICE_CAP = 130;
const BASELINE_LOOKBACK = 5; // prior reports to scan for a query's last rank (rotation-aware)
const INSPECT_TOP = 5; // top pages by impressions (the winners)
const INSPECT_RANDOM = 5; // random sitemap URLs (the long tail — is it even indexed?)

const NARRATIVE_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    summary: { type: 'string' },
    highlights: { type: 'array', items: { type: 'string' } },
    actionItems: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          candidateId: { type: 'string' },
          title: { type: 'string' },
          why: { type: 'string' },
          expected: { type: 'string' },
        },
        required: ['candidateId', 'title', 'why', 'expected'],
      },
    },
  },
  required: ['title', 'summary', 'highlights', 'actionItems'],
};

const round2 = (n) => Math.round(n * 100) / 100;
const shapeRow = (r) => ({
  keys: r.keys,
  clicks: r.clicks,
  impressions: r.impressions,
  ctr: round2(r.ctr * 100),
  position: round2(r.position),
  deltaClicks: r.deltaClicks ?? 0,
  deltaImpressions: r.deltaImpressions ?? 0,
  deltaPosition: round2(r.deltaPosition ?? 0),
});

/** "plot / land for sale…" → "plot for sale…": tracker queries must read like a real search. */
function normalizeQuery(q) {
  return String(q || '').trim().toLowerCase().replace(/(\S+)\s*\/\s*\S+/g, '$1').replace(/\s+/g, ' ');
}

/**
 * The market tracker's two tiers (operator decision 2026-07-19 — the "middle path"):
 *   deep    — every TN city (seoLocations doc, synced from the platform's tnLocations.ts) plus
 *             config seeds plus demand-derived queries, ranked to the top 50 EVERY week.
 *   shallow — the 343 localities in a 4-week rotation, page-1 check only, so every locality gets
 *             a look each month for ~1/5th the page cost of deep-checking them all.
 * The rotation slice is deterministic in the periodKey (week index mod 4) — a re-run of the same
 * report week always checks the same localities.
 */
async function buildMarketQueries(db, orgId, seo, priorDoc, periodKey) {
  const deep = [];
  const pushDeep = (q) => {
    const s = normalizeQuery(q);
    if (s && !deep.includes(s) && deep.length < MARKET_QUERY_CAP) deep.push(s);
  };

  let locations = { cities: [], localities: [] };
  try {
    const snap = await db.collection('seoLocations').doc(orgId).get();
    if (snap.exists) locations = snap.data();
  } catch (e) {
    console.error('seoReport:locations:err', orgId, e?.message || e);
  }

  for (const q of Array.isArray(seo.trackedQueries) ? seo.trackedQueries : []) pushDeep(q);
  for (const city of locations.cities || []) pushDeep(`plot for sale in ${city}`);
  try {
    const snap = await db
      .collection('intelRuns')
      .doc(orgId)
      .collection('days')
      .orderBy('dateKey', 'desc')
      .limit(1)
      .get();
    for (const r of snap.empty ? [] : snap.docs[0].data().demandTop || []) {
      const place = [r.locality, r.city].filter(Boolean).join(' ');
      if (!place || !r.propertyType) continue;
      const intent = /rent/i.test(String(r.listingType || '')) ? 'for rent' : 'for sale';
      pushDeep(`${String(r.propertyType)} ${intent} in ${place}`);
    }
  } catch (e) {
    console.error('seoReport:marketQueries:err', orgId, e?.message || e);
  }

  // This week's locality slice: week index (from the periodKey's Monday) mod rotation length.
  const d = new Date(Date.UTC(+periodKey.slice(0, 4), +periodKey.slice(4, 6) - 1, +periodKey.slice(6, 8)));
  const weekIndex = Math.floor(d.getTime() / (7 * 24 * 60 * 60 * 1000)) % LOCALITY_ROTATION_WEEKS;
  const shallow = [];
  (locations.localities || []).forEach((l, i) => {
    if (i % LOCALITY_ROTATION_WEEKS !== weekIndex || shallow.length >= LOCALITY_SLICE_CAP) return;
    const s = normalizeQuery(`plot for sale in ${l.name} ${l.city}`);
    if (s && !deep.includes(s) && !shallow.includes(s)) shallow.push(s);
  });

  return { deep, shallow };
}

/** Random sample of page URLs from up to two of the site's sitemap files. */
async function sampleSitemapUrls(sitemaps, n) {
  const files = sitemaps.map((s) => s.path).filter((p) => /\.xml(\?|$)/i.test(p));
  const urls = [];
  for (const f of [...files].sort(() => Math.random() - 0.5).slice(0, 2)) {
    try {
      const xml = await (await fetch(f, { signal: AbortSignal.timeout(20000) })).text();
      for (const m of xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/g)) {
        if (!/\.xml(\?|$)/i.test(m[1])) urls.push(m[1]);
      }
    } catch (e) {
      console.error('seoReport:sitemapFetch:err', e?.message || e);
    }
  }
  return [...new Set(urls)].sort(() => Math.random() - 0.5).slice(0, n);
}

/** This week's metrics for one prior action item's target (equals filter on query and/or page). */
async function metricNowForTarget(siteUrl, range, target) {
  const filters = [];
  if (target.query) filters.push({ dimension: 'query', operator: 'equals', expression: target.query });
  if (target.page) filters.push({ dimension: 'page', operator: 'equals', expression: target.page });
  if (!filters.length) return null;
  const rows = await querySearchAnalytics(siteUrl, {
    startDate: range.startDate,
    endDate: range.endDate,
    dimensions: [],
    rowLimit: 1,
    dimensionFilterGroups: [{ groupType: 'and', filters }],
  });
  const r = rows[0];
  return r ? { clicks: r.clicks, impressions: r.impressions, position: round2(r.position) } : { clicks: 0, impressions: 0, position: 0 };
}

/**
 * Produce, deliver and settle one org's weekly SEO report. Returns a summary object (never
 * throws — a failure must not break the org loop; a missed week is caught by next Monday's run
 * or an on-demand trigger).
 */
export async function runSeoReportForOrg(db, orgId, cfg, trigger) {
  const seo = cfg.seo || {};
  const range = reportWeekRange(Date.now());
  const { periodKey } = range;
  const summary = { orgId, periodKey, trigger, status: 'skipped' };

  try {
    if (!seo.enabled || !seo.reportUrl || !seo.siteUrl) {
      summary.reason = 'seo-not-configured';
      return summary;
    }

    // Idempotency pre-check — the settle log doubles as "this week is already reported & billed".
    const logRef = db.collection(METER_LOG).doc(`${orgId}:${SERVICE}:${periodKey}`);
    if ((await logRef.get()).exists) {
      summary.reason = 'already-reported';
      return summary;
    }

    const secretSnap = await db.collection('orgSecrets').doc(orgId).get();
    const secret = secretSnap.exists ? secretSnap.data()?.sourcing?.secret : null;
    if (!secret) {
      summary.status = 'error';
      summary.reason = 'no-secret';
      return summary;
    }

    const siteUrl = seo.siteUrl;
    const cur = { startDate: range.startDate, endDate: range.endDate };
    const prev = { startDate: range.prevStartDate, endDate: range.prevEndDate };

    // 1) Pull GSC — current + previous week. Totals and per-dimension tables; the query+page table
    // feeds striking distance. Sitemaps/inspection are fail-soft: an indexing hiccup never blocks
    // the search-analytics core.
    const [totalsCur, totalsPrev, byQuery, byQueryPrev, byPage, byPagePrev, byQueryPage] =
      await Promise.all([
        querySearchAnalytics(siteUrl, { ...cur, dimensions: [], rowLimit: 1 }),
        querySearchAnalytics(siteUrl, { ...prev, dimensions: [], rowLimit: 1 }),
        querySearchAnalytics(siteUrl, { ...cur, dimensions: ['query'] }),
        querySearchAnalytics(siteUrl, { ...prev, dimensions: ['query'] }),
        querySearchAnalytics(siteUrl, { ...cur, dimensions: ['page'] }),
        querySearchAnalytics(siteUrl, { ...prev, dimensions: ['page'] }),
        querySearchAnalytics(siteUrl, { ...cur, dimensions: ['query', 'page'] }),
      ]);

    let sitemaps = [];
    try {
      sitemaps = await listSitemaps(siteUrl);
    } catch (e) {
      console.error('seoReport:sitemaps:err', orgId, e?.message || e);
    }
    // Inspection sample: the top pages (winners) PLUS a random sitemap draw — top-only sampling is
    // biased toward pages that already work; the random draw asks whether the long tail of listing
    // pages is indexed at all. Well inside the 2,000/day quota.
    const topPageUrls = byPage
      .sort((a, b) => b.impressions - a.impressions)
      .slice(0, INSPECT_TOP)
      .map((r) => r.keys[0])
      .filter(Boolean);
    const randomUrls = (await sampleSitemapUrls(sitemaps, INSPECT_RANDOM)).filter((u) => !topPageUrls.includes(u));
    const inspectedSample = [];
    for (const { url, source } of [
      ...topPageUrls.map((url) => ({ url, source: 'top' })),
      ...randomUrls.map((url) => ({ url, source: 'random' })),
    ]) {
      try {
        inspectedSample.push({ ...(await inspectUrl(siteUrl, url)), source });
      } catch (e) {
        console.error('seoReport:inspect:err', orgId, url, e?.message || e);
        break; // quota/permission problem — don't hammer, ship what we have
      }
    }
    const indexing = { sitemaps, inspectedSample };

    // 2) Deterministic tables.
    const keyOf = (r) => r.keys.join('␟');
    const queries = joinWithPrev(byQuery, byQueryPrev, keyOf).sort((a, b) => b.clicks - a.clicks);
    const pages = joinWithPrev(byPage, byPagePrev, keyOf).sort((a, b) => b.clicks - a.clicks);
    const { winners, losers } = pickWinnersLosers(pages);
    const strikingDistance = pickStrikingDistance(byQueryPage);
    const t = totalsCur[0] || { clicks: 0, impressions: 0, ctr: 0, position: 0 };
    const p = totalsPrev[0] || { clicks: 0, impressions: 0, ctr: 0, position: 0 };
    const totals = {
      clicks: t.clicks,
      impressions: t.impressions,
      ctr: round2(t.ctr * 100),
      position: round2(t.position),
      prevClicks: p.clicks,
      prevImpressions: p.impressions,
      prevCtr: round2(p.ctr * 100),
      prevPosition: round2(p.position),
    };

    // 3) Accountability loop — score LAST report's action items against this week's data. Read our
    // own audit trail (latest report before this periodKey — robust to a skipped week).
    const prevActionItemsReview = [];
    let priorDocs = [];
    try {
      const priorSnap = await db
        .collection('seoRuns')
        .doc(orgId)
        .collection('reports')
        .where('periodKey', '<', periodKey)
        .orderBy('periodKey', 'desc')
        .limit(BASELINE_LOOKBACK)
        .get();
      priorDocs = priorSnap.docs.map((d) => d.data());
    } catch (e) {
      console.error('seoReport:prior:err', orgId, e?.message || e);
    }
    const priorDoc = priorDocs[0] || null;
    for (const item of priorDoc?.actionItems || []) {
      const target = item.target || {};
      let metricNow = null;
      if (target.type !== 'technical') {
        try {
          metricNow = await metricNowForTarget(siteUrl, cur, target);
        } catch (e) {
          console.error('seoReport:recheck:err', orgId, item.id, e?.message || e);
        }
      }
      const movement =
        target.type === 'technical' ? 'unmeasurable' : scoreActionItem(target.metricAtCreation, metricNow);
      prevActionItemsReview.push({
        id: item.id || '',
        title: item.title || '',
        target,
        metricBefore: target.metricAtCreation || null,
        metricNow,
        movement,
        serpBefore: item.serpRank ?? null, // live rank when the item was created
        serpNow: null, // filled after the SERP sweep below
      });
    }
    const counts = { improved: 0, declined: 0, no_change: 0, unmeasurable: 0 };
    for (const r of prevActionItemsReview) counts[r.movement] = (counts[r.movement] || 0) + 1;
    const measurable = counts.improved + counts.declined + counts.no_change;
    const accountability = {
      reviewed: prevActionItemsReview.length,
      improved: counts.improved,
      declined: counts.declined,
      noChange: counts.no_change,
      unmeasurable: counts.unmeasurable,
      score: measurable ? round2(counts.improved / measurable) : null,
    };

    // 4) Narrative + action items — Flash writes prose against code-owned candidates; ids that
    // don't echo a candidate are dropped. Deterministic fallback ships templated items.
    const candidates = buildActionCandidates(periodKey, { strikingDistance, losers, indexing });

    // 4b) Live SERP sweep — the non-GSC layer: what the actual Google page 1 (India) looks like
    // TODAY for the queries we're about to assign work on, plus last week's items so the review can
    // show real rank movement. One batched actor run; failure ships the report without it.
    const { deep: marketDeep, shallow: marketShallow } = await buildMarketQueries(db, orgId, seo, priorDoc, periodKey);
    const serpQueries = [
      ...candidates.map((c) => c.target.query).filter(Boolean),
      ...(priorDoc?.actionItems || []).map((i) => i?.target?.query).filter(Boolean),
    ].slice(0, SERP_QUERY_CAP);
    // Three parallel actor runs: the deep tier split in two (halves the wall-clock of ~500 page
    // fetches), the locality slice shallow. Deep = rank within top 50; shallow = page-1 check.
    const apifyToken = process.env.APIFY_TOKEN;
    const actorId = cfg.actorId || 'apify~google-search-scraper';
    const deepQueries = [...serpQueries, ...marketDeep];
    const mid = Math.ceil(deepQueries.length / 2);
    const [deepA, deepB, shallowSerp] = await Promise.all([
      serpSweep({ apifyToken, actorId, queries: deepQueries.slice(0, mid), maxPages: 5 }),
      serpSweep({ apifyToken, actorId, queries: deepQueries.slice(mid), maxPages: 5 }),
      serpSweep({ apifyToken, actorId, queries: marketShallow, maxPages: 1 }),
    ]);
    const serpByQuery = new Map([...shallowSerp, ...deepA, ...deepB]);
    const serpOf = (q) => (q ? serpByQuery.get(String(q).trim().toLowerCase()) : undefined);
    for (const c of candidates) {
      const s = serpOf(c.target.query);
      if (s) c.serp = s;
    }
    for (const r of prevActionItemsReview) {
      const s = serpOf(r.target?.query);
      if (s) r.serpNow = s.ourRank;
    }

    // The market rank tracker: same commercial queries every week (cities deep) / every rotation
    // (localities shallow), live rank vs the query's LAST check — which for a rotated locality is
    // up to 4 reports back, hence the multi-doc baseline lookback.
    const priorMarketByQuery = new Map();
    for (const d of priorDocs) {
      for (const m of d.marketSerp || []) {
        const k = String(m.query || '').toLowerCase();
        if (k && !priorMarketByQuery.has(k)) priorMarketByQuery.set(k, m);
      }
    }
    const marketSerp = [
      ...marketDeep.map((q) => ({ q, tier: 'city' })),
      ...marketShallow.map((q) => ({ q, tier: 'locality' })),
    ].map(({ q, tier }) => {
      const s = serpOf(q);
      const prev = priorMarketByQuery.get(q);
      return {
        query: q,
        tier,
        depth: s?.searchedDepth ?? (tier === 'city' ? 50 : 10),
        ourRank: s?.ourRank ?? null,
        ourUrl: s?.ourUrl ?? null,
        prevRank: prev?.ourRank ?? null,
        prevChecked: Boolean(prev?.checked),
        checked: Boolean(s),
        page1: (s?.results || []).slice(0, 5).map((x) => ({ rank: x.rank, domain: x.domain, title: x.title, url: x.url })),
      };
    });

    const prompt = [
      `Write the weekly SEO report for the property ${siteUrl}, week ${range.startDate} to ${range.endDate} (previous week ${range.prevStartDate} to ${range.prevEndDate}).`,
      `Verified numbers (use ONLY these, never invent figures):`,
      `- Totals: ${totals.clicks} clicks (prev ${totals.prevClicks}), ${totals.impressions} impressions (prev ${totals.prevImpressions}), CTR ${totals.ctr}% (prev ${totals.prevCtr}%), avg position ${totals.position} (prev ${totals.prevPosition})`,
      winners.length
        ? `- Winning pages: ${winners.map((r) => `${r.keys[0]} (+${r.deltaClicks} clicks)`).join('; ')}`
        : '',
      losers.length
        ? `- Declining pages: ${losers.map((r) => `${r.keys[0]} (${r.deltaClicks} clicks)`).join('; ')}`
        : '',
      strikingDistance.length
        ? `- Striking-distance queries (position 8–20, high impressions): ${strikingDistance
            .slice(0, 8)
            .map((r) => `"${r.keys[0]}" pos ${r.position.toFixed(1)}, ${r.impressions} imps`)
            .join('; ')}`
        : '',
      accountability.reviewed
        ? `- Last week's action items: ${accountability.reviewed} reviewed — ${accountability.improved} improved, ${accountability.declined} declined, ${accountability.noChange} unchanged, ${accountability.unmeasurable} unmeasurable`
        : '- First report: no prior action items to review.',
      ...(() => {
        // The tracker spans ~170 queries — feed Gemini the shape, not the firehose: totals,
        // every query where we DO rank (the wins to protect), and a sample of the absences.
        const checked = marketSerp.filter((m) => m.checked);
        if (!checked.length) return [];
        const ranked = checked.filter((m) => m.ourRank != null);
        const moved = checked.filter((m) => m.prevChecked && (m.prevRank ?? null) !== (m.ourRank ?? null));
        return [
          `- Market rank tracker (LIVE Google today): ${checked.length} commercial queries checked (${
            checked.filter((m) => m.tier === 'city').length
          } city-level to top 50, ${checked.filter((m) => m.tier === 'locality').length} locality page-1 rotation). We appear for ${
            ranked.length
          }; absent for ${checked.length - ranked.length}.`,
          ranked.length
            ? `- Where we DO rank: ${ranked
                .map((m) => `"${m.query}" #${m.ourRank}${m.ourRank > 10 ? ' (page ' + Math.ceil(m.ourRank / 10) + ')' : ''}`)
                .join('; ')}`
            : '- We rank NOWHERE in the checked depth for any tracked commercial query.',
          moved.length
            ? `- Movement vs last check: ${moved
                .slice(0, 12)
                .map((m) => `"${m.query}" ${m.prevRank ? '#' + m.prevRank : 'absent'} → ${m.ourRank ? '#' + m.ourRank : 'absent'}`)
                .join('; ')}`
            : '',
          `- Sample of absences (page 1 owners): ${checked
            .filter((m) => m.ourRank == null)
            .slice(0, 6)
            .map((m) => `"${m.query}" — ${m.page1.slice(0, 3).map((p) => p.domain).join(', ')}`)
            .join('; ')}`,
        ].filter(Boolean);
      })(),
      `Action-item candidates (pick up to 6, echo candidateId EXACTLY; write title/why/expected for each):`,
      ...candidates.map((c) => {
        let line = `  ${c.id}: ${c.hint}`;
        if (c.serp) {
          line += c.serp.ourRank
            ? ` — LIVE Google today: we rank #${c.serp.ourRank}${
                c.serp.ourPage > 1 ? ` (page ${c.serp.ourPage})` : ''
              }; page 1 is: ${c.serp.above.slice(0, 3).map((a) => a.domain).join(', ')}`
            : ` — LIVE Google today: we are NOT in the top ${c.serp.searchedDepth}; page 1 is: ${c.serp.results
                .slice(0, 3)
                .map((a) => a.domain)
                .join(', ')}`;
        }
        return line;
      }),
      'Use the LIVE page-1 context to judge winnability: a page 1 dominated by government portals/apps for the head term means the GSC average comes from long-tail variants — say so and target those instead of the head term. Name the specific competitor page to beat when there is one.',
      'If the market rank tracker shows commercial queries where we are absent from page 1 while property portals rank, call that out in the summary — it is the visibility gap the marketplace must close, and rank movement on these queries week-over-week is the scoreboard.',
      'Frame it for the SEO team: what moved, what to do this week, what result to expect. Sober, factual, no hype.',
      'Return JSON {title, summary (3-6 sentences), highlights (3-6 bullets), actionItems (max 6 of {candidateId, title, why, expected})}.',
    ]
      .filter(Boolean)
      .join('\n');

    const out = await generateJson({
      model: GEMINI_FLASH,
      prompt,
      schema: NARRATIVE_SCHEMA,
      temperature: 0.3,
      maxOutputTokens: 2500,
      thinkingBudget: 0,
    });
    const candidateById = new Map(candidates.map((c) => [c.id, c]));
    let actionItems = (out?.actionItems || [])
      .filter((a) => candidateById.has(a.candidateId))
      .slice(0, 6)
      .map((a) => ({
        id: a.candidateId,
        title: String(a.title || '').slice(0, 200),
        why: String(a.why || '').slice(0, 500),
        expected: String(a.expected || '').slice(0, 300),
        target: candidateById.get(a.candidateId).target,
        serpRank: candidateById.get(a.candidateId).serp?.ourRank ?? null,
      }));
    if (!actionItems.length) {
      // Deterministic fallback — the numbers are the product, Flash is garnish.
      actionItems = candidates.slice(0, 5).map((c) => ({
        id: c.id,
        title: c.hint.slice(0, 200),
        why: 'Flagged deterministically from this week’s Search Console data.',
        expected: c.target.type === 'technical' ? 'Indexing issue resolved.' : 'Position/clicks improve within 2–3 weeks.',
        target: c.target,
        serpRank: c.serp?.ourRank ?? null,
      }));
    }
    const narrative = {
      title: out?.title?.slice(0, 160) || `Weekly SEO report ${range.startDate} – ${range.endDate}`,
      summary:
        out?.summary?.slice(0, 4000) ||
        `Clicks ${totals.clicks} (prev ${totals.prevClicks}), impressions ${totals.impressions} (prev ${totals.prevImpressions}), avg position ${totals.position} (prev ${totals.prevPosition}).`,
      highlights: (out?.highlights || []).slice(0, 8).map((s) => String(s).slice(0, 400)),
    };

    // 5) Deliver. Sign the EXACT body bytes.
    const pricePaise = randomSeoReportPricePaise();
    const reportRunId = `seo_${periodKey}_${crypto.randomBytes(5).toString('hex')}`;
    const body = JSON.stringify({
      orgId,
      reportRunId,
      period: 'seo_weekly',
      periodKey,
      generatedAtMs: Date.now(),
      range: { start: range.startDate, end: range.endDate },
      prevRange: { start: range.prevStartDate, end: range.prevEndDate },
      siteUrl,
      totals,
      topQueries: queries.slice(0, 20).map(shapeRow),
      topPages: pages.slice(0, 20).map(shapeRow),
      winners: winners.map(shapeRow),
      losers: losers.map(shapeRow),
      strikingDistance: strikingDistance.slice(0, 15).map(shapeRow),
      indexing: {
        sitemaps: sitemaps.slice(0, 10),
        inspectedSample,
      },
      ...narrative,
      actionItems,
      prevActionItemsReview,
      accountability,
      serpChecks: serpQueries
        .map((q) => serpOf(q))
        .filter(Boolean)
        .map((s) => ({
          query: s.query,
          ourRank: s.ourRank,
          ourUrl: s.ourUrl,
          page1: s.results.map((x) => ({ rank: x.rank, domain: x.domain, title: x.title, url: x.url })),
        })),
      marketSerp,
    });
    const signed = signPayload(secret, body);
    const resp = await fetch(seo.reportUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-bosun-signature': signed.signature,
        'x-bosun-timestamp': signed.timestamp,
      },
      body,
      signal: AbortSignal.timeout(30000),
    });
    if (!resp.ok) {
      summary.status = 'error';
      summary.reason = `report-post-http-${resp.status}`;
      return summary;
    }

    // 6) Settle — flat banded price, one transaction, log row = idempotency key (daily_plan
    // discipline, incl. the billingPaused waive branch used as the dry-run switch).
    let charged = 0;
    charged = await db.runTransaction(async (tx) => {
      const orgRef = db.collection('organisations').doc(orgId);
      const orgSnap = await tx.get(orgRef);
      if (!orgSnap.exists) return 0;
      const dupe = await tx.get(logRef);
      if (dupe.exists) return 0;
      const org = orgSnap.data();

      if (isServicePaused(org, SERVICE)) {
        tx.set(logRef, {
          orgId,
          service: SERVICE,
          idempotencyKey: periodKey,
          qty: 1,
          reportRunId,
          trigger,
          pricePaise,
          debitInr: 0,
          waived: true,
          waivedPaise: pricePaise,
          createdAt: FieldValue.serverTimestamp(),
        });
        return 0;
      }

      const { debitInr, accrualPaise } = accrueComposeCharge(org.seoReportAccrualPaise, pricePaise);
      const update = { seoReportAccrualPaise: accrualPaise };
      if (debitInr > 0) {
        update.balance = Number(org.balance ?? 0) - debitInr;
        tx.set(db.collection('transactions').doc(), {
          orgId,
          type: 'debit',
          kind: SERVICE,
          amount: debitInr,
          description: `Weekly SEO report (week of ${range.startDate}, ${actionItems.length} action items)`,
          createdAt: FieldValue.serverTimestamp(),
        });
      }
      tx.update(orgRef, update);
      tx.set(logRef, {
        orgId,
        service: SERVICE,
        idempotencyKey: periodKey,
        qty: 1,
        reportRunId,
        trigger,
        pricePaise,
        debitInr,
        createdAt: FieldValue.serverTimestamp(),
      });
      return debitInr;
    });

    // 7) Audit + loop state — next week's run reads actionItems from here.
    await db
      .collection('seoRuns')
      .doc(orgId)
      .collection('reports')
      .doc(periodKey)
      .set({
        periodKey,
        reportRunId,
        trigger,
        range: { start: range.startDate, end: range.endDate },
        totals,
        actionItems,
        accountability,
        marketSerp, // next week's prevRank baseline — the tracker's memory
        composed: Boolean(out),
        pricePaise,
        chargedInr: charged,
        createdAt: FieldValue.serverTimestamp(),
      });

    summary.status = 'ok';
    summary.reportRunId = reportRunId;
    summary.actionItems = actionItems.length;
    summary.reviewed = accountability.reviewed;
    summary.composed = Boolean(out);
    return summary;
  } catch (e) {
    console.error('seoWeeklyReport:org', orgId, e?.message || e);
    summary.status = 'error';
    summary.reason = e?.message || String(e);
    return summary;
  }
}

// Monday 05:00 IST — 90 min after weeklyIntelligence, on last-complete-week GSC data.
export const weeklySeoReport = onSchedule(
  {
    region: REGION,
    schedule: '0 5 * * 1',
    timeZone: 'Asia/Kolkata',
    timeoutSeconds: 900, // deep SERP sweep polls an async Apify run — needs headroom
    memory: '512MiB',
    secrets: ['GSC_SA_KEY_JSON', APIFY_TOKEN],
  },
  async () => {
    const db = getFirestore();
    const snap = await db.collection('organisations').where('sourcing.enabled', '==', true).get();
    for (const orgDoc of snap.docs) {
      const cfg = orgDoc.data().sourcing || {};
      if (!cfg.seo?.enabled) continue;
      const summary = await runSeoReportForOrg(db, orgDoc.id, cfg, 'cron');
      console.log('weeklySeoReport:done', orgDoc.id, JSON.stringify(summary));
    }
  },
);

/**
 * POST /seoReportNow — on-demand run for one org ("produce this week's report now"). Body { orgId }
 * signed `${timestamp}.${rawBody}` with the org's relay secret. Used for testing and for re-running
 * a missed Monday; the meter-log pre-check makes a repeat call after success a charged:0 no-op.
 */
export const seoReportNow = onRequest(
  { region: REGION, cors: false, timeoutSeconds: 900, secrets: ['GSC_SA_KEY_JSON', APIFY_TOKEN] },
  async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'POST only' });
      return;
    }
    const raw = req.rawBody ? req.rawBody.toString('utf8') : '';
    let body;
    try {
      body = JSON.parse(raw || '{}');
    } catch {
      res.status(400).json({ error: 'invalid JSON' });
      return;
    }
    const orgId = String(body.orgId || '');
    if (!orgId) {
      res.status(400).json({ error: 'orgId required' });
      return;
    }

    const db = getFirestore();
    const secretSnap = await db.collection('orgSecrets').doc(orgId).get();
    const secret = secretSnap.exists ? secretSnap.data()?.sourcing?.secret : null;
    if (!secret) {
      logReject('seoReportNow', { orgId, status: 403, reason: 'org-has-no-sourcing-secret' });
      res.status(403).json({ error: 'sourcing not configured for this org' });
      return;
    }
    const auth = verifyCustomerSignature(raw, req.get('x-bosun-signature'), req.get('x-bosun-timestamp'), secret);
    if (!auth.ok) {
      logReject('seoReportNow', { orgId, status: 401, reason: auth.reason });
      res.status(401).json({ error: 'bad signature' });
      return;
    }

    const cfg = (await db.collection('organisations').doc(orgId).get()).data()?.sourcing || {};
    if (!cfg.seo?.enabled) {
      res.status(409).json({ error: 'seo reports disabled for this org' });
      return;
    }

    const summary = await runSeoReportForOrg(db, orgId, cfg, 'on-demand');
    console.log('seoReportNow:done', orgId, JSON.stringify(summary));
    res.status(summary.status === 'error' ? 502 : 200).json(summary);
  },
);
