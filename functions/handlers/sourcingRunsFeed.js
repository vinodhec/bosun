/**
 * POST /sourcingRunsFeed — the customer's window into Bosun's sourcing run history.
 *
 * The platform's target console shows WHEN a locality was last served (lastRunId stamps from the
 * query-matrix pull), but "served" is only a promise — the operator's real question is "did that run
 * actually fetch/scrape/relay anything?". This endpoint answers it: the customer signs a request with
 * the SAME per-org relay secret used everywhere else (`${timestamp}.${rawBody}` HMAC, the
 * sourcingCompose scheme), and gets back the org's recent `sourcingRuns` — id, status, per-run funnel
 * (fetched / enriched / relayed / billed) and the per-target legs.
 *
 * The caller does NOT know its Bosun orgId (that's our internal id), so the org is resolved by
 * verifying the signature against each sourcing-enabled org's secret — a handful of orgs, one HMAC
 * each, constant-time compares. No secrets config needed: this only reads Firestore.
 *
 * Read-only and paid-for-nothing: nothing here bills, stamps, or mutates.
 *
 * Request  POST { limit? }   headers: x-bosun-signature: sha256=…, x-bosun-timestamp: <ms>
 * Response { runs: [{ id, trigger, status, error, startedAtMs, finishedAtMs, ms, relayed, amountInr,
 *                     leadRows, notes, funnel, targets: [{ locality, city, relayed, amountInr, note,
 *                     fetched, newProspects, enriched, relayed }] }] }
 */
import { onRequest } from 'firebase-functions/v2/https';
import { getFirestore } from 'firebase-admin/firestore';
import { verifyCustomerSignature, logReject } from '../utils/customerAuth.js';

const REGION = 'asia-south1';

export const sourcingRunsFeed = onRequest({ region: REGION, cors: false }, async (req, res) => {
  if (req.method !== 'POST') {
    logReject('sourcingRunsFeed', { status: 405, reason: 'non-POST-method', extra: { method: req.method } });
    res.status(405).json({ error: 'POST only' });
    return;
  }
  const raw = req.rawBody ? req.rawBody.toString('utf8') : '';
  let body;
  try {
    body = JSON.parse(raw || '{}');
  } catch {
    logReject('sourcingRunsFeed', { status: 400, reason: 'body-not-valid-json', extra: { bytes: raw.length } });
    res.status(400).json({ error: 'invalid JSON' });
    return;
  }

  const db = getFirestore();

  // Resolve WHICH org signed this: try each sourcing-enabled org's vault secret. The failure reasons
  // are collected for our logs only — the response stays a flat 401 so it can't be used to probe.
  const orgsSnap = await db.collection('organisations').where('sourcing.enabled', '==', true).get();
  let orgId = null;
  let lastReason = 'no-sourcing-orgs';
  for (const orgDoc of orgsSnap.docs) {
    const secretSnap = await db.collection('orgSecrets').doc(orgDoc.id).get();
    const secret = secretSnap.exists ? secretSnap.data()?.sourcing?.secret : null;
    if (!secret) continue;
    const auth = verifyCustomerSignature(raw, req.get('x-bosun-signature'), req.get('x-bosun-timestamp'), secret);
    if (auth.ok) {
      orgId = orgDoc.id;
      break;
    }
    lastReason = auth.reason;
  }
  if (!orgId) {
    logReject('sourcingRunsFeed', { status: 401, reason: lastReason, extra: { orgsTried: orgsSnap.size, bytes: raw.length } });
    res.status(401).json({ error: 'bad signature' });
    return;
  }

  const limit = Math.max(1, Math.min(100, Math.floor(Number(body.limit) || 40)));
  const snap = await db.collection('sourcingRuns')
    .where('orgId', '==', orgId)
    .orderBy('startedAt', 'desc')
    .limit(limit)
    .get();

  const runs = snap.docs.map((doc) => {
    const d = doc.data();
    return {
      id: doc.id,
      trigger: d.trigger || 'cron',
      status: d.status || 'done',
      error: d.error || null,
      startedAtMs: d.startedAt?.toMillis?.() ?? null,
      finishedAtMs: d.finishedAt?.toMillis?.() ?? null,
      ms: d.ms ?? null,
      relayed: d.relayed || 0,
      amountInr: d.amountInr || 0,
      leadRows: d.leadRows || 0,
      notes: d.notes || [],
      funnel: d.funnel || null,
      targets: (d.targets || []).map((t) => ({
        locality: t.locality || null,
        city: t.city || null,
        relayed: t.relayed || 0,
        amountInr: t.amountInr || 0,
        note: t.note || null,
        fetched: t.funnel?.fetched || 0,
        newProspects: t.funnel?.newProspects || 0,
        enriched: t.funnel?.enriched || 0,
      })),
    };
  });
  console.log('sourcingRunsFeed:ok', orgId, JSON.stringify({ runs: runs.length, limit }));
  res.status(200).json({ runs });
});
