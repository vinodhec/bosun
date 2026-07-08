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

// Proven templates (see experiment above). Broad OR-groups keep recall high; the Gemini relevance
// gate downstream is what enforces precision, so we deliberately cast wide here.
const enQuery = (name) =>
  `site:facebook.com ${name} (house OR flat OR apartment OR villa OR plot OR land) (sale OR rent OR lease)`;
const taQuery = (name) =>
  `site:facebook.com ${name} (வீடு OR மனை OR நிலம் OR அபார்ட்மெண்ட்) (விற்பனை OR வாடகை OR குத்தகை)`;

/**
 * Build the search queries for a target: a broad English query on the full name + a Tamil-script
 * query when we have a Tamil name. Always returns at least the English query (falls back to the raw
 * locality if Gemini is unavailable), so a name/LLM hiccup never leaves us with nothing to search.
 */
export async function buildSourcingQueries({ locality, city }) {
  const names = await localityNames({ locality, city });
  const en = names?.englishName || locality;
  const ta = names?.tamilName || '';
  const queries = [enQuery(en)];
  if (ta) queries.push(taQuery(ta));
  return { queries, englishName: en, tamilName: ta };
}
