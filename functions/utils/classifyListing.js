import { generateJson, geminiConfigured, GEMINI_FLASH } from './gemini.js';
import { generateJson as generateJsonClaude, claudeConfigured, CLAUDE_HAIKU } from './claude.js';

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
    // Builder/promoter PROJECT signal (many units for sale: a plot layout, an apartment project, a
    // villa community). Not in `required` — an older cached prompt that omits it degrades to false.
    isProject: { type: 'boolean' },
    projectName: { type: 'string' },
    promoterName: { type: 'string' },
    // Where the property is and what the post is written in — read by `orgFitDropReason` against the
    // org's own allow-lists. Not in `required`: absent degrades to '' = unknown = kept.
    state: { type: 'string' },
    language: { type: 'string', enum: ['english', 'tamil', 'hindi', 'telugu', 'malayalam', 'kannada', 'marathi', 'bengali', 'other'] },
    reason: { type: 'string' },
  },
  required: ['isListing', 'side', 'localityMatches', 'confidence'],
  propertyOrdering: [
    'isListing', 'side', 'localityMatches', 'localityNamed', 'confidence', 'locality', 'bhk',
    'propertyType', 'listingType', 'priceText', 'phone', 'isProject', 'projectName', 'promoterName', 'state',
    'language', 'reason',
  ],
};

// Haiku 5.5 reads "in or immediately around" much more narrowly than gemini-2.5-flash. On 120
// recorded leads (2026-10-18) it dropped Old Pallavaram for Pallavaram, Shenoy Nagar for Anna Nagar
// and Karanodai for Red Hills, and called a post that names only the CITY a locality mismatch. This
// note is sent to Claude only, so the Gemini verdicts do not move.
const CLAUDE_LOCALITY_NOTE =
  `\n\nHow to judge the locality. "Immediately around" is a buyer's radius, not a boundary: a ` +
  `neighbouring area, a suburb or village on the same side of town, an "Old"/"New"/"East"/"West" ` +
  `part of the target, a road or nagar inside it, or anywhere a buyer looking in the target would ` +
  `still drive over to see (roughly 5-8 km in a city, a little more outside one) is a MATCH. Only a ` +
  `different town, a different part of a big city, or another state is a mismatch. When the text ` +
  `names only the CITY (or district) and no locality, set localityNamed false and localityMatches ` +
  `false: the full post is fetched and judged again, so this is a deferral, not a reject. A ` +
  `directory or agency page that lists several properties in the target is still a genuine ` +
  `listing for isListing. confidence is how sure you are that this is a genuine property post on ` +
  `the side you chose; a missing place name does not lower it.`;

// Claude fills a tool call's fields in schema order, so with `reason` last it commits to
// localityMatches before it has placed the property ("Pallavaram is a neighbouring suburb of
// Ponneri? No: ..." came back with localityMatches true). Asking for the reasoning FIRST fixes the order.
const { reason: _reason, ...REST_PROPS } = SCHEMA.properties;
const CLAUDE_SCHEMA = {
  ...SCHEMA,
  properties: {
    reason: { type: 'string', description: 'Write this FIRST, in one or two sentences: what the post offers or seeks, where the property is, and how far that is from the target locality.' },
    ...REST_PROPS,
  },
  required: ['reason', ...SCHEMA.required],
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
 *
 * `provider` is the org's `sourcing.classifyProvider`: 'claude' asks Haiku 5.5 first (cheaper than
 * flash, paid from the Max plan's API credits; 2026-10-18) and falls back to Gemini on any Claude
 * failure or when the function has no ANTHROPIC_API_KEY; anything else is Gemini, as before. It is
 * a Firestore flip, so going back needs no deploy. `model` on the verdict says which one answered.
 */
export async function classifyListing({ text, locality, city, shape, minConfidence = MIN_CONFIDENCE, provider = 'gemini' }) {
  const body = String(text || '').trim();
  if (!body) return { keep: false, isListing: false, localityMatches: false, confidence: 0, reason: 'empty' };
  const useClaude = provider === 'claude' && claudeConfigured();
  if (!useClaude && !geminiConfigured()) return { keep: true, degraded: true, confidence: 0, reason: 'gemini-unconfigured' };

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
    `property or someone looking for one; NOT a shop ad, service promo, vehicle sale, job post, news, ` +
    `a market-trend or price-rise article, or a personal / political post), side ('offering' ` +
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
    `(Sale/Rent/Lease — for a 'seeking' post, what the poster WANTS), priceText and phone when present. ` +
    `isProject: TRUE only when an 'offering' poster is a BUILDER or PROMOTER advertising a whole ` +
    `PROJECT or LAYOUT with many units for sale — a DTCP/CMDA/RERA-approved plot layout, an apartment ` +
    `or villa project, a gated community, "new launch", "booking open", "promoters", "sites available" ` +
    `— NOT a single owner property, a resale flat, or a broker's one listing. When true, extract ` +
    `projectName (the layout/project's name, e.g. "Sri Karpaga Vinayagar Nagar") and promoterName ` +
    `(the builder/promoter company) if stated. ` +
    `state: the Indian STATE or union territory the property (or the place the seeker wants) is in, ` +
    `as its full English name ("Tamil Nadu", "Kerala", "Uttar Pradesh", "Puducherry") — work it out ` +
    `from the city/locality when the post names no state (Lucknow → "Uttar Pradesh", Borivali → ` +
    `"Maharashtra"); empty string when the text doesn't let you tell. language: the language the ` +
    `post is MAINLY written in, judged from the TITLE when title and snippet disagree. Tamil written ` +
    `in English letters ("veedu virpanaikku") is 'tamil'; Hindi written in English letters ("plot ` +
    `ke samne", "makan for sale") is 'hindi'; an English post that only quotes local place names is ` +
    `'english'.`;

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
  let j = null;
  let model = GEMINI_FLASH;
  if (useClaude) {
    j = await generateJsonClaude({ model: CLAUDE_HAIKU, prompt: prompt + CLAUDE_LOCALITY_NOTE, system: SYSTEM, schema: CLAUDE_SCHEMA, maxOutputTokens: 700 });
    if (j) model = CLAUDE_HAIKU;
  }
  if (!j && geminiConfigured()) j = await generateJson({ model: GEMINI_FLASH, prompt, system: SYSTEM, schema: SCHEMA, thinkingBudget: 0 });
  if (!j) return { keep: true, degraded: true, confidence: 0, reason: useClaude ? 'classify-error' : 'gemini-error' };

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
      isProject: j.isProject === true,
      projectName: String(j.projectName || '').slice(0, 120),
      promoterName: String(j.promoterName || '').slice(0, 120),
    },
    state: String(j.state || '').trim().slice(0, 60),
    language: String(j.language || '').trim().toLowerCase(),
    reason: String(j.reason || '').slice(0, 160),
    model,
  };
}

// ── Region + language fit (2026-10-16) ──────────────────────────────────────────────────────────
// A post can be a genuine listing and still be worthless to the org that pays for it. MaadiVeedu's
// callers reject, by hand, listings in Lucknow / Borivali / Hyderabad / Shimla (the off-target lane
// salvages ANY confident listing, wherever it is) and posts in Hindi / Telugu / Malayalam that their
// Tamil-and-English callers cannot work: ~140 a month in staff's "other" notes, every one of them
// billed. So each org may declare what it can use:
//   sourcing.allowedStates    — e.g. ['Tamil Nadu', 'Puducherry']
//   sourcing.allowedLanguages — e.g. ['tamil', 'english']
// Absent / empty = no filter (every other org is unchanged). Only a POSITIVE mismatch drops: an
// unknown state or language keeps the lead — this gate removes the clearly-wrong, never the unsure.
const normState = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '')
  .replace(/^pondicherry$/, 'puducherry').replace(/^tn$/, 'tamilnadu');

/**
 * Returns a drop reason ('out-of-region: Kerala' / 'wrong-language: hindi') when a confident verdict
 * names a state or language outside the org's allow-lists, else ''. Degraded verdicts are never
 * judged here (they carry no state/language).
 */
export function orgFitDropReason(verdict, cfg = {}) {
  if (!verdict || verdict.degraded) return '';
  const states = Array.isArray(cfg.allowedStates) ? cfg.allowedStates.map(normState).filter(Boolean) : [];
  const langs = Array.isArray(cfg.allowedLanguages) ? cfg.allowedLanguages.map((l) => String(l).toLowerCase().trim()).filter(Boolean) : [];
  const st = normState(verdict.state);
  if (states.length && st && !states.includes(st)) return `out-of-region: ${verdict.state}`;
  const lang = String(verdict.language || '');
  if (langs.length && lang && lang !== 'other' && !langs.includes(lang)) return `wrong-language: ${lang}`;
  return '';
}
