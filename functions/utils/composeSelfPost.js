/**
 * Compose the WhatsApp message a MaadiVeedu admin sends a property owner to invite them to finish
 * their own listing ("self-post link"). This is the billable half of the compose service — the
 * charging + HTTP surface live in handlers/sourcingCompose.js.
 *
 * What the customer is paying ₹0.25 for, versus the hardcoded English template they had before:
 *   1. the owner's OWN language (their post is often Tamil) — the single biggest lift on a Chennai base;
 *   2. their OWN property quoted back (2BHK, Anna Nagar, ₹85L) so it reads as a human who saw the ad;
 *   3. the exact fields still missing, named — the owner knows the effort up front ("just built-up area");
 *   4. wording that CHANGES per attempt — a 2nd/3rd nudge that repeats itself is what gets ignored.
 *
 * Degrades to null on any failure (unconfigured, network, junk) — the caller must fall back to its own
 * template and NOT charge. An owner never waits on Gemini for a message we could have sent anyway.
 */
import { generateJson, geminiConfigured, GEMINI_FLASH, GEMINI_FLASH_LITE } from './gemini.js';

export { geminiConfigured };

/**
 * FLASH, not FLASH_LITE (which queryGen/classifyListing use): those EXTRACT structure, this WRITES
 * natural Tamil/Hindi prose a stranger will judge us on. Clumsy Tamil is worse than the customer's
 * English template, and the ₹0.25 exists only because the message is better. ~5.5 paise/call vs
 * 25 paise revenue = ~78% margin (flash-lite would be ~1.3 paise / 95%) — the ~4 paise gap is not
 * what decides this; the quality of the Tamil is. `SELFPOST_COMPOSE_MODEL=gemini-2.5-flash-lite`
 * drops to the cheap model without a deploy if the gap ever stops paying for itself.
 */
export const COMPOSE_MODEL = process.env.SELFPOST_COMPOSE_MODEL || GEMINI_FLASH;
export { GEMINI_FLASH, GEMINI_FLASH_LITE };

/** Hard ceiling on the composed text. WhatsApp shows ~300 chars before "Read more" collapses it. */
const MAX_MESSAGE_CHARS = 700;

/**
 * `lines[]`, NOT a single `message` string — deliberately.
 *
 * A WhatsApp message is multi-line, and asking for it as one JSON string makes the model emit RAW
 * newlines inside the string value, which is invalid JSON that `responseSchema` does NOT prevent:
 * measured, flash failed to parse on half the Tamil calls ("Unterminated string in JSON"). An array
 * of single-line strings removes the newline from the JSON entirely, so the failure cannot occur —
 * and it makes the 2-4 line rule checkable in code rather than merely requested in the prompt.
 */
const SCHEMA = {
  type: 'object',
  properties: {
    lines: { type: 'array', items: { type: 'string' } },
    language: { type: 'string', enum: ['en', 'ta', 'hi', 'te', 'kn', 'ml'] },
  },
  required: ['lines', 'language'],
};

/**
 * The languages a customer may FORCE a compose into (MaadiVeedu's sourcing-language codes). The name
 * + script pair goes into the prompt verbatim — the script matters, or the model may transliterate
 * Tamil into Latin letters.
 */
const FORCE_LANGUAGES = {
  en: 'English (Latin script)',
  ta: 'Tamil (Tamil script)',
  hi: 'Hindi (Devanagari script)',
  te: 'Telugu (Telugu script)',
  kn: 'Kannada (Kannada script)',
  ml: 'Malayalam (Malayalam script)',
};

/**
 * The prompt line that overrides the "mirror their post's language" default when the customer forces
 * a language. Returns '' for absent/unknown codes — unknown must never break a compose.
 */
function forceLanguageBrief(code) {
  const name = FORCE_LANGUAGES[String(code || '').toLowerCase()];
  return name
    ? `LANGUAGE OVERRIDE: write the ENTIRE message in ${name}, regardless of the language of their post. Do not mix scripts.`
    : '';
}

/** Model line arrays arrive with blanks/padding; normalise to at most MAX_LINES real lines. */
const MAX_LINES = 4;

const SYSTEM = `You write short WhatsApp messages for MaadiVeedu, an Indian property marketplace, to
property owners who publicly posted their property for sale/rent on Facebook.

You are messaging a real person about THEIR OWN post. Rules:
- Write in the SAME language as their original post. Tamil post -> reply in Tamil script. Hindi -> Hindi
  (Devanagari). English or unclear -> English. Never mix scripts in one message.
- Reference their actual property (BHK, locality, price) so it is obvious a human read their ad.
- MaadiVeedu lists it FREE. Say so. No fee, ever. Never invent an offer, discount, deadline or buyer.
- If fields are missing, name them plainly so the effort is obvious ("just the built-up area").
- Always end with the link exactly as given. Never alter, shorten or wrap it.
- Warm, plain, human. No marketing hype, no ALL CAPS, at most one emoji.
- Return 2-4 SHORT lines in "lines" — one line per element, no newlines inside an element. The last
  line is the link, alone. This is a WhatsApp message, not an email.
- Do NOT recite their whole ad back at them. Pick the ONE or TWO details that prove you read it
  (locality + size, or price). Listing every spec reads like a robot.

NEVER, under any circumstance:
- Change their NAME. Use it only if given, spelled EXACTLY as given — never translate it, never
  transliterate it into another script, never "correct" it to a similar name. Murugan is not
  Murugesan. If you cannot reproduce the name exactly as provided, leave the name out entirely.
- Claim they contacted us, replied, asked us anything, showed interest, or agreed to anything.
  Opening a link is NOT interest and must never be described as interest — they are a stranger who
  posted publicly and has never spoken to us.`;

/** Money as an owner would say it: 85L / 1.3Cr / ₹18,000. */
function humanPrice(amount, category) {
  const n = Number(amount) || 0;
  if (n <= 0) return '';
  if (category === 'Rent' || category === 'Lease') return `₹${n.toLocaleString('en-IN')}`;
  if (n >= 1e7) return `₹${Math.round((n / 1e7) * 100) / 100} Cr`;
  if (n >= 1e5) return `₹${Math.round((n / 1e5) * 100) / 100} L`;
  return `₹${n.toLocaleString('en-IN')}`;
}

/**
 * The per-attempt angle. `sendCount` is the nudge number (1 = first contact) and `opened` says the
 * owner clicked but did not finish — MaadiVeedu tracks that (completeLinkOpenedAt), and a nudge that
 * knows it converts far better than one that repeats the pitch.
 */
function attemptBrief(sendCount, opened) {
  if (sendCount <= 1) {
    return 'This is the FIRST message to this owner. Introduce MaadiVeedu in one short line, then the ask.';
  }
  if (opened) {
    // "Opened" is a server log line, not a conversation. Left unqualified, models turn it into "you
    // showed interest" — a false claim to someone who has never spoken to us (measured on flash-lite).
    return `This is nudge #${sendCount}. Our server shows the link was opened but the form was not finished. Do NOT re-pitch. Offer help in case something was unclear, and keep it to 2 lines. Do NOT say they showed interest, contacted us, or started an application — you must not characterise their intent at all.`;
  }
  return `This is nudge #${sendCount}. The earlier message got no reply. Say something DIFFERENT from a first pitch — shorter, lighter, no pressure. Do not repeat the introduction.`;
}

/**
 * Compose one message. Returns `{ message, language }`, or null to signal "fall back to the template
 * and do not charge".
 *
 * @param {object} lead    - { description, locality, city, propertyType, category, bhkType, price, ownerName }
 * @param {string} url     - the /complete/<token> link; reproduced verbatim
 * @param {string[]} missingFieldLabels - human labels of the fields still needed (may be empty)
 * @param {number} sendCount - 1 = first contact, 2+ = nudge
 * @param {boolean} opened   - owner has opened the link before
 * @param {string} model     - override the model (tests / A-B); defaults to COMPOSE_MODEL
 */
export async function composeSelfPostMessage({ lead = {}, url, missingFieldLabels = [], sendCount = 1, opened = false, model = COMPOSE_MODEL }) {
  if (!geminiConfigured() || !url) return null;

  const price = humanPrice(lead.price, lead.category);
  const facts = [
    lead.propertyType && `type: ${lead.propertyType}`,
    lead.category && `listed for: ${lead.category}`,
    lead.bhkType && `size: ${lead.bhkType}`,
    price && `price: ${price}`,
    lead.locality && `locality: ${lead.locality}`,
    lead.city && `city: ${lead.city}`,
    lead.ownerName && `owner's name: ${lead.ownerName}`,
  ].filter(Boolean).join('\n');

  const ask = missingFieldLabels.length
    ? `Still needed from them: ${missingFieldLabels.join(', ')}. Name these plainly.`
    : 'Nothing is missing — everything is ready. Ask them only to review and confirm.';

  // Their own words decide the language, so the post goes in raw (truncated — the tail of a long FB
  // post is boilerplate and we are paying per token).
  const prompt = `Their original public post:
"""
${String(lead.description || '').slice(0, 1200)}
"""

What we know:
${facts || '(nothing beyond the post)'}

${ask}

${attemptBrief(Number(sendCount) || 1, Boolean(opened))}

Their link (reproduce EXACTLY, do not modify): ${url}

Write the WhatsApp message.`;

  const out = await generateJson({
    model,
    prompt,
    system: SYSTEM,
    schema: SCHEMA,
    temperature: 0.7, // nudges must not be carbon copies — this is the whole point of per-attempt billing
    // No thinking: writing 3 lines needs none, and on flash its reasoning ate the output budget (JSON
    // truncated mid-string on half the Tamil calls) while billing at the output rate. See gemini.js.
    thinkingBudget: 0,
    // Tamil/Devanagari cost FAR more tokens per character than Latin: at 400 the JSON was truncated
    // mid-string and came back unparseable (measured — flash degraded on half the Tamil calls). The
    // message is length-capped by MAX_MESSAGE_CHARS anyway, so this only has to be big enough to never
    // truncate; unused tokens are not billed.
    maxOutputTokens: 1400,
  });

  const lines = Array.isArray(out?.lines)
    ? out.lines.map((l) => String(l ?? '').trim()).filter(Boolean).slice(0, MAX_LINES)
    : [];
  if (!lines.length) return null;
  const message = lines.join('\n');

  // A message that lost the link is a dead end for the owner — worse than the plain template.
  if (!message.includes(url)) return null;
  if (message.length > MAX_MESSAGE_CHARS) return null;

  return { message, language: String(out?.language || 'en') };
}

/**
 * The OTHER side of the marketplace. `composeSelfPostMessage` writes to a SELLER who posted a
 * property; this writes to a BUYER who posted a "wanted / looking for" ad — telling them we already
 * have matching listings and inviting them to see ALL of them at one consolidated link. Same ₹0.25
 * lane, same degrade-to-null contract, but the link here is a public /properties browse URL (not a
 * per-owner /complete token), so the single-link rule protects a DIFFERENT dead end: a buyer pitch
 * that lost the link is just spam.
 */
const BUYER_SYSTEM = `You write short, warm WhatsApp messages for MaadiVeedu, an Indian property
marketplace, to people who PUBLICLY POSTED on Facebook looking for a property to buy or rent (a
"wanted / looking for" post). You are telling them we already have matching listings in their area.

You are messaging a real person about THEIR OWN "looking for" post. Rules:
- Write in the SAME language as their original post. Tamil post -> reply in Tamil script. Hindi ->
  Hindi (Devanagari). English or unclear -> English. Never mix scripts in one message.
- Reference what THEY are looking for (BHK, area, sale/rent) so it is obvious a human read their post.
- Tell them we found matching properties in their area and they can see ALL of them at the link. If a
  COUNT is given, use it ("8 listings"). NEVER invent a count, a price, or a property we did not give you.
- MaadiVeedu is free to browse — no fee to the buyer, ever. No fake urgency, no invented offer or deadline.
- Warm, plain, human, a little inviting. No marketing hype, no ALL CAPS, at most one emoji.
- Return 2-4 SHORT lines in "lines" — one line per element, no newlines inside an element. The LAST
  line is the link, alone. This is a WhatsApp message, not an email.
- Do NOT list every property back at them. Name the count and at most one or two highlights — the
  link is where they browse the rest.

NEVER, under any circumstance:
- Claim they contacted us, replied, asked us anything, showed interest, or agreed to anything. They
  posted publicly and have never spoken to us.
- Promise a specific property is still available, or name any price/detail we did not give you.`;

/**
 * Compose one buyer pitch. Returns `{ message, language }`, or null to fall back to the caller's
 * template and NOT charge — identical contract to composeSelfPostMessage.
 *
 * @param {object}   buyer      - { description, locality, city, bhk, propertyType, listingType, priceText }
 * @param {object[]} listings   - a few matching listings for concreteness: { title, bhkType|bhk, propertyType, listingType, price }
 * @param {number}   count      - total matching live listings (may exceed listings.length)
 * @param {string}   url        - the consolidated /properties browse link; reproduced verbatim
 * @param {string}   city       - the buyer's city (for "locality, city" phrasing)
 * @param {number}   sendCount  - 1 = first contact, 2+ = nudge
 * @param {string}   forceLanguage - FORCE_LANGUAGES code; forces the output language instead of mirroring the post
 * @param {boolean}  single     - true = pitch ONE specific listing (url is that property's own page)
 * @param {string}   model      - override the model; defaults to COMPOSE_MODEL
 */
export async function composeBuyerPitch({ buyer = {}, listings = [], count = 0, url, city = '', sendCount = 1, forceLanguage = '', single = false, model = COMPOSE_MODEL }) {
  if (!geminiConfigured() || !url) return null;

  const want = [buyer.bhk, buyer.propertyType, buyer.listingType].filter(Boolean).join(' ');
  const sample = (Array.isArray(listings) ? listings.slice(0, 5) : [])
    // The title only matters when pitching ONE property — in the consolidated pitch the link is the star.
    .map((l) => [single ? l.title : '', l.bhkType || l.bhk, l.propertyType, l.listingType, l.price ? humanPrice(l.price, l.listingType) : '']
      .filter(Boolean).join(' · '))
    .filter(Boolean);
  const n = Math.max(Number(count) || 0, sample.length);

  const facts = [
    buyer.locality && `their area: ${[buyer.locality, city || buyer.city].filter(Boolean).join(', ')}`,
    want && `they are looking for: ${want}`,
    buyer.priceText && `their budget (their words): ${buyer.priceText}`,
    // In single mode the count would contradict the "don't mention a count" brief below — omit it.
    !single && n && `matching live listings we can show them: ${n}`,
  ].filter(Boolean).join('\n');

  const highlights = sample.length
    ? `${single ? 'The property being pitched:' : 'A few of the matches:'}\n${sample.map((s) => `- ${s}`).join('\n')}`
    : '';

  const brief = sendCount > 1
    ? 'This is a follow-up nudge — keep it lighter and different from a first message, no pressure.'
    : 'This is the FIRST message to this buyer. Introduce MaadiVeedu in one short line, then the invite.';

  // Single-listing pitch: the link is ONE property's own page, so "see all N at the link" would be a
  // false promise — pitch that property specifically instead.
  const linkBrief = single
    ? `You are pitching ONE SPECIFIC property (described above) — the link opens that property's page. Do not claim the link shows multiple listings, and do not mention any count.`
    : `The link shows ALL the matching listings.`;

  const langBrief = forceLanguageBrief(forceLanguage);

  const prompt = `Their original public "looking for" post:
"""
${String(buyer.description || '').slice(0, 1200)}
"""

What we know:
${facts || '(nothing beyond the post)'}

${highlights}

${brief}
${linkBrief}
${langBrief}

The link${single ? " to this property's page" : ' to ALL matching listings'} (reproduce EXACTLY, do not modify): ${url}

Write the WhatsApp message.`;

  const out = await generateJson({
    model,
    prompt,
    system: BUYER_SYSTEM,
    schema: SCHEMA,
    temperature: 0.7,
    thinkingBudget: 0,
    maxOutputTokens: 1400,
  });

  const lines = Array.isArray(out?.lines)
    ? out.lines.map((l) => String(l ?? '').trim()).filter(Boolean).slice(0, MAX_LINES)
    : [];
  if (!lines.length) return null;
  const message = lines.join('\n');

  // Same rule as the seller path: a pitch that lost the browse link is just spam — reject it.
  if (!message.includes(url)) return null;
  if (message.length > MAX_MESSAGE_CHARS) return null;

  return { message, language: String(out?.language || 'en') };
}
