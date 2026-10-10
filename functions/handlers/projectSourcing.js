/**
 * Builder PROJECT sourcing from the TN RERA register → the platform's `/api/ingest/sourced-project`.
 *
 * Per org with `sourcing.projectRegistry.enabled`: read the current-year register, keep the rows
 * inside the org's cities (metro boxes), fetch the certificate page for registrations not yet
 * relayed (promoter name lives only there), HMAC-relay each project to the org's project webhook and
 * bill the batch at the flat SOURCED_PROJECT_UNIT_INR on 2xx — charge-on-delivery, like listings.
 *
 * Direct fetch, no Apify: public static pages, one at a time with a pause (see utils/reraTn.js).
 * A run is budgeted (`maxPerRun`, default 150 certificate pages ≈ 6 min); the weekly cron and the
 * on-demand callable both pick up where the last run stopped via `organisations/{org}/projectSeen`.
 */
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { signPayload } from '../utils/sourcing.js';
import { priceForProjectBatch, SOURCED_PROJECT_UNIT_INR } from '../utils/billing.js';
import { fetchReraMapRows, fetchReraDetails, reraCoordToDecimal, cityForPoint, reraDocId, sleep, RERA_BASE } from '../utils/reraTn.js';

const RELAY_TIMEOUT_MS = 20_000;
const DEFAULT_MAX_PER_RUN = 150;
const PAGE_PAUSE_MS = 250;

function requireAdmin(request) {
  const email = request.auth?.token?.email;
  const allow = (process.env.ADMIN_EMAILS || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (!email || !allow.includes(String(email).toLowerCase())) throw new HttpsError('permission-denied', 'Admin only.');
  return email;
}

function projectWebhookFor(cfg) {
  return String(cfg.projectWebhookUrl || String(cfg.webhookUrl || '').replace(/\/sourced-listing\b/, '/sourced-project'));
}

/** HMAC-sign and POST one RERA project. Returns true on a 2xx (the receiver's "persisted or merged"). */
export async function relayReraProject({ projectWebhookUrl, secret, orgId, project }) {
  const body = JSON.stringify({ orgId, project, source: { via: 'bosun', channel: 'rera', url: project.url } });
  const { signature, timestamp } = signPayload(secret, body);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), RELAY_TIMEOUT_MS);
  try {
    const resp = await fetch(projectWebhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bosun-signature': signature, 'x-bosun-timestamp': timestamp },
      body,
      signal: ctrl.signal,
    });
    return resp.ok;
  } catch (e) {
    console.error('relayReraProject:err', orgId, e?.message || e);
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One org, one budgeted pass over the register. Returns the funnel counts and the charge.
 */
export async function sourceProjectsForOrg(db, orgId, cfg, { trigger = 'cron', maxPerRun } = {}) {
  const t0 = Date.now();
  const reg = cfg.projectRegistry || {};
  const cities = Array.isArray(reg.cities) && reg.cities.length ? reg.cities.map(String) : ['Chennai'];
  const budget = Math.max(1, Math.min(400, Math.floor(Number(maxPerRun ?? reg.maxPerRun) || DEFAULT_MAX_PER_RUN)));
  const secretSnap = await db.collection('orgSecrets').doc(orgId).get();
  const secret = secretSnap.exists ? secretSnap.data()?.sourcing?.secret : null;
  const projectWebhookUrl = projectWebhookFor(cfg);
  if (!secret || !projectWebhookUrl) throw new Error(`org ${orgId}: no sourcing secret / webhook`);

  const runRef = db.collection('organisations').doc(orgId).collection('projectSourcingRuns').doc();
  await runRef.set({ trigger, cities, budget, status: 'running', startedAt: FieldValue.serverTimestamp() });

  const rows = await fetchReraMapRows();
  const wanted = [];
  let skippedNoCoords = 0;
  for (const r of rows) {
    const lat = reraCoordToDecimal(r.latRaw);
    const lng = reraCoordToDecimal(r.lngRaw);
    if (lat === null || lng === null) {
      skippedNoCoords++;
      continue;
    }
    const city = cityForPoint(lat, lng);
    if (!city || !cities.includes(city)) continue;
    wanted.push({ ...r, lat, lng, city });
  }
  // Dedup-forever: one read of the org's relayed registrations, not a query per row.
  const seenCol = db.collection('organisations').doc(orgId).collection('projectSeen');
  const seenSnap = await seenCol.select('reraNo').get();
  const seen = new Set(seenSnap.docs.map((d) => String(d.data().reraNo || d.id)));
  const fresh = wanted.filter((r) => !seen.has(r.reraNo));
  const batch = fresh.slice(0, budget);

  let relayed = 0;
  let relayFailed = 0;
  let detailsFailed = 0;
  for (const r of batch) {
    let d = null;
    if (r.uuid) {
      try {
        d = await fetchReraDetails(r.uuid);
      } catch (e) {
        detailsFailed++;
        console.error('rera:details:err', r.reraNo, e?.message || e);
      }
      await sleep(PAGE_PAUSE_MS);
    }
    const project = {
      url: r.detailsUrl || `${RERA_BASE}/projects-map#${r.reraNo}`,
      title: r.reraNo,
      kind: r.kind,
      projectName: r.projectName || d?.projectName || '',
      promoterName: d?.promoterName || '',
      reraNo: r.reraNo,
      reraUuid: r.uuid,
      reraUrl: r.detailsUrl,
      registrationDate: d?.registrationDate || null,
      completionDate: d?.completionDate || null,
      projectStatusText: d?.currentStatus || d?.projectType || null,
      description: d?.description && d.description.length > r.description.length ? d.description : r.description,
      city: r.city,
      lat: r.lat,
      lng: r.lng,
    };
    const ok = await relayReraProject({ projectWebhookUrl, secret, orgId, project });
    if (ok) {
      relayed++;
      await seenCol.doc(reraDocId(r.reraNo)).set({ reraNo: r.reraNo, kind: r.kind, city: r.city, url: project.url, relayedAt: FieldValue.serverTimestamp(), runId: runRef.id });
    } else {
      relayFailed++;
    }
  }

  // Charge-on-delivery: one transactional debit for the batch (org may go negative — operator reconciles).
  const { amountInr, unitPrices } = priceForProjectBatch(relayed);
  if (amountInr > 0) {
    await db.runTransaction(async (tx) => {
      const orgRef = db.collection('organisations').doc(orgId);
      const orgSnap = await tx.get(orgRef);
      if (!orgSnap.exists) return;
      tx.update(orgRef, { balance: Number(orgSnap.data().balance ?? 0) - amountInr });
      tx.set(db.collection('transactions').doc(), {
        orgId,
        type: 'debit',
        kind: 'project_sourcing',
        amount: amountInr,
        count: relayed,
        unitPrice: SOURCED_PROJECT_UNIT_INR,
        unitPrices,
        runId: runRef.id,
        createdAt: FieldValue.serverTimestamp(),
      });
    });
  }
  const result = { mapRows: rows.length, inCities: wanted.length, alreadySeen: wanted.length - fresh.length, attempted: batch.length, relayed, relayFailed, detailsFailed, skippedNoCoords, remaining: Math.max(0, fresh.length - batch.length), amountInr, tookMs: Date.now() - t0 };
  await runRef.set({ ...result, status: 'done', finishedAt: FieldValue.serverTimestamp() }, { merge: true });
  console.log('projectSourcing:done', orgId, JSON.stringify(result));
  return { runId: runRef.id, ...result };
}

/** Weekly: Tuesday 05:00 IST. TN RERA adds 25–100 Chennai registrations a month, so one pass a week keeps up. */
export const runProjectSourcingJobs = onSchedule(
  { region: 'asia-south1', schedule: '0 5 * * 2', timeZone: 'Asia/Kolkata', timeoutSeconds: 1800, memory: '512MiB' },
  async () => {
    const db = getFirestore();
    const orgs = await db.collection('organisations').where('sourcing.projectRegistry.enabled', '==', true).get();
    for (const o of orgs.docs) {
      try {
        await sourceProjectsForOrg(db, o.id, o.data().sourcing || {}, { trigger: 'cron' });
      } catch (e) {
        console.error('projectSourcing:org:err', o.id, e?.message || e);
      }
    }
  },
);

/** Operator: run one org's register pass now (`{ orgId, maxPerRun? }`). */
export const adminSourceProjectsNow = onCall(
  { region: 'asia-south1', timeoutSeconds: 1800, memory: '512MiB' },
  async (request) => {
    requireAdmin(request);
    const orgId = String(request.data?.orgId ?? '').trim();
    if (!orgId) throw new HttpsError('invalid-argument', 'orgId required.');
    const db = getFirestore();
    const orgSnap = await db.collection('organisations').doc(orgId).get();
    if (!orgSnap.exists) throw new HttpsError('not-found', 'Organisation not found.');
    const cfg = orgSnap.data().sourcing || {};
    if (!cfg.projectRegistry?.enabled) throw new HttpsError('failed-precondition', 'Enable sourcing.projectRegistry for this org first (adminSetSourcingLanes).');
    return { ok: true, ...(await sourceProjectsForOrg(db, orgId, cfg, { trigger: 'admin-run-now', maxPerRun: request.data?.maxPerRun })) };
  },
);
