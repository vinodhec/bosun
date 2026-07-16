import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { generateSourcingSecret, freshnessForMonths, DEFAULT_FRESHNESS_MONTHS } from '../utils/sourcing.js';
import { runForOrg, sourceTopTargets } from './runSourcingJobs.js';
import { startRun } from '../utils/sourcingRun.js';
import { APIFY_TOKEN } from '../utils/secrets.js';
// Gemini auth is Vertex/ADC (the runtime service account) — no bound secret needed (see utils/gemini.js).

// Operator-only flow to configure an org's sourced-listing relay (see utils/sourcing.js +
// handlers/runSourcingJobs.js). Mirrors adminFigma.js: the shared HMAC secret is stored backend-only
// in orgSecrets/{orgId}.sourcing (the vault — never readable by the browser); the non-secret config
// (which Apify actor, the query matrix, freshness, the webhook) is mirrored onto the org doc so the
// Admin panel can show it. Bosun stays generic — the property/Facebook specifics live entirely in
// the `queries` the operator loads here on the customer's behalf.

function requireAdmin(request) {
  const email = request.auth?.token?.email;
  const allow = (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (!email || !allow.includes(email.toLowerCase())) {
    throw new HttpsError('permission-denied', 'Admin only.');
  }
  return email;
}

// Configure (or update) an org's sourcing relay. Mints an HMAC secret the first time and returns it
// ONCE so the operator can paste it into the customer's env; re-configuring keeps the same secret
// and does not echo it again.
export const adminConfigureSourcing = onCall({ region: 'asia-south1' }, async (request) => {
  requireAdmin(request);
  const orgId = String(request.data?.orgId ?? '').trim();
  const actorId = String(request.data?.actorId ?? '').trim();
  const webhookUrl = String(request.data?.webhookUrl ?? '').trim();
  // Recency window: only fetch listings posted within the last N months (default 3). Operators pass
  // the friendly `freshnessMonths` number; a raw `freshness` (Google `tbs`) string still wins if
  // given, for power-user windows like 'qdr:w' the month knob can't express.
  const rawFreshness = String(request.data?.freshness ?? '').trim();
  const freshnessMonths = request.data?.freshnessMonths == null
    ? DEFAULT_FRESHNESS_MONTHS
    : Math.max(1, Math.min(60, Math.floor(Number(request.data.freshnessMonths) || DEFAULT_FRESHNESS_MONTHS)));
  const freshness = rawFreshness || freshnessForMonths(freshnessMonths);
  const enabled = request.data?.enabled !== false; // default true
  const queries = Array.isArray(request.data?.queries)
    ? request.data.queries.map((q) => String(q || '').trim()).filter(Boolean)
    : [];
  // Optional per-run cap on how many NEW listings to relay/charge (0 = no cap). Bounds cost per run.
  const maxPerRun = Math.max(0, Math.floor(Number(request.data?.maxPerRun) || 0));
  // Optional: the platform's demand-ranked matrix endpoint. When set, the org can source the top
  // target(s) on demand (adminSourceTopTarget) instead of relying only on the static `queries`.
  const matrixUrl = String(request.data?.matrixUrl ?? '').trim();

  if (!orgId || !actorId || !webhookUrl || (queries.length === 0 && !matrixUrl)) {
    throw new HttpsError('invalid-argument', 'orgId, actorId, webhookUrl and either at least one query or a matrixUrl are required.');
  }
  try {
    const u = new URL(webhookUrl);
    if (u.protocol !== 'https:') throw new Error('not https');
  } catch {
    throw new HttpsError('invalid-argument', 'webhookUrl must be a valid https URL.');
  }
  if (matrixUrl) {
    try {
      const u = new URL(matrixUrl);
      if (u.protocol !== 'https:') throw new Error('not https');
    } catch {
      throw new HttpsError('invalid-argument', 'matrixUrl must be a valid https URL.');
    }
  }

  const db = getFirestore();
  const orgRef = db.collection('organisations').doc(orgId);
  if (!(await orgRef.get()).exists) throw new HttpsError('not-found', 'Organisation not found.');

  const secretRef = db.collection('orgSecrets').doc(orgId);
  const secretSnap = await secretRef.get();
  const existing = secretSnap.exists ? secretSnap.data()?.sourcing?.secret : null;
  const secret = existing || generateSourcingSecret();
  await secretRef.set({ sourcing: { secret, updatedAt: FieldValue.serverTimestamp() } }, { merge: true });

  await orgRef.set(
    { sourcing: { enabled, actorId, queries, freshness, freshnessMonths, webhookUrl, maxPerRun, matrixUrl, configuredAt: FieldValue.serverTimestamp() } },
    { merge: true }
  );

  // Only reveal the secret when it was newly minted (avoids echoing it into logs on every re-config).
  return { ok: true, enabled, queryCount: queries.length, ...(existing ? {} : { secret }) };
});

// Run ONE org's sourcing relay right now, on demand — the manual trigger for testing a single flow
// end-to-end without waiting for (or depending on) the daily runSourcingJobs schedule. Runs the same
// runForOrg pipeline (Apify fetch → dedup → signed relay → debit) once for the given org, regardless
// of its `enabled` flag, so we can validate before turning the schedule on. Operator-only.
export const adminRunSourcingNow = onCall(
  { region: 'asia-south1', secrets: [APIFY_TOKEN], timeoutSeconds: 300, memory: '512MiB' },
  async (request) => {
    requireAdmin(request);
    const orgId = String(request.data?.orgId ?? '').trim();
    if (!orgId) throw new HttpsError('invalid-argument', 'orgId required.');
    const db = getFirestore();
    const orgSnap = await db.collection('organisations').doc(orgId).get();
    if (!orgSnap.exists) throw new HttpsError('not-found', 'Organisation not found.');
    const cfg = orgSnap.data().sourcing || {};
    if (!cfg.actorId || !cfg.webhookUrl || !(cfg.queries || []).length) {
      throw new HttpsError('failed-precondition', 'This org has no sourcing config — run adminConfigureSourcing first.');
    }
    const run = startRun(db, orgId, 'admin-run-now');
    try {
      const result = await runForOrg(db, process.env.APIFY_TOKEN, orgId, cfg, {
        leg: run.leg({ queries: cfg.queries || [] }),
      });
      await run.finish();
      return { ok: true, runId: run.id, ...result };
    } catch (e) {
      await run.finish({ status: 'error', error: e?.message || String(e) });
      throw e;
    }
  },
);

// Source the TOP demand-ranked target(s) from the platform matrix, once, on demand — the manual
// probe for "can we actually add leads for the hottest locality?". Pulls the platform's query matrix
// (dry run — does not advance the platform's per-target refresh schedule), takes the top `topN`
// targets (default 1), and runs the normal fetch → dedup → enrich → signed relay for just their
// queries. This is NOT the daily schedule and NOT tied to sourcing.enabled — it's a controlled test
// that still incurs Apify cost + the per-listing wallet debit, capped by the org's maxPerRun.
export const adminSourceTopTarget = onCall(
  { region: 'asia-south1', secrets: [APIFY_TOKEN], timeoutSeconds: 300, memory: '512MiB' },
  async (request) => {
    requireAdmin(request);
    const orgId = String(request.data?.orgId ?? '').trim();
    if (!orgId) throw new HttpsError('invalid-argument', 'orgId required.');
    const topN = Math.max(1, Math.floor(Number(request.data?.topN) || 1));

    const db = getFirestore();
    const orgSnap = await db.collection('organisations').doc(orgId).get();
    if (!orgSnap.exists) throw new HttpsError('not-found', 'Organisation not found.');
    const cfg = orgSnap.data().sourcing || {};
    if (!cfg.actorId || !cfg.webhookUrl || !cfg.matrixUrl) {
      throw new HttpsError('failed-precondition', 'This org needs actorId, webhookUrl and matrixUrl — run adminConfigureSourcing first.');
    }

    // Same smart path the daily cron runs (utils shared in runSourcingJobs.js), but dryRun:true so a
    // manual probe never burns a target's cadence. Gemini bilingual queries + relevance gate applied
    // per target; wallet debits aggregate across targets.
    const result = await sourceTopTargets(db, process.env.APIFY_TOKEN, orgId, cfg, { topN, dryRun: true, trigger: 'admin-top-target' });
    if (result?.note === 'no secret') throw new HttpsError('failed-precondition', 'No sourcing secret for this org.');
    return result;
  },
);

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// Read side: the sourcing audit trail (see utils/sourcingRun.js).
//
// Two independent sources, because they answer different questions and have different histories:
//   • `sourcingRuns` — the full per-run, per-target funnel. Complete, but only from the run that
//     first recorded it: before that, the funnel existed only as console.log and is unrecoverable.
//   • `sourcingSeen` — the dedup-forever ledger. It predates the run recorder, so it carries real
//     history, but only for leads that reached a TERMINAL state (relayed, or enriched-then-dead).
//     It has no target/query attribution and never saw the transient drops.
// The panel shows both and labels which is which — a rollup that silently mixed them would imply a
// funnel we cannot actually reconstruct.
// ─────────────────────────────────────────────────────────────────────────────────────────────────

/** Strip a run doc down to what the panel renders, resolving timestamps to plain millis. */
function runSummary(doc) {
  const d = doc.data();
  return {
    id: doc.id,
    orgId: d.orgId,
    trigger: d.trigger || 'cron',
    status: d.status || 'done',
    error: d.error || null,
    startedAtMs: d.startedAt?.toMillis?.() ?? null,
    finishedAtMs: d.finishedAt?.toMillis?.() ?? null,
    ms: d.ms ?? null,
    matrix: d.matrix || null,
    funnel: d.funnel || null,
    targets: d.targets || [],
    targetCount: d.targetCount ?? (d.targets || []).length,
    relayed: d.relayed || 0,
    amountInr: d.amountInr || 0,
    leadRows: d.leadRows || 0,
    leadsTruncated: Boolean(d.leadsTruncated),
    notes: d.notes || [],
  };
}

/**
 * Recent sourcing runs, newest first, with their whole funnel — the panel's main list. Optionally
 * scoped to one org. Also returns a rollup across the returned window so the operator gets the
 * "of everything we fetched, what actually landed?" number without summing rows by hand.
 */
export const adminSourcingRuns = onCall({ region: 'asia-south1' }, async (request) => {
  requireAdmin(request);
  const orgId = String(request.data?.orgId ?? '').trim();
  const limit = Math.max(1, Math.min(200, Math.floor(Number(request.data?.limit) || 40)));

  const db = getFirestore();
  let q = db.collection('sourcingRuns');
  if (orgId) q = q.where('orgId', '==', orgId);
  const snap = await q.orderBy('startedAt', 'desc').limit(limit).get();
  const runs = snap.docs.map(runSummary);

  // Rollup over exactly the window returned — never a global total, so the header can never
  // disagree with the rows under it.
  const funnel = {};
  for (const r of runs) {
    for (const [k, v] of Object.entries(r.funnel || {})) funnel[k] = (funnel[k] || 0) + (Number(v) || 0);
  }
  // One batched read — the name lookup must not cost a serial round-trip per org.
  const orgIds = [...new Set(runs.map((r) => r.orgId).filter(Boolean))];
  const orgNames = new Map();
  if (orgIds.length) {
    const snaps = await db.getAll(...orgIds.map((id) => db.collection('organisations').doc(id)));
    for (const s of snaps) orgNames.set(s.id, s.exists ? (s.data().name || s.id) : s.id);
  }

  return {
    runs: runs.map((r) => ({ ...r, orgName: orgNames.get(r.orgId) || r.orgId })),
    rollup: {
      runs: runs.length,
      funnel,
      relayed: runs.reduce((n, r) => n + r.relayed, 0),
      amountInr: runs.reduce((n, r) => n + r.amountInr, 0),
      targets: runs.reduce((n, r) => n + r.targetCount, 0),
      // Fetched→relayed conversion. The single number that says whether a bad day was a supply
      // problem or a gate problem.
      yieldPct: funnel.fetched > 0 ? (funnel.relayed || 0) / funnel.fetched * 100 : 0,
    },
    generatedAt: Date.now(),
  };
});

/**
 * One run, plus every lead row it recorded — the URL-level drill-down: what we fetched, which query
 * found it, and exactly which gate dropped it.
 */
export const adminSourcingRunDetail = onCall({ region: 'asia-south1' }, async (request) => {
  requireAdmin(request);
  const runId = String(request.data?.runId ?? '').trim();
  if (!runId) throw new HttpsError('invalid-argument', 'runId required.');

  const db = getFirestore();
  const ref = db.collection('sourcingRuns').doc(runId);
  const [runDoc, leadsSnap] = await Promise.all([ref.get(), ref.collection('leads').get()]);
  if (!runDoc.exists) throw new HttpsError('not-found', 'Run not found.');

  const leads = leadsSnap.docs.map((d) => {
    const l = d.data();
    return {
      id: d.id,
      url: l.url,
      title: l.title || '',
      // The stored snippet runs to 1200 chars; the table only ever shows one truncated line and a
      // hover tooltip. Sending all of it for up to 2000 rows would be a multi-MB response for text
      // nobody reads — trim to what the UI can actually display.
      snippet: String(l.snippet || '').slice(0, 200),
      locality: l.locality || null,
      city: l.city || null,
      query: l.query || null,
      stage: l.stage,
      dropStage: l.dropStage || null,
      dropReason: l.dropReason || null,
      postedAt: l.postedAt || null,
      freshness: l.freshness || null,
      classifyStatus: l.classifyStatus || null,
      listingType: l.listingType || null,
      propertyType: l.propertyType || null,
      priceText: l.priceText || null,
      hasPhone: Boolean(l.hasPhone),
      imageCount: l.imageCount || 0,
    };
  });
  // Relayed first (the outcome that earned money), then dropped, then deferred; newest post first
  // inside each band.
  const rank = { relayed: 0, dropped: 1, deferred: 2 };
  leads.sort((a, b) => (rank[a.stage] - rank[b.stage]) || ((b.postedAt || 0) - (a.postedAt || 0)));

  const byDropStage = {};
  for (const l of leads) {
    if (l.stage === 'relayed') continue;
    const k = l.dropStage || 'unknown';
    byDropStage[k] = (byDropStage[k] || 0) + 1;
  }
  return { run: runSummary(runDoc), leads, byDropStage };
});

/**
 * The historical lead ledger, straight from `sourcingSeen` — the only lead-level history that
 * predates the run recorder. `mode:'relayed'` reads the delivered+billed leads; `mode:'dropped'`
 * reads the enriched-then-dead ones (the posts we PAID to scrape and then binned, which is the
 * expensive mistake worth watching).
 *
 * Note the orderBy is load-bearing: a relayed doc has `relayedAt` and a dead one has `examinedAt`,
 * and Firestore omits docs missing the ordered field — so each query naturally returns only its own
 * kind, with no filter needed.
 */
export const adminSourcingLeadLedger = onCall({ region: 'asia-south1' }, async (request) => {
  requireAdmin(request);
  const orgId = String(request.data?.orgId ?? '').trim();
  if (!orgId) throw new HttpsError('invalid-argument', 'orgId required.');
  const mode = request.data?.mode === 'dropped' ? 'dropped' : 'relayed';
  const limit = Math.max(1, Math.min(500, Math.floor(Number(request.data?.limit) || 100)));

  const db = getFirestore();
  const col = db.collection('sourcingSeen').doc(orgId).collection('keys');
  const field = mode === 'dropped' ? 'examinedAt' : 'relayedAt';
  const snap = await col.orderBy(field, 'desc').limit(limit).get();

  const leads = snap.docs.map((d) => {
    const l = d.data();
    return {
      key: d.id,
      url: l.url || '',
      title: l.title || '',
      postedAt: l.postedAt || null,
      atMs: l[field]?.toMillis?.() ?? null,
      dropReason: l.dropReason || null,
    };
  });
  const byReason = {};
  for (const l of leads) if (l.dropReason) byReason[l.dropReason] = (byReason[l.dropReason] || 0) + 1;
  return { mode, leads, byReason, generatedAt: Date.now() };
});

// Turn an org's relay off without dropping its secret/config (so re-enabling is one flag flip and
// the customer's webhook keeps validating).
export const adminDisableSourcing = onCall({ region: 'asia-south1' }, async (request) => {
  requireAdmin(request);
  const orgId = String(request.data?.orgId ?? '').trim();
  if (!orgId) throw new HttpsError('invalid-argument', 'orgId required.');
  const db = getFirestore();
  await db.collection('organisations').doc(orgId).set({ sourcing: { enabled: false } }, { merge: true });
  return { ok: true };
});
