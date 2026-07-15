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
    regionalCity: { type: 'string' },
    propTerms: { type: 'string' },
    intentTerms: { type: 'string' },
  },
  required: ['englishName'],
  propertyOrdering: ['englishName', 'regionalLanguage', 'regionalName', 'regionalCity', 'propTerms', 'intentTerms'],
};

/**
 * Compare place names ignoring case, punctuation and spacing. Unicode-aware ON PURPOSE: a
 * Latin-only [^a-z0-9] strip reduces every regional-script name to "", and an empty string makes
 * both containment tests below meaningless (it drops the city from regional queries, and reads
 * "இராமநாதபுரம், இராமநாதபுரம்" as two different places).
 */
const normPlace = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * Is Gemini's expansion plausibly the SAME place we asked about?
 *
 * WHY THIS EXISTS: englishName REPLACES the locality in the query, and one bad expansion silently
 * redirects a whole target's sourcing at another city — we then pay Apify to scrape it and bill the
 * customer for the junk. It happened: target `trichy__thillai-nagar` (Thillai Nagar, Trichy) emitted
 * `site:facebook.com Ponnammapet, Salem …` and relayed Salem shop ads. It is INTERMITTENT (the same
 * call returns the right answer 3/3 today at temperature 0), so a better prompt cannot be the fix —
 * a rare hallucination must be structurally unable to redirect the search.
 *
 * Accepts a genuine expansion, rejects a substitution:
 *   "Thillai Nagar" → "Thillai Nagar, Trichy"  ✓ containment
 *   "Ramnad"        → "Ramanathapuram"         ✓ shared first-token prefix ("ram")
 *   "Thillai Nagar" → "Ponnammapet, Salem"     ✗ nothing in common → fall back to the raw locality
 * Rejection is cheap (we search the locality as stored, which is what a no-LLM degrade already does);
 * a false accept costs a whole run. So this is deliberately strict.
 */
export function expansionLooksSane(input, output) {
  const a = normPlace(input);
  const b = normPlace(output);
  if (!a || !b) return false;
  if (b.includes(a) || a.includes(b)) return true;
  const ta = a.split(' ')[0];
  const tb = b.split(' ')[0];
  let i = 0;
  while (i < ta.length && i < tb.length && ta[i] === tb[i]) i++;
  return i >= 3; // "ramnad"/"ramanathapuram" share "ram"; "thillai"/"ponnammapet" share nothing
}

/**
 * Pin the query to the city we KNOW from the target doc, rather than whatever the model returned.
 * Skipped when the name already carries it (or the locality IS the city, e.g. Ramanathapuram town),
 * so we never emit "Ramanathapuram, Ramanathapuram".
 */
function placeWithCity(name, city) {
  const n = String(name || '').trim();
  const c = String(city || '').trim();
  if (!c || !n) return n || c;
  const nn = normPlace(n);
  const nc = normPlace(c);
  // Both sides must actually normalise to something before a containment test means anything:
  // normPlace() keeps only [a-z0-9], so a regional-script name reduces to "" — and `x.includes("")`
  // is ALWAYS true, which would silently drop the city from every regional query.
  if (nn && nc && (nn.includes(nc) || nc.includes(nn))) return n;
  return `${n}, ${c}`;
}

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
      (city
        ? `The city/district above is GROUND TRUTH: this locality is the one in "${city}", not a ` +
          `same-named place anywhere else. Indian locality names repeat across cities (there is a ` +
          `Thillai Nagar in Trichy AND one in Salem) — resolve ONLY the one in "${city}". If you cannot ` +
          `place this locality inside "${city}", return the locality name EXACTLY as given rather than ` +
          `substituting a different place.\n\n`
        : '') +
      `1. englishName = the full canonical English name of the LOCALITY ITSELF (expand abbreviations, ` +
      `e.g. "Ramnad" → "Ramanathapuram"). Do NOT append the city, district or state — we add those ` +
      `ourselves. If the name is already full, return it unchanged.\n` +
      `2. regionalLanguage = the dominant LOCAL language of this locality's state/region (e.g. Tamil ` +
      `in Tamil Nadu, Malayalam in Kerala, Telugu in Andhra Pradesh/Telangana, Kannada in Karnataka, ` +
      `Marathi in Maharashtra, Bengali in West Bengal, Hindi in the Hindi belt).\n` +
      `3. regionalName = the same LOCALITY written in that language's script (no city/district).\n` +
      (city ? `3b. regionalCity = "${city}" written in that language's script, so the regional query can be pinned to the city in-script too.\n` : '') +
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
    regionalCity: String(j.regionalCity || '').trim(),
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
  // The DEFAULT group (no demand shape — all town-level targets land here) must cover every supply
  // type an owner might post, incl. farm properties: rural TN posts say "farm land"/"acre", not
  // "plot". Recall-wide is safe — the Gemini relevance gate downstream enforces precision.
  residential: { en: 'house OR flat OR apartment OR villa OR home OR plot OR land OR farmhouse OR "farm land" OR acre' },
  commercial: { en: '"office space" OR office OR shop OR showroom OR "commercial space" OR commercial OR warehouse OR godown' },
  land: { en: 'plot OR land OR "vacant land" OR "farm land" OR "agricultural land" OR farmhouse OR acre OR cent' },
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
  // Farm House rides the land group too — its supply-side posts read like land posts (acreage,
  // agricultural terms), not like flats.
  if (/plot|land|acre|cent|farm|agri/.test(p)) return 'land';
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

  // Trust the expansion only if it is still the place we asked about; otherwise search the locality
  // exactly as the target stores it. Losing an abbreviation expansion costs some recall for one run;
  // accepting a substituted place sends the whole run (and the Apify spend) at the wrong city.
  const proposed = info?.englishName || '';
  const expansionOk = proposed && expansionLooksSane(locality, proposed);
  if (proposed && !expansionOk) {
    console.error('queryGen:bad-expansion', JSON.stringify({ locality, city, proposed, using: locality }));
  }
  const localityName = expansionOk ? proposed : locality;

  // The city comes from the TARGET, never from the model — a same-named locality in another city is
  // exactly the failure this guards (target trichy__thillai-nagar once searched Ponnammapet, Salem).
  const enPlace = placeWithCity(localityName, city);
  const queries = [enQuery(enPlace, category)];

  // Only add the regional query when we have BOTH the script name AND the translated terms — a partial
  // translation would search the region's name against English property words (or vice versa), which
  // matches nothing useful.
  const regionalOk = info?.regionalName && expansionLooksSane(locality, info.regionalName)
    // A regional name is in another script, so it shares no characters with the English input and can
    // never pass the sanity check — accept it on the English name's verdict instead, since both come
    // from the same call about the same place.
    || info?.regionalName && expansionOk;
  if (regionalOk && info.propTerms && info.intentTerms) {
    // Pin the regional query to the city in-script when we have it; fall back to the English city
    // (Indian regional posts routinely write the city in English) rather than dropping it entirely.
    const regPlace = placeWithCity(info.regionalName, info.regionalCity || city);
    queries.push(regionalQuery(regPlace, info.propTerms, info.intentTerms));
  }
  return {
    queries,
    englishName: localityName,
    regionalLanguage: info?.regionalLanguage || '',
    regionalName: info?.regionalName || '',
    category,
  };
}
