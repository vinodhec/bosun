/**
 * GROUP-DEMAND YIELD EXPERIMENT — how much FRESH buyer demand actually lives inside Facebook
 * property groups, read DIRECTLY instead of through Google?
 *
 * Why this exists: the buyer lane (mode:'buyer', 2026-09-01) proved that Google's index of
 * facebook.com holds almost no fresh demand — it finds real "wanted / looking for" posts, but they
 * are 300–700 days old, because Google ranks group threads on engagement, not recency. The only
 * plausible route to fresh demand is the groups themselves. This measures that route before anyone
 * builds it or promises a daily number on it.
 *
 * Method: discover group URLs with the same SERP actor the lane already uses (group LANDING pages —
 * exactly what the production pipeline discards), then feed each group URL to the SAME
 * facebook-posts-scraper the enrichment step already pays for, which returns the group's recent
 * posts. Tally posts/day, buyer share (looksLikeBuyerText — the production corroboration guard),
 * and phone share. NOTHING is relayed, billed, or marked seen.
 *
 * Run:  cd functions && APIFY_TOKEN=... node scripts/experiment-group-demand.mjs
 * Flags: --groups=N        max groups to scrape (default 4)
 *        --posts=N         posts to pull per group (default 40)
 *        --city=NAME       discovery city (default Chennai)
 *        --url=URL         skip discovery, scrape this group URL (repeatable)
 */
import { callSerpActor, parseEnrichedItem, canonicalizeUrl } from '../utils/sourcing.js';
import { looksLikeBuyerText } from '../utils/classifyListing.js';

const apifyToken = process.env.APIFY_TOKEN;
if (!apifyToken) {
  console.error('APIFY_TOKEN env var required');
  process.exit(1);
}

const APIFY_BASE = 'https://api.apify.com/v2';
const SERP_ACTOR = 'apify~google-search-scraper';
// The GROUPS actor, not the posts actor. Verified 2026-09-01: facebook-posts-scraper returns
// `no_items` ("Empty or private data") for every group FEED — it only reads pages and individual
// public posts — while facebook-groups-scraper returned same-hour posts from the same groups.
const POSTS_ACTOR = 'apify~facebook-groups-scraper';

const args = process.argv.slice(2);
const arg = (name, dflt) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : dflt;
};
const MAX_GROUPS = Math.max(1, Number(arg('groups', 4)) || 4);
const POSTS_PER_GROUP = Math.max(5, Number(arg('posts', 40)) || 40);
const CITY = arg('city', 'Chennai');
const FIXED_URLS = args.filter((a) => a.startsWith('--url=')).map((a) => a.slice(6));

const DAY = 24 * 60 * 60 * 1000;

/** A facebook GROUP LANDING page (the thing production discards as not-an-individual-post). */
function isGroupLanding(url) {
  try {
    const u = new URL(url);
    if (!/facebook\.com$/i.test(u.hostname.replace(/^www\./i, ''))) return false;
    const seg = u.pathname.split('/').filter(Boolean);
    return seg[0] === 'groups' && seg.length <= 2; // /groups/<id-or-slug>, not /groups/x/posts/y
  } catch {
    return false;
  }
}

// Seller-side phrasing, to split the non-buyer remainder into "supply" vs "chatter".
const SELLER_RX = /\bfor\s+(sale|rent|lease)\b|\b(selling|sale|resale|available)\b|விற்பனை|வாடகைக்கு|கிடைக்கும்/i;
const PHONE_RX = /(?:\+?91|0)?\s*[6-9]\d{9}(?!\d)/;

// ── 1) Discover candidate groups (unless URLs were given) ────────────────────────────────────────
let groupUrls = FIXED_URLS.filter(isGroupLanding);
if (!groupUrls.length) {
  const queries = [
    `site:facebook.com/groups ${CITY} property buy sell rent`,
    `site:facebook.com/groups ${CITY} real estate`,
    `site:facebook.com/groups சென்னை வீடு மனை`,
  ];
  const seen = new Set();
  for (const query of queries) {
    const items = await callSerpActor({ apifyToken, actorId: SERP_ACTOR, query, maxPages: 1 });
    for (const it of items) {
      if (!isGroupLanding(it.url)) continue;
      const key = canonicalizeUrl(it.url);
      if (seen.has(key)) continue;
      seen.add(key);
      groupUrls.push(it.url);
      console.log('discovered:', it.url, '—', (it.title || '').slice(0, 70));
    }
    if (groupUrls.length >= MAX_GROUPS * 2) break; // headroom for groups that scrape empty
  }
}
groupUrls = groupUrls.slice(0, MAX_GROUPS * 2);
if (!groupUrls.length) {
  console.error('no group URLs discovered — try --url=');
  process.exit(1);
}

// ── 2) Scrape each group's recent posts with the enrichment actor ────────────────────────────────
async function scrapeGroup(url) {
  const endpoint = `${APIFY_BASE}/acts/${encodeURIComponent(POSTS_ACTOR)}/run-sync-get-dataset-items?token=${encodeURIComponent(apifyToken)}`;
  try {
    const resp = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ startUrls: [{ url }], resultsLimit: POSTS_PER_GROUP }),
    });
    if (!resp.ok) {
      console.error('scrapeGroup:http', resp.status, url);
      return [];
    }
    const items = await resp.json();
    return Array.isArray(items) ? items : [];
  } catch (e) {
    console.error('scrapeGroup:err', url, e?.message || e);
    return [];
  }
}

const now = Date.now();
const perGroup = [];
let scraped = 0;
for (const url of groupUrls) {
  if (scraped >= MAX_GROUPS) break;
  console.log(`\nscraping ${url} …`);
  const items = await scrapeGroup(url);
  if (!items.length) {
    console.log('  (returned nothing — private group or scrape miss)');
    continue;
  }
  scraped += 1;
  const posts = items
    .map((it) => ({ raw: it, parsed: parseEnrichedItem(it) }))
    .filter((p) => p.parsed && (p.parsed.text || p.parsed.postedAt));
  const dated = posts.filter((p) => p.parsed.postedAt);
  const ages = dated.map((p) => (now - p.parsed.postedAt) / DAY).sort((a, b) => a - b);
  // Posts/day from the observed span: N dated posts over (oldest age) days.
  const spanDays = ages.length ? Math.max(ages[ages.length - 1], 1) : 0;
  const buyers = posts.filter((p) => looksLikeBuyerText(p.parsed.text) && !SELLER_RX.test(p.parsed.text));
  const freshBuyers = buyers.filter((p) => p.parsed.postedAt && now - p.parsed.postedAt < 30 * DAY);
  const g = {
    url,
    posts: posts.length,
    dated: dated.length,
    medianAgeDays: ages.length ? Math.round(ages[Math.floor(ages.length / 2)]) : null,
    postsPerDay: spanDays ? +(dated.length / spanDays).toFixed(1) : null,
    buyerPosts: buyers.length,
    freshBuyerPosts: freshBuyers.length,
    buyersWithPhone: buyers.filter((p) => PHONE_RX.test(p.parsed.text)).length,
  };
  perGroup.push(g);
  console.log(' ', JSON.stringify(g));
  console.log('  sample buyer posts:');
  for (const p of buyers.slice(0, 5)) {
    const age = p.parsed.postedAt ? `${Math.round((now - p.parsed.postedAt) / DAY)}d` : 'no-date';
    console.log(`   • [${age}] ${(p.parsed.text || '').replace(/\s+/g, ' ').slice(0, 110)}`);
  }
}

// ── 3) The number the build decision hinges on ───────────────────────────────────────────────────
const tot = (k) => perGroup.reduce((n, g) => n + (g[k] || 0), 0);
console.log('\n=== SUMMARY ===');
console.log(JSON.stringify({
  groupsScraped: perGroup.length,
  postsExamined: tot('posts'),
  buyerPosts: tot('buyerPosts'),
  freshBuyerPostsUnder30d: tot('freshBuyerPosts'),
  buyersWithPhone: tot('buyersWithPhone'),
}, null, 1));
console.log('\nRead it as: freshBuyerPostsUnder30d ÷ (median age window) ≈ the demand these groups');
console.log('generate per month — scale by how many such groups exist per city before promising a rate.');
process.exit(0);
