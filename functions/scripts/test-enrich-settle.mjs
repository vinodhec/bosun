// node functions/scripts/test-enrich-settle.mjs — settleEnrichment + blankSharedSnippets (maadiveedu #1655).
// Fixture is run HohNoyDumWNdimtZ4FLv (2026-09-26 15:00 UTC): Google served the same 5 BHK snippet on two
// different plot posts; the land-plot scrape returned a post date but no text, and the SERP text relayed
// unmarked as SP-020236's description.
import assert from 'node:assert/strict';
import { settleEnrichment, blankSharedSnippets, parseEnrichedItem } from '../utils/sourcing.js';

const BLED = '*For Sale - 5 bhk house* Iyyappanthangal Chennai. Land area 1200 sqft. Built up area 2200 sqft 30 ft road South facing & east facing. ( ...Read more';
const PLOT = 'https://www.facebook.com/karthik.451154/posts/iyappanthangal-dhanalakshmi-nagar-residential-land-plot-area-1776-sq-ftsize-4837/1071973265730303/';
const RESALE = 'https://www.facebook.com/saravanan567/posts/check-the-caption-below%EF%B8%8Fplot-for-re-sale-iyyapanthangalchennai-prime-location-fa/28485616547746588/';

let n = 0;
const t = (name, fn) => { fn(); n += 1; console.log('ok -', name); };

t('a scrape with a date but no text marks the SERP body snippetOnly', () => {
  const enriched = parseEnrichedItem({ time: 1789785891 }); // date only, as the land-plot post came back
  assert.equal(enriched.text, '');
  const listing = { url: PLOT, title: 'Can be Subdivided into 2 plots 24/37 - 888 sq. ...', snippet: BLED };
  const r = settleEnrichment(listing, enriched);
  assert.equal(r.enrichedText, false);
  assert.equal(listing.snippetOnly, true);
  assert.equal(listing.snippet, BLED);
  assert.equal(listing.postedAt, 1789785891000);
});

t('a miss marks snippetOnly', () => {
  const listing = { url: PLOT, snippet: BLED };
  settleEnrichment(listing, null);
  assert.equal(listing.snippetOnly, true);
});

t('scraped text replaces the snippet and is not snippetOnly', () => {
  const listing = { url: PLOT, snippet: BLED };
  const r = settleEnrichment(listing, { text: 'Residential land, plot area 1776 sq ft, can be subdivided', phone: '9843984033', author: 'k' });
  assert.equal(r.enrichedText, true);
  assert.equal(r.author, 'k');
  assert.equal(listing.snippetOnly, undefined);
  assert.match(listing.snippet, /1776/);
  assert.equal(listing.phone, '9843984033');
});

t('a SERP body served on two posts is blanked on both', () => {
  const a = { url: PLOT, snippet: BLED, snippetOnly: true };
  const b = { url: RESALE, snippet: BLED, snippetOnly: true };
  const c = { url: 'https://www.facebook.com/x/posts/1/', snippet: 'Independent house for sale in Porur, 2400 sq ft, east facing, call owner', snippetOnly: true };
  assert.equal(blankSharedSnippets([a, b, c]), 2);
  assert.equal(a.snippet, ''); assert.equal(a.snippetShared, true);
  assert.equal(b.snippet, '');
  assert.match(c.snippet, /Porur/);
});

t('scraped text is never blanked; a SERP copy of it on another post is', () => {
  const real = { url: PLOT, snippet: BLED }; // scraped: this post's own text
  const copy = { url: RESALE, snippet: BLED, snippetOnly: true };
  assert.equal(blankSharedSnippets([real, copy]), 1);
  assert.equal(real.snippet, BLED);
  assert.equal(copy.snippet, '');
});

t('the same post twice (www vs bare host, tracking params) is not "shared"', () => {
  const a = { url: PLOT, snippet: BLED, snippetOnly: true };
  const b = { url: PLOT.replace('www.', '') + '?__cft__=abc', snippet: BLED, snippetOnly: true };
  assert.equal(blankSharedSnippets([a, b]), 0);
});

console.log(`${n} passed`);
