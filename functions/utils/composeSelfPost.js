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
    language: { type: 'string', enum: ['en', 'ta', 'hi'] },
  },
  required: ['lines', 'language'],
};

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
