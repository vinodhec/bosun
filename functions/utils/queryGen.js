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
    jobTerms: { type: 'string' },
  },
  required: ['englishName'],
  propertyOrdering: ['englishName', 'regionalLanguage', 'regionalName', 'regionalCity', 'propTerms', 'intentTerms', 'jobTerms'],
};

/**
 * Compare place names ignoring case, punctuation and spacing. Unicode-aware ON PURPOSE: a
 * Latin-only [^a-z0-9] strip reduces every regional-script name to "", and an empty string makes
 * both containment tests below meaningless (it drops the city from regional queries, and reads
 * "இராமநாதபுரம், இராமநாதபுரம்" as two different places).
 */
const normPlace = (s) => String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/**
 * Collapse repeats inside a translated "A OR B OR C" group.
 *
 * Translation is many-to-one: English distinguishes words the local language does not. "house" and
 * "home" both come back as வீடு; the buyer group's "need", "required" and "requirement" all collapse
 * to தேவை. Left alone the query carries `(வீடு OR ... OR வீடு)` — the duplicate matches nothing extra
 * and just spends query length, and a group that is three copies of one word looks like a broken
 * translation to anyone reading the run panel. Case/space-insensitive, first spelling wins, order
 * preserved.
 */
export function dedupOrGroup(group) {
  const parts = String(group || '').split(/\s+OR\s+/i).map((t) => t.trim()).filter(Boolean);
  const seen = new Set();
  const out = [];
  for (const t of parts) {
    const k = t.toLowerCase().replace(/^["']|["']$/g, '');
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out.join(' OR ');
}

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
async function localityInfo({ locality, city, category, intentEn = INTENT_EN, buyerIntent = false }) {
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
      `5. intentTerms = translate "${intentEn}" into that language, same "A OR B OR C" format.` +
      (buyerIntent
        // Without this the model returns the QUESTION form ("வேண்டுமா" = "do you want?"), which is
        // how you ASK someone, not how a seeker writes their own requirement post — so the query
        // misses the very posts the buyer lane exists to find.
        ? ` These are the words someone writes when they are LOOKING FOR a property to buy or rent — ` +
          `the plain "wanted / needed / looking for" forms a person uses in their own requirement ` +
          `post, NOT the question form ("do you want…?") and NOT the words a seller uses. Give ` +
          `DISTINCT terms — if several English words translate to the same word, return it once and ` +
          `add another real phrasing people use instead.\n\n`
        : `\n\n`) +
      (buyerIntent
        ? `6. jobTerms = the words for JOB, VACANCY and HIRING in that language, as "A OR B OR C". We ` +
          `subtract these from the search: recruitment posts use the same "wanted / needed" words as ` +
          `property seekers and would otherwise swamp the results.\n\n`
        : '') +
      `If you are not confident of a regional value, return an empty string for it rather than guessing.`,
    schema: NAME_SCHEMA,
  });
  if (!j) return null;
  return {
    englishName: String(j.englishName || '').trim(),
    regionalLanguage: String(j.regionalLanguage || '').trim(),
    regionalName: String(j.regionalName || '').trim(),
    regionalCity: String(j.regionalCity || '').trim(),
    propTerms: dedupOrGroup(String(j.propTerms || '').trim()),
    intentTerms: dedupOrGroup(String(j.intentTerms || '').trim()),
    jobTerms: dedupOrGroup(String(j.jobTerms || '').trim()),
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
// Intent OR-groups (English) by RUN MODE. `supply` is the original lane — the words an owner uses
// when they HAVE a property. `buyer` is the demand lane: the words someone uses when they WANT one.
//
// Why the buyer lane needs its own words at all: for a year the buyer leads we relayed were a
// by-product of these supply queries, and the numbers say that can never be a lane. Over the 60 runs
// to 2026-09-01 the pipeline relayed 420 leads, of which 9 were buyers — and of the 99 buyer posts it
// found, 90 died on recency, 59 of them posted MORE THAN A YEAR ago. That is exactly what a supply
// query does to demand: it surfaces the old "looking for a 2BHK?" group threads Google still ranks on
// engagement, not the requirement somebody posted this week. Searching the demand words directly is
// the only way to reach fresh demand.
//
// The terms are the ones the 2026-07-17 yield experiment measured (scripts/experiment-buyer-sourcing.mjs).
const INTENT_GROUPS = {
  supply: 'sale OR rent OR lease',
  buyer: 'wanted OR "looking for" OR required OR need OR requirement',
};

// Buyer queries MUST exclude the recruitment universe, or they return almost nothing else.
//
// "wanted", "required", "need" and "vacancy" are the defining words of Indian Facebook job posts, and
// against the commercial property group the collision is total: `(office OR shop OR warehouse) AND
// (wanted OR required)` is literally how "staff wanted for shop" is written. Measured on the first
// live buyer run (2026-09-01, Avaniyapuram/Madurai + Nasiyanur Road/Erode): 98 prospects, 0 relayed —
// 83 killed by the property-signal filter as generic page noise, and essentially every survivor a
// hiring ad ("We Are Hiring", "Your Dream Job is Just One Call Away"). The July yield experiment
// never saw this because it only tested RESIDENTIAL localities, where "house OR flat" keeps job ads
// out on its own; the demand ranking hands the live lane commercial and PG targets too.
//
// Negatives are cheap and precise here — a genuine property-requirement post has no reason to say
// "salary" or "resume" — and they cost nothing on the supply side because supply never uses them.
const BUYER_EXCLUDE_EN = ['hiring', 'job', 'jobs', 'vacancy', 'vacancies', 'salary', 'recruitment', 'candidates', 'resume', 'interview'];

/** Render terms as Google negative operators: `-hiring -job …`. Multi-word terms get quoted. */
export function excludeClause(terms) {
  const seen = new Set();
  const out = [];
  for (const t of terms) {
    const v = String(t || '').trim().replace(/^-+/, '');
    const k = v.toLowerCase();
    if (!v || seen.has(k)) continue;
    seen.add(k);
    out.push(/\s/.test(v) ? `-"${v}"` : `-${v}`);
  }
  return out.join(' ');
}
const INTENT_EN = INTENT_GROUPS.supply; // back-compat for callers that never pass a mode

/** Normalize a caller's mode to a key of INTENT_GROUPS (anything unknown degrades to supply). */
export const intentModeOf = (mode) => (mode === 'buyer' ? 'buyer' : 'supply');

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

const enQuery = (name, cat, intentEn, exclude = '') => `site:facebook.com ${name} (${PROP_GROUPS[cat].en}) (${intentEn})${exclude ? ` ${exclude}` : ''}`;
const regionalQuery = (name, propTerms, intentTerms, exclude = '') => `site:facebook.com ${name} (${propTerms}) (${intentTerms})${exclude ? ` ${exclude}` : ''}`;

/**
 * Build the search queries for a target in the given MODE ('supply' = inventory someone HAS,
 * 'buyer' = demand someone WANTS): an English query on the full name + a regional-language query
 * (in the locality's own script) when Gemini could supply the translated name + terms, both keyed to
 * the demand CATEGORY (residential / commercial / land / pg) so we search for the kind of property
 * that's actually in demand. Always returns at least the English query (falls back to the raw locality
 * if Gemini is unavailable), so a name/LLM hiccup never leaves us with nothing to search.
 */
export async function buildSourcingQueries({ locality, city, shape, mode = 'supply' }) {
  const category = categoryForShape(shape);
  // The property nouns stay the same in both modes — a buyer names the same kinds of property an
  // owner does. Only the INTENT group flips (have vs want), which is the whole difference between
  // sourcing inventory and sourcing demand.
  const intentMode = intentModeOf(mode);
  const intentEn = INTENT_GROUPS[intentMode];
  const info = await localityInfo({ locality, city, category, intentEn, buyerIntent: intentMode === 'buyer' });

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
  // Buyer queries carry the recruitment exclusion; supply queries carry none (they never collide
  // with job ads, and every negative term is a chance to lose a real listing). The local-language
  // job words ride along when Gemini could supply them, since a Tamil hiring post says வேலை, not "job".
  const exclude = intentMode === 'buyer'
    ? excludeClause([...BUYER_EXCLUDE_EN, ...String(info?.jobTerms || '').split(/\s+OR\s+/i)])
    : '';

  const enPlace = placeWithCity(localityName, city);
  const queries = [enQuery(enPlace, category, intentEn, exclude)];

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
    queries.push(regionalQuery(regPlace, info.propTerms, info.intentTerms, exclude));
  }
  return {
    queries,
    englishName: localityName,
    regionalLanguage: info?.regionalLanguage || '',
    regionalName: info?.regionalName || '',
    category,
    mode: intentMode,
  };
}
