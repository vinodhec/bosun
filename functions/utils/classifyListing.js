import { generateJson, geminiConfigured, GEMINI_FLASH } from './gemini.js';

// Gemini relevance + extraction gate for a sourced Facebook post. Built on the shared utils/gemini.js
// client. Given a post's text and the TARGET locality, it decides whether the post is a genuine
// listing IN/AROUND that locality (killing the loose-search noise) and pulls out structured fields so
// the relayed lead lands pre-parsed.

// Cheap deterministic pre-filter — skip an LLM call on posts with no property signal at all.
const KEYWORDS = /\b(sale|resale|rent|lease|bhk|sq\.?\s?ft|sqft|cent|ground|acre|lakh|crore|villa|flat|apartment|plot|house|property|price|emi)\b/i;
const PHONE = /(?:\+?91|0)?\s*[6-9]\d{9}/;

/** True if the post looks like a property listing at all (worth spending a classify call on). */
export function hasPropertySignal(text) {
  const t = String(text || '');
  return KEYWORDS.test(t) || t.includes('₹') || PHONE.test(t);
}

const SCHEMA = {
  type: 'object',
  properties: {
    isListing: { type: 'boolean' },
    localityMatches: { type: 'boolean' },
    confidence: { type: 'number' },
    locality: { type: 'string' },
    bhk: { type: 'string' },
    propertyType: { type: 'string' },
    listingType: { type: 'string' },
    priceText: { type: 'string' },
    phone: { type: 'string' },
    reason: { type: 'string' },
  },
  required: ['isListing', 'localityMatches', 'confidence'],
  propertyOrdering: [
    'isListing', 'localityMatches', 'confidence', 'locality', 'bhk',
    'propertyType', 'listingType', 'priceText', 'phone', 'reason',
  ],
};

const SYSTEM =
  'You classify and extract fields from real-estate posts scraped from Facebook. Be strict about ' +
  'whether the property is located in or immediately around the target locality. Output JSON only.';

/**
 * Classify one post against a target locality. Returns
 *   { keep, isListing, localityMatches, confidence, extracted{...}, reason }.
 * Fails OPEN (keep:true, degraded:true) when Gemini is unconfigured or errors — a broken classifier
 * must never silently drop leads we already paid Apify to fetch; the human consent call is the backstop.
 */
export async function classifyListing({ text, locality, city, shape, minConfidence = 0.6 }) {
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
    `Facebook post:\n"""${body.slice(0, 1500)}"""\n\n` +
    `Decide: isListing (a genuine property listing?), localityMatches (is the property in or ` +
    `immediately around the TARGET locality?), confidence 0-1. Extract locality, bhk, propertyType, ` +
    `listingType (Sale/Rent/Lease), priceText and phone when present.`;

  // FLASH, not FLASH_LITE. This gate only ever sees the ~145-char Google SERP snippet (see the
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
    localityMatches,
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
