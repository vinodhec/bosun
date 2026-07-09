import { generateJson, GEMINI_FLASH_LITE, geminiConfigured } from './gemini.js';

// Turn a target locality into high-yield Facebook search queries.
//
// A live experiment (Ramanathapuram + Velachery, 6 query styles each) showed the best recall AND
// precision comes from the FULL place name — not the abbreviation the platform stores — with broad
// property/intent OR-groups, PLUS a parallel Tamil-script query (English-only queries miss Tamil-only
// posts entirely). So: Gemini supplies the name variants (it knows "Ramnad" → "Ramanathapuram" →
// "ராமநாதபுரம்"); the query TEMPLATES are fixed here so the proven structure never drifts.

const NAME_SCHEMA = {
  type: 'object',
  properties: {
    englishName: { type: 'string' },
    tamilName: { type: 'string' },
  },
  required: ['englishName'],
  propertyOrdering: ['englishName', 'tamilName'],
};

/** Ask Gemini for the full English name + Tamil-script name of a locality. Null if unavailable. */
async function localityNames({ locality, city }) {
  if (!geminiConfigured()) return null;
  const j = await generateJson({
    model: GEMINI_FLASH_LITE,
    system: 'You normalise Indian (Tamil Nadu) place names. Output JSON only.',
    prompt:
      `Locality: "${locality}"${city ? `, city/district: "${city}"` : ''} (Tamil Nadu, India).\n` +
      `Return englishName = the full canonical English name (expand abbreviations, e.g. "Ramnad" → ` +
      `"Ramanathapuram"), and tamilName = the same place written in Tamil script. If you are not ` +
      `confident of the Tamil name, return an empty string for tamilName rather than guessing.`,
    schema: NAME_SCHEMA,
  });
  if (!j) return null;
  return { englishName: String(j.englishName || '').trim(), tamilName: String(j.tamilName || '').trim() };
}

// Property-term OR-groups (English + Tamil) by demand CATEGORY. We pick the group from the target's
// dominant property type so a commercial-demand locality (Office Space, Shop) is searched for
// commercial supply — not homes. Broad within a category keeps recall high; the Gemini relevance
// gate downstream enforces precision, so we deliberately cast wide.
const PROP_GROUPS = {
  residential: {
    en: 'house OR flat OR apartment OR villa OR home OR plot OR land',
    ta: 'வீடு OR மனை OR நிலம் OR அபார்ட்மெண்ட் OR குடியிருப்பு',
  },
  commercial: {
    en: '"office space" OR office OR shop OR showroom OR "commercial space" OR commercial OR warehouse',
    ta: 'அலுவலகம் OR கடை OR வணிக OR கமர்ஷியல் OR கிடங்கு',
  },
  land: {
    en: 'plot OR land OR "vacant land" OR "farm land" OR acre OR cent',
    ta: 'மனை OR நிலம் OR பண்ணை OR சென்ட்',
  },
  pg: {
    en: '"paying guest" OR PG OR hostel OR "room for rent"',
    ta: 'விடுதி OR தங்குமிடம் OR அறை',
  },
};
const INTENT_EN = 'sale OR rent OR lease';
const INTENT_TA = 'விற்பனை OR வாடகை OR குத்தகை';

/**
 * Map a target's dominant property type → a query category. A dominant shape can be a comma-joined
 * mix; we scan the whole string and let the most specific signal win (commercial before land, so
 * "Commercial Land" reads as commercial). Falls back to residential when the shape is absent/unknown.
 */
export function categoryForShape(shape) {
  const p = String(shape?.propertyType || '').toLowerCase();
  if (/office|shop|showroom|warehouse|commercial|industrial|mall|godown|\bhall\b|hotel|resort|guest house/.test(p)) return 'commercial';
  if (/paying guest|\bpg\b|hostel/.test(p)) return 'pg';
  if (/plot|land|acre|cent/.test(p)) return 'land';
  return 'residential';
}

const enQuery = (name, cat) => `site:facebook.com ${name} (${PROP_GROUPS[cat].en}) (${INTENT_EN})`;
const taQuery = (name, cat) => `site:facebook.com ${name} (${PROP_GROUPS[cat].ta}) (${INTENT_TA})`;

/**
 * Build the search queries for a target: an English query on the full name + a Tamil-script query
 * when we have a Tamil name, both keyed to the demand CATEGORY (residential / commercial / land / pg)
 * so we search for the kind of property that's actually in demand. Always returns at least the English
 * query (falls back to the raw locality if Gemini is unavailable), so a name/LLM hiccup never leaves
 * us with nothing to search.
 */
export async function buildSourcingQueries({ locality, city, shape }) {
  const names = await localityNames({ locality, city });
  const en = names?.englishName || locality;
  const ta = names?.tamilName || '';
  const category = categoryForShape(shape);
  const queries = [enQuery(en, category)];
  if (ta) queries.push(taQuery(ta, category));
  return { queries, englishName: en, tamilName: ta, category };
}
