import { generateJson, geminiConfigured, GEMINI_FLASH } from './gemini.js';

// Gemini relevance + extraction gate for a sourced Facebook post. Built on the shared utils/gemini.js
// client. Given a post's text and the TARGET locality, it decides whether the post is a genuine
// property post IN/AROUND that locality (killing the loose-search noise), which SIDE of the market it
// sits on (an owner OFFERING a property vs a buyer/tenant SEEKING one — the caller's buyer-lead
// harvest rides on this), and pulls out structured fields so the relayed lead lands pre-parsed.

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
    `Facebook group pages the snippet is sometimes lifted from an ADJACENT post, so when the title ` +
    `and snippet name different localities, judge locality from the title):\n` +
    `"""${body.slice(0, 1500)}"""\n\n` +
    `Decide: isListing (a genuine post about ONE specific property need — either someone offering a ` +
    `property or someone looking for one; NOT a shop ad, service promo, or news), side ('offering' ` +
    `when the poster HAS a property to sell/rent — owner, builder or agent; 'seeking' when the poster ` +
    `is LOOKING FOR a property to buy/rent). Seller ads routinely open with rhetorical hooks like ` +
    `"Looking for a spacious home?" before pitching a property for sale — those are 'offering'. ` +
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
    side: j.side === 'seeking' ? 'seeking' : 'offering',
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
