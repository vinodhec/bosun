/**
 * Manual group posts — the GROUP lane without the scraper.
 *
 * WHY. The group lane (runSourcingJobs.js#sourceBuyerGroups) reads 52 Facebook group feeds twice a
 * day through Apify's groups actor: ~2,000 posts/day at $2.60/1,000, ~$4–5/day on the org's Apify
 * bill, to find ~10 buyers + ~45 owner posts. The org's own admins already sit in those groups, so
 * from 2026-09-25 they read the feeds themselves and paste the posts worth having. Bosun does the
 * rest exactly as it would for a scraped post: dedup-forever, the Gemini classify (buyer vs owner,
 * on-target, extraction), owner/buyer repost dedup, the signed relay into the platform queue, and
 * the SAME per-lead charge on a 2xx (priceForSourcedBatch — buyer ₹12.40, owner band). Nothing here
 * touches Apify: a pasted post arrives FULL, so it rides the pipeline's pre-enriched path
 * (origin:'manual', see runForOrg 3c1) and the paid per-post scrape never runs.
 *
 * WHAT THE ADMIN GETS BACK. A per-post outcome, because a human pasted each one and deserves to know
 * what became of it — queued (buyer/owner), already have it, rejected (and why), too old. The
 * outcomes come from the same leg.lead() rows the run panel shows; the two cheap checks runForOrg
 * does NOT write a row for (a link that is not a single post, a post already seen) are settled here
 * first, so every pasted item gets an answer.
 */
import { listingKey, isIndividualPost, extractPhone } from './sourcing.js';

/** Most posts one call takes. A paste session is a handful; this only bounds a runaway client. */
export const MAX_MANUAL_POSTS = 50;
const MAX_TEXT = 2000; // same clip as a scraped post (parseEnrichedItem)

function parsePostedAt(v) {
  if (v == null || v === '') return null;
  const n = typeof v === 'number' ? v : Date.parse(String(v));
  return Number.isFinite(n) && n > 0 && n <= Date.now() + 86400000 ? n : null;
}

/**
 * Shape pasted items into the pipeline's listing shape (the one fetchGroupFeed emits), and settle
 * the ones that cannot enter it. Returns { listings: [{key, listing, city}], outcomes: Map<index, outcome> }.
 */
export function normalizeManualPosts(items) {
  const outcomes = new Map();
  const listings = [];
  const keysInBatch = new Set();
  (Array.isArray(items) ? items : []).slice(0, MAX_MANUAL_POSTS).forEach((raw, i) => {
    const url = String(raw?.url || '').trim();
    const text = String(raw?.text || '').trim().slice(0, MAX_TEXT);
    if (!url || !isIndividualPost(url) || !/^https?:\/\//i.test(url)) {
      outcomes.set(i, { status: 'bad-link', reason: 'Paste the link of the post itself, not the group' });
      return;
    }
    if (text.length < 15) {
      outcomes.set(i, { status: 'no-text', reason: 'Paste the post text too' });
      return;
    }
    const key = listingKey(url);
    if (keysInBatch.has(key)) {
      outcomes.set(i, { status: 'duplicate', reason: 'Pasted twice in this batch' });
      return;
    }
    keysInBatch.add(key);
    const postedAt = parsePostedAt(raw?.postedAt);
    const groupUrl = String(raw?.groupUrl || '').trim().slice(0, 300);
    listings.push({
      index: i,
      key,
      city: String(raw?.city || '').trim().slice(0, 60) || 'Tamil Nadu',
      listing: {
        url,
        title: text.split('\n').find((l) => l.trim())?.slice(0, 120) || '',
        snippet: text,
        serpAgeMs: postedAt,
        postedAt,
        phone: extractPhone(String(raw?.phone || '')) || extractPhone(text),
        author: String(raw?.author || '').trim().slice(0, 120),
        origin: 'manual',
        sourceQuery: groupUrl ? `manual:${groupUrl}` : 'manual',
      },
    });
  });
  return { listings, outcomes };
}

/** What a leg.lead() row means to the admin who pasted the post. */
export function outcomeFromLead({ stage, dropStage, dropReason, listing }) {
  if (stage === 'relayed') {
    return { status: 'queued', leadType: listing?.leadType === 'buyer' ? 'buyer' : 'owner' };
  }
  if (stage === 'deferred') return { status: 'deferred', reason: 'Over this run\'s limit — paste it again later' };
  if (dropStage === 'owner-dedup') return { status: 'duplicate', reason: 'Same person already queued for this' };
  if (dropStage === 'recency' || dropStage === 'serp-date') return { status: 'too-old', reason: 'Older than the lead window' };
  if (dropStage === 'relay') return { status: 'failed', reason: 'The queue did not accept it — paste it again later' };
  const why = String(dropReason || '');
  if (why === 'no-signal') return { status: 'rejected', reason: 'Not about a property' };
  if (why === 'degraded-no-india-signal') return { status: 'failed', reason: 'Checker unavailable — paste it again later' };
  return { status: 'rejected', reason: why || 'Not a genuine listing or request for this city' };
}

/**
 * Run pasted posts through the ordinary pipeline. `runForOrg` is injected (it lives in
 * runSourcingJobs.js, which imports this module's siblings — keeping the import one-way).
 */
export async function sourceManualPosts(db, { orgId, cfg, items, run, runForOrg }) {
  const total = Math.min(Array.isArray(items) ? items.length : 0, MAX_MANUAL_POSTS);
  const { listings, outcomes } = normalizeManualPosts(items);

  // Dedup-forever, settled HERE so the admin hears "already have it" — runForOrg drops seen keys
  // silently (no lead row), which would read as "nothing happened" on a post a human chose.
  if (listings.length) {
    const seenCol = db.collection('sourcingSeen').doc(orgId).collection('keys');
    const snaps = await db.getAll(...listings.map((l) => seenCol.doc(l.key)));
    const seen = new Map(snaps.filter((s) => s.exists).map((s) => [s.id, s.data() || {}]));
    for (let j = listings.length - 1; j >= 0; j -= 1) {
      const rec = seen.get(listings[j].key);
      if (!rec) continue;
      outcomes.set(listings[j].index, rec.dropped
        ? { status: 'rejected', reason: 'Checked before and rejected' }
        : { status: 'duplicate', reason: 'Already in the queue' });
      listings.splice(j, 1);
    }
  }

  // One leg per CITY — the city is the classify target, as in the group lane.
  const byCity = new Map();
  for (const l of listings) {
    if (!byCity.has(l.city)) byCity.set(l.city, []);
    byCity.get(l.city).push(l);
  }
  const indexByKey = new Map(listings.map((l) => [l.key, l.index]));
  let relayed = 0;
  let amountInr = 0;
  for (const [city, group] of byCity) {
    const target = { locality: city, city: '' };
    const query = `manual:${city}`;
    const inner = run.leg({ target, queries: [query], mode: 'buyer' });
    // Tap the leg: every row it records is also this post's answer.
    const leg = {
      ...inner,
      lead(row) {
        const idx = indexByKey.get(row?.key);
        if (idx != null) outcomes.set(idx, outcomeFromLead(row));
        inner.lead(row);
      },
    };
    const r = await runForOrg(db, null, orgId, cfg, {
      queries: [query],
      fetchSerp: async () => group.map((l) => ({ ...l.listing })),
      target,
      leg,
      mode: 'buyer',
      // A human chose each post, so an owner post is kept like a buyer — and the platform's pending
      // cap does not apply, for the same reason sourceOnDemand ignores it.
      harvestSupply: true,
    });
    relayed += r.relayed || 0;
    amountInr += r.amountInr || 0;
  }

  const results = [];
  for (let i = 0; i < total; i += 1) {
    results.push({ index: i, ...(outcomes.get(i) || { status: 'failed', reason: 'Not processed — paste it again' }) });
  }
  const buyers = results.filter((r) => r.status === 'queued' && r.leadType === 'buyer').length;
  return { relayed, buyers, owners: relayed - buyers, amountInr, results };
}
