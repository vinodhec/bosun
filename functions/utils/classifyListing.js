import { generateJson, geminiConfigured, GEMINI_FLASH } from './gemini.js';

// Gemini relevance + extraction gate for a sourced Facebook post. Built on the shared utils/gemini.js
// client. Given a post's text and the TARGET locality, it decides whether the post is a genuine
// property post IN/AROUND that locality (killing the loose-search noise), which SIDE of the market it
// sits on (an owner OFFERING a property vs a buyer/tenant SEEKING one — the caller's buyer-lead
// harvest rides on this), and pulls out structured fields so the relayed lead lands pre-parsed.

// ── The snippet is not always the post (13 Aug 2026) ────────────────────────────────────────────
// The `side` verdict was landing sellers in the platform's buyer queue, and the cause is not the
// model's judgement — it is the input. Google splices adjacent Facebook posts and comments into one
// SERP snippet, so the text handed to this function routinely contains somebody ELSE's words:
//   SP-005794  title "15 லட்சத்தில் வீடு" (a seller's video)
//              snippet "… வீடு விவசாய நிலம் வேண்டும் …"        → classified 'seeking'
//   SP-005866  title "⚠️இவளோ கம்மி பட்ஜெட்ல 2BHK வீடா" (a seller's ad)
//              snippet "Looking for 2 cent plot in Tirunelveli · Srini … RAJ AVENUE …"
//                      ↑ the " · " is Google joining two separate results  → classified 'seeking'
// The prompt already told the model to prefer the title for LOCALITY; it now says the same for
// `side`, with the failure spelled out. The platform carries an independent title-anchored guard
// (web/src/lib/leadIntent.ts) because a prompt is a request, not a guarantee.

// Cheap deterministic pre-filter — skip an LLM call on posts with no property signal at all.
// `\d*\s*bhk`, not plain `bhk`: listings routinely write "2BHK" with no space, and \b never fires
// between a digit and a letter — plain \bbhk\b silently missed every unspaced variant.
const KEYWORDS = /\b(sale|resale|rent|lease|\d*\s*bhk|sq\.?\s?ft|sqft|cent|ground|acre|lakh|crore|villa|flat|apartment|plot|house|property|price|emi)\b/i;
const PHONE = /(?:\+?91|0)?\s*[6-9]\d{9}/;

/** True if the post looks like a property listing at all (worth spending a classify call on). */
export function hasPropertySignal(text) {
  const t = String(text || '');
  return KEYWORDS.test(t) || t.includes('₹') || PHONE.test(t);
}

// ── A 'seeking' verdict needs the text to actually ASK for something (2026-09-01) ───────────────
// The buyer lane's first live day relayed "South Facing 23' Road DTCP & RERA Approved Plot" and
// "Have 2–10 Acres of Land in Kelambakkam" as buyer leads — 2 of its 4 relays were sellers. The
// failure is structural: a demand query drags in posts stuffed with "wanted/required", and a seller
// ADVERTISING TO buyers ("Wanted: buyers for this plot", a broker listing stock) reads as 'seeking'
// to a model judging a truncated snippet. The prompt below now spells the case out, but a prompt is
// a request, not a guarantee (cf. the platform's leadIntent.ts guard) — so the verdict is also
// corroborated deterministically: a post tagged 'seeking' whose text contains NO buyer phrasing in
// any language we serve is demoted to 'offering'. Checked against every buyer lead ever relayed:
// all the genuine ones ("…Requirement", "Land Wanted", "Need a portion or flat", "Looking for
// resale land", "தேவை…") pass; both false positives fail. Demotion fails SAFE — a demoted post
// becomes supply, which relays it as a listing instead of billing it into the buyer queue.
const BUYER_PHRASES = new RegExp(
  [
    // English: wanted / needed / need / require(d) / requirement / looking for / searching for /
    // "in need of". Deliberately NOT bare "want" (too common in seller copy: "want a dream home?").
    String.raw`\bwanted\b`, String.raw`\bneed(?:ed)?\b`, String.raw`\brequire[ds]?\b`,
    String.raw`\brequirement`, String.raw`\blooking\s+for\b`, String.raw`\bsearching\s+for\b`,
    String.raw`\bin\s+need\s+of\b`, String.raw`\bany(?:one|body)\s+(?:selling|renting|have|has)\b`,
    // Tamil: தேவை (needed), வேண்டும் (want), தேடுகிறேன்/தேடுகிறோம் (I/we are searching)
    'தேவை', 'வேண்டும்', 'தேடுகி',
    // Hindi: चाहिए (needed), तलाश (search), ढूंढ (looking)
    'चाहिए', 'तलाश', 'ढूंढ',
    // Malayalam / Telugu / Kannada "needed"
    'ആവശ്യമുണ്ട്', 'కావాలి', 'ಬೇಕು',
  ].join('|'),
  'i',
);

/** Does the text contain the phrasing of someone ASKING for a property? Exported so the funnel
 *  validator can pin it against the real relayed-lead corpus. */
export function looksLikeBuyerText(text) {
  return BUYER_PHRASES.test(String(text || ''));
}

// The confidence floor a verdict must clear to count as CONFIDENT — shared with the caller so the
// off-target salvage lane applies the exact same bar as `keep` (a forked threshold would let a lead
// be "not confident enough to relay on-target" yet "confident enough to salvage", which is absurd).
export const MIN_CONFIDENCE = 0.6;

const SCHEMA = {
  type: 'object',
  properties: {
    isListing: { type: 'boolean' },
    side: { type: 'string', enum: ['offering', 'seeking'] },
    localityMatches: { type: 'boolean' },
    // Deliberately NOT in `required`: an older cached prompt or a partial JSON that omits it degrades
    // to "named" (the pre-lane behaviour), never to a spurious second classify pass.
    localityNamed: { type: 'boolean' },
    confidence: { type: 'number' },
    locality: { type: 'string' },
    bhk: { type: 'string' },
    propertyType: { type: 'string' },
    listingType: { type: 'string' },
    priceText: { type: 'string' },
    phone: { type: 'string' },
    reason: { type: 'string' },
  },
  required: ['isListing', 'side', 'localityMatches', 'confidence'],
  propertyOrdering: [
    'isListing', 'side', 'localityMatches', 'localityNamed', 'confidence', 'locality', 'bhk',
    'propertyType', 'listingType', 'priceText', 'phone', 'reason',
  ],
};

const SYSTEM =
  'You classify and extract fields from real-estate posts scraped from Facebook. Be strict about ' +
  'whether the property is located in or immediately around the target locality. Output JSON only.';

/**
 * Classify one post against a target locality. Returns
 *   { keep, isListing, side, localityMatches, confidence, extracted{...}, reason }.
 * `keep` is SIDE-AGNOSTIC (a confident on-target post, whichever side) — the caller branches on
 * `side` ('offering' = a listing to relay as supply, 'seeking' = a buyer/tenant "wanted" post).
 * Absent/garbled side degrades to 'offering', which reproduces the pre-side behaviour exactly.
 * Fails OPEN (keep:true, degraded:true) when Gemini is unconfigured or errors — a broken classifier
 * must never silently drop leads we already paid Apify to fetch; the human consent call is the backstop.
 */
export async function classifyListing({ text, locality, city, shape, minConfidence = MIN_CONFIDENCE }) {
  const body = String(text || '').trim();
  if (!body) return { keep: false, isListing: false, localityMatches: false, confidence: 0, reason: 'empty' };
  if (!geminiConfigured()) return { keep: true, degraded: true, confidence: 0, reason: 'gemini-unconfigured' };

  const target = [locality, city].filter(Boolean).join(', ');
  const prompt =
    `TARGET locality: ${target}\n` +
    (shape ? `Buyers there mostly want: ${shape}\n` : '') +
    `\nIndian place names vary — treat abbreviations and English or regional-language ` +
    `(Tamil, Malayalam, Telugu, Kannada, Hindi, Bengali, Marathi, …) spellings/transliterations as the ` +
    `SAME place (e.g. "Ramnad" = "Ramanathapuram" = "ராமநாதபுரம").\n\n` +
    `Facebook post, as a Google search result (first line = result title, rest = snippet; on ` +
    `Facebook group pages the snippet is often lifted from an ADJACENT post or comment — sometimes ` +
    `TWO of them joined by " · " — so the snippet may describe a completely different property, or ` +
    `a different person, than the title. The TITLE is the post. Whenever the title and the snippet ` +
    `disagree, judge from the TITLE: both the locality AND which side of the market the poster is ` +
    `on. In particular, do NOT call the post 'seeking' because the SNIPPET says "looking for" / ` +
    `"wanted" / "தேவை" / "வேண்டும்" while the TITLE advertises a property, and do not call it ` +
    `'offering' because the snippet advertises one while the title asks):\n` +
    `"""${body.slice(0, 1500)}"""\n\n` +
    `Decide: isListing (a genuine post about ONE specific property need — either someone offering a ` +
    `property or someone looking for one; NOT a shop ad, service promo, or news), side ('offering' ` +
    `when the poster HAS a property to sell/rent — owner, builder or agent; 'seeking' when the poster ` +
    `is LOOKING FOR a property to buy/rent). Seller ads routinely open with rhetorical hooks like ` +
    `"Looking for a spacious home?" before pitching a property for sale — those are 'offering'. So ` +
    `is anyone ADVERTISING TO buyers: "Wanted: buyers/clients for…", a broker listing the stock they ` +
    `HAVE ("Have 2 acres in…"), or a post describing a specific property's features, approvals or ` +
    `price — whoever describes a property they can hand over is 'offering', whatever demand words ` +
    `appear around it. ` +
    `localityMatches (is the property, or the place the seeker wants, in or immediately around the ` +
    `TARGET locality?), localityNamed (does the TEXT itself actually name a place for the property? ` +
    `FALSE when the title is cut off before any place name — e.g. it ends "near ..." — or when no ` +
    `locality appears anywhere in the text; a place name that is merely MISSING is not a mismatch), ` +
    `confidence 0-1. Extract locality, bhk, propertyType, listingType ` +
    `(Sale/Rent/Lease — for a 'seeking' post, what the poster WANTS), priceText and phone when present.`;

  // FLASH, not FLASH_LITE. This gate only ever sees the SERP title + ~145-char snippet (see the
  // caller in runSourcingJobs.js), which is truncated mid-sentence and strips the context that makes
  // a post obviously not a property. Measured on the real snippets of two relayed saree ads
  // (prod SP-001519/SP-001520, a Salem silk shop whose ADDRESS matched the target locality):
  //   flash-lite → relayed 4/5 and 5/5, reading "Flat 15% & 30% OFF" as propertyType "Flat" at
  //                confidence 1.0 ("the listing is for a flat in Ponnammapet, Salem")
  //   flash      → rejected 5/5 and 5/5 ("the post is about clothing discounts, not a property")
  // Both models agree once given the FULL post — the extra capability is only needed because the
  // input is this thin. A wrongly-kept lead costs a ₹2.50 relay + Apify enrichment + admin time to
  // reject, which dwarfs the ~10 paise/property the better model adds.
  // thinkingBudget 0: reasoning tokens are billed at the output rate and truncate the JSON — see gemini.js.
  const j = await generateJson({ model: GEMINI_FLASH, prompt, system: SYSTEM, schema: SCHEMA, thinkingBudget: 0 });
  if (!j) return { keep: true, degraded: true, confidence: 0, reason: 'gemini-error' };

  const confidence = Number(j.confidence) || 0;
  const isListing = !!j.isListing;
  const localityMatches = !!j.localityMatches;
  return {
    keep: isListing && localityMatches && confidence >= minConfidence,
    isListing,
    // 'seeking' only when the text corroborates it (see BUYER_PHRASES above) — the model's word
    // alone has already billed seller posts into the buyer queue.
    side: j.side === 'seeking' && looksLikeBuyerText(body) ? 'seeking' : 'offering',
    localityMatches,
    // Only an EXPLICIT false means "the text names no place" — absent/garbled degrades to true, so a
    // reject stays a reject (the caller's locality-unknown detour only fires on the explicit signal).
    localityNamed: j.localityNamed !== false,
    confidence,
    extracted: {
      locality: String(j.locality || ''),
      bhk: String(j.bhk || ''),
      propertyType: String(j.propertyType || ''),
      listingType: String(j.listingType || ''),
      priceText: String(j.priceText || ''),
      phone: String(j.phone || ''),
    },
    reason: String(j.reason || '').slice(0, 160),
  };
}
