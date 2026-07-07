import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { generateSourcingSecret } from '../utils/sourcing.js';
import { runForOrg } from './runSourcingJobs.js';
import { APIFY_TOKEN } from '../utils/secrets.js';

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
  const freshness = String(request.data?.freshness ?? 'qdr:d').trim();
  const enabled = request.data?.enabled !== false; // default true
  const queries = Array.isArray(request.data?.queries)
    ? request.data.queries.map((q) => String(q || '').trim()).filter(Boolean)
    : [];
  // Optional per-run cap on how many NEW listings to relay/charge (0 = no cap). Bounds cost per run.
  const maxPerRun = Math.max(0, Math.floor(Number(request.data?.maxPerRun) || 0));

  if (!orgId || !actorId || !webhookUrl || queries.length === 0) {
    throw new HttpsError('invalid-argument', 'orgId, actorId, webhookUrl and at least one query are required.');
  }
  try {
    const u = new URL(webhookUrl);
    if (u.protocol !== 'https:') throw new Error('not https');
  } catch {
    throw new HttpsError('invalid-argument', 'webhookUrl must be a valid https URL.');
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
    { sourcing: { enabled, actorId, queries, freshness, webhookUrl, maxPerRun, configuredAt: FieldValue.serverTimestamp() } },
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
