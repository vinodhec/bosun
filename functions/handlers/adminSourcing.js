import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { generateSourcingSecret, fetchQueryMatrix, freshnessForMonths, DEFAULT_FRESHNESS_MONTHS } from '../utils/sourcing.js';
import { runForOrg } from './runSourcingJobs.js';
import { APIFY_TOKEN, GEMINI_API_KEY } from '../utils/secrets.js';

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
    const result = await runForOrg(db, process.env.APIFY_TOKEN, orgId, cfg);
    return { ok: true, ...result };
  },
);

// Source the TOP demand-ranked target(s) from the platform matrix, once, on demand — the manual
// probe for "can we actually add leads for the hottest locality?". Pulls the platform's query matrix
// (dry run — does not advance the platform's per-target refresh schedule), takes the top `topN`
// targets (default 1), and runs the normal fetch → dedup → enrich → signed relay for just their
// queries. This is NOT the daily schedule and NOT tied to sourcing.enabled — it's a controlled test
// that still incurs Apify cost + the per-listing wallet debit, capped by the org's maxPerRun.
export const adminSourceTopTarget = onCall(
  { region: 'asia-south1', secrets: [APIFY_TOKEN, GEMINI_API_KEY], timeoutSeconds: 300, memory: '512MiB' },
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
    const secretSnap = await db.collection('orgSecrets').doc(orgId).get();
    const secret = secretSnap.exists ? secretSnap.data()?.sourcing?.secret : null;
    if (!secret) throw new HttpsError('failed-precondition', 'No sourcing secret for this org.');

    // Pull the demand-ranked matrix (dry run: never burns a target's cadence while we're testing).
    const matrix = await fetchQueryMatrix({ matrixUrl: cfg.matrixUrl, secret, limit: 12, dryRun: true });
    const targets = Array.isArray(matrix?.targets) ? matrix.targets : [];
    if (!targets.length) {
      return { ok: true, relayed: 0, amountInr: 0, note: 'No due targets returned by the platform matrix.' };
    }

    // Run each chosen target on its OWN queries + locality context, so the Gemini relevance gate
    // checks each post against the right place. Results (and wallet debits) aggregate across targets.
    const chosen = targets.slice(0, topN);
    let relayed = 0;
    let amountInr = 0;
    const perTarget = [];
    for (const t of chosen) {
      const queries = Array.isArray(t.queries) ? t.queries : [];
      if (!queries.length) {
        perTarget.push({ locality: t.locality, city: t.city, relayed: 0, note: 'no queries' });
        continue;
      }
      const r = await runForOrg(db, process.env.APIFY_TOKEN, orgId, cfg, {
        queries,
        freshness: t.freshness || cfg.freshness,
        target: { locality: t.locality, city: t.city, shape: shapeLabel(t) },
      });
      relayed += r.relayed || 0;
      amountInr += r.amountInr || 0;
      perTarget.push({ locality: t.locality, city: t.city, queries, ...r });
    }
    return { ok: true, targeted: perTarget, relayed, amountInr };
  },
);

// Build a short "2BHK · Villa / House · Sale" hint from a matrix target's dominant shape, if present.
function shapeLabel(t) {
  const s = t.dominantShape || t.shape || {};
  return [s.bhkType, s.propertyType, s.listingType].filter(Boolean).join(' · ') || undefined;
}

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
