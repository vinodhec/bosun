/**
 * Composed reporting rail — proposal §5's "justifies itself with numbers":
 *   - `weeklyIntelligence`   — Monday 03:30 IST: demand hotspots, supply gaps, conversion trend,
 *                              top localities, over the trailing week.
 *   - `monthlyProofOfValue`  — 1st 04:00 IST: the previous month's leads, plans, WhatsApp
 *                              connections and processed sessions, attributed to agent actions.
 *
 * Numbers are aggregated DETERMINISTICALLY from our own ledgers (intelRuns days, plannerRuns,
 * usage_meter_log, org sessionMeter) — Gemini Flash only turns the aggregate into prose (title,
 * summary, highlights, recommendations) and is forbidden from inventing figures: every number it
 * may use is in the prompt. Reports POST to the platform's /api/ingest/intelligence-report
 * (first-report-wins) and render on /admin/intelligence-reports.
 *
 * Config rides the same block as session intelligence: organisations/{orgId}.sourcing.intelligence
 * = { enabled, reportUrl, ... }. Idempotent per (orgId, period, periodKey) via reportsSent docs.
 */
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import crypto from 'node:crypto';
import { signPayload } from '../utils/sourcing.js';
import { generateJson, GEMINI_FLASH } from '../utils/gemini.js';

const REGION = 'asia-south1';
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function istDate(nowMs = Date.now()) {
  return new Date(nowMs + IST_OFFSET_MS);
}
function dateKeyOf(d) {
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
}

const REPORT_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    summary: { type: 'string' },
    highlights: { type: 'array', items: { type: 'string' } },
    recommendations: { type: 'array', items: { type: 'string' } },
  },
  required: ['title', 'summary', 'highlights', 'recommendations'],
};

/** Aggregate the org's ledgers over [startKey, endKey] (inclusive yyyymmdd bounds). */
async function gatherStats(db, orgId, startKey, endKey) {
  const stats = {
    days: 0,
    sessions: 0,
    leads: 0,
    searches: 0,
    plansDelivered: 0,
    tasksPlanned: 0,
    listingsRelayed: 0,
    autoPosts: 0,
    waDelivered: 0,
    waAccepted: 0,
    anomalies: 0,
  };
  const unserved = new Map();

  // intelRuns days — doc field dateKey is a yyyymmdd string, so string range works.
  try {
    const snap = await db
      .collection('intelRuns')
      .doc(orgId)
      .collection('days')
      .where('dateKey', '>=', startKey)
      .where('dateKey', '<=', endKey)
      .get();
    for (const d of snap.docs) {
      const r = d.data();
      stats.days++;
      stats.sessions += Number(r.sessions) || 0;
      stats.leads += Number(r.leads) || 0;
      stats.searches += Number(r.searches) || 0;
      stats.anomalies += (r.anomalies || []).length;
      for (const row of r.demandTop || []) {
        if (!row.locality || !row.unservedCount) continue;
        const key = `${row.locality}, ${row.city}`;
        unserved.set(key, (unserved.get(key) || 0) + row.unservedCount);
      }
    }
  } catch (e) {
    console.error('reports:intelRuns:err', orgId, e?.message || e);
  }

  // plannerRuns — planned work volume.
  try {
    const snap = await db
      .collection('plannerRuns')
      .doc(orgId)
      .collection('runs')
      .where('dateKey', '>=', startKey)
      .where('dateKey', '<=', endKey)
      .get();
    for (const d of snap.docs) {
      const r = d.data();
      stats.plansDelivered++;
      stats.tasksPlanned += Number(r.taskCount) || 0;
    }
  } catch (e) {
    console.error('reports:plannerRuns:err', orgId, e?.message || e);
  }

  // usage_meter_log — service events (equality-only query, date-filtered in memory: no composite).
  try {
    const snap = await db.collection('usage_meter_log').where('orgId', '==', orgId).limit(1000).get();
    for (const d of snap.docs) {
      const r = d.data();
      const at = r.createdAt?.toMillis?.() || 0;
      const key = at ? dateKeyOf(istDate(at)) : '';
      if (!key || key < startKey || key > endKey) continue;
      if (r.service === 'auto_post') stats.autoPosts += Number(r.qty) || 1;
      if (r.service === 'wa_message_delivered') stats.waDelivered += Number(r.qty) || 1;
      if (r.service === 'wa_lead_accepted') stats.waAccepted += Number(r.qty) || 1;
    }
  } catch (e) {
    console.error('reports:meterLog:err', orgId, e?.message || e);
  }

  // Relay volume from sourcingRuns funnels (relayed listings per run).
  try {
    const snap = await db
      .collection('sourcingRuns')
      .doc(orgId)
      .collection('runs')
      .orderBy('startedAt', 'desc')
      .limit(400)
      .get();
    for (const d of snap.docs) {
      const r = d.data();
      const at = r.startedAt?.toMillis?.() || 0;
      const key = at ? dateKeyOf(istDate(at)) : '';
      if (!key || key < startKey || key > endKey) continue;
      stats.listingsRelayed += Number(r.relayed ?? r.funnel?.relayed) || 0;
    }
  } catch (e) {
    console.error('reports:sourcingRuns:err', orgId, e?.message || e);
  }

  const topUnserved = [...unserved.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([place, count]) => ({ place, count }));
  return { stats, topUnserved };
}

async function composeAndDeliver(db, orgId, cfg, period, periodKey, startKey, endKey) {
  const intel = cfg.intelligence || {};
  const summary = { orgId, period, periodKey, status: 'skipped' };
  try {
    if (!intel.enabled || !intel.reportUrl) {
      summary.reason = 'reports-not-configured';
      return summary;
    }
    const sentRef = db.collection('reportsSent').doc(`${orgId}_${period}_${periodKey}`);
    if ((await sentRef.get()).exists) {
      summary.reason = 'already-sent';
      return summary;
    }
    const secretSnap = await db.collection('orgSecrets').doc(orgId).get();
    const secret = secretSnap.exists ? secretSnap.data()?.sourcing?.secret : null;
    if (!secret) {
      summary.status = 'error';
      summary.reason = 'no-secret';
      return summary;
    }

    const { stats, topUnserved } = await gatherStats(db, orgId, startKey, endKey);

    const label = period === 'monthly' ? 'monthly proof-of-value report' : 'weekly intelligence report';
    const prompt = [
      `Write the ${label} for MaadiVeedu.com's always-on Bosun agent, period ${startKey}–${endKey}.`,
      `Verified numbers (use ONLY these, never invent figures):`,
      `- Visitor sessions processed: ${stats.sessions} over ${stats.days} days`,
      `- Leads (enquiry/contact sessions): ${stats.leads}`,
      `- Searches logged: ${stats.searches}`,
      `- Admin work plans delivered: ${stats.plansDelivered} (${stats.tasksPlanned} tasks planned)`,
      `- Sourced listings relayed: ${stats.listingsRelayed}; auto-published: ${stats.autoPosts}`,
      `- WhatsApp messages delivered: ${stats.waDelivered}; postings accepted via WhatsApp: ${stats.waAccepted}`,
      `- Anomaly alerts raised: ${stats.anomalies}`,
      topUnserved.length
        ? `- Top unserved demand (searches that found no fresh listing): ${topUnserved.map((u) => `${u.place} (${u.count})`).join('; ')}`
        : '',
      period === 'monthly'
        ? 'Frame it as value produced by agent actions vs a no-agent baseline: leads from the same traffic, admin minutes saved by planning, inventory sourced where demand already was. Sober, factual, no hype.'
        : 'Frame it as: where demand is hot, where supply gaps are (the unserved list = tomorrow\'s sourcing targets), and what to watch next week. Sober, factual.',
      'Return JSON {title, summary (3-6 sentences), highlights (3-6 bullets), recommendations (2-4 bullets)}.',
    ]
      .filter(Boolean)
      .join('\n');

    const out = await generateJson({
      model: GEMINI_FLASH,
      prompt,
      schema: REPORT_SCHEMA,
      temperature: 0.3,
      maxOutputTokens: 2000,
      thinkingBudget: 0,
    });
    // Deterministic fallback so a Gemini hiccup still delivers the numbers.
    const report = out || {
      title: `${period === 'monthly' ? 'Proof of value' : 'Weekly intelligence'} ${periodKey}`,
      summary: `Automated period summary ${startKey}–${endKey}. Sessions: ${stats.sessions}; leads: ${stats.leads}; plans: ${stats.plansDelivered}; listings relayed: ${stats.listingsRelayed}.`,
      highlights: [],
      recommendations: [],
    };

    const reportRunId = `ir_${periodKey}_${crypto.randomBytes(5).toString('hex')}`;
    const body = JSON.stringify({
      orgId,
      reportRunId,
      period,
      periodKey,
      generatedAtMs: Date.now(),
      title: report.title,
      summary: report.summary,
      highlights: report.highlights,
      recommendations: report.recommendations,
      stats: { ...stats, topUnserved: topUnserved.map((u) => `${u.place}: ${u.count}`).join('; ') || '—' },
    });
    const signed = signPayload(secret, body);
    const resp = await fetch(intel.reportUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-bosun-signature': signed.signature,
        'x-bosun-timestamp': signed.timestamp,
      },
      body,
      signal: AbortSignal.timeout(30000),
    });
    if (!resp.ok) {
      summary.status = 'error';
      summary.reason = `report-post-http-${resp.status}`;
      return summary;
    }
    await sentRef.set({
      orgId,
      period,
      periodKey,
      reportRunId,
      stats,
      composed: Boolean(out),
      createdAt: FieldValue.serverTimestamp(),
    });
    summary.status = 'ok';
    summary.reportRunId = reportRunId;
    return summary;
  } catch (e) {
    console.error('intelligenceReports:org', orgId, period, e?.message || e);
    summary.status = 'error';
    summary.reason = e?.message || String(e);
    return summary;
  }
}

async function runForEnabledOrgs(fn) {
  const db = getFirestore();
  const snap = await db.collection('organisations').where('sourcing.enabled', '==', true).get();
  for (const orgDoc of snap.docs) {
    const cfg = orgDoc.data().sourcing || {};
    if (!cfg.intelligence?.enabled) continue;
    const summary = await fn(db, orgDoc.id, cfg);
    console.log('intelligenceReports:done', orgDoc.id, JSON.stringify(summary));
  }
}

// Monday 03:30 IST — the trailing week (last Monday through Sunday).
export const weeklyIntelligence = onSchedule(
  { region: REGION, schedule: '30 3 * * 1', timeZone: 'Asia/Kolkata', timeoutSeconds: 300, memory: '512MiB' },
  async () => {
    const now = istDate();
    const end = new Date(now.getTime() - 24 * 60 * 60 * 1000); // yesterday (Sunday)
    const start = new Date(end.getTime() - 6 * 24 * 60 * 60 * 1000); // the Monday before
    const periodKey = dateKeyOf(start);
    await runForEnabledOrgs((db, orgId, cfg) =>
      composeAndDeliver(db, orgId, cfg, 'weekly', periodKey, dateKeyOf(start), dateKeyOf(end)),
    );
  },
);

// 1st of the month 04:00 IST — the previous calendar month.
export const monthlyProofOfValue = onSchedule(
  { region: REGION, schedule: '0 4 1 * *', timeZone: 'Asia/Kolkata', timeoutSeconds: 300, memory: '512MiB' },
  async () => {
    const now = istDate();
    const firstOfThis = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const lastOfPrev = new Date(firstOfThis.getTime() - 24 * 60 * 60 * 1000);
    const firstOfPrev = new Date(Date.UTC(lastOfPrev.getUTCFullYear(), lastOfPrev.getUTCMonth(), 1));
    const periodKey = `${firstOfPrev.getUTCFullYear()}${String(firstOfPrev.getUTCMonth() + 1).padStart(2, '0')}`;
    await runForEnabledOrgs((db, orgId, cfg) =>
      composeAndDeliver(db, orgId, cfg, 'monthly', periodKey, dateKeyOf(firstOfPrev), dateKeyOf(lastOfPrev)),
    );
  },
);
