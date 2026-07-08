import { onSchedule } from 'firebase-functions/v2/scheduler';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { callSerpActor, listingKey, signPayload, enrichPost, isIndividualPost } from '../utils/sourcing.js';
import { priceForSourcedBatch } from '../utils/billing.js';
import { APIFY_TOKEN } from '../utils/secrets.js';

// Scheduled sourced-listing relay (see utils/sourcing.js). Once a day, for every org with
// sourcing.enabled: fetch listings via Apify across the org's query matrix, dedup them FOREVER
// against sourcingSeen/{orgId}/keys, HMAC-sign + POST each NEW one to the org's webhook, and debit
// the org wallet a small per-listing fee for the ones that were accepted (2xx). This is a separate,
// near-zero-COGS metered lane — it never touches the managed-agent pipeline or finalize.js.

const RELAY_CONCURRENCY = 5;
const RELAY_TIMEOUT_MS = 15000;
const GETALL_CHUNK = 300; // Firestore getAll batch size for the dedup lookup

export const runSourcingJobs = onSchedule(
  {
    region: 'asia-south1',
    schedule: 'every day 07:00',
    timeZone: 'Asia/Kolkata',
    secrets: [APIFY_TOKEN],
    timeoutSeconds: 540,
    memory: '512MiB',
  },
  async () => {
    const db = getFirestore();
    const apifyToken = process.env.APIFY_TOKEN;
    const snap = await db.collection('organisations').where('sourcing.enabled', '==', true).get();
    for (const orgDoc of snap.docs) {
      try {
        await runForOrg(db, apifyToken, orgDoc.id, orgDoc.data().sourcing || {});
      } catch (e) {
        // Best-effort per org — one org's Apify/webhook failure must not block the others.
        console.error('runSourcingJobs:org', orgDoc.id, e?.message || e);
      }
    }
  },
);

// Exported for the emulator/E2E test harness (lets tests inject a stubbed serp fetcher + rng).
// `queries`/`freshness` overrides let a caller source a SPECIFIC set of queries (e.g. the top target
// pulled from the platform matrix) instead of the org's static cfg.queries — see adminSourceTopTarget.
export async function runForOrg(
  db,
  apifyToken,
  orgId,
  cfg,
  { fetchSerp = callSerpActor, rng, queries: queriesOverride, freshness: freshnessOverride } = {},
) {
  const secretSnap = await db.collection('orgSecrets').doc(orgId).get();
  const secret = secretSnap.exists ? secretSnap.data()?.sourcing?.secret : null;
  if (!secret) {
    console.error('runSourcingJobs:no-secret', orgId);
    return { relayed: 0, amountInr: 0 };
  }
  const { actorId, webhookUrl } = cfg;
  const queries = queriesOverride && queriesOverride.length ? queriesOverride : (cfg.queries || []);
  const freshness = freshnessOverride ?? cfg.freshness;
  if (!actorId || !webhookUrl || !queries.length) return { relayed: 0, amountInr: 0 };

  // 1) Fetch every query, flatten the results.
  const all = [];
  for (const query of queries) {
    const items = await fetchSerp({ apifyToken, actorId, query, freshness });
    all.push(...items);
  }

  // 2) Keep only individual posts (real listings that enrich); drop group/page landing pages. Then
  // dedup WITHIN this run by canonical listing key.
  const posts = all.filter((it) => it?.url && isIndividualPost(it.url));
  console.log('runSourcingJobs:filter', orgId, JSON.stringify({ fetched: all.length, posts: posts.length }));
  const local = new Map();
  for (const it of posts) {
    const key = listingKey(it.url);
    if (!local.has(key)) local.set(key, it);
  }
  if (!local.size) {
    console.log('runSourcingJobs:no-results', orgId);
    return { relayed: 0, amountInr: 0 };
  }

  // 3) Drop keys we've EVER relayed for this org (dedup forever).
  const seenCol = db.collection('sourcingSeen').doc(orgId).collection('keys');
  const keys = [...local.keys()];
  const already = new Set();
  for (let i = 0; i < keys.length; i += GETALL_CHUNK) {
    const refs = keys.slice(i, i + GETALL_CHUNK).map((k) => seenCol.doc(k));
    const snaps = await db.getAll(...refs);
    for (const s of snaps) if (s.exists) already.add(s.id);
  }
  const allNew = keys.filter((k) => !already.has(k)).map((k) => ({ key: k, listing: local.get(k) }));
  if (!allNew.length) {
    console.log('runSourcingJobs:all-seen', orgId);
    return { relayed: 0, amountInr: 0 };
  }

  // Per-run cap: process at most `maxPerRun` NEW listings (0 / unset = no cap). Applied BEFORE
  // enrichment, so a run's Apify enrichment cost + wallet debit are bounded. The overflow isn't
  // marked seen, so the next run picks it up — spreads cost across runs and keeps tests cheap.
  const cap = Math.max(0, Math.floor(Number(cfg.maxPerRun) || 0));
  const candidates = cap > 0 ? allNew.slice(0, cap) : allNew;

  // 3b) Enrich each new listing with the FULL Facebook post (the SERP snippet is truncated). Adds
  // the complete description + the owner phone; priced into the sourcing baseline. Best-effort and
  // bounded — a miss just leaves the SERP snippet in place.
  await mapLimit(candidates, RELAY_CONCURRENCY, async (c) => {
    const enriched = await enrichPost({ apifyToken, url: c.listing.url });
    if (enriched?.text && enriched.text.length > String(c.listing.snippet || '').length) {
      c.listing.snippet = enriched.text;
    }
    if (enriched?.phone) c.listing.phone = enriched.phone;
  });

  // 4) Relay each new listing; mark it seen ONLY on a 2xx (charge-on-delivery).
  let relayed = 0;
  await mapLimit(candidates, RELAY_CONCURRENCY, async ({ key, listing }) => {
    const ok = await relayOne({ webhookUrl, secret, orgId, listing });
    if (ok) {
      await seenCol.doc(key).set({
        url: listing.url,
        title: listing.title || '',
        relayedAt: FieldValue.serverTimestamp(),
      });
      relayed += 1;
    }
  });
  if (!relayed) {
    console.log('runSourcingJobs:relayed-0', orgId);
    return { relayed: 0, amountInr: 0 };
  }

  // 5) One transactional debit for the whole batch (org may go negative — operator reconciles).
  const { amountInr, unitPrices } = priceForSourcedBatch(relayed, rng ? { rng } : {});
  if (amountInr > 0) {
    await db.runTransaction(async (tx) => {
      const orgRef = db.collection('organisations').doc(orgId);
      const orgSnap = await tx.get(orgRef);
      if (!orgSnap.exists) return;
      const balance = Number(orgSnap.data().balance ?? 0);
      tx.update(orgRef, { balance: balance - amountInr });
      tx.set(db.collection('transactions').doc(), {
        orgId,
        type: 'debit',
        kind: 'sourcing',
        amount: amountInr,
        count: relayed,
        unitPrices,
        createdAt: FieldValue.serverTimestamp(),
      });
    });
  }
  console.log('runSourcingJobs:done', orgId, JSON.stringify({ relayed, amountInr }));
  return { relayed, amountInr };
}

// HMAC-sign and POST one listing to the org's webhook. Returns true on a 2xx, false on anything
// else (so the caller does NOT mark it seen and does NOT charge — Bosun retries it next run).
async function relayOne({ webhookUrl, secret, orgId, listing }) {
  const body = JSON.stringify({ orgId, listing, source: { via: 'bosun', url: listing.url } });
  const { signature, timestamp } = signPayload(secret, body);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), RELAY_TIMEOUT_MS);
  try {
    const resp = await fetch(webhookUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-bosun-signature': signature,
        'x-bosun-timestamp': timestamp,
      },
      body,
      signal: ctrl.signal,
    });
    return resp.ok;
  } catch (e) {
    console.error('relayOne:err', orgId, e?.message || e);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

// Minimal bounded-concurrency map (no dep). Runs `fn` over `items`, at most `limit` in flight.
async function mapLimit(items, limit, fn) {
  const queue = [...items];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      await fn(item);
    }
  });
  await Promise.all(workers);
}
