/**
 * On-demand BUYER probe for one place — the "find buyers for Mettupalayam, now" the platform asks
 * for when a seller in a town we don't otherwise watch asks "any leads?".
 *
 * The scheduled buyer lane only reads the Facebook groups configured on the org (metro groups for
 * ten cities, twice a day). A small town has no group in that list, so demand there is invisible
 * until someone posts in a metro group. This probe fills that gap ONCE, on request, for one place:
 *
 *   1. Find a group.  A group we already know for the place (`organisations/{org}/sourcingGroups/
 *      {placeSlug}`, or a configured buyerGroups entry tagged with that town) is reused. Otherwise
 *      ONE Google SERP (`site:facebook.com/groups "<place>" property …`) is paid for, the groups
 *      that Google's results belong to are counted, and the top few are cached under the place —
 *      so the second seller in that town never pays discovery again. A place with no public group
 *      is cached too (`noGroup`), and re-discovered only after DISCOVERY_TTL_MS.
 *   2. Read it once.  `fetchGroupFeed` pulls the newest N posts (billed per post) and the ordinary
 *      pipeline runs in buyer mode: seeking posts only, age gate, dedup, relay-on-2xx billing —
 *      exactly the group lane, with the place as the classify target — except that the OWNER posts
 *      in the feed are kept too (`harvestSupply`): a town we probe on request is one the supply lane
 *      has no target for, so that by-catch is inventory nobody else will fetch. The group is NOT
 *      added to the twice-a-day rotation; the visit is the whole cost.
 *   3. No group at all → fall back to the demand SERP queries (`buildSourcingQueries` buyer mode),
 *      the retired lane's path: staler, but better than telling the seller nothing was tried.
 *
 * Every probe stamps `probes` / `lastProbeAt` / `lastRelayed` on the place doc, so the platform can
 * later say "we checked Mettupalayam groups on 10 Sep, nothing yet" instead of a bare no.
 */
import { FieldValue } from 'firebase-admin/firestore';
import { callSerpActor, fetchGroupFeed } from './sourcing.js';
import { buildSourcingQueries } from './queryGen.js';

/** Posts read per group per probe — ~3–7 days of a small-town feed. The lane's whole cost knob. */
export const PROBE_POSTS_DEFAULT = 30;
export const PROBE_POSTS_MIN = 10;
export const PROBE_POSTS_MAX = 60;
/** DISCOVERED groups read per probe. Two covers "the town group" + "the district group"; more is just cost. */
export const PROBE_MAX_GROUPS = 2;
/**
 * CONFIGURED groups read per probe — a whole-city ask ("all of Erode", town left blank) should read
 * every group the operator curated for that city, not two of six. Bounded so a runaway config can't
 * turn one click into a scrape bill.
 */
export const PROBE_MAX_CONFIGURED_GROUPS = 10;
/** A place with no public group is re-discovered only after this long. */
export const DISCOVERY_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const SOURCING_GROUPS = 'sourcingGroups';

const GROUP_URL_RE = /^https?:\/\/(?:www\.|m\.|web\.)?facebook\.com\/groups\/([^/?#]+)/i;

/** Deterministic id for a place: `coimbatore__mettupalayam`, `mettupalayam` when the city is blank. */
export function placeSlug(locality, city) {
  const slug = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const l = slug(locality);
  const c = slug(city);
  return c && c !== l ? `${c}__${l}` : l || c;
}

/** The canonical `https://www.facebook.com/groups/<id>/` form of any group-ish URL, or null. */
export function canonicalGroupUrl(url) {
  const m = String(url || '').match(GROUP_URL_RE);
  if (!m) return null;
  const id = m[1];
  // Not a group: the groups directory, search, feed and other reserved paths.
  if (/^(search|feed|discover|joins|create|your_groups)$/i.test(id)) return null;
  return `https://www.facebook.com/groups/${id}/`;
}

/**
 * Rank the groups behind a SERP result list. Every result under /groups/<id>/posts/… counts one hit
 * for that group, so a group with many indexed posts about the place outranks one lone mention.
 * Titles are kept (the first one seen) purely for the operator's eyes in the run panel.
 */
export function rankGroups(items, max = PROBE_MAX_GROUPS) {
  const hits = new Map();
  for (const it of Array.isArray(items) ? items : []) {
    const url = canonicalGroupUrl(it?.url);
    if (!url) continue;
    const cur = hits.get(url) || { url, hits: 0, title: '' };
    cur.hits += 1;
    if (!cur.title && it?.title) cur.title = String(it.title).replace(/\s*\|\s*Facebook\s*$/i, '').slice(0, 120);
    hits.set(url, cur);
  }
  return [...hits.values()].sort((a, b) => b.hits - a.hits).slice(0, max);
}

/** The one discovery query. Tamil nouns ride along so a Tamil-named group is not missed. */
export function discoveryQuery(locality, city) {
  const place = city && city.toLowerCase() !== locality.toLowerCase() ? `"${locality}" ${city}` : `"${locality}"`;
  return `site:facebook.com/groups ${place} (property OR "real estate" OR plot OR house OR rent OR வீடு OR நிலம்)`;
}

/** Configured buyerGroups whose `city` tag IS this place (a town the operator already added). */
function configuredGroupsFor(cfg, locality, city) {
  const names = new Set([locality, city].filter(Boolean).map((s) => s.toLowerCase()));
  // The metro groups are tagged with the metro; a locality inside it must NOT inherit them — that
  // would re-read six Coimbatore feeds for every Coimbatore suburb, which the cron already covers.
  if (city && locality && city.toLowerCase() !== locality.toLowerCase()) names.delete(city.toLowerCase());
  return (Array.isArray(cfg.buyerGroups) ? cfg.buyerGroups : [])
    .map((g) => (typeof g === 'string' ? { url: g, city: '' } : g))
    .filter((g) => g?.url && names.has(String(g.city || '').toLowerCase()))
    .map((g) => ({ url: canonicalGroupUrl(g.url) || g.url, title: '', hits: 0, source: 'configured' }));
}

/**
 * Resolve the groups to read for a place: configured → cached → discovered (one SERP). Returns
 * `{ groups, source, discovered }` where `source` is 'configured' | 'cached' | 'discovered' | 'none'.
 */
export async function resolveGroups(db, { apifyToken, orgId, cfg, locality, city, force = false }) {
  const configured = configuredGroupsFor(cfg, locality, city);
  if (configured.length) return { groups: configured.slice(0, PROBE_MAX_CONFIGURED_GROUPS), source: 'configured', discovered: false };

  const ref = db.collection('organisations').doc(orgId).collection(SOURCING_GROUPS).doc(placeSlug(locality, city));
  const snap = await ref.get();
  const cached = snap.exists ? snap.data() : null;
  const fresh = cached && Date.now() - (Number(cached.discoveredAtMs) || 0) < DISCOVERY_TTL_MS;
  if (!force && cached && fresh) {
    const groups = Array.isArray(cached.groups) ? cached.groups.slice(0, PROBE_MAX_GROUPS) : [];
    return { groups, source: groups.length ? 'cached' : 'none', discovered: false, ref };
  }

  const items = await callSerpActor({
    apifyToken,
    actorId: cfg.actorId,
    query: discoveryQuery(locality, city),
    maxPages: 1,
  });
  const groups = rankGroups(items).map((g) => ({ ...g, source: 'discovered' }));
  await ref.set({
    orgId,
    locality,
    city,
    groups,
    noGroup: groups.length === 0,
    serpResults: Array.isArray(items) ? items.length : 0,
    discoveredAtMs: Date.now(),
    discoveredAt: FieldValue.serverTimestamp(),
    // Probe counters live on the same doc; keep them across a re-discovery.
    probes: Number(cached?.probes) || 0,
    ...(cached?.lastProbeAtMs ? { lastProbeAtMs: cached.lastProbeAtMs, lastRelayed: cached.lastRelayed ?? null } : {}),
  }, { merge: true });
  return { groups, source: groups.length ? 'discovered' : 'none', discovered: true, ref };
}

/** Stamp the probe outcome on the place doc (creating it for a configured-group place). */
export async function recordProbe(db, { orgId, locality, city, relayed, examined, source, runId }) {
  const ref = db.collection('organisations').doc(orgId).collection(SOURCING_GROUPS).doc(placeSlug(locality, city));
  await ref.set({
    orgId,
    locality,
    city,
    probes: FieldValue.increment(1),
    lastProbeAtMs: Date.now(),
    lastProbeAt: FieldValue.serverTimestamp(),
    lastRelayed: Number(relayed) || 0,
    lastExamined: Number(examined) || 0,
    lastSource: source,
    lastRunId: runId || null,
  }, { merge: true });
}

/**
 * The probe itself. `runForOrg` is injected (it lives in the handlers module, which imports this
 * file's siblings — passing it avoids a handlers↔utils import cycle).
 */
export async function probeBuyersForPlace(db, {
  apifyToken, orgId, cfg, run, runForOrg,
  locality, city, propertyType, listingType, posts, force,
}) {
  const shapeLabel = [propertyType, listingType].filter(Boolean).join(' · ') || undefined;
  const target = { locality: locality || city, city: locality ? city : '', shape: shapeLabel };
  const limit = Math.max(PROBE_POSTS_MIN, Math.min(PROBE_POSTS_MAX, Math.floor(Number(posts) || PROBE_POSTS_DEFAULT)));

  const resolved = await resolveGroups(db, { apifyToken, orgId, cfg, locality: target.locality, city: target.city, force });
  const groups = resolved.groups || [];
  run.note(`groups for ${target.locality}: ${resolved.source}${groups.length ? ' — ' + groups.map((g) => g.url).join(' ') : ''}`);

  let result;
  let source;
  if (groups.length) {
    source = 'groups';
    const urls = groups.map((g) => g.url);
    const leg = run.leg({ target, queries: urls, mode: 'buyer', meta: { groupSource: resolved.source, postsPerGroup: limit } });
    result = await runForOrg(db, apifyToken, orgId, cfg, {
      queries: urls,
      fetchSerp: ({ query }) => fetchGroupFeed({ apifyToken, groupUrl: query, limit }),
      target,
      leg,
      mode: 'buyer',
      // A town we probe on request is one the supply lane has no target for, so the owner posts in
      // its group are inventory nobody else will fetch — keep them (one shot, so no flood risk).
      harvestSupply: true,
    });
  } else {
    // No public group for the place: the demand SERP is the only remaining source. Staler
    // (Google's index of group feeds lags by months) but it is what the retired buyer lane ran.
    source = 'serp';
    const smart = await buildSourcingQueries({ locality: target.locality, city: target.city, shape: [propertyType, listingType].filter(Boolean).join(' ') || undefined, mode: 'buyer' });
    const queries = smart.queries || [];
    const leg = run.leg({ target, queries, mode: 'buyer', meta: { ...smart, groupSource: 'none' } });
    if (!queries.length) {
      leg.done({ note: 'no group found and query generation produced nothing' });
      result = { relayed: 0, amountInr: 0 };
    } else {
      result = await runForOrg(db, apifyToken, orgId, cfg, { queries, target, leg, mode: 'buyer', harvestSupply: true });
    }
  }

  await recordProbe(db, {
    orgId, locality: target.locality, city: target.city,
    relayed: result.relayed || 0, examined: result.examined, source, runId: run.id,
  });
  return {
    ...result,
    buyers: Number(result.buyerRelayed) || 0,
    owners: Math.max(0, (Number(result.relayed) || 0) - (Number(result.buyerRelayed) || 0)),
    source,
    groupSource: resolved.source,
    discovered: !!resolved.discovered,
    groups: groups.map((g) => ({ url: g.url, title: g.title || '', hits: g.hits || 0 })),
    postsPerGroup: groups.length ? limit : 0,
  };
}
