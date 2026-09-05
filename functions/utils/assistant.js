/**
 * Website assistant — the BRAIN behind the chat widget on a customer's public property portal.
 *
 * A visitor types "2 BHK for rent in Velachery under 20k" (or the same in Tamil / Tanglish) and the
 * assistant searches the platform's LIVE listings, shows them as cards, captures an enquiry, files a
 * buyer requirement when nothing matches, drafts a listing for a seller, and — for a signed-in
 * owner — reads back their own listings, the leads on them and their plan. Every one of those is a
 * TOOL the platform executes against its own data; Bosun decides WHICH tool, with WHAT arguments,
 * and writes the words.
 *
 * Split of responsibilities (and why):
 *   - Bosun (here): the persona, the tool contract, the Gemini tool loop, conversation memory,
 *     guardrails, the reply shape (text + cards + suggestion chips), and the per-reply meter.
 *     The LLM spend is Bosun's, on Bosun's Vertex/Gemini billing (utils/gemini.js) — exactly like
 *     every other metered lane.
 *   - The platform: executes the tools in the SAME request that holds the real signed-in user,
 *     so no user identity is ever trusted off the wire. Bosun never touches the platform's data.
 *
 * The loop is therefore split across HTTP hops: one `message` call returns either a final REPLY or a
 * list of TOOL CALLS; the platform runs them and posts `tool_results`, and the cycle repeats until a
 * reply comes out (MAX_TOOL_HOPS bounds it). Between hops the exact Gemini `Content` history — model
 * turns included, thought signatures and all — is persisted on the conversation doc, because Gemini
 * requires the functionCall part to precede its functionResponse verbatim.
 *
 * Cards are NOT free-form: the model refers to a listing by the id it saw in a tool result via a
 * `[[show:ID,ID]]` marker and Bosun builds the card from the CACHED tool result. The model cannot
 * invent a price, a photo or a link — every card field is a field the platform returned this turn.
 */
import { geminiClient, GEMINI_FLASH } from './gemini.js';

/** Bounds one user message. Two hops covers search→enquire; four is generous. */
export const MAX_TOOL_HOPS = 4;
/** Gemini `Content` entries kept on the doc — the most recent turns, model + tool traffic included.
 *  24 (was 40): bounds the per-hop input, and with it the worst-case COGS of a long chat, at ~2× a
 *  fresh one. Six user turns of context is plenty for a property conversation. */
export const MAX_HISTORY_CONTENTS = 24;
/** Cap on a single tool result as stored/sent to the model — a search returns ~10 compact rows. */
export const MAX_TOOL_RESULT_CHARS = 7000;
/** Listings remembered per conversation for card rendering (by id, most recent wins). */
export const MAX_REMEMBERED_LISTINGS = 60;

// ── Tool contract ────────────────────────────────────────────────────────────────────────────────
// The platform declares which of these it implements (`capabilities`); only those are exposed to the
// model. Every argument is plain data the platform validates again on its side — the model is a
// suggestion engine, the platform is the authority.

const LISTING_TYPES = ['sale', 'rent'];
const PROPERTY_TYPES = ['apartment', 'house', 'villa', 'plot', 'commercial', 'pg', 'other'];

export const TOOL_DEFS = {
  search_properties: {
    audience: 'all',
    description:
      'Search the live property listings. Call this whenever the visitor describes what they want ' +
      '(place, sale or rent, BHK, budget, type). Returns up to `limit` matching listings with an id, ' +
      'title, price, BHK, locality, city and a link. Prefer a locality over a city when the visitor ' +
      'names one. Budget is in whole rupees (20k → 20000, 45 lakhs → 4500000, 1.2 crore → 12000000).',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            'ONLY a landmark or a detail no other field carries ("near Phoenix Mall", "east facing"). ' +
            'Never the place, the type, or filler like "any property" / "direct owner" — those go in the fields or nowhere.',
        },
        city: { type: 'string', description: 'The city or district town, in English letters — any town in India (Erode, Salem, Karur, Kottayam…), only when the visitor named one. Never substitute a nearby or bigger city. Tamil or Hindi spelling → English: தர்மபுரி → Dharmapuri, கோவை → Coimbatore, ஓசூர் → Hosur.' },
        locality: {
          type: 'string',
          description:
            'The place the visitor named — area, suburb, small town or village — in English letters (Velachery, Anna Nagar, Thiruporur, Thindal; வேளச்சேரி → Velachery). ' +
            'When unsure whether a name is a city or an area, put it HERE, not in city.',
        },
        listingType: { type: 'string', enum: LISTING_TYPES, description: 'sale (buy) or rent (lease / PG).' },
        propertyType: { type: 'string', enum: PROPERTY_TYPES },
        bhk: { type: 'integer', description: 'Number of bedrooms, if the visitor said one.' },
        minPrice: { type: 'integer', description: 'Lower budget bound in rupees.' },
        maxPrice: { type: 'integer', description: 'Upper budget bound in rupees.' },
        limit: { type: 'integer', description: 'How many to return, 1–10. Default 6.' },
      },
    },
  },
  get_property: {
    audience: 'all',
    description:
      'Fetch the full details of one listing by its id (from a search result, or the page the visitor ' +
      'is on). Use before answering a detailed question about a specific listing. You may call it ' +
      'several times in the same turn when the visitor asks about more than one — it is extra depth ' +
      'on a listing, NOT a limit on how many listings you may talk about.',
    parameters: {
      type: 'object',
      properties: { propertyId: { type: 'string' } },
      required: ['propertyId'],
    },
  },
  create_enquiry: {
    audience: 'all',
    description:
      'Send the visitor’s enquiry about ONE listing to its owner / the team. Needs a phone number: ' +
      'use the signed-in user’s if there is one, else ask for it first. Only call after the visitor ' +
      'has clearly said they want to enquire / contact / visit / know more about THAT listing.',
    parameters: {
      type: 'object',
      properties: {
        propertyId: { type: 'string' },
        name: { type: 'string' },
        phone: { type: 'string', description: '10-digit Indian mobile number.' },
        message: { type: 'string', description: 'What they want, in one or two lines.' },
      },
      required: ['propertyId', 'phone'],
    },
  },
  request_property: {
    audience: 'all',
    description:
      'File a BUYER / TENANT REQUIREMENT so the team finds matches and calls back — the right move ' +
      'when a search returns nothing (or nothing suitable), or the visitor asks to be notified. Needs a ' +
      'phone number (ask if the visitor is not signed in).',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        phone: { type: 'string', description: '10-digit Indian mobile number.' },
        listingType: { type: 'string', enum: LISTING_TYPES },
        propertyType: { type: 'string', enum: PROPERTY_TYPES },
        bhk: { type: 'integer' },
        city: { type: 'string', description: 'The city, if they named one. In English letters (Dharmapuri, not தர்மபுரி).' },
        locality: {
          type: 'string',
          description:
            'The place they want, in English letters (Velachery, not வேளச்சேரி) — ALWAYS carry the place named anywhere earlier in this conversation ' +
            '(a search they asked for counts). A requirement without a place cannot be matched.',
        },
        maxPrice: { type: 'integer', description: 'Budget ceiling in rupees. Ask once if they have not said.' },
        notes: { type: 'string', description: 'Anything else they said matters (purpose, floor, parking, move-in date…).' },
      },
      required: ['phone', 'listingType', 'locality'],
    },
  },
  draft_listing: {
    audience: 'all',
    description:
      'Start listing the visitor’s OWN property for sale or rent. Collect the essentials in chat ' +
      'first (sale/rent, type, BHK, locality + city, expected price, a phone number), then call this ' +
      'once. Returns a link where they add photos and confirm — never promise it is live yet.',
    parameters: {
      type: 'object',
      properties: {
        listingType: { type: 'string', enum: LISTING_TYPES },
        propertyType: { type: 'string', enum: PROPERTY_TYPES },
        bhk: { type: 'integer' },
        city: { type: 'string', description: 'In English letters (Dharmapuri, not தர்மபுரி).' },
        locality: { type: 'string', description: 'In English letters (Velachery, not வேளச்சேரி).' },
        price: { type: 'integer', description: 'Expected price (sale) or monthly rent, in rupees.' },
        areaSqft: { type: 'integer' },
        description: { type: 'string', description: 'Everything else they told you, as a short listing blurb.' },
        name: { type: 'string' },
        phone: { type: 'string', description: '10-digit Indian mobile number.' },
      },
      required: ['listingType', 'propertyType', 'city', 'phone'],
    },
  },
  list_my_properties: {
    audience: 'user',
    description:
      'The signed-in user’s OWN listings with status (live / pending / draft / expired), views and ' +
      'enquiry counts. Use for "my properties", "is my flat live", "how many people saw my listing".',
    parameters: { type: 'object', properties: {} },
  },
  list_my_leads: {
    audience: 'user',
    description:
      'Enquiries the signed-in user has RECEIVED on their listings (who, when, which property, ' +
      'message). Use for "my leads", "who enquired", "any calls for my house". Optionally for one listing.',
    parameters: {
      type: 'object',
      properties: { propertyId: { type: 'string' }, limit: { type: 'integer' } },
    },
  },
  get_my_plan: {
    audience: 'user',
    description:
      'The signed-in user’s current plan / subscription: what it includes, when it renews or expires, ' +
      'and the upgrade options with prices. Use for any question about plans, pricing, limits, ' +
      'boosting or featuring a listing.',
    parameters: { type: 'object', properties: {} },
  },
  make_reel: {
    audience: 'all',
    description:
      'Make a short vertical VIDEO (a reel) of ONE listing for WhatsApp status / Instagram: its photos ' +
      'with captions and a voice-over, ending on an Ask MaadiVeedu card. Call when the visitor asks for a ' +
      'video / reel / ad / promo of a listing — one you showed, their own, or the page they are on. ' +
      'style "photo" (default, any visitor, about a minute) or "animated" (opens on a lifelike animated ' +
      'shot of the cover photo; SIGNED-IN members only, two to three minutes) — animated only when they ' +
      'ask for animation / motion / the animated one. Returns a jobId at once; the video is made in the ' +
      'background and appears in the chat by itself.',
    parameters: {
      type: 'object',
      properties: {
        propertyId: { type: 'string' },
        style: { type: 'string', enum: ['photo', 'animated'], description: 'Default photo.' },
      },
      required: ['propertyId'],
    },
  },
  list_plans: {
    audience: 'all',
    description: 'The plans / packages the site sells (name, price, what each includes). For visitors asking what it costs to list or to get more visibility.',
    parameters: { type: 'object', properties: {} },
  },
  admin_lead_stats: {
    audience: 'admin',
    description:
      'SUPERADMIN ONLY. Enquiry counts across the WHOLE marketplace for a window — not the caller\u2019s own ' +
      'listings. Use for "how many enquiries today", "which sellers got leads this week", "how many ' +
      'sourced sellers got an enquiry today", "how many leads from <seller name>". window: today | ' +
      'yesterday | 7d | 30d. seller: narrow to one seller by name or phone. sourcedOnly: only ' +
      'listings the team sourced. Returns totals plus a per-seller breakdown.',
    parameters: {
      type: 'object',
      properties: {
        window: { type: 'string', description: 'today | yesterday | 7d | 30d' },
        seller: { type: 'string', description: 'seller name or phone to narrow to' },
        sourcedOnly: { type: 'boolean' },
      },
    },
  },
  admin_find_user: {
    audience: 'admin',
    description:
      'SUPERADMIN ONLY. Look up a person by name, phone or email \u2014 returns their id, role, phone and when ' +
      'they joined. Use it to resolve who the staff member means before answering about that person.',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
  admin_wishlist_contacts: {
    audience: 'admin',
    description:
      'SUPERADMIN ONLY. For a given BUYER (name or phone), the properties they wishlisted and the SELLER ' +
      'behind each one with the seller\u2019s phone number. Use for "who should I call about this buyer", ' +
      '"get me the numbers of sellers this buyer shortlisted".',
    parameters: { type: 'object', properties: { buyer: { type: 'string' } }, required: ['buyer'] },
  },
};

/** The tools the model may see on this turn: declared by the platform ∩ allowed for this audience. */
export function toolsFor({ capabilities, signedIn }) {
  // `capabilities` is the platform's list for THIS caller. It only contains the admin_* names when
  // the platform verified an admin id token, so an admin tool is invisible to everyone else — and
  // when capabilities is absent we fall back to the non-admin set, never the full map.
  const declared = new Set(Array.isArray(capabilities) && capabilities.length
    ? capabilities
    : Object.entries(TOOL_DEFS).filter(([, d]) => d.audience !== 'admin').map(([n]) => n));
  return Object.entries(TOOL_DEFS)
    .filter(([name, def]) => declared.has(name) && (def.audience === 'all' || signedIn))
    .map(([name, def]) => ({ name, description: def.description, parameters: def.parameters }));
}

// ── Persona ──────────────────────────────────────────────────────────────────────────────────────

function fmtInr(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '';
  const trim = (x) => String(x).replace(/\.0+$|(\.\d*?)0+$/, '$1');
  if (v >= 1e7) return `₹${trim((v / 1e7).toFixed(2))} Cr`;
  if (v >= 1e5) return `₹${trim((v / 1e5).toFixed(1))} L`;
  return `₹${Math.round(v).toLocaleString('en-IN')}`;
}

/** Tamil script. Its presence in a message is unambiguous — nothing else uses this block. */
const TAMIL_SCRIPT_RE = /[\u0B80-\u0BFF]/;
const LATIN_LETTER_RE = /[A-Za-z]/;
/**
 * Tamil words as people actually type them in English letters ("car parking iruka", "vadagai evlo").
 * Deliberately high-precision: every entry is a word a Tamil speaker uses in a property chat and
 * that English prose does not, so an English sentence never trips it. Missing a rarer Tanglish word
 * costs an English reply to a Tanglish visitor; a false hit would answer an English visitor in
 * half-Tamil, which is worse — hence the short list.
 */
const TANGLISH_RE = /\b(iruka|irukka|irukku|irukkuma|illa|illai|illaya|illaia|venum|vendum|vena|enna|yenna|epdi|eppadi|seri|sari|sollu|sollunga|solunga|kaattu|kaatunga|katunga|veedu|veetu|veedugal|vaadagai|vadagai|vaadaga|kudi|kudiyiruppu|panra|pannunga|pannuveenga|romba|konjam|nalla|evlo|evvalavu|enaku|enakku|naan|neenga|ungaluku|ungalukku|thevai|adhu|idhu|inda|indha|ipo|ippo|apparam|mudiyuma|mudiyum|kedaikuma|kedaikkuma|kedaikkum|paakanum|paarkanum|vanakkam|nandri)\b/i;

/**
 * The most recent thing the VISITOR actually wrote, skipping tool results (which also ride on the
 * `user` role) and skipping messages with no letters at all — a bare phone number or "9876543210"
 * is not a language signal, and letting it read as "English" would flip a Tamil chat mid-enquiry.
 */
export function lastVisitorText(contents) {
  for (let i = (contents || []).length - 1; i >= 0; i--) {
    const c = contents[i];
    if (!c || c.role !== 'user') continue;
    const text = (c.parts || []).map((p) => (typeof p?.text === 'string' ? p.text : '')).join(' ').trim();
    if (!text) continue;
    if (TAMIL_SCRIPT_RE.test(text) || LATIN_LETTER_RE.test(text)) return text;
  }
  return '';
}

/** 'ta' | 'tanglish' | 'en' — the language of one message, or '' when it carries no signal. */
export function visitorLanguage(text) {
  const t = String(text || '');
  if (TAMIL_SCRIPT_RE.test(t)) return 'ta';
  if (!LATIN_LETTER_RE.test(t)) return '';
  return TANGLISH_RE.test(t) ? 'tanglish' : 'en';
}

/**
 * The language rule for THIS turn, decided from the visitor's latest message rather than left to
 * the model to infer. Flash reads a long Tamil history as "this is a Tamil chat" and keeps writing
 * Tamil script even after the visitor switches to English (2026-09-08: "any wedding hall in
 * tambaram" came back in Tamil, six Tamil turns deep), so the instruction names the language
 * outright and says the history does not carry over. `locale` (the widget's EN/தமிழ் toggle) is
 * only the tie-break for the opening message, before the visitor has written anything.
 */
export function languageRule(lastMessage, locale = 'en') {
  const lang = visitorLanguage(lastMessage) || (locale === 'ta' ? 'ta' : 'en');
  const said = lang === 'ta'
    ? 'in TAMIL SCRIPT. Write this whole reply — every sentence AND every suggestion — in Tamil script.'
    : lang === 'tanglish'
      ? 'in TANGLISH (Tamil typed in English letters, like "car parking iruka"). Write this whole reply — every sentence AND every suggestion — in Tanglish: Tamil words in English letters, never Tamil script.'
      : 'in ENGLISH. Write this whole reply — every sentence AND every suggestion — in English, and do NOT use Tamil script.';
  return `LANGUAGE: the visitor's latest message is ${said} Decide this fresh on EVERY turn from their latest message alone; the language of earlier messages in this chat does not carry over, and a visitor who switches language mid-chat gets the new one immediately.`;
}

/**
 * The system instruction. Kept tight: Flash follows short, concrete rules far better than essays,
 * and every token here is paid on every hop of every message.
 */
export function buildSystemInstruction({ site = {}, user = {}, page = {}, locale = 'en', lastMessage = '' }) {
  const siteName = String(site.name || 'this property site').slice(0, 80);
  const cities = Array.isArray(site.cities) && site.cities.length ? site.cities.slice(0, 20).join(', ') : '';
  const signedIn = !!user.id;
  const who = signedIn
    ? `The visitor is SIGNED IN as ${user.name ? `"${String(user.name).slice(0, 60)}"` : 'a member'}` +
      `${user.phone ? ` (phone on file: ${String(user.phone).slice(0, 16)} — never ask for it, never repeat it back)` : ''}` +
      `${user.role ? `, role: ${String(user.role).slice(0, 24)}` : ''}.`
    : 'The visitor is NOT signed in (a guest). You cannot see their listings, leads or plan; if they ask for those, tell them to sign in first (one short line) — do not call those tools.';
  const where = page.propertyId
    ? `They are currently viewing listing id ${String(page.propertyId).slice(0, 80)} — "it" / "this one" means that listing.`
    : page.path ? `They are on the page ${String(page.path).slice(0, 160)}.` : '';
  const lang = languageRule(lastMessage, locale);

  return [
    `You are the friendly, sharp property assistant on ${siteName}, a property website in Tamil Nadu, India (owner-direct listings, no brokerage).`,
    `You help people FIND a home (buy or rent), ENQUIRE about a listing, FILE a requirement so the team finds one for them, LIST their own property, and MAKE A SHORT VIDEO (a reel) of any listing to share on WhatsApp. Signed-in members can also check their own listings, the leads on them, and their plan.`,
    '',
    who,
    where,
    cities ? `Popular cities: ${cities}. Listings exist in hundreds of other towns too — always search the exact town the visitor names; never swap it for a bigger or nearby city. Place names go to tools in English letters whatever language the visitor writes in (தர்மபுரி → Dharmapuri) — the site stores every place in English.` : '',
    lang,
    '',
    'HOW TO WORK',
    '- Act, then talk: when the visitor describes what they want, SEARCH immediately with whatever you have. Do not interrogate first. Ask ONE follow-up only if the search cannot run at all (no place at all, or sale vs rent unclear).',
    '- Use the place exactly as the visitor said it (Erode stays Erode — never Coimbatore): a well-known city or district town goes in `city`; anything else — an area, suburb, small town or village — goes in `locality`. A place only in `query` is a wasted search.',
    '- Whenever the visitor names a place, a type, a budget, or changes any of them, call search_properties again in THAT turn. Never say nothing was found unless a search in this turn returned nothing.',
    '- BE HONEST ABOUT THE PLACE. A search result carries `place` (where the rows actually came from) and `widenedToCity`. When `widenedToCity` is true, or `place` is not the place the visitor named, say so in the SAME sentence that offers the cards: "Nothing in Palakkarai right now — here are some elsewhere in Trichy." NEVER write "I could not find any…" in a turn that shows cards; that reads as a broken site. If a turn genuinely has no rows, show no cards and offer request_property.',
    '- A search the visitor asked to NARROW ("Tambaram only", "under 40 lakhs", "3 BHK only") must come back narrower or be called out as not possible. Never re-show the same listings you showed last turn as if they were a new answer — if the narrowed search returns the same rows or nothing, say that plainly and offer to widen the budget, the area or the type.',
    '- Never invent a listing, a price, a phone number or a link. Everything about a property comes from a tool result. If a tool returns nothing, say so plainly and offer to file a requirement (request_property).',
    '- WHO YOU ARE. You are Ask ' + siteName + ', this site\u2019s own property assistant. Asked what you are, whether you are a robot, a bot, a human, an AI, or who made you: say you are Ask ' + siteName + ', the assistant here to help with property \u2014 in one short line, then get back to the question. Asked specifically who BUILT, MADE or TRAINED you, the answer is ' + siteName + ' \u2014 you are their own assistant, built by them, and that is the whole answer. NEVER name anything behind you: not the model, not its vendor, not any platform or supplier (no "large language model", no "AI model", no "trained by Google", no Gemini, no Bosun, no vendor of any kind). If pressed again, repeat that you are ' + siteName + '\u2019s own assistant and move the conversation back to property. Never apologise for not naming one.',
    '- PLACES: a name the visitor gives is usually an AREA (Thiruporur, Kelambakkam, Velachery) — pass it as locality; the search tool also tries it as a city on its own. The result says how the place was read (placeReadAs) and, when it widened to the city, widenedToCity — say so honestly ("nothing in X yet, but nearby in Y").',
    '- Every listing on this site is owner-direct. Never answer "no owner-direct properties" — an empty result means "nothing listed in <place> yet", nothing more.',
    '- Filing a requirement: carry the place from earlier in the conversation into request_property (never file one with no place); if the budget is unknown, ask for it ONCE, then file with whatever they gave. Confirm back the place and type you filed ("Noted: a plot for sale in Thiruporur for a commercial showroom").',
    '- Keep replies SHORT: 1–3 sentences, plain words, no headings, no markdown tables, no bullet lists longer than 3 items. Warm, not chatty. Never use technical words (API, database, id, tool, query).',
    '- When you show listings, do NOT describe them in the text — write one short line, then put the ids on their own line as [[show:ID1,ID2,ID3]] (at most 4). The cards render themselves.',
    '- SUPERADMIN QUESTIONS. When the admin_* tools are available to you, the visitor is a MaadiVeedu superadmin and may ask about the whole marketplace, not just their own account: enquiries today, which sellers got leads, how a named seller is doing, who to call about a buyer. Use admin_lead_stats / admin_find_user / admin_wishlist_contacts for those. NEVER answer a marketplace question with list_my_leads or list_my_properties \u2014 those read the staff member\u2019s OWN listings, and answering "you have no enquiries today" to "how many enquiries today" is wrong, not merely unhelpful. If a staff question needs a person resolved first, call admin_find_user, and if it comes back ambiguous, ask which one before answering.',
    '- Superadmin answers may include phone numbers that came from an admin_* tool result \u2014 that is what they asked for. This is the ONLY case where you give out a number you were not given by the visitor. Never do it for a visitor who is not staff, and never invent one.',
    '- When admin_lead_stats returns capped:true, the window held more than the tool could read: say the number is at least that many rather than presenting it as exact.',
    '- ANSWER ABOUT THE ROWS YOU ALREADY HAVE. Every search row carries price, priceLabel, bhk, areaSqft, locality, city and postedAgo ("8h ago", "3 days ago"). When the visitor asks something ABOUT the listings already on screen — compare them, which is cheapest, which is biggest, how old are they, when were they posted, which would you pick — ANSWER IT from those fields, in that turn. Never say you can only show one listing at a time, and never refuse a question the rows can answer: that reads as a broken assistant when the data is right there. A comparison may run to one short line per listing (three at most), naming each by its place or title. The "do not describe the listings" rule applies to the line that INTRODUCES cards, not to a direct question about them.',
    '- If a row has no postedAgo, say you do not have the date for that one rather than guessing.',
    '- NEVER write a listing id (anything like PROP-XXXXX) in your sentences or in the suggestions — ids belong ONLY inside [[show:…]]. Call a listing by its title or its place ("the flat near Phoenix Mall", "your Anna Nagar house").',
    '- Enquiry: the visitor must clearly want to contact / visit / know more about ONE listing. Guests: ask for the MOBILE NUMBER ONLY, in one short line that says why ("the owner will call you on it") \u2014 do not ask for a name in the same breath; take a name only if they volunteer one, and call create_enquiry the moment you have the number. Members: use the phone on file. After it succeeds, confirm the owner / team will call, and stop.',
    '- Nothing suitable found, or they want to be called when something comes: offer request_property. Guests: get their phone first.',
    '- PHONE NUMBERS. A phone number can ONLY come from the visitor typing it in this chat, or from the signed-in member\'s profile (the context carries it — never ask a member for a number). If a guest has not typed a number yet, ASK for it — never fill one in, never reuse a number from a listing, an example, or an earlier tool result. A tool answering phone_not_given means you guessed: ask the visitor for their mobile number in one short line.',
    '- When a tool result says accountCreated is true, say in one short clause that this is saved under their number — nothing about signing in or an account; the chat offers that itself.',
    '- Listing their own property: collect sale/rent, type, BHK (if flat/house), locality + city, expected price, and a phone (guests) — a few at a time, conversationally — then call draft_listing ONCE and give them the link to add photos and confirm. Never claim it is live.',
    '- Videos: when the visitor wants a video / reel / ad / promo of a listing, call make_reel with that listing\'s id (from the cards you showed, their own listings, or the page they are on) — do not ask what to put in it. Default style is photo. Use animated only if they ask for it AND they are signed in; a guest who wants the animated one gets the photo reel now (call make_reel with photo) plus ONE short line that the animated version is for signed-in members. When the tool returns a jobId, say in one line that the video is being made (about a minute; animated: two to three), that it will appear right here, and that they can share it on WhatsApp — then put [[reel:JOBID]] on its own line. If it returns existing:true, say the video is ready and use the same marker. Never describe what is in the video. If it fails (not_found / no_photos), say so in one line.',
    '- Plans and pricing: only from list_plans / get_my_plan. Never quote a price from memory. When a plan question is about what the visitor GETS for the money (leads, buyer contacts, photos, reposts), answer with the fields the tool actually returned and give the pricing link; never pad it with a guess, and never leave a paying question with "it does not specify" when the tool result has the answer.',
    '- USE THE LINKS THE TOOLS GIVE YOU. When a tool result carries a url (manageUrl, pricingUrl, browseUrl, the complete-your-listing link), and the answer is "you can do that on the site", give that link in the sentence. Never say "from your dashboard" or "on our website" without the link when you were handed one. Never invent a url that was not in a tool result.',
    '- REACHING A PERSON. If the visitor asks for a phone number, an email, customer support, the sales team, or simply to talk to somebody, NEVER refuse and never say only "it is on the website". Point them to the site\u2019s Contact page in one short line AND offer the better path: leave their number and the team will call them (request_property, or create_enquiry when it is about one listing). A person asking to talk to a person is the most valuable message of the day \u2014 treat it as a lead, not as an out-of-scope question.',
    '- What a property is WORTH: you cannot value it, but do not stop at "I can\u2019t". Search what comparable listings in that locality are asking (search_properties on the same place and type) and show two or three as a guide, saying plainly that these are asking prices, not a valuation.',
    '- If asked something unrelated to property or this site, answer in one polite line and steer back.',
    '- Never offer a chip you would then refuse: every suggestion must be something you can actually do (no other languages, no valuations, no services this site does not run).',
    '- Always end with a suggestions line: [[suggest:short option 1|short option 2|short option 3]] — 2 or 3 things the visitor might tap next, each under 6 words, in the visitor’s language. Never suggest something you just did. After showing listings (or a member\'s own listings), one suggestion should be a video of one of them, e.g. "Make a video of the Velachery flat".',
    '',
    'FORMAT OF EVERY REPLY: the sentence(s) for the visitor, then optionally one [[show:…]] line or one [[reel:…]] line, then the [[suggest:…]] line. Nothing after that.',
  ].filter(Boolean).join('\n');
}

// ── Reply parsing ────────────────────────────────────────────────────────────────────────────────

const SHOW_RE = /\[\[\s*show\s*:\s*([^\]]+?)\s*\]\]/gi;
const SUGGEST_RE = /\[\[\s*suggest\s*:\s*([^\]]+?)\s*\]\]/gi;
const REEL_RE = /\[\[\s*reel\s*:\s*([^\]]+?)\s*\]\]/gi;

/** Split the model's final text into { text, showIds, reelId, suggestions } and strip the markers. */
export function parseReply(rawText) {
  let text = String(rawText || '');
  const showIds = [];
  const suggestions = [];
  let reelId = '';
  text = text.replace(REEL_RE, (_, id) => {
    const clean = String(id).trim().replace(/[^A-Za-z0-9_-]/g, '');
    if (clean && !reelId) reelId = clean;
    return '';
  });
  text = text.replace(SHOW_RE, (_, ids) => {
    for (const id of String(ids).split(/[,\s]+/)) {
      const clean = id.trim().replace(/[^A-Za-z0-9_:.-]/g, '');
      if (clean && !showIds.includes(clean)) showIds.push(clean);
    }
    return '';
  });
  text = text.replace(SUGGEST_RE, (_, opts) => {
    for (const o of String(opts).split('|')) {
      const s = o.trim().slice(0, 48);
      if (s && !suggestions.includes(s)) suggestions.push(s);
    }
    return '';
  });
  // Flash occasionally leaks markdown despite the instruction — flatten the common bits.
  text = text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/^#+\s*/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text, showIds: showIds.slice(0, 4), reelId, suggestions: suggestions.slice(0, 3) };
}

/**
 * Belt and braces for the "no ids in prose" rule: any remembered listing id that still leaks into the
 * text or a chip is swapped for its title (or place). The instruction holds ~95% of the time on Flash;
 * this makes it 100%, because an id is meaningless to a visitor and looks like a bug.
 */
export function scrubIds(text, remembered) {
  let out = String(text || '');
  for (const l of remembered || []) {
    if (!l.id || out.indexOf(l.id) === -1) continue;
    const name = l.title || [l.bhk ? `${l.bhk} BHK` : '', l.locality || l.city].filter(Boolean).join(' in ') || 'that listing';
    out = out.split(l.id).join(name);
  }
  return out;
}

/**
 * Pull the listings out of a tool result so we can (a) remember them for cards and (b) know which
 * tool surfaced them. Tolerant of the two shapes the platform sends: `{ items:[…] }` for a search,
 * `{ property:{…} }` for one listing.
 */
export function listingsFromToolResult(name, result) {
  if (!result || typeof result !== 'object') return [];
  const rows = Array.isArray(result.items) ? result.items
    : result.property && typeof result.property === 'object' ? [result.property]
    : [];
  return rows
    .filter((r) => r && (r.id || r.propertyId))
    .map((r) => ({
      id: String(r.id || r.propertyId).slice(0, 80),
      title: String(r.title || '').slice(0, 140),
      price: Number(r.price) || 0,
      priceLabel: r.priceLabel ? String(r.priceLabel).slice(0, 40) : fmtInr(r.price),
      listingType: r.listingType ? String(r.listingType).slice(0, 12) : '',
      propertyType: r.propertyType ? String(r.propertyType).slice(0, 24) : '',
      bhk: Number(r.bhk) || null,
      areaSqft: Number(r.areaSqft) || null,
      locality: String(r.locality || '').slice(0, 80),
      city: String(r.city || '').slice(0, 60),
      url: String(r.url || '').slice(0, 300),
      image: String(r.image || '').slice(0, 500),
      fromTool: name,
    }));
}

/** Merge new listings into the conversation's remembered set (id-keyed, bounded, newest last). */
export function rememberListings(existing, fresh) {
  const map = new Map((Array.isArray(existing) ? existing : []).map((l) => [l.id, l]));
  for (const l of fresh) { map.delete(l.id); map.set(l.id, l); }
  const all = [...map.values()];
  return all.slice(Math.max(0, all.length - MAX_REMEMBERED_LISTINGS));
}

/** The cards for a reply: the ids the model named, resolved against what tools returned. */
export function cardsFor(showIds, remembered) {
  const byId = new Map((remembered || []).map((l) => [l.id, l]));
  return showIds.map((id) => byId.get(id)).filter(Boolean).map(({ fromTool, ...card }) => card);
}

/** Reel jobs remembered per conversation (by jobId) so a `[[reel:…]]` marker resolves to real fields. */
export const MAX_REMEMBERED_REELS = 10;

/** The reel a successful make_reel result describes — every field bounded, nothing model-authored. */
export function reelFromToolResult(name, result) {
  if (name !== 'make_reel' || !result || typeof result !== 'object' || result.ok === false || !result.jobId) return null;
  const status = ['queued', 'running', 'ready', 'failed'].includes(result.status) ? result.status : 'queued';
  return {
    jobId: String(result.jobId).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64),
    style: result.style === 'animated' ? 'animated' : 'photo',
    status,
    etaSeconds: Number(result.etaSeconds) || (result.style === 'animated' ? 180 : 75),
    listingId: String(result.listingId || '').slice(0, 80),
    title: String(result.title || '').slice(0, 140),
    listingUrl: String(result.listingUrl || '').slice(0, 400),
    videoUrl: String(result.videoUrl || '').slice(0, 600),
    posterUrl: String(result.posterUrl || '').slice(0, 600),
    existing: result.existing === true,
    at: Date.now(),
  };
}

export function rememberReel(existing, reel) {
  const list = (Array.isArray(existing) ? existing : []).filter((r) => r && r.jobId !== reel.jobId);
  list.push(reel);
  return list.slice(Math.max(0, list.length - MAX_REMEMBERED_REELS));
}

/**
 * The reel to attach to a reply: the one the model marked, else — when make_reel succeeded this
 * turn and Flash forgot the marker — the newest from this turn. The widget needs the jobId to poll;
 * a reel the visitor asked for must never be lost to a missing marker.
 */
export function reelFor(reelId, remembered, turnJobIds = []) {
  const list = Array.isArray(remembered) ? remembered : [];
  const byId = (id) => list.find((r) => r.jobId === id);
  const hit = reelId ? byId(reelId) : null;
  if (hit) return stripReel(hit);
  for (let i = turnJobIds.length - 1; i >= 0; i--) {
    const r = byId(turnJobIds[i]);
    if (r) return stripReel(r);
  }
  return null;
}

function stripReel({ at, existing, ...reel }) {
  return reel;
}

// ── Tool-result hygiene ──────────────────────────────────────────────────────────────────────────

/** Bound a tool result before it reaches the model / the doc. Truncates arrays first, then text. */
export function boundToolResult(result) {
  let obj = result && typeof result === 'object' ? result : { value: result ?? null };
  let s = JSON.stringify(obj);
  if (s.length <= MAX_TOOL_RESULT_CHARS) return obj;
  if (Array.isArray(obj.items)) {
    let items = obj.items.slice();
    while (items.length > 1 && JSON.stringify({ ...obj, items }).length > MAX_TOOL_RESULT_CHARS) items.pop();
    obj = { ...obj, items, truncated: true };
    s = JSON.stringify(obj);
    if (s.length <= MAX_TOOL_RESULT_CHARS) return obj;
  }
  return { truncated: true, text: s.slice(0, MAX_TOOL_RESULT_CHARS) };
}

// ── The Gemini call ──────────────────────────────────────────────────────────────────────────────

/**
 * One model step over the conversation so far.
 *
 * @returns {{ kind:'reply', text:string, content:object, usage:object }
 *         | { kind:'tool_calls', calls:[{id,name,args}], content:object, usage:object }
 *         | null}   null on any model failure — the caller degrades (and charges nothing).
 */
export async function modelStep({ contents, systemInstruction, tools, model = GEMINI_FLASH }) {
  const ai = geminiClient();
  if (!ai) return null;
  const MAX_ATTEMPTS = 2;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const resp = await ai.models.generateContent({
        model,
        contents,
        config: {
          systemInstruction,
          ...(tools.length ? { tools: [{ functionDeclarations: tools }] } : {}),
          // Tool selection + a two-line answer: reasoning tokens buy nothing here and cost seconds
          // (see the model note in utils/gemini.js).
          thinkingConfig: { thinkingBudget: 0 },
          temperature: 0.3,
          maxOutputTokens: 700,
        },
      });
      const cand = resp.candidates?.[0];
      const content = cand?.content;
      if (!content || !Array.isArray(content.parts)) return null;
      const usage = {
        inputTokens: resp.usageMetadata?.promptTokenCount ?? 0,
        outputTokens: resp.usageMetadata?.candidatesTokenCount ?? 0,
      };
      const calls = content.parts
        .filter((p) => p.functionCall && p.functionCall.name)
        .map((p, i) => ({
          id: String(p.functionCall.id || `call_${Date.now().toString(36)}_${i}`),
          name: String(p.functionCall.name),
          args: p.functionCall.args && typeof p.functionCall.args === 'object' ? p.functionCall.args : {},
        }));
      if (calls.length) return { kind: 'tool_calls', calls, content: { role: 'model', parts: content.parts }, usage };
      const text = content.parts.filter((p) => typeof p.text === 'string' && !p.thought).map((p) => p.text).join('');
      return { kind: 'reply', text, content: { role: 'model', parts: content.parts }, usage };
    } catch (e) {
      const msg = String(e?.message || e);
      const transient = /\b(429|500|503|UNAVAILABLE|RESOURCE_EXHAUSTED|fetch failed|ETIMEDOUT)\b/i.test(msg);
      console.error('assistant:model:err', msg.slice(0, 300), transient && attempt < MAX_ATTEMPTS - 1 ? '(retrying)' : '');
      if (!transient || attempt === MAX_ATTEMPTS - 1) return null;
      await new Promise((r) => setTimeout(r, 1200));
    }
  }
  return null;
}

/** Build the `functionResponse` content the platform's results become. Order = the calls' order. */
export function toolResultsContent(pendingCalls, results) {
  const byId = new Map();
  for (const r of Array.isArray(results) ? results : []) {
    if (r && r.id) byId.set(String(r.id), r);
  }
  return {
    role: 'user',
    parts: pendingCalls.map((call) => {
      const r = byId.get(call.id);
      const response = r && r.result !== undefined
        ? boundToolResult(r.result)
        : { error: r?.error ? String(r.error).slice(0, 300) : 'no result returned' };
      return { functionResponse: { name: call.name, response } };
    }),
  };
}

/** Trim history to the most recent MAX_HISTORY_CONTENTS, never splitting a call/response pair. */
export function trimHistory(contents) {
  if (contents.length <= MAX_HISTORY_CONTENTS) return contents;
  let start = contents.length - MAX_HISTORY_CONTENTS;
  // A history must begin with a plain user turn — walk forward until it does.
  while (start < contents.length) {
    const c = contents[start];
    const isPlainUser = c.role === 'user' && c.parts.every((p) => typeof p.text === 'string');
    if (isPlainUser) break;
    start++;
  }
  return contents.slice(start);
}

/** What the platform shows as a fallback when the model is unavailable. Free (never metered). */
export function degradedReply(locale) {
  return locale === 'ta'
    ? 'மன்னிக்கவும், இப்போது பதிலளிக்க முடியவில்லை. சிறிது நேரம் கழித்து மீண்டும் முயற்சிக்கவும்.'
    : 'Sorry, I could not answer just now. Please try again in a moment.';
}
