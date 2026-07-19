// One-off local runner for the weekly SEO report (testing phase, platform ingest unavailable).
// Reuses the agent's own modules — gsc.js, seoMetrics.js, serpSweep.js — and writes the raw
// report JSON to stdout-file for artifact rendering. No Firestore writes, no billing, no delivery.
import fs from 'node:fs';
import { querySearchAnalytics, listSitemaps, inspectUrl } from './utils/gsc.js';
import {
  reportWeekRange,
  joinWithPrev,
  pickWinnersLosers,
  pickStrikingDistance,
  buildActionCandidates,
} from './utils/seoMetrics.js';
import { serpSweep } from './utils/serpSweep.js';

const OUT = process.argv[2];
const siteUrl = 'sc-domain:maadiveedu.com';
const locations = JSON.parse(fs.readFileSync(process.argv[3], 'utf8')); // { cities, localities }

const norm = (q) => String(q || '').trim().toLowerCase().replace(/(\S+)\s*\/\s*\S+/g, '$1').replace(/\s+/g, ' ');
const round2 = (n) => Math.round(n * 100) / 100;
const shapeRow = (r) => ({
  keys: r.keys, clicks: r.clicks, impressions: r.impressions,
  ctr: round2(r.ctr * 100), position: round2(r.position),
  deltaClicks: r.deltaClicks ?? 0, deltaImpressions: r.deltaImpressions ?? 0, deltaPosition: round2(r.deltaPosition ?? 0),
});

const range = reportWeekRange(Date.now());
console.log('report week', range.startDate, '→', range.endDate);
const cur = { startDate: range.startDate, endDate: range.endDate };
const prev = { startDate: range.prevStartDate, endDate: range.prevEndDate };

const [totalsCur, totalsPrev, byQuery, byQueryPrev, byPage, byPagePrev, byQueryPage] = await Promise.all([
  querySearchAnalytics(siteUrl, { ...cur, dimensions: [], rowLimit: 1 }),
  querySearchAnalytics(siteUrl, { ...prev, dimensions: [], rowLimit: 1 }),
  querySearchAnalytics(siteUrl, { ...cur, dimensions: ['query'] }),
  querySearchAnalytics(siteUrl, { ...prev, dimensions: ['query'] }),
  querySearchAnalytics(siteUrl, { ...cur, dimensions: ['page'] }),
  querySearchAnalytics(siteUrl, { ...prev, dimensions: ['page'] }),
  querySearchAnalytics(siteUrl, { ...cur, dimensions: ['query', 'page'] }),
]);
console.log('gsc pulled:', byQuery.length, 'queries,', byPage.length, 'pages');

let sitemaps = [];
try { sitemaps = await listSitemaps(siteUrl); } catch (e) { console.error('sitemaps:', e.message); }

const keyOf = (r) => r.keys.join('␟');
const queries = joinWithPrev(byQuery, byQueryPrev, keyOf).sort((a, b) => b.clicks - a.clicks);
const pages = joinWithPrev(byPage, byPagePrev, keyOf).sort((a, b) => b.clicks - a.clicks);
const { winners, losers } = pickWinnersLosers(pages);
const strikingDistance = pickStrikingDistance(byQueryPage);
const t = totalsCur[0] || { clicks: 0, impressions: 0, ctr: 0, position: 0 };
const p = totalsPrev[0] || { clicks: 0, impressions: 0, ctr: 0, position: 0 };
const totals = {
  clicks: t.clicks, impressions: t.impressions, ctr: round2(t.ctr * 100), position: round2(t.position),
  prevClicks: p.clicks, prevImpressions: p.impressions, prevCtr: round2(p.ctr * 100), prevPosition: round2(p.position),
};

// Inspection: 5 top + 5 random sitemap URLs
const topPageUrls = byPage.sort((a, b) => b.impressions - a.impressions).slice(0, 5).map((r) => r.keys[0]).filter(Boolean);
const files = sitemaps.map((s) => s.path).filter((x) => /\.xml(\?|$)/i.test(x));
const urls = [];
for (const f of [...files].sort(() => Math.random() - 0.5).slice(0, 2)) {
  try {
    const xml = await (await fetch(f, { signal: AbortSignal.timeout(30000) })).text();
    for (const m of xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/g)) if (!/\.xml(\?|$)/i.test(m[1])) urls.push(m[1]);
  } catch (e) { console.error('sitemapFetch:', e.message); }
}
const randomUrls = [...new Set(urls)].sort(() => Math.random() - 0.5).slice(0, 5).filter((u) => !topPageUrls.includes(u));
const inspectedSample = [];
for (const { url, source } of [...topPageUrls.map((url) => ({ url, source: 'top' })), ...randomUrls.map((url) => ({ url, source: 'random' }))]) {
  try { inspectedSample.push({ ...(await inspectUrl(siteUrl, url)), source }); }
  catch (e) { console.error('inspect:', url, e.message); break; }
}
console.log('inspected:', inspectedSample.length);

// Candidates + tracker queries
const candidates = buildActionCandidates(range.periodKey, { strikingDistance, losers, indexing: { sitemaps, inspectedSample } });
const seeds = JSON.parse(fs.readFileSync(process.argv[4], 'utf8')); // trackedQueries seed list
const deep = [];
const pushDeep = (q) => { const s = norm(q); if (s && !deep.includes(s) && deep.length < 100) deep.push(s); };
for (const q of seeds) pushDeep(q);
for (const c of locations.cities) pushDeep(`plot for sale in ${c}`);
const d = new Date(Date.UTC(+range.periodKey.slice(0, 4), +range.periodKey.slice(4, 6) - 1, +range.periodKey.slice(6, 8)));
const weekIndex = Math.floor(d.getTime() / (7 * 24 * 60 * 60 * 1000)) % 4;
const shallow = [];
locations.localities.forEach((l, i) => {
  if (i % 4 !== weekIndex || shallow.length >= 130) return;
  const s = norm(`plot for sale in ${l.name} ${l.city}`);
  if (s && !deep.includes(s) && !shallow.includes(s)) shallow.push(s);
});
const actionQueries = candidates.map((c) => c.target.query).filter(Boolean);
console.log('sweep: deep', deep.length + actionQueries.length, 'shallow', shallow.length, '| locality week index', weekIndex);

const apifyToken = process.env.APIFY_TOKEN;
const actorId = 'apify~google-search-scraper';
const deepQueries = [...new Set([...actionQueries.map(norm), ...deep])];
const mid = Math.ceil(deepQueries.length / 2);
const [a, b, c] = await Promise.all([
  serpSweep({ apifyToken, actorId, queries: deepQueries.slice(0, mid), maxPages: 5 }),
  serpSweep({ apifyToken, actorId, queries: deepQueries.slice(mid), maxPages: 5 }),
  serpSweep({ apifyToken, actorId, queries: shallow, maxPages: 1 }),
]);
const serp = new Map([...c, ...a, ...b]);
console.log('serp snapshots:', serp.size);

const serpOf = (q) => serp.get(norm(q));
const marketSerp = [
  ...deep.map((q) => ({ q, tier: 'city' })),
  ...shallow.map((q) => ({ q, tier: 'locality' })),
].map(({ q, tier }) => {
  const s = serpOf(q);
  return {
    query: q, tier, depth: s?.searchedDepth ?? (tier === 'city' ? 50 : 10),
    ourRank: s?.ourRank ?? null, ourPage: s?.ourPage ?? null, ourUrl: s?.ourUrl ?? null,
    checked: Boolean(s),
    page1: (s?.results || []).slice(0, 5).map((x) => ({ rank: x.rank, domain: x.domain, title: x.title })),
  };
});
const serpChecks = actionQueries.map((q) => serpOf(q)).filter(Boolean).map((s) => ({
  query: s.query, ourRank: s.ourRank, ourPage: s.ourPage, ourUrl: s.ourUrl,
  page1: s.results.slice(0, 5).map((x) => ({ rank: x.rank, domain: x.domain, title: x.title })),
}));

fs.writeFileSync(OUT, JSON.stringify({
  range, totals,
  topQueries: queries.slice(0, 20).map(shapeRow),
  topPages: pages.slice(0, 20).map(shapeRow),
  winners: winners.map(shapeRow), losers: losers.map(shapeRow),
  strikingDistance: strikingDistance.slice(0, 15).map(shapeRow),
  indexing: { sitemaps, inspectedSample },
  candidates, marketSerp, serpChecks,
}, null, 1));
console.log('WROTE', OUT);
