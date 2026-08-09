/**
 * The nightly admin work-queue planner — the "plan and split tomorrow's work" service line.
 *
 * Two entry points over ONE shared flow (`runPlanForOrg`):
 *   - `planDailyTasks`   — 01:30 IST nightly cron over every org with sourcing.planner.enabled.
 *   - `sourcingPlanNow`  — HTTPS on-demand trigger the PLATFORM calls at 07:00 IST if no plan doc
 *                          landed (our outage, failed POST). Same HMAC handshake as usageMeter.
 *
 * Flow per org: pull the platform's work-state snapshot (candidates + roster) → deterministic
 * allocation in utils/planTasks.js (the ONLY copy of the rules anywhere) → one Gemini Flash briefing
 * per admin (thinkingBudget 0; a briefing failure NEVER blocks the plan — the deterministic core is
 * the product, Flash is garnish) → POST the plan to the platform's /api/ingest/daily-plan → settle
 * billing on the 2xx ack.
 *
 * Billing: FLAT per plan-day (DAILY_PLAN_PRICE_PAISE), qty 1, settled directly in one transaction
 * (accrual `plannerAccrualPaise`, ledger kind `daily_plan`) — the same discipline as usageMeter.
 * Idempotency: the settle writes `usage_meter_log/{orgId}:daily_plan:{dateKey}`; both entry points
 * pre-check that doc, so a scheduler retry, a double cron, or an on-demand call after a successful
 * night are all charged:0 no-ops. The platform's ingest is first-plan-wins on top.
 *
 * Withheld days (`withholdDay`): a REST DAY (Sunday — the team's weekly holiday) or a NEGATIVE org
 * balance withholds the day entirely — nothing produced, nothing billed, and a blocked notice tells
 * the plan page which of the two it was. See HOLIDAY_MESSAGE / LOW_BALANCE_MESSAGE below.
 *
 * Config: organisations/{orgId}.sourcing.planner = { enabled, workStateUrl, planUrl,
 * maxTasksPerAdmin?, capPerCategory?, restDays? }. Secret: orgSecrets/{orgId}.sourcing.secret (same
 * vault as the relay). Audit: plannerRuns/{orgId}/runs/{planRunId}.
 */
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { onRequest } from 'firebase-functions/v2/https';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import crypto from 'node:crypto';
import { signPayload } from '../utils/sourcing.js';
import { verifyCustomerSignature, logReject } from '../utils/customerAuth.js';
import { generateJson, GEMINI_FLASH } from '../utils/gemini.js';
import { DAILY_PLAN_PRICE_PAISE, accrueComposeCharge, isServicePaused } from '../shared/billing.js';
import { allocateTasks, briefingPrompt, BRIEFING_SCHEMA } from '../utils/planTasks.js';

const REGION = 'asia-south1';
const METER_LOG = 'usage_meter_log';
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
const BRIEFING_CONCURRENCY = 4; // same Vertex-quota discipline as the classify pool
// Generous: the platform's ingest runs one idempotent transaction per admin plan, and a
// cross-region hop (testing runs Vercel-US against an asia-south1 Firestore) makes a big roster
// legitimately slow. The platform side is idempotent, so even a timeout here never double-writes.
const PLAN_POST_TIMEOUT_MS = 60000;

/**
 * What the admins see on the plan page when the wallet is empty. Bosun owns this string (not the
 * platform) because Bosun owns the wallet — the reason the plan is missing must come from the side
 * that knows why. Deliberately in the customer's own words: it names the recharge, not the ledger.
 */
export const LOW_BALANCE_MESSAGE = 'Low balance — recharge to use AI agents to manage the tasks.';

/** What the admins see on a rest day. Same ownership argument as LOW_BALANCE_MESSAGE. */
export const HOLIDAY_MESSAGE = 'Weekly holiday — no tasks planned today.';

/**
 * Sunday is the team's weekly holiday: no work queue is planned for it, and the day is never billed.
 * Per-org override: `sourcing.planner.restDays` — IST weekday numbers, `[]` to plan every day.
 */
const DEFAULT_REST_DAYS = [0];

/** IST calendar date as yyyymmdd — must match the platform's istDateKey exactly. */
export function istDateKey(nowMs = Date.now()) {
  const ist = new Date(nowMs + IST_OFFSET_MS);
  const y = ist.getUTCFullYear();
  const m = String(ist.getUTCMonth() + 1).padStart(2, '0');
  const d = String(ist.getUTCDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

/** IST weekday of `nowMs` — 0 = Sunday … 6 = Saturday. */
export function istWeekday(nowMs = Date.now()) {
  return new Date(nowMs + IST_OFFSET_MS).getUTCDay();
}

/** True when the org does not work the IST day containing `nowMs`. */
export function isRestDay(planner = {}, nowMs = Date.now()) {
  const days = Array.isArray(planner.restDays)
    ? planner.restDays.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6)
    : DEFAULT_REST_DAYS;
  return days.includes(istWeekday(nowMs));
}

/** Tiny promise pool — run `fn` over `items` with at most `limit` in flight. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (i < items.length) {
        const idx = i++;
        out[idx] = await fn(items[idx], idx);
      }
    }),
  );
  return out;
}

/**
 * Withhold the day and tell the platform WHY. Two reasons reach here — the weekly holiday (expected;
 * nobody is working) and a negative wallet (a fault the owner must act on) — and both take the same
 * shape: nothing produced, nothing billed, and a BLOCKED notice carrying the reason to the plan page.
 *
 * The notice goes through the ingest's `blocked` branch, which writes daily_plan_meta ONLY and no
 * plan docs. That is the whole point: plan-doc ingest is first-plan-wins, so a placeholder "plan"
 * would occupy a day that may still need planning for real. With nothing written and nothing billed
 * the day stays re-plannable — the next trigger picks it up once the reason clears.
 *
 * Best-effort delivery: a notice that fails to land degrades to the page's ordinary "no plan yet"
 * state. It must never turn into an error that masks why the day was withheld.
 */
async function withholdDay({ db, orgId, planner, secret, dateKey, trigger, summary, blocked }) {
  const noticeRunId = `dpb_${dateKey}_${crypto.randomBytes(5).toString('hex')}`;
  const noticeBody = JSON.stringify({
    orgId,
    planRunId: noticeRunId,
    dateKey,
    generatedAtMs: Date.now(),
    trigger,
    blocked,
    plans: [],
  });
  try {
    const signedNotice = signPayload(secret, noticeBody);
    const noticeResp = await fetch(planner.planUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-bosun-signature': signedNotice.signature,
        'x-bosun-timestamp': signedNotice.timestamp,
      },
      body: noticeBody,
      signal: AbortSignal.timeout(30000),
    });
    summary.noticeDelivered = noticeResp.ok;
    if (!noticeResp.ok) summary.noticeStatus = noticeResp.status;
  } catch (e) {
    summary.noticeDelivered = false;
    summary.noticeError = e?.message || String(e);
  }
  await db
    .collection('plannerRuns')
    .doc(orgId)
    .collection('runs')
    .doc(noticeRunId)
    .set({
      dateKey,
      trigger,
      blocked: { ...blocked, noticeDelivered: !!summary.noticeDelivered },
      admins: 0,
      taskCount: 0,
      chargedInr: 0,
      createdAt: FieldValue.serverTimestamp(),
    })
    .catch(() => {});
  return summary;
}

/**
 * Plan one org's day. Returns a summary object (never throws — a planner failure must not break the
 * org loop, and the platform's degraded state covers a missed morning).
 */
export async function runPlanForOrg(db, orgId, cfg, trigger) {
  const planner = cfg.planner || {};
  const dateKey = istDateKey();
  const summary = { orgId, dateKey, trigger, status: 'skipped' };

  try {
    if (!planner.enabled || !planner.workStateUrl || !planner.planUrl) {
      summary.reason = 'planner-not-configured';
      return summary;
    }

    // Idempotency pre-check — the settle log doubles as "this day is already planned & billed".
    const logRef = db.collection(METER_LOG).doc(`${orgId}:daily_plan:${dateKey}`);
    if ((await logRef.get()).exists) {
      summary.reason = 'already-planned';
      return summary;
    }

    const secretSnap = await db.collection('orgSecrets').doc(orgId).get();
    const secret = secretSnap.exists ? secretSnap.data()?.sourcing?.secret : null;
    if (!secret) {
      summary.status = 'error';
      summary.reason = 'no-secret';
      return summary;
    }

    // 0a) Rest day. Sunday is the team's weekly holiday: nobody works it, so there is nothing to
    // plan and nothing to bill. Checked here — inside the shared flow — so BOTH entry points honour
    // it: the 01:30 cron AND the platform's 07:00 "no plan landed" fallback, which would otherwise
    // read a deliberately empty Sunday as an outage and ask us to plan it. Ordered ahead of the
    // wallet gate because a rest day is not about money: telling a team that isn't working to go
    // top up would be the wrong answer to the right silence.
    if (isRestDay(planner)) {
      summary.status = 'blocked';
      summary.reason = 'weekly-holiday';
      summary.message = HOLIDAY_MESSAGE;
      return await withholdDay({
        db,
        orgId,
        planner,
        secret,
        dateKey,
        trigger,
        summary,
        blocked: { reason: 'weekly_holiday', message: HOLIDAY_MESSAGE },
      });
    }

    // 0b) Wallet gate. A negative balance stops the day being PRODUCED, not merely delivered: no
    // work-state pull, no Flash briefings, no plan docs, no charge. The fix pipeline deliberately
    // lets an org run negative (the operator reconciles later), but the planner is a recurring
    // nightly service — running it on an empty wallet just deepens a debt the owner never agreed to.
    // Instead we POST a BLOCKED notice so the admins' page can say why and ask for a top-up.
    //
    // A waived line (billingPaused) is free by operator choice, so its balance cannot be the reason
    // to withhold it — testing and goodwill orgs keep planning at a negative balance.
    const walletSnap = await db.collection('organisations').doc(orgId).get();
    const wallet = walletSnap.data() || {};
    const balance = Number(wallet.balance ?? 0);
    if (balance < 0 && !isServicePaused(wallet, 'daily_plan')) {
      summary.status = 'blocked';
      summary.reason = 'low-balance';
      summary.balance = balance;
      summary.message = LOW_BALANCE_MESSAGE;
      return await withholdDay({
        db,
        orgId,
        planner,
        secret,
        dateKey,
        trigger,
        summary,
        blocked: { reason: 'low_balance', message: LOW_BALANCE_MESSAGE, balanceInr: balance },
      });
    }

    // 1) Pull the work-state snapshot (constant-string HMAC, like query-matrix).
    const { signature, timestamp } = signPayload(secret, 'work-state');
    let url;
    try {
      url = new URL(planner.workStateUrl);
    } catch {
      summary.status = 'error';
      summary.reason = 'bad-workStateUrl';
      return summary;
    }
    if (planner.capPerCategory) url.searchParams.set('capPerCategory', String(planner.capPerCategory));
    const wsResp = await fetch(url.toString(), {
      headers: { 'x-bosun-signature': signature, 'x-bosun-timestamp': timestamp },
      signal: AbortSignal.timeout(45000),
    });
    if (!wsResp.ok) {
      summary.status = 'error';
      summary.reason = `work-state-http-${wsResp.status}`;
      return summary;
    }
    const workState = await wsResp.json();
    if (!workState?.success || !Array.isArray(workState.admins)) {
      summary.status = 'error';
      summary.reason = 'work-state-malformed';
      return summary;
    }

    // 2) Deterministic allocation.
    const maxTasksPerAdmin = Math.max(1, Math.floor(Number(planner.maxTasksPerAdmin) || 40));
    const { plans, stats } = allocateTasks(workState, { maxTasksPerAdmin });

    // 3) Briefings — Flash, capped concurrency, failure → '' (never block the plan on Gemini).
    const withTasks = plans.filter((p) => p.tasks.length > 0);
    await mapLimit(withTasks, BRIEFING_CONCURRENCY, async (p) => {
      const admin = workState.admins.find((a) => a.uid === p.adminUid);
      const out = await generateJson({
        model: GEMINI_FLASH,
        prompt: briefingPrompt(admin, p.tasks, workState),
        schema: BRIEFING_SCHEMA,
        temperature: 0.3,
        maxOutputTokens: 256,
        thinkingBudget: 0,
      });
      p.briefing = typeof out?.briefing === 'string' ? out.briefing.slice(0, 1200) : '';
    });
    const briefingFailures = withTasks.filter((p) => !p.briefing).length;

    // 4) Deliver. Every roster admin gets a doc (even tasks:[]) so the platform's morning trigger
    // can treat "any doc exists" as planned. Sign the EXACT body bytes.
    const planRunId = `dp_${dateKey}_${crypto.randomBytes(5).toString('hex')}`;
    const demandMatched = plans.reduce(
      (s, p) => s + p.tasks.filter((t) => (Number(t.demand) || 0) > 0).length,
      0,
    );
    const body = JSON.stringify({
      orgId,
      planRunId,
      dateKey,
      generatedAtMs: Date.now(),
      trigger,
      // Run-level stats → the platform's daily_plan_meta (team-scoreboard staffing flag). The
      // dropped-work number leaving our side is the point: unassigned backlog must be VISIBLE.
      stats: { unassigned: stats.unassigned, demandMatched },
      plans: plans.map((p) => ({
        adminUid: p.adminUid,
        adminName: p.adminName,
        briefing: p.briefing || '',
        tasks: p.tasks,
      })),
    });
    const signed = signPayload(secret, body);
    const postResp = await fetch(planner.planUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-bosun-signature': signed.signature,
        'x-bosun-timestamp': signed.timestamp,
      },
      body,
      signal: AbortSignal.timeout(PLAN_POST_TIMEOUT_MS),
    });
    if (!postResp.ok) {
      summary.status = 'error';
      summary.reason = `plan-post-http-${postResp.status}`;
      return summary;
    }
    const ack = await postResp.json().catch(() => ({}));

    // 5) Settle — flat per plan-day, one transaction, log row = idempotency key. Charged on the ack
    // even when the platform reports {duplicate:true}: the charge follows the FIRST acknowledged
    // delivery for the day, and the pre-check above means we only reach here unbilled.
    const taskCount = plans.reduce((s, p) => s + p.tasks.length, 0);
    let charged = 0;
    charged = await db.runTransaction(async (tx) => {
      const orgRef = db.collection('organisations').doc(orgId);
      const orgSnap = await tx.get(orgRef);
      if (!orgSnap.exists) return 0;
      const dupe = await tx.get(logRef);
      if (dupe.exists) return 0;
      const org = orgSnap.data();

      // Waived line (testing / goodwill): log it for idempotency + reconciliation, charge nothing.
      if (isServicePaused(org, 'daily_plan')) {
        tx.set(logRef, {
          orgId,
          service: 'daily_plan',
          idempotencyKey: dateKey,
          qty: 1,
          planRunId,
          trigger,
          taskCount,
          adminCount: plans.length,
          pricePaise: DAILY_PLAN_PRICE_PAISE,
          debitInr: 0,
          waived: true,
          waivedPaise: DAILY_PLAN_PRICE_PAISE,
          createdAt: FieldValue.serverTimestamp(),
        });
        return 0;
      }

      const { debitInr, accrualPaise } = accrueComposeCharge(org.plannerAccrualPaise, DAILY_PLAN_PRICE_PAISE);
      const update = { plannerAccrualPaise: accrualPaise };
      if (debitInr > 0) {
        update.balance = Number(org.balance ?? 0) - debitInr;
        tx.set(db.collection('transactions').doc(), {
          orgId,
          type: 'debit',
          kind: 'daily_plan',
          amount: debitInr,
          count: 1, // one plan-day — adminMetrics sums `count` for the lane's Units column
          description: `Nightly admin work-queue plan (${dateKey}, ${taskCount} tasks, ${plans.length} admins)`,
          createdAt: FieldValue.serverTimestamp(),
        });
      }
      tx.update(orgRef, update);
      tx.set(logRef, {
        orgId,
        service: 'daily_plan',
        idempotencyKey: dateKey,
        qty: 1,
        planRunId,
        trigger,
        taskCount,
        adminCount: plans.length,
        pricePaise: DAILY_PLAN_PRICE_PAISE,
        debitInr,
        createdAt: FieldValue.serverTimestamp(),
      });
      return debitInr;
    });

    // 6) Audit trail for the ops console.
    await db
      .collection('plannerRuns')
      .doc(orgId)
      .collection('runs')
      .doc(planRunId)
      .set({
        dateKey,
        trigger,
        admins: plans.length,
        taskCount,
        demandMatched, // tasks with a buyer already waiting — the value-proof series
        openRequirements: Number(workState.demand?.openRequirements) || 0,
        tasksPerCategory: Object.fromEntries(
          Object.entries(workState.categories || {}).map(([k, v]) => [k, (v || []).length]),
        ),
        unassigned: stats.unassigned,
        // Per-admin usage record — did yesterday's plan get worked, and what did tonight allocate?
        // callsYesterday/converted7d were always in the snapshot; now they persist for the audit.
        roster: (workState.admins || []).map((a) => ({
          uid: a.uid,
          name: a.name || '',
          callsYesterday: Number(a.callsYesterday) || 0,
          converted7d: Number(a.converted7d) || 0,
          planYesterday: a.planYesterday || null,
          assignedTonight: Number(stats.perAdmin?.[a.uid]) || 0,
        })),
        briefingFailures,
        ack: { created: ack.created ?? null, duplicates: ack.duplicates ?? null },
        chargedInr: charged,
        createdAt: FieldValue.serverTimestamp(),
      });

    summary.status = 'ok';
    summary.planRunId = planRunId;
    summary.taskCount = taskCount;
    summary.adminCount = plans.length;
    summary.briefingFailures = briefingFailures;
    return summary;
  } catch (e) {
    console.error('planDailyTasks:org', orgId, e?.message || e);
    summary.status = 'error';
    summary.reason = e?.message || String(e);
    return summary;
  }
}

// Nightly at 01:30 IST — inside the plan day, hours before admins start.
export const planDailyTasks = onSchedule(
  {
    region: REGION,
    schedule: '30 1 * * *',
    timeZone: 'Asia/Kolkata',
    timeoutSeconds: 540,
    memory: '512MiB',
  },
  async () => {
    const db = getFirestore();
    const snap = await db.collection('organisations').where('sourcing.enabled', '==', true).get();
    for (const orgDoc of snap.docs) {
      const cfg = orgDoc.data().sourcing || {};
      if (!cfg.planner?.enabled) continue;
      const summary = await runPlanForOrg(db, orgDoc.id, cfg, 'cron');
      console.log('planDailyTasks:done', orgDoc.id, JSON.stringify(summary));
    }
  },
);

/**
 * POST /sourcingPlanNow — the platform's 07:00 IST safety trigger ("no plan landed — plan now").
 * Body { orgId, dateKey } signed `${timestamp}.${rawBody}` with the org's relay secret. dateKey must
 * be today (IST) — this endpoint regenerates a missed morning, never a past day.
 */
export const sourcingPlanNow = onRequest({ region: REGION, cors: false, timeoutSeconds: 300 }, async (req, res) => {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' });
    return;
  }
  const raw = req.rawBody ? req.rawBody.toString('utf8') : '';
  let body;
  try {
    body = JSON.parse(raw || '{}');
  } catch {
    res.status(400).json({ error: 'invalid JSON' });
    return;
  }
  const orgId = String(body.orgId || '');
  const dateKey = String(body.dateKey || '');
  if (!orgId) {
    res.status(400).json({ error: 'orgId required' });
    return;
  }

  const db = getFirestore();
  const secretSnap = await db.collection('orgSecrets').doc(orgId).get();
  const secret = secretSnap.exists ? secretSnap.data()?.sourcing?.secret : null;
  if (!secret) {
    logReject('sourcingPlanNow', { orgId, status: 403, reason: 'org-has-no-sourcing-secret' });
    res.status(403).json({ error: 'sourcing not configured for this org' });
    return;
  }
  const auth = verifyCustomerSignature(raw, req.get('x-bosun-signature'), req.get('x-bosun-timestamp'), secret);
  if (!auth.ok) {
    logReject('sourcingPlanNow', { orgId, status: 401, reason: auth.reason });
    res.status(401).json({ error: 'bad signature' });
    return;
  }
  if (dateKey && dateKey !== istDateKey()) {
    res.status(409).json({ error: 'dateKey is not today (IST)', today: istDateKey() });
    return;
  }

  const cfg = (await db.collection('organisations').doc(orgId).get()).data()?.sourcing || {};
  if (!cfg.planner?.enabled) {
    res.status(409).json({ error: 'planner disabled for this org' });
    return;
  }

  const summary = await runPlanForOrg(db, orgId, cfg, 'on-demand');
  console.log('sourcingPlanNow:done', orgId, JSON.stringify(summary));
  res.status(summary.status === 'error' ? 502 : 200).json(summary);
});
