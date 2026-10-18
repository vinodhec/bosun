/**
 * Buyer background check — the brain. Is this buyer a genuine buyer, a property agent, or an owner
 * in disguise? Pure where it can be: every outside fetch (platform snapshot, Google, the Facebook
 * profile, the model) is injectable so scripts/validate-buyer-check.mjs can drive the whole path
 * with no network. The handler (handlers/buyerChecks.js) owns Firestore, scheduling and money.
 *
 * WHY IT EXISTS. MaadiVeedu's buyer bank is the product — sellers are pitched on "verified buyers
 * waiting". An agent who registers as a buyer harvests those sellers for free and poisons the bank.
 * Staff were spotting agents by feel; this makes it evidence, with a timeline anyone can audit.
 *
 * THE EVIDENCE, cheapest first (every line carries its link + the exact words, so staff can click):
 *   1. where the buyer came from  — an enquiry on ONE listing leans buyer; a group "wanted" post is
 *                                   neutral (agents post wanted-ads to harvest); the same phone also
 *                                   SELLING in our relayed-listing history leans agent. Free.
 *   2. our own history            — sourcingSeen owner docs (every seller phone we ever relayed) and
 *                                   other buyerChecks records on the same phone / profile. Free.
 *   3. portal behaviour           — listings posted, enquiries, areas, requirements, phone verified,
 *                                   sellers contacted; the platform's snapshot. Free.
 *   4. Google                     — phone and name + city: "realty / properties / promoters" pages,
 *                                   99acres / MagicBricks agent profiles. Apify, the ORG's account.
 *   5. Facebook profile           — work / about line, linked business page, public posts. Apify.
 *
 * THE VERDICT. Sonnet 5.5 reads the evidence and returns {verdict, agentScore, confidence, torn,
 * summary, reasons, signals[]}. A TORN answer with evidence on the table (low confidence or a
 * mid-range score) is re-judged by Opus 5.5 — the deep check, billed ₹36 in place of ₹12. NO
 * evidence at all → `unclear`, free, and the buyer goes on watch: their portal behaviour becomes
 * the evidence (step 3 keeps arriving), so nobody stays unmarked for good.
 *
 * Nothing here charges, writes or schedules — see the handler for the money rules.
 */
import crypto from 'node:crypto';
import { CLAUDE_SONNET, CLAUDE_OPUS, generateStructured as claudeGenerate, usageCostUsd } from './claude.js';

export const VERDICTS = ['buyer', 'possible_agent', 'agent', 'unclear'];
export const SOURCES = ['sourced', 'enquiry', 'requirement', 'portal', 'backfill', 'manual'];
/** Why a record is on the batch, in pick order (first wins a slot). */
export const DUE_REASONS = ['override_review', 'manual', 'new', 'behaviour', 'renewal', 'watch_expiry', 'backfill'];

export const DEFAULTS = {
  maxPerBatch: 5,            // owner: 5 per batch, two batches a day (2026-10-18); per-org override
  behaviourCooldownDays: 30, // a behaviour trip re-checks at most once every 30 days
  renewalDays: 90,           // a Verified badge is re-checked every 90 days
  watchDays: 90,             // an unclear buyer quiet for 90 days is judged on behaviour alone
  overrideReviewDays: 14,    // an admin override is audited after 14 days — free
  agentScore: 0.75,          // ≥ → agent
  possibleScore: 0.45,       // ≥ → possible agent (< → buyer)
  tornConfidence: 0.6,       // Sonnet below this with evidence → Opus re-judges
};

/** Behaviour that pulls a checked buyer back onto the batch (a "trip"). Any one is enough. */
export const TRIP_RULES = [
  ['listingsPosted', 1, 'posted a listing'],
  ['sellersContacted1d', 10, 'contacted 10+ sellers in a day'],
  ['enquiries30d', 10, 'made 10+ enquiries in 30 days'],
  ['distinctAreas30d', 3, 'active across 3+ areas'],
];

const AGENT_WORDS = /\b(realty|realtors?|properties|promoters?|builders?|developers?|dealers?|consultants?|brokers?|estates?|land\s*marks?|homes|housing|99acres|magicbricks|housing\.com|squareyards|nobroker|commonfloor|sulekha|justdial|indiamart)\b/i;

export function normalizePhone(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  const last10 = d.length > 10 ? d.slice(-10) : d;
  return /^[6-9]\d{9}$/.test(last10) ? last10 : '';
}

function clean(v, max) {
  return String(v ?? '').trim().slice(0, max);
}

/**
 * The buyer's identity inside Bosun. The platform's lead id is the stable handle (a buyer in the
 * bank is a `sourced_leads` doc); a portal user without one keys on their uid; a phone-only buyer on
 * the phone. Deterministic, so the platform can address the record without storing our id.
 */
export function buyerKeyFor({ buyerId, userId, phone } = {}) {
  const id = clean(buyerId, 120).replace(/[^A-Za-z0-9_-]/g, '');
  if (id) return `lead:${id}`;
  const uid = clean(userId, 128).replace(/[^A-Za-z0-9_-]/g, '');
  if (uid) return `user:${uid}`;
  const ph = normalizePhone(phone);
  return ph ? `phone:${ph}` : '';
}

export function recordId(orgId, buyerKey) {
  return `${orgId}__${buyerKey}`.replace(/[^A-Za-z0-9_:-]/g, '_').slice(0, 400);
}

/** A fresh record from an `enqueue` payload — every field bounded, nothing trusted beyond its shape. */
export function newRecord({ orgId, buyerKey, payload = {}, nowMs = Date.now() }) {
  const src = SOURCES.includes(payload.source) ? payload.source : 'portal';
  const ref = payload.sourceRef && typeof payload.sourceRef === 'object' ? payload.sourceRef : {};
  return {
    orgId,
    buyerKey,
    buyerId: clean(payload.buyerId, 120) || null,
    userId: clean(payload.userId, 128) || null,
    phone: normalizePhone(payload.phone) || null,
    name: clean(payload.name, 80) || null,
    city: clean(payload.city, 60) || null,
    locality: clean(payload.locality, 80) || null,
    source: src,
    sourceRef: {
      url: /^https?:\/\//i.test(clean(ref.url, 500)) ? clean(ref.url, 500) : null,
      title: clean(ref.title, 200) || null,
      text: clean(ref.text, 1500) || null,
      groupName: clean(ref.groupName, 120) || null,
      refId: clean(ref.refId, 40) || null,
      listingId: clean(ref.listingId, 120) || null,
      postedAtMs: Number(ref.postedAtMs) || null,
    },
    profileUrl: /^https?:\/\/(www\.|m\.)?facebook\.com\//i.test(clean(payload.profileUrl, 300)) ? clean(payload.profileUrl, 300) : null,
    author: clean(payload.author, 120) || null,
    snapshot: cleanSnapshot(payload.snapshot),
    status: 'due',
    dueReason: src === 'backfill' ? 'backfill' : 'new',
    verdict: null,
    agentScore: null,
    confidence: null,
    summary: null,
    checkCount: 0,
    checkedAtMs: null,
    lastBehaviourCheckMs: null,
    nextDueMs: null,
    badge: false,
    agent: false,
    override: null,
    deliveryPending: false,
    activityAtMs: Number(payload.activityAtMs) || nowMs,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
  };
}

/** The platform's behaviour snapshot, bounded. Unknown keys dropped; counts clamped to sane ints. */
export function cleanSnapshot(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const n = (k) => (raw[k] == null ? null : Math.max(0, Math.min(100000, Math.floor(Number(raw[k]) || 0))));
  const arr = (k) => (Array.isArray(raw[k]) ? raw[k].map((x) => clean(x, 60)).filter(Boolean).slice(0, 20) : []);
  return {
    accountAgeDays: n('accountAgeDays'),
    phoneVerified: raw.phoneVerified === true,
    role: clean(raw.role, 30) || null,
    memberType: clean(raw.memberType, 30) || null,
    listingsPosted: n('listingsPosted'),
    listingsActive: n('listingsActive'),
    enquiries7d: n('enquiries7d'),
    enquiries30d: n('enquiries30d'),
    enquiriesTotal: n('enquiriesTotal'),
    distinctAreas30d: n('distinctAreas30d'),
    requirementsFiled: n('requirementsFiled'),
    requirementAreas: arr('requirementAreas'),
    requirementBudget: clean(raw.requirementBudget, 60) || null,
    sellersContacted1d: n('sellersContacted1d'),
    sellersContacted30d: n('sellersContacted30d'),
    searches30d: n('searches30d'),
    searchAreas30d: arr('searchAreas30d'),
    lastActiveAtMs: Number(raw.lastActiveAtMs) || null,
    converted: raw.converted === true,
    bankState: clean(raw.bankState, 30) || null,
    takenAtMs: Number(raw.takenAtMs) || Date.now(),
  };
}

/** Which TRIP_RULES a snapshot trips — [] when none. */
export function behaviourTrips(snapshot) {
  if (!snapshot) return [];
  return TRIP_RULES.filter(([k, min]) => Number(snapshot[k]) >= min).map(([, , label]) => label);
}

/** A watched buyer that stayed quiet: enough ordinary activity to call them a buyer on behaviour. */
export function quietBuyerOnBehaviour(snapshot) {
  if (!snapshot) return false;
  const activity = (snapshot.requirementsFiled || 0) + (snapshot.enquiriesTotal || 0);
  return activity >= 1 && (snapshot.listingsPosted || 0) === 0 && (snapshot.distinctAreas30d || 0) <= 2;
}

/** Score → label. The model proposes a verdict too; the score mapping is what the price and the badge follow. */
export function verdictFromScore(agentScore, cfg = {}) {
  if (agentScore == null || agentScore === '') return 'unclear';
  const s = Number(agentScore);
  if (!Number.isFinite(s)) return 'unclear';
  if (s >= (cfg.agentScore ?? DEFAULTS.agentScore)) return 'agent';
  if (s >= (cfg.possibleScore ?? DEFAULTS.possibleScore)) return 'possible_agent';
  return 'buyer';
}

export function labelFor(verdict) {
  return { buyer: 'Buyer', possible_agent: 'Possible agent', agent: 'Agent', unclear: 'Unclear' }[verdict] || 'Unclear';
}

// ── Evidence ───────────────────────────────────────────────────────────────────────────────────────

/** One evidence line. `signal` is what the SOURCE suggests before the model weighs it. */
function ev(source, { kind = 'fact', url = null, quote = '', signal = 'neutral', meta = {} } = {}) {
  return { source, kind, url: url || null, quote: clean(quote, 400), signal, meta };
}

/** Evidence from where the buyer came from — step 1, always present, so a check is never evidence-less by construction. */
export function sourceEvidence(rec) {
  const out = [];
  const r = rec.sourceRef || {};
  if (rec.source === 'enquiry') {
    out.push(ev('source', { quote: `Enquired on one listing${r.listingId ? ` (${r.listingId})` : ''}${r.title ? `: ${r.title}` : ''}`, signal: 'buyer', url: r.url }));
  } else if (rec.source === 'requirement') {
    out.push(ev('source', { quote: `Filed a requirement on the portal${r.text ? `: ${r.text}` : ''}`, signal: 'buyer', url: r.url }));
  } else if (rec.source === 'sourced' || rec.source === 'manual') {
    out.push(ev('source', { quote: `Posted in ${r.groupName || 'a Facebook group'}${r.title ? `: ${r.title}` : ''}${r.text ? ` — ${r.text}` : ''}`, signal: 'neutral', url: r.url, meta: { postedAtMs: r.postedAtMs } }));
  } else {
    out.push(ev('source', { quote: rec.source === 'backfill' ? 'Already in the buyer bank before checks began' : 'Joined on the portal', signal: 'neutral' }));
  }
  return out;
}

/** What staff learned on a call ("confirm by call" tasks) — the strongest evidence there is, so it rides into every later check. */
export function staffEvidence(rec) {
  return (Array.isArray(rec.staffOutcomes) ? rec.staffOutcomes : []).slice(-3).map((o) => ev('staff', {
    quote: `${o.byName || 'Staff'} spoke to them on ${isoDay(o.atMs)}: ${o.outcome === 'agent' ? 'an agent' : o.outcome === 'buyer' ? 'a genuine buyer' : 'no answer'}${o.note ? ` — "${o.note}"` : ''}`,
    signal: o.outcome === 'agent' ? 'agent' : o.outcome === 'buyer' ? 'buyer' : 'neutral',
  }));
}

/** Evidence from the platform's behaviour snapshot — step 3. */
export function snapshotEvidence(snapshot) {
  if (!snapshot) return [];
  const out = [];
  const s = snapshot;
  const parts = [];
  if (s.accountAgeDays != null) parts.push(`account ${s.accountAgeDays} days old`);
  parts.push(s.phoneVerified ? 'phone confirmed' : 'phone not confirmed');
  if (s.role) parts.push(`role ${s.role}`);
  if (s.memberType) parts.push(`member type ${s.memberType}`);
  out.push(ev('portal', { quote: parts.join(' · '), signal: s.phoneVerified ? 'buyer' : 'neutral' }));
  if (s.listingsPosted) out.push(ev('portal', { quote: `Posted ${s.listingsPosted} listing${s.listingsPosted === 1 ? '' : 's'} (${s.listingsActive || 0} active)`, signal: 'agent', meta: { count: s.listingsPosted } }));
  if (s.enquiriesTotal != null) {
    const many = (s.enquiries30d || 0) >= 10;
    out.push(ev('portal', { quote: `${s.enquiriesTotal} enquir${s.enquiriesTotal === 1 ? 'y' : 'ies'} in all, ${s.enquiries30d || 0} in the last 30 days, ${s.enquiries7d || 0} this week`, signal: many ? 'agent' : (s.enquiriesTotal ? 'buyer' : 'neutral') }));
  }
  if (s.distinctAreas30d != null) out.push(ev('portal', { quote: `Active in ${s.distinctAreas30d} area${s.distinctAreas30d === 1 ? '' : 's'} in 30 days${s.searchAreas30d?.length ? ` (${s.searchAreas30d.slice(0, 6).join(', ')})` : ''}`, signal: s.distinctAreas30d >= 3 ? 'agent' : (s.distinctAreas30d ? 'buyer' : 'neutral') }));
  if (s.requirementsFiled) out.push(ev('portal', { quote: `${s.requirementsFiled} requirement${s.requirementsFiled === 1 ? '' : 's'} filed${s.requirementAreas?.length ? ` for ${s.requirementAreas.slice(0, 4).join(', ')}` : ''}${s.requirementBudget ? `, budget ${s.requirementBudget}` : ''}`, signal: s.requirementsFiled >= 3 ? 'agent' : 'buyer' }));
  if (s.sellersContacted1d || s.sellersContacted30d) out.push(ev('portal', { quote: `Contacted ${s.sellersContacted1d || 0} seller${s.sellersContacted1d === 1 ? '' : 's'} today, ${s.sellersContacted30d || 0} in 30 days`, signal: (s.sellersContacted1d || 0) >= 10 || (s.sellersContacted30d || 0) >= 30 ? 'agent' : 'neutral' }));
  if (s.converted) out.push(ev('portal', { quote: 'Converted (a deal closed through the bank)', signal: 'buyer' }));
  return out;
}

/** Evidence from our own records — step 2. `history` is what the handler looked up. */
export function historyEvidence(history) {
  const out = [];
  if (!history) return out;
  const sold = history.sellerPostsRelayed || 0;
  if (sold > 0) {
    out.push(ev('history', {
      quote: `This phone appeared on ${sold} property listing${sold === 1 ? '' : 's'} we found for sale/rent (${history.sellerFirstAt ? `first ${isoDay(history.sellerFirstAt)}` : ''}${history.sellerLastAt ? `, last ${isoDay(history.sellerLastAt)}` : ''})`,
      signal: sold >= 2 ? 'agent' : 'neutral',
      url: history.sellerSampleUrl || null,
      meta: { count: sold },
    }));
  } else if (history.phoneChecked) {
    out.push(ev('history', { quote: 'Phone not seen on any listing we have found so far', signal: 'buyer' }));
  }
  if (history.otherBuyerRecords > 0) {
    out.push(ev('history', { quote: `Same phone / profile behind ${history.otherBuyerRecords} other buyer record${history.otherBuyerRecords === 1 ? '' : 's'} in the bank`, signal: history.otherBuyerRecords >= 2 ? 'agent' : 'neutral' }));
  }
  if (history.posterPosts > 1) {
    out.push(ev('history', { quote: `Poster seen ${history.posterPosts}× in the groups we read${history.posterWanted && history.posterAvailable ? ` — both "wanted" (${history.posterWanted}) and "available" (${history.posterAvailable}) posts` : ''}`, signal: history.posterAvailable ? 'agent' : 'neutral' }));
  }
  return out;
}

/** Google results → evidence lines. Only property-shaped hits are kept; agent words flag the signal. */
export function serpEvidence(results, { query } = {}) {
  const out = [];
  for (const r of (Array.isArray(results) ? results : []).slice(0, 8)) {
    const text = `${r.title || ''} ${r.snippet || ''}`;
    if (!/propert|real ?estate|realty|flat|plot|house|villa|bhk|land|apartment|rent|sale|broker|agent/i.test(text)) continue;
    const agent = AGENT_WORDS.test(text) || /\b(agent|broker|consultant)\b/i.test(text);
    out.push(ev('google', { kind: 'search', url: r.url, quote: `${clean(r.title, 120)} — ${clean(r.snippet, 240)}`, signal: agent ? 'agent' : 'neutral', meta: { query } }));
  }
  if (!out.length) out.push(ev('google', { kind: 'search', quote: `No property-related results for ${query}`, signal: 'neutral', meta: { query, empty: true } }));
  return out;
}

/** A Facebook profile scrape (any actor's shape) → evidence lines. A private/empty profile is "no evidence", never a bad sign. */
export function profileEvidence(profile, profileUrl) {
  const out = [];
  if (!profile || typeof profile !== 'object') {
    out.push(ev('facebook', { kind: 'profile', url: profileUrl, quote: 'Profile private or unreadable — no about line, no public posts', signal: 'neutral', meta: { empty: true } }));
    return out;
  }
  const pick = (...ks) => ks.map((k) => profile[k]).find((v) => v && typeof v === 'string');
  const name = pick('name', 'title', 'pageName');
  const about = [pick('intro', 'about', 'bio', 'description', 'info'), pick('work', 'job', 'occupation'), pick('category', 'categories', 'pageCategory')].filter(Boolean).join(' · ');
  const followers = Number(profile.followers ?? profile.followersCount ?? profile.likes ?? 0) || 0;
  const posts = (Array.isArray(profile.posts) ? profile.posts : []).map((p) => (typeof p === 'string' ? p : p?.text || p?.message || '')).filter(Boolean).slice(0, 6);
  const isPage = /page/i.test(String(profile.type || profile.kind || '')) || profile.isBusinessPage === true || !!pick('category', 'pageCategory');
  if (about || name) out.push(ev('facebook', { kind: 'profile', url: profileUrl, quote: `${name || 'Profile'}${about ? ` — ${about}` : ''}${followers ? ` · ${followers} followers` : ''}`, signal: AGENT_WORDS.test(about) || isPage ? 'agent' : 'neutral', meta: { isPage, followers } }));
  const availableCount = posts.filter((t) => /\b(available|for sale|for rent|sale|rent out|dm for details|call for details|site visit)\b/i.test(t)).length;
  for (const t of posts.slice(0, 3)) out.push(ev('facebook', { kind: 'post', url: profileUrl, quote: t, signal: /\b(available|for sale|for rent|site visit)\b/i.test(t) ? 'agent' : 'neutral' }));
  if (availableCount >= 2) out.push(ev('facebook', { kind: 'profile', url: profileUrl, quote: `${availableCount} of the last ${posts.length} public posts advertise properties as available`, signal: 'agent', meta: { availableCount, posts: posts.length } }));
  if (!out.length) out.push(ev('facebook', { kind: 'profile', url: profileUrl, quote: 'Public profile with nothing property-related on it', signal: 'buyer', meta: { empty: true } }));
  return out;
}

function isoDay(ms) {
  return new Date(Number(ms) + 5.5 * 3600 * 1000).toISOString().slice(0, 10);
}

/** True when the pile holds anything beyond "where they came from" and "nothing found" lines. */
export function hasSubstance(evidence) {
  return (evidence || []).some((e) => e.source !== 'source' && !e.meta?.empty);
}

/**
 * Gather the evidence for one record. `deps` are the outside calls; each is optional and each failure
 * degrades to "no evidence from that source", never to a failed check — a Google outage must not
 * leave a buyer unmarked when the behaviour already says enough.
 *
 * @param {object} p
 * @param {object} p.rec        the buyerChecks record
 * @param {object} p.cfg        org.buyerCheck
 * @param {object} p.deps       { lookupHistory, fetchSnapshot, searchGoogle, fetchProfile }
 * @param {object} [p.opts]     { skipOutside: true } for the free override review / watch expiry
 */
export async function gatherEvidence({ rec, cfg = {}, deps = {}, opts = {} }) {
  const searches = [];
  const evidence = [...sourceEvidence(rec), ...staffEvidence(rec)];
  let snapshot = rec.snapshot || null;
  let history = null;

  const tasks = [];
  if (deps.lookupHistory) tasks.push(deps.lookupHistory(rec).then((h) => { history = h; }).catch((e) => searches.push({ source: 'history', error: String(e?.message || e) })));
  if (deps.fetchSnapshot) tasks.push(deps.fetchSnapshot(rec).then((s) => { if (s) snapshot = cleanSnapshot({ ...(rec.snapshot || {}), ...s }); }).catch((e) => searches.push({ source: 'portal', error: String(e?.message || e) })));
  await Promise.all(tasks);
  evidence.push(...historyEvidence(history));
  evidence.push(...snapshotEvidence(snapshot));

  if (!opts.skipOutside) {
    const outside = [];
    if (deps.searchGoogle) {
      const queries = [];
      if (rec.phone) queries.push(`"${rec.phone}"`);
      if (rec.name && rec.name.length >= 3) queries.push(`"${rec.name}" ${rec.city || ''} (property OR "real estate" OR realty OR flat OR plot)`.replace(/\s+/g, ' ').trim());
      for (const q of queries.slice(0, 2)) {
        outside.push(deps.searchGoogle({ query: q, rec })
          .then((results) => { searches.push({ source: 'google', query: q, results: (results || []).length }); evidence.push(...serpEvidence(results, { query: q })); })
          .catch((e) => searches.push({ source: 'google', query: q, error: String(e?.message || e) })));
      }
    }
    if (deps.fetchProfile && rec.profileUrl) {
      outside.push(deps.fetchProfile(rec.profileUrl, rec)
        .then((p) => { searches.push({ source: 'facebook', url: rec.profileUrl, found: !!p }); evidence.push(...profileEvidence(p, rec.profileUrl)); })
        .catch((e) => searches.push({ source: 'facebook', url: rec.profileUrl, error: String(e?.message || e) })));
    }
    await Promise.all(outside);
  }
  return { evidence: evidence.slice(0, 40), searches, snapshot, history };
}

// ── The verdict ────────────────────────────────────────────────────────────────────────────────────

export const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'agentScore', 'confidence', 'torn', 'summary', 'reasons', 'signals'],
  properties: {
    verdict: { type: 'string', enum: VERDICTS },
    agentScore: { type: 'number', description: '0 = certainly a genuine buyer, 1 = certainly an agent/dealer' },
    confidence: { type: 'number', description: 'How sure you are of agentScore given the evidence, 0–1' },
    torn: { type: 'boolean', description: 'True when the evidence genuinely points both ways' },
    summary: { type: 'string', description: 'One plain-English sentence a staff member can read out. No jargon.' },
    reasons: { type: 'array', items: { type: 'string' }, description: '2–5 short reasons, each naming the evidence it rests on' },
    signals: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['evidenceIndex', 'supports', 'note'],
        properties: {
          evidenceIndex: { type: 'integer' },
          supports: { type: 'string', enum: ['agent', 'buyer', 'neutral'] },
          note: { type: 'string' },
        },
      },
    },
  },
};

const SYSTEM = `You verify buyers for an Indian property marketplace (Tamil Nadu). A "buyer" is a person or family looking for ONE property for themselves. An "agent" is a broker, dealer, builder's sales person, realty page or anyone trading property for others. "Possible agent" means some signals but not enough to be sure. "Unclear" means there is nothing to go on.

Rules:
- Judge ONLY from the evidence given. Never invent facts. Quote the evidence index you rely on.
- Being in a Facebook group, posting a "wanted" ad, or searching several areas is NORMAL for a real buyer. Agents show up as: a business/realty page or about line, many listings posted, selling AND buying at once, dozens of enquiries or seller contacts, the same phone behind several "buyers", agent profiles on 99acres/MagicBricks, "available / DM for details / site visit" posts.
- A private profile, no Google results or an empty search is NOT evidence of anything.
- Tamil, Tanglish and English evidence are all fine.
- A relocating family or an NRI buying for parents can look busy — weigh the whole picture, and say "torn" when it is genuinely both ways.
- agentScore is a probability that this is an agent. Calibrate: 0.1 clear buyer, 0.5 cannot tell, 0.9 clear agent.
- If the ONLY substantive evidence is "nothing found", answer unclear with low confidence.`;

export function buildPrompt({ rec, evidence, priorVerdict = null, override = null, dueReason = 'new' }) {
  const lines = evidence.map((e, i) => `[${i}] (${e.source}${e.kind !== 'fact' ? `/${e.kind}` : ''}, leans ${e.signal}) ${e.quote}${e.url ? ` <${e.url}>` : ''}`);
  const head = [
    `Buyer: ${rec.name || '(no name)'}${rec.phone ? `, phone ending ${rec.phone.slice(-4)}` : ', no phone'}${rec.city ? `, ${rec.city}` : ''}${rec.locality ? ` / ${rec.locality}` : ''}.`,
    `Came in as: ${rec.source}. This is check #${(rec.checkCount || 0) + 1}, reason: ${dueReason}.`,
  ];
  if (priorVerdict) head.push(`Earlier verdict: ${labelFor(priorVerdict.verdict)} (score ${priorVerdict.agentScore}) on ${isoDay(priorVerdict.atMs)}.`);
  if (override) head.push(`An admin (${override.byName || override.by}) OVERRODE to "${labelFor(override.verdict)}" on ${isoDay(override.atMs)}, reason: "${override.reason}". Judge afresh on the evidence; say whether the evidence since then supports or contradicts them.`);
  return `${head.join('\n')}\n\nEvidence:\n${lines.join('\n')}\n\nReturn the JSON.`;
}

/**
 * Judge one pile of evidence. Sonnet first; if the answer is torn with evidence on the table, Opus
 * re-judges the same pile (`deep: true`). Returns the final verdict with the usage of every call so
 * the handler can book COGS and pick the line to settle.
 */
export async function judge({ rec, evidence, cfg = {}, priorVerdict = null, override = null, dueReason = 'new', generate = claudeGenerate, allowDeep = true }) {
  const calls = [];
  const prompt = buildPrompt({ rec, evidence, priorVerdict, override, dueReason });
  const substance = hasSubstance(evidence);
  if (!substance) {
    // Nothing beyond the origin line and empty searches: no model call, no charge. On watch.
    return { verdict: 'unclear', agentScore: null, confidence: 0, torn: false, summary: 'Nothing found yet — on watch; their activity on the portal will decide.', reasons: ['No outside evidence and no behaviour to judge from.'], signals: [], deep: false, model: null, calls, cogsUsd: 0 };
  }
  const first = await generate({ model: CLAUDE_SONNET, system: SYSTEM, prompt, schema: VERDICT_SCHEMA, effort: 'medium' });
  if (!first?.data) {
    return { verdict: 'unclear', agentScore: null, confidence: 0, torn: false, summary: 'The check could not be completed — will retry on the next batch.', reasons: [], signals: [], deep: false, model: null, calls, cogsUsd: 0, failed: true };
  }
  calls.push({ model: first.model, usage: first.usage, cogsUsd: usageCostUsd(first.model, first.usage) });
  let data = sanitizeVerdict(first.data);
  let deep = false;
  let model = first.model;
  // Deep only when the SCORE is genuinely in the middle (or the model says so). A low-confidence
  // answer with a clear-cut score is not torn — the first live check (2026-10-18) sent an ordinary
  // 15%-agent buyer to Opus on confidence alone and billed ₹36 for a ₹12 answer.
  const mid = data.agentScore >= 0.3 && data.agentScore <= 0.7;
  const torn = data.torn || (mid && data.confidence < (cfg.tornConfidence ?? DEFAULTS.tornConfidence))
    || (data.agentScore > 0.4 && data.agentScore < 0.6);
  if (allowDeep && torn && data.verdict !== 'unclear') {
    const second = await generate({ model: CLAUDE_OPUS, system: SYSTEM, prompt: `${prompt}\n\nA first reading found this torn. Take the time to weigh it properly.`, schema: VERDICT_SCHEMA, effort: 'high', maxOutputTokens: 8000 });
    if (second?.data) {
      calls.push({ model: second.model, usage: second.usage, cogsUsd: usageCostUsd(second.model, second.usage) });
      data = sanitizeVerdict(second.data);
      deep = true;
      model = second.model;
    }
  }
  // The score, not the model's label, decides the verdict — one calibrated mapping for pricing + badge.
  const verdict = data.verdict === 'unclear' ? 'unclear' : verdictFromScore(data.agentScore, cfg);
  return { ...data, verdict, deep, model, calls, cogsUsd: calls.reduce((s, c) => s + c.cogsUsd, 0) };
}

function sanitizeVerdict(d) {
  const num = (v, lo, hi) => Math.max(lo, Math.min(hi, Number(v) || 0));
  return {
    verdict: VERDICTS.includes(d.verdict) ? d.verdict : 'unclear',
    agentScore: num(d.agentScore, 0, 1),
    confidence: num(d.confidence, 0, 1),
    torn: d.torn === true,
    summary: clean(d.summary, 300),
    reasons: (Array.isArray(d.reasons) ? d.reasons : []).map((r) => clean(r, 200)).filter(Boolean).slice(0, 6),
    signals: (Array.isArray(d.signals) ? d.signals : []).map((s) => ({ evidenceIndex: Math.max(0, Math.floor(Number(s?.evidenceIndex) || 0)), supports: ['agent', 'buyer', 'neutral'].includes(s?.supports) ? s.supports : 'neutral', note: clean(s?.note, 160) })).slice(0, 12),
  };
}

/** The questions staff ask on a "confirm by call" task — tailored to what the evidence suggested. */
export function callQuestions(result, evidence) {
  const q = ['Which property are you looking for, and is it for your own use?', 'Which area and budget, and how soon do you need it?'];
  const says = (re) => (evidence || []).some((e) => re.test(e.quote));
  if (says(/listing|available|for sale|for rent/i)) q.push('We see a property listed under this number — is that yours, or are you helping someone?');
  if (says(/realty|properties|promoters|agent|broker|consultant|page/i)) q.push('Do you work in property — a realty, a builder, or as a consultant?');
  if (says(/areas|enquir/i)) q.push('You have asked about several areas — are you comparing for one purchase, or for clients?');
  return q.slice(0, 5);
}

// ── Timeline events ────────────────────────────────────────────────────────────────────────────────

/** One timeline line. `text` is what staff read; evidence rides alongside, never inside it. */
export function event(type, { atMs = Date.now(), text, evidence = [], chargeInr = null, service = null, by = null, byName = null, checkNo = null, verdict = null, agentScore = null, extra = {} } = {}) {
  return {
    id: crypto.randomUUID(),
    atMs, type, text: clean(text, 400),
    evidence: (evidence || []).slice(0, 40),
    chargeInr, service, by, byName, checkNo, verdict, agentScore,
    ...extra,
  };
}

/** Verdict → the one-line text for the timeline and the WhatsApp/Telegram digests. */
export function verdictText(result) {
  const score = result.agentScore != null ? ` (${Math.round(result.agentScore * 100)}% agent)` : '';
  return `${labelFor(result.verdict)}${score} · ${result.summary || ''}`.trim();
}

/** Which metered line a finished check settles, or null when it is free. */
export function serviceFor(result, { dueReason } = {}) {
  if (!result || result.failed) return null;
  if (dueReason === 'override_review') return null; // audits the admin, not the buyer
  if (result.verdict === 'unclear') return null;
  return result.deep ? 'buyer_check_deep' : 'buyer_check';
}
