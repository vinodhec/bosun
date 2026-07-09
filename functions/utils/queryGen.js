import { generateJson, GEMINI_FLASH_LITE, geminiConfigured } from './gemini.js';

// Turn a target locality into high-yield Facebook search queries.
//
// A live experiment (Ramanathapuram + Velachery, 6 query styles each) showed the best recall AND
// precision comes from the FULL place name — not the abbreviation the platform stores — with broad
// property/intent OR-groups, PLUS a parallel query in the locality's OWN regional language (an
// English-only query misses posts written only in the regional script). This must work ANYWHERE in
// India, so nothing here is Tamil-specific: Gemini identifies the locality's dominant language (Tamil,
// Malayalam, Telugu, Kannada, Hindi, Bengali, Marathi, …), gives the place name in that script, and
// translates the property + intent OR-groups into it. The query TEMPLATES stay fixed here so the proven
// structure never drifts; only the language content is Gemini-supplied.

const NAME_SCHEMA = {
  type: 'object',
  properties: {
    englishName: { type: 'string' },
    regionalLanguage: { type: 'string' },
    regionalName: { type: 'string' },
    propTerms: { type: 'string' },
    intentTerms: { type: 'string' },
  },
  required: ['englishName'],
  propertyOrdering: ['englishName', 'regionalLanguage', 'regionalName', 'propTerms', 'intentTerms'],
};

/**
 * Ask Gemini for a locality's full English name AND its regional-language search terms: the place name
 * in the dominant local script, plus the property + intent OR-groups translated into that language for
 * the given demand category. Returns null if Gemini is unavailable so the caller degrades to English.
 */
async function localityInfo({ locality, city, category }) {
  if (!geminiConfigured()) return null;
  const enProp = PROP_GROUPS[category].en;
  const j = await generateJson({
    model: GEMINI_FLASH_LITE,
    system: 'You normalise Indian place names and translate short property-search terms into the ' +
      'locality\'s own regional language. Output JSON only.',
    prompt:
      `Locality: "${locality}"${city ? `, city/district: "${city}"` : ''} (India).\n\n` +
      `1. englishName = the full canonical English name (expand abbreviations, e.g. "Ramnad" → ` +
      `"Ramanathapuram").\n` +
      `2. regionalLanguage = the dominant LOCAL language of this locality's state/region (e.g. Tamil ` +
      `in Tamil Nadu, Malayalam in Kerala, Telugu in Andhra Pradesh/Telangana, Kannada in Karnataka, ` +
      `Marathi in Maharashtra, Bengali in West Bengal, Hindi in the Hindi belt).\n` +
      `3. regionalName = the same place written in that language's script.\n` +
      `4. propTerms = translate this property OR-group into that language, KEEPING the "A OR B OR C" ` +
      `format (translate each term, leave "OR" in English): ${enProp}\n` +
      `5. intentTerms = translate "${INTENT_EN}" into that language, same "A OR B OR C" format.\n\n` +
      `If you are not confident of a regional value, return an empty string for it rather than guessing.`,
    schema: NAME_SCHEMA,
  });
  if (!j) return null;
  return {
    englishName: String(j.englishName || '').trim(),
    regionalLanguage: String(j.regionalLanguage || '').trim(),
    regionalName: String(j.regionalName || '').trim(),
    propTerms: String(j.propTerms || '').trim(),
    intentTerms: String(j.intentTerms || '').trim(),
  };
}

// Property-term OR-groups (English) by demand CATEGORY. We pick the group from the target's dominant
// property type so a commercial-demand locality (Office Space, Shop) is searched for commercial supply
// — not homes. Broad within a category keeps recall high; the Gemini relevance gate downstream enforces
// precision, so we deliberately cast wide. The regional-language equivalents are translated per-target
// by localityInfo (Gemini), so this stays region-agnostic.
const PROP_GROUPS = {
  residential: { en: 'house OR flat OR apartment OR villa OR home OR plot OR land' },
  commercial: { en: '"office space" OR office OR shop OR showroom OR "commercial space" OR commercial OR warehouse' },
  land: { en: 'plot OR land OR "vacant land" OR "farm land" OR acre OR cent' },
  pg: { en: '"paying guest" OR PG OR hostel OR "room for rent"' },
};
const INTENT_EN = 'sale OR rent OR lease';

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
const regionalQuery = (name, propTerms, intentTerms) => `site:facebook.com ${name} (${propTerms}) (${intentTerms})`;

/**
 * Build the search queries for a target: an English query on the full name + a regional-language query
 * (in the locality's own script) when Gemini could supply the translated name + terms, both keyed to
 * the demand CATEGORY (residential / commercial / land / pg) so we search for the kind of property
 * that's actually in demand. Always returns at least the English query (falls back to the raw locality
 * if Gemini is unavailable), so a name/LLM hiccup never leaves us with nothing to search.
 */
export async function buildSourcingQueries({ locality, city, shape }) {
  const category = categoryForShape(shape);
  const info = await localityInfo({ locality, city, category });
  const en = info?.englishName || locality;
  const queries = [enQuery(en, category)];
  // Only add the regional query when we have BOTH the script name AND the translated terms — a partial
  // translation would search the region's name against English property words (or vice versa), which
  // matches nothing useful.
  if (info?.regionalName && info?.propTerms && info?.intentTerms) {
    queries.push(regionalQuery(info.regionalName, info.propTerms, info.intentTerms));
  }
  return {
    queries,
    englishName: en,
    regionalLanguage: info?.regionalLanguage || '',
    regionalName: info?.regionalName || '',
    category,
  };
}
