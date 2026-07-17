/**
 * BUYER-SOURCING YIELD EXPERIMENT — do enough people post "wanted / looking for" property demand
 * on Facebook to make a buyer-leads lane worth building?
 *
 * Mirrors the live supply pipeline's proven query template (site:facebook.com <place> (<prop terms>)
 * (<intent terms>), English + regional script, 3-month window) but flips the intent group to buyer
 * phrasing, and runs a SUPPLY CONTROL query per locality so the report gives a buyer:supply volume
 * ratio — the number the build decision actually hinges on. Fetch → individual-post filter → dedup →
 * buyer/seller signal tally, then batch-enriches a small sample of buyer-signal posts for real
 * postedAt + full text. NOTHING is relayed, billed, or marked seen.
 *
 * Run:  cd functions && APIFY_TOKEN=... node scripts/experiment-buyer-sourcing.mjs
 * Flags: --no-enrich          skip the FB-post enrichment sample (SERP-only, cheapest)
 *        --enrich-cap=N       max posts to enrich across the whole run (default 12)
 *        --months=N           recency window (default 3, matching production)
 *        --out=path.json      where to dump the full result JSON
 */
import {
  callSerpActor, tbsForMonths, isIndividualPost, listingKey, enrichPosts, extractPhone,
} from '../utils/sourcing.js';

const apifyToken = process.env.APIFY_TOKEN;
if (!apifyToken) {
  console.error('APIFY_TOKEN env var required');
  process.exit(1);
}

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : dflt;
};
const ENRICH = !process.argv.includes('--no-enrich');
const ENRICH_CAP = Math.max(0, Number(arg('enrich-cap', 12)) || 12);
const MONTHS = Math.max(1, Number(arg('months', 3)) || 3);
const OUT = arg('out', '');
const ACTOR = 'apify~google-search-scraper'; // same SERP actor the production lane uses
const MAX_PAGES = 3;

// Buyer-intent OR-group (English) — the phrasing demand posts actually use, per the same
// recall-wide philosophy as the production PROP_GROUPS (precision comes later, from eyeballing).
const BUY_EN = '"wanted" OR "looking for" OR required OR need OR requirement';
// Production residential supply template (queryGen.js) — the control arm.
const SUP_PROP_EN = 'house OR flat OR apartment OR villa OR home OR plot OR land';
const SUP_INTENT_EN = 'sale OR rent OR lease';
const BUY_PROP_EN = 'house OR flat OR apartment OR plot OR land OR "2bhk" OR "3bhk"';

// Two known-good Tamil Nadu localities (the same pair the supply query-style experiment used),
// with hand-written Tamil buyer terms — the production lane would get these from Gemini, but for
// a one-off experiment fixed strings keep the variable count down. தேவை = needed/wanted,
// வேண்டும் = want; வீடு house, மனை plot, நிலம் land.
const LOCALITIES = [
  {
    name: 'Velachery, Chennai',
    ta: 'வேளச்சேரி, சென்னை',
    taProp: 'வீடு OR மனை OR நிலம் OR பிளாட்',
    taBuy: 'தேவை OR வேண்டும் OR தேவைப்படுகிறது',
  },
  {
    name: 'Ramanathapuram',
    ta: 'இராமநாதபுரம்',
    taProp: 'வீடு OR மனை OR நிலம் OR பிளாட்',
    taBuy: 'தேவை OR வேண்டும் OR தேவைப்படுகிறது',
  },
];

const q = (place, prop, intent) => `site:facebook.com ${place} (${prop}) (${intent})`;

// Which side does a SERP result's visible text signal? (Coarse — full text comes from enrichment.)
const BUYER_RX = /\b(wanted|looking\s+for|required?|need(?:ed)?|requirement)\b|தேவை|வேண்டும்/i;
const SELLER_RX = /\bfor\s+(sale|rent|lease)\b|\b(selling|available)\b|விற்பனை|வாடகைக்கு/i;
const signalOf = (text) => {
  const b = BUYER_RX.test(text);
  const s = SELLER_RX.test(text);
  return b && s ? 'mixed' : b ? 'buyer' : s ? 'seller' : 'unclear';
};

const freshness = tbsForMonths(MONTHS);
const runs = [];
for (const loc of LOCALITIES) {
  runs.push(
    { locality: loc.name, arm: 'buyer-en', query: q(loc.name, BUY_PROP_EN, BUY_EN) },
    { locality: loc.name, arm: 'buyer-ta', query: q(loc.ta, loc.taProp, loc.taBuy) },
    { locality: loc.name, arm: 'supply-control-en', query: q(loc.name, SUP_PROP_EN, SUP_INTENT_EN) },
  );
}

console.log(`Buyer-sourcing yield experiment — ${runs.length} queries, ${MONTHS}-month window, enrich=${ENRICH ? ENRICH_CAP : 'off'}\n`);

const results = [];
for (const r of runs) {
  process.stdout.write(`  [${r.arm}] ${r.query}\n`);
  const t0 = Date.now();
  const items = await callSerpActor({ apifyToken, actorId: ACTOR, query: r.query, freshness, maxPages: MAX_PAGES });
  // Same first gates as production: individual posts only, dedup within the experiment.
  const seen = new Set();
  const posts = [];
  let landingPages = 0;
  for (const it of items) {
    if (!isIndividualPost(it.url)) { landingPages += 1; continue; }
    const key = listingKey(it.url);
    if (seen.has(key)) continue;
    seen.add(key);
    posts.push({ ...it, key, signal: signalOf(`${it.title} ${it.snippet}`) });
  }
  const bySignal = { buyer: 0, seller: 0, mixed: 0, unclear: 0 };
  for (const p of posts) bySignal[p.signal] += 1;
  results.push({ ...r, raw: items.length, landingPages, posts, bySignal, secs: Math.round((Date.now() - t0) / 1000) });
  console.log(`      raw ${items.length} → posts ${posts.length} (buyer ${bySignal.buyer} / seller ${bySignal.seller} / mixed ${bySignal.mixed} / unclear ${bySignal.unclear})  ${results.at(-1).secs}s`);
}

// Cross-arm dedup: a post surfacing in both the buyer arm and the supply control tells us the buyer
// arm isn't finding anything new — count overlaps per locality.
for (const loc of LOCALITIES) {
  const armKeys = (arm) => new Set(results.filter((x) => x.locality === loc.name && x.arm === arm).flatMap((x) => x.posts.map((p) => p.key)));
  const buyer = new Set([...armKeys('buyer-en'), ...armKeys('buyer-ta')]);
  const supply = armKeys('supply-control-en');
  const overlap = [...buyer].filter((k) => supply.has(k)).length;
  console.log(`\n  ${loc.name}: unique buyer-arm posts ${buyer.size}, supply-control posts ${supply.size}, overlap ${overlap}`);
}

// Enrich a sample of buyer-signal posts for the real post date + full text (age distribution was a
// stated goal of the experiment; the SERP snippet can't answer it).
let enriched = [];
if (ENRICH && ENRICH_CAP > 0) {
  const candidates = results
    .filter((x) => x.arm.startsWith('buyer'))
    .flatMap((x) => x.posts.filter((p) => p.signal === 'buyer' || p.signal === 'mixed').map((p) => ({ ...p, locality: x.locality, arm: x.arm })));
  const dedup = [...new Map(candidates.map((c) => [c.key, c])).values()].slice(0, ENRICH_CAP);
  if (dedup.length) {
    console.log(`\n  Enriching ${dedup.length} buyer-signal posts for real dates + full text…`);
    const byUrl = await enrichPosts({ apifyToken, urls: dedup.map((c) => c.url) });
    enriched = dedup.map((c) => {
      const e = byUrl.get(c.url) || null;
      return {
        locality: c.locality, arm: c.arm, url: c.url, title: c.title,
        postedAt: e?.postedAt ? new Date(e.postedAt).toISOString().slice(0, 10) : null,
        ageDays: e?.postedAt ? Math.round((Date.now() - e.postedAt) / 86400000) : null,
        phone: e ? (e.phone || extractPhone(e.text)) : null,
        fullTextSignal: e?.text ? signalOf(e.text) : null,
        text: e?.text?.slice(0, 400) || null,
      };
    });
    for (const e of enriched) {
      console.log(`    · [${e.fullTextSignal || 'no-scrape'}] ${e.postedAt || 'date?'} (${e.ageDays ?? '?'}d) ${e.phone || 'no-phone'} — ${(e.text || e.title).replace(/\s+/g, ' ').slice(0, 110)}`);
    }
  } else {
    console.log('\n  No buyer-signal posts to enrich.');
  }
}

// ── Summary ────────────────────────────────────────────────────────────────
console.log('\n═══ SUMMARY ═══');
for (const loc of LOCALITIES) {
  const arms = results.filter((x) => x.locality === loc.name);
  const buyerPosts = arms.filter((a) => a.arm.startsWith('buyer')).reduce((n, a) => n + a.bySignal.buyer + a.bySignal.mixed, 0);
  const supplyPosts = arms.find((a) => a.arm === 'supply-control-en')?.posts.length ?? 0;
  console.log(`  ${loc.name}: buyer-signal posts ${buyerPosts} vs supply-control posts ${supplyPosts}` +
    (supplyPosts ? ` — buyer volume ≈ ${(100 * buyerPosts / supplyPosts).toFixed(0)}% of supply` : ''));
}
const confirmed = enriched.filter((e) => e.fullTextSignal === 'buyer').length;
if (enriched.length) {
  console.log(`  Enriched sample: ${enriched.length} scraped, ${confirmed} confirmed buyer posts on full text, ` +
    `${enriched.filter((e) => e.phone).length} with a phone number`);
}

if (OUT) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(OUT, JSON.stringify({ ranAt: new Date().toISOString(), months: MONTHS, results, enriched }, null, 2));
  console.log(`\nFull dump: ${OUT}`);
}
