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
        query: { type: 'string', description: 'Free-text version of the ask, in the visitor’s words.' },
        city: { type: 'string', description: 'City name, e.g. Chennai, Coimbatore, Madurai.' },
        locality: { type: 'string', description: 'Area / neighbourhood, e.g. Velachery, Anna Nagar.' },
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
      'Fetch the full details of ONE listing by its id (from a search result, or the page the visitor ' +
      'is on). Use before answering a detailed question about a specific listing.',
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
        city: { type: 'string' },
        locality: { type: 'string' },
        maxPrice: { type: 'integer', description: 'Budget ceiling in rupees.' },
        notes: { type: 'string', description: 'Anything else they said matters (floor, parking, move-in date…).' },
      },
      required: ['phone', 'listingType'],
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
        city: { type: 'string' },
        locality: { type: 'string' },
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
  list_plans: {
    audience: 'all',
    description: 'The plans / packages the site sells (name, price, what each includes). For visitors asking what it costs to list or to get more visibility.',
    parameters: { type: 'object', properties: {} },
  },
};

/** The tools the model may see on this turn: declared by the platform ∩ allowed for this audience. */
export function toolsFor({ capabilities, signedIn }) {
  const declared = new Set(Array.isArray(capabilities) && capabilities.length ? capabilities : Object.keys(TOOL_DEFS));
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

/**
 * The system instruction. Kept tight: Flash follows short, concrete rules far better than essays,
 * and every token here is paid on every hop of every message.
 */
export function buildSystemInstruction({ site = {}, user = {}, page = {}, locale = 'en' }) {
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
  const lang = locale === 'ta'
    ? 'The site is being read in TAMIL. Reply in Tamil (Tamil script) unless the visitor writes in English.'
    : 'Reply in the language the visitor writes in: English, Tamil (Tamil script) or Tanglish (Tamil in Latin letters) — mirror them exactly.';

  return [
    `You are the friendly, sharp property assistant on ${siteName}, a property website in Tamil Nadu, India (owner-direct listings, no brokerage).`,
    `You help people FIND a home (buy or rent), ENQUIRE about a listing, FILE a requirement so the team finds one for them, and LIST their own property. Signed-in members can also check their own listings, the leads on them, and their plan.`,
    '',
    who,
    where,
    cities ? `Cities the site covers: ${cities}.` : '',
    lang,
    '',
    'HOW TO WORK',
    '- Act, then talk: when the visitor describes what they want, SEARCH immediately with whatever you have. Do not interrogate first. Ask ONE follow-up only if the search cannot run at all (no place at all, or sale vs rent unclear).',
    '- Never invent a listing, a price, a phone number or a link. Everything about a property comes from a tool result. If a tool returns nothing, say so plainly and offer to file a requirement (request_property).',
    '- Keep replies SHORT: 1–3 sentences, plain words, no headings, no markdown tables, no bullet lists longer than 3 items. Warm, not chatty. Never use technical words (API, database, id, tool, query).',
    '- When you show listings, do NOT describe them in the text — write one short line, then put the ids on their own line as [[show:ID1,ID2,ID3]] (at most 4). The cards render themselves.',
    '- NEVER write a listing id (anything like PROP-XXXXX) in your sentences or in the suggestions — ids belong ONLY inside [[show:…]]. Call a listing by its title or its place ("the flat near Phoenix Mall", "your Anna Nagar house").',
    '- Enquiry: the visitor must clearly want to contact / visit / know more about ONE listing. Guests: ask their name and phone in ONE message before create_enquiry. Members: use the phone on file. After it succeeds, confirm the owner / team will call, and stop.',
    '- Nothing suitable found, or they want to be called when something comes: offer request_property. Guests: get their phone first.',
    '- When a tool result says accountCreated is true, tell the visitor in one short clause that a MaadiVeedu account was created with their number and they can sign in with it to track this — do not explain further.',
    '- Listing their own property: collect sale/rent, type, BHK (if flat/house), locality + city, expected price, and a phone (guests) — a few at a time, conversationally — then call draft_listing ONCE and give them the link to add photos and confirm. Never claim it is live.',
    '- Plans and pricing: only from list_plans / get_my_plan. Never quote a price from memory.',
    '- If asked something unrelated to property or this site, answer in one polite line and steer back.',
    '- Always end with a suggestions line: [[suggest:short option 1|short option 2|short option 3]] — 2 or 3 things the visitor might tap next, each under 6 words, in the visitor’s language. Never suggest something you just did.',
    '',
    'FORMAT OF EVERY REPLY: the sentence(s) for the visitor, then optionally one [[show:…]] line, then the [[suggest:…]] line. Nothing after that.',
  ].filter(Boolean).join('\n');
}

// ── Reply parsing ────────────────────────────────────────────────────────────────────────────────

const SHOW_RE = /\[\[\s*show\s*:\s*([^\]]+?)\s*\]\]/gi;
const SUGGEST_RE = /\[\[\s*suggest\s*:\s*([^\]]+?)\s*\]\]/gi;

/** Split the model's final text into { text, showIds, suggestions } and strip the markers. */
export function parseReply(rawText) {
  let text = String(rawText || '');
  const showIds = [];
  const suggestions = [];
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
  return { text, showIds: showIds.slice(0, 4), suggestions: suggestions.slice(0, 3) };
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
