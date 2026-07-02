import { onSchedule } from 'firebase-functions/v2/scheduler';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import Anthropic from '@anthropic-ai/sdk';
import { markRoundReady, markRoundFailure, chargeCiRun } from '../utils/finalize.js';
import { usageBreakdown, extractResult } from '../utils/agentResult.js';
import { extractPlan } from '../utils/featurePlan.js';
import { continueFeatureStep } from '../utils/featureRun.js';
import { MAX_FEATURE_STEP_CHARGE_INR, FEATURE_MAX_STEPS_PER_SESSION } from '../utils/billing.js';
import { extractDesignTurn } from '../utils/designSession.js';
import { extractCompareTurn, renderReportHtml } from '../utils/compareSession.js';
import { saveReportHtml } from '../utils/compareShots.js';
import { saveMockHtml } from '../utils/mockStore.js';
import { priceForPlanning, priceForDesign, priceForCompare, computeCharge } from '../utils/billing.js';
import { getUsdToInrRate } from '../utils/fxRate.js';
import { fetchPrPreviewUrl, latestWorkflowRun, dispatchWorkflow, getPrHeadRef } from '../utils/github.js';
import { ANTHROPIC_API_KEY } from '../utils/secrets.js';

const BETA = 'managed-agents-2026-04-01';
// CONFIRM these status values against the sessions API reference.
const DONE = new Set(['completed', 'ended', 'idle', 'succeeded']);
const FAILED = new Set(['failed', 'error', 'cancelled', 'canceled']);

// Best-effort: delete the read-only Firebase SA key files we uploaded for this session once it
// ends, so service-account keys don't accumulate in Files storage. Safe on a terminal round — the
// agent has finished; a later revision simply re-reads from code if it needs Firebase again.
async function deleteSessionFiles(client, task) {
  for (const fid of task.firebaseFileIds || []) {
    try { await client.beta.files.delete(fid); } catch { /* best-effort */ }
  }
}
const MAX_PREVIEW_TRIES = 12; // ~12 min before we give up waiting for the Vercel preview

// A planning session (kind:'planning') ended without a usable plan → mark the planning task failed
// and the feature plan_failed. Failed planning is NEVER charged (same as a failed fix).
async function failPlan(db, taskSnap, task, reason, client) {
  await taskSnap.ref.update({ status: 'failed', error: reason });
  if (task.featureId) {
    await db.collection('features').doc(task.featureId).update({ status: 'plan_failed', error: reason }).catch(() => {});
  }
  await deleteSessionFiles(client, task);
}

// A planning session finished with steps → write them onto the feature, open it for review, and
// charge the breakdown (priceForPlanning = 2× the session's real COGS), atomically. Idempotent:
// guarded on the planning task still being 'running' so two overlapping polls can't double-charge.
async function finalizePlanReady(db, taskSnap, task, steps, costUsd, client) {
  const rate = await getUsdToInrRate();
  const chargeInr = priceForPlanning(costUsd, { rate });
  const featureRef = db.collection('features').doc(task.featureId);
  const orgRef = db.collection('organisations').doc(task.orgId);
  const taskRef = taskSnap.ref;
  await db.runTransaction(async (tx) => {
    const tSnap = await tx.get(taskRef);
    if (!tSnap.exists || tSnap.data().status !== 'running') return; // already finalized
    const oSnap = await tx.get(orgRef);
    const fSnap = await tx.get(featureRef);
    if (!fSnap.exists) return;
    const balance = oSnap.exists ? Number(oSnap.data().balance ?? 0) : 0;
    if (chargeInr > 0) {
      tx.update(orgRef, { balance: balance - chargeInr });
      tx.set(db.collection('transactions').doc(), {
        orgId: task.orgId, userId: task.userId, type: 'debit', amount: chargeInr,
        featureId: task.featureId, kind: 'planning', createdAt: FieldValue.serverTimestamp(),
      });
    }
    tx.update(featureRef, {
      steps: steps.map((s) => ({ title: s.title, description: s.description, kind: s.kind, status: 'pending', taskId: null })),
      status: 'plan_review',
      planningChargeInr: chargeInr,
      planningCostUsd: costUsd,
      updatedAt: FieldValue.serverTimestamp(),
    });
    // Stamp planning revenue + COGS on the task so adminMetrics counts the planning business too.
    tx.update(taskRef, {
      status: 'complete',
      actualCostUsd: costUsd,
      reviewedCostUsd: costUsd,
      finalCharge: chargeInr,
      billed: chargeInr > 0,
      actualCostInr: computeCharge(costUsd, { rate }).actualCostInr,
    });
  });
  await deleteSessionFiles(client, task);
}

// ===== "Design a screen" session finalizers =====
// The design session is multi-turn: it goes idle after EVERY turn. A question turn pauses the task
// (status 'awaiting') until the owner replies; a mock turn charges priceForPlanning on the cost since
// the last charge and opens the design for review. Failed/over-cap → design failed, never charged.

// A design turn produced clarifying questions (no mock) → show them and pause until the owner answers.
async function finalizeDesignQuestions(db, taskSnap, task, questions) {
  await db.collection('designs').doc(task.designId).update({
    status: 'clarifying',
    awaitingOwner: true,
    turns: FieldValue.arrayUnion({ role: 'agent', text: String(questions || 'Could you tell me a little more about what you want?').slice(0, 2000), at: Date.now() }),
    updatedAt: FieldValue.serverTimestamp(),
  }).catch((e) => console.warn('finalizeDesignQuestions', task.designId, e?.message || e));
  await taskSnap.ref.update({ status: 'awaiting' }); // paused; replyToClarify flips it back to running
}

// A design turn produced a mock → store the HTML, charge the design phase (bracketed cost-plus like
// a fix, on the cost since the last charge — covers exploration + this mock; a refine charges only
// its new cost), and open the design for review. Idempotent: guarded on the task still 'running'.
async function finalizeDesignMock(db, taskSnap, task, turn, costUsd) {
  const mockUrl = await saveMockHtml(task.designId, turn.mockHtml); // network — before the tx
  const rate = await getUsdToInrRate();
  const designRef = db.collection('designs').doc(task.designId);
  const orgRef = db.collection('organisations').doc(task.orgId);
  const taskRef = taskSnap.ref;
  await db.runTransaction(async (tx) => {
    const tSnap = await tx.get(taskRef);
    if (!tSnap.exists || tSnap.data().status !== 'running') return; // already finalized
    const dSnap = await tx.get(designRef);
    if (!dSnap.exists) return;
    const oSnap = await tx.get(orgRef);
    const reviewed = Number(tSnap.data().reviewedCostUsd) || 0;
    const roundUsd = Math.max(0, costUsd - reviewed);
    // The first mock is the priced deliverable (high markup); a refine (the design already has a
    // charge) is cheap iteration. Both on the cost since the last charge — a refine only pays for
    // its new work. See priceForDesign in shared/billing.js.
    const isRefine = (Number(dSnap.data().designChargeInr) || 0) > 0;
    const chargeInr = priceForDesign(roundUsd, { rate, isRefine });
    if (chargeInr > 0) {
      const balance = oSnap.exists ? Number(oSnap.data().balance ?? 0) : 0;
      tx.update(orgRef, { balance: balance - chargeInr });
      tx.set(db.collection('transactions').doc(), {
        orgId: task.orgId, userId: task.userId, type: 'debit', amount: chargeInr,
        designId: task.designId, kind: 'design', createdAt: FieldValue.serverTimestamp(),
      });
    }
    tx.update(designRef, {
      status: 'mockup_review',
      awaitingOwner: false,
      mockUrl: mockUrl || dSnap.data().mockUrl || null,
      // The approved mock markup + scope are handed to the builder so it reproduces what was
      // approved and changes ONLY what was asked (see designRun.buildAgentPrompt).
      mockHtml: turn.mockHtml || dSnap.data().mockHtml || null,
      scope: turn.scope || dSnap.data().scope || 'new_page',
      changeSummary: turn.changeSummary || dSnap.data().changeSummary || '',
      keepUnchanged: turn.keepUnchanged || dSnap.data().keepUnchanged || '',
      // The proposed build breakdown — prepopulated into the feature on approval (no re-plan, no
      // planning charge). Latest mock wins; a refine re-emits its own steps.
      steps: Array.isArray(turn.steps) && turn.steps.length ? turn.steps : (dSnap.data().steps || []),
      // Optional "make it even better" extras the owner can opt into on review. Latest mock is
      // authoritative — a refine re-emits its own list (empty once the screen is strong).
      suggestions: Array.isArray(turn.suggestions) ? turn.suggestions : [],
      brief: turn.brief || dSnap.data().brief || '',
      // Show the PLAIN brief on a mock turn, not the agent's freeform reply — the reply can carry
      // technical narrative (file names, CSS, build steps) that must never reach the owner.
      turns: FieldValue.arrayUnion({ role: 'agent', text: (turn.brief || 'Here’s how your screen will look.').slice(0, 2000), at: Date.now() }),
      designChargeInr: (Number(dSnap.data().designChargeInr) || 0) + chargeInr,
      designCostUsd: costUsd,
      updatedAt: FieldValue.serverTimestamp(),
    });
    // Stamp the design-phase revenue + COGS on the session task so adminMetrics (which sums
    // task.finalCharge / actualCostInr across all tasks) counts the design business, not just builds.
    const prevFinal = Number(tSnap.data().finalCharge) || 0;
    tx.update(taskRef, {
      status: 'awaiting',
      reviewedCostUsd: costUsd,
      finalCharge: prevFinal + chargeInr,
      billed: prevFinal + chargeInr > 0,
      actualCostUsd: costUsd,
      actualCostInr: computeCharge(costUsd, { rate }).actualCostInr,
    });
  });
}

// ===== "Size up the competition" session finalizers =====
// Same multi-turn shape as design: a question turn pauses the comparison (awaitingOwner) until the
// owner replies; a report turn charges priceForCompare and opens the report. Failed/over-cap → failed.

// A comparison turn produced questions (no report) → show them and pause until the owner answers.
async function finalizeCompareQuestions(db, taskSnap, task, questions) {
  await db.collection('comparisons').doc(task.comparisonId).update({
    status: 'analysing',
    awaitingOwner: true,
    turns: FieldValue.arrayUnion({ role: 'agent', text: String(questions || 'Could you tell me a little more so I can compare properly?').slice(0, 2000), at: Date.now() }),
    updatedAt: FieldValue.serverTimestamp(),
  }).catch((e) => console.warn('finalizeCompareQuestions', task.comparisonId, e?.message || e));
  await taskSnap.ref.update({ status: 'awaiting' }); // paused; replyToComparison flips it back to running
}

// A comparison turn produced a report → store it, charge the phase (priceForCompare on the cost since
// the last charge; a refine pays only its new cost), and open the report. Idempotent: guarded on the
// task still 'running'.
async function finalizeCompareReady(db, taskSnap, task, report, costUsd) {
  const rate = await getUsdToInrRate();
  const comparisonRef = db.collection('comparisons').doc(task.comparisonId);
  const orgRef = db.collection('organisations').doc(task.orgId);
  const taskRef = taskSnap.ref;
  // Render the shareable report HTML + persist it to Storage BEFORE the tx (network), same as the
  // design mock. Read prompt/repo first for the page; best-effort (reportUrl may be null).
  const cPre = await comparisonRef.get();
  const reportUrl = cPre.exists
    ? await saveReportHtml(task.comparisonId, renderReportHtml(report, { prompt: cPre.data().prompt || '', repoFullName: cPre.data().repoFullName || '' }))
    : null;
  await db.runTransaction(async (tx) => {
    const tSnap = await tx.get(taskRef);
    if (!tSnap.exists || tSnap.data().status !== 'running') return; // already finalized
    const cSnap = await tx.get(comparisonRef);
    if (!cSnap.exists) return;
    const oSnap = await tx.get(orgRef);
    const reviewed = Number(tSnap.data().reviewedCostUsd) || 0;
    const roundUsd = Math.max(0, costUsd - reviewed);
    // First report = priced deliverable (higher markup); a "look again" is a cheap refine. Both on
    // the cost since the last charge, so a refine only pays for its new work.
    const isRefine = (Number(cSnap.data().compareChargeInr) || 0) > 0;
    const chargeInr = priceForCompare(roundUsd, { rate, isRefine });
    if (chargeInr > 0) {
      const balance = oSnap.exists ? Number(oSnap.data().balance ?? 0) : 0;
      tx.update(orgRef, { balance: balance - chargeInr });
      tx.set(db.collection('transactions').doc(), {
        orgId: task.orgId, userId: task.userId, type: 'debit', amount: chargeInr,
        comparisonId: task.comparisonId, kind: 'compare', createdAt: FieldValue.serverTimestamp(),
      });
    }
    tx.update(comparisonRef, {
      status: 'report_ready',
      awaitingOwner: false,
      report,
      reportUrl: reportUrl || cSnap.data().reportUrl || null, // durable, shareable HTML in Storage
      turns: FieldValue.arrayUnion({ role: 'agent', text: (report.summary || 'Here’s how you compare.').slice(0, 2000), at: Date.now() }),
      compareChargeInr: (Number(cSnap.data().compareChargeInr) || 0) + chargeInr,
      compareCostUsd: costUsd,
      updatedAt: FieldValue.serverTimestamp(),
    });
    // Stamp the comparison-phase revenue + COGS on the task so adminMetrics counts this business too.
    const prevFinal = Number(tSnap.data().finalCharge) || 0;
    tx.update(taskRef, {
      status: 'awaiting',
      reviewedCostUsd: costUsd,
      finalCharge: prevFinal + chargeInr,
      billed: prevFinal + chargeInr > 0,
      actualCostUsd: costUsd,
      actualCostInr: computeCharge(costUsd, { rate }).actualCostInr,
    });
  });
}

// A comparison session failed / blew its cap → mark it failed. NEVER charged (same as a fix).
async function failCompare(db, taskSnap, task, reason, client) {
  await taskSnap.ref.update({ status: 'failed', error: reason });
  if (task.comparisonId) {
    await db.collection('comparisons').doc(task.comparisonId).update({ status: 'failed', error: reason }).catch(() => {});
  }
  await deleteSessionFiles(client, task);
}

// A design session failed / blew its cap → mark the design failed. NEVER charged (same as a fix).
async function failDesign(db, taskSnap, task, reason, client) {
  await taskSnap.ref.update({ status: 'failed', error: reason });
  if (task.designId) {
    await db.collection('designs').doc(task.designId).update({ status: 'failed', error: reason }).catch(() => {});
  }
  await deleteSessionFiles(client, task);
}

// Structured per-round usage line for Cloud Logging. The optimisation dashboard: token
// breakdown, cache-hit ratio, and the THIS-round split (cumulative minus what prior rounds
// already accounted for). Emitted only on a terminal transition so there's one clean line
// per round, not one a minute. `reason` is how the round ended (done|failed|timeout|over_budget).
function logAgentUsage(reason, taskId, task, bd, roundUsd, roundSec) {
  try {
    console.log(`AGENT_USAGE ${JSON.stringify({
      reason, taskId, sessionId: task.sessionId,
      complexity: task.complexity || null, model: task.model || null,
      modelRan: bd.model || null, priceFamily: bd.family || null,
      kind: task.pendingRound?.kind || task.kind || 'initial',
      round: (Array.isArray(task.rounds) ? task.rounds.length : 0) + 1,
      input: bd.input, output: bd.output, cacheRead: bd.cacheRead,
      cacheWrite5m: bd.cacheWrite5m, cacheWrite1h: bd.cacheWrite1h,
      cacheHitRatio: bd.cacheHitRatio,
      cumulativeUsd: round4(bd.totalUsd), roundUsd: round4(roundUsd),
      cumulativeSec: bd.runtimeSec, roundSec,
    })}`);
  } catch { /* noop — logging must never break the poller */ }
}
const round4 = (n) => Math.round((Number(n) || 0) * 1e4) / 1e4;

// Runs every minute. (1) For running tasks: read the session cost, terminate if it
// crosses the tier cap, bill on completion. (2) For completed tasks with a PR: poll
// GitHub for the Vercel preview URL and store it. Idempotent (billed / needsPreview guards).
export const pollSessions = onSchedule(
  { region: 'asia-south1', schedule: 'every 1 minutes', secrets: [ANTHROPIC_API_KEY] },
  async () => {
    const db = getFirestore();

    // (1) Finalize running sessions.
    const running = await db.collection('tasks').where('status', '==', 'running').limit(50).get();
    if (!running.empty) {
      const client = new Anthropic({
        apiKey: process.env.ANTHROPIC_API_KEY,
        defaultHeaders: { 'anthropic-beta': BETA },
      });
      for (const docSnap of running.docs) {
        const task = docSnap.data();
        if (!task.sessionId) continue;
        try {
          const session = await client.beta.sessions.retrieve(task.sessionId);
          const bd = usageBreakdown(session); // one parse: cost + token/cache observability
          const costUsd = bd.totalUsd; // cumulative across rounds
          const activeSec = bd.runtimeSec;
          const status = String(session?.status || '');
          // THIS round's split, used for both the cap checks below and the usage log.
          const roundUsd = costUsd - (Number(task.reviewedCostUsd) || 0);
          const roundSec = activeSec - (Number(task.reviewedSeconds) || 0);

          // Planning sessions finalize differently: parse the proposed steps + charge the
          // breakdown, instead of the fix round/PR flow. (Reuses the same cap guards.)
          if (task.kind === 'planning') {
            if (DONE.has(status)) {
              const steps = await extractPlan(client, task.sessionId);
              if (steps.length) await finalizePlanReady(db, docSnap, task, steps, costUsd, client);
              else await failPlan(db, docSnap, task, 'no_steps', client);
              continue;
            }
            if (FAILED.has(status)) { await failPlan(db, docSnap, task, 'agent_failed', client); continue; }
            await docSnap.ref.update({ liveCostUsd: costUsd, liveActiveSeconds: activeSec, liveUpdatedAt: FieldValue.serverTimestamp() });
            const overSec = activeSec > (Number(task.maxSeconds) || 600);
            const overUsd = costUsd > (Number(task.maxBudgetUsd) || 0.75);
            if (overSec || overUsd) {
              try { await client.beta.sessions.cancel(task.sessionId); } catch { /* best-effort */ }
              await failPlan(db, docSnap, task, overSec ? 'timeout' : 'over_budget', client);
            }
            continue;
          }

          // Design sessions are multi-turn: idle = a turn finished. A mock turn charges + opens
          // review; a question turn pauses for the owner. Same cap guards (cumulative, like planning).
          if (task.kind === 'design') {
            if (DONE.has(status)) {
              const turn = await extractDesignTurn(client, task.sessionId);
              if (turn.ready) await finalizeDesignMock(db, docSnap, task, turn, costUsd);
              else await finalizeDesignQuestions(db, docSnap, task, turn.questions);
              continue;
            }
            if (FAILED.has(status)) { await failDesign(db, docSnap, task, 'agent_failed', client); continue; }
            await docSnap.ref.update({ liveCostUsd: costUsd, liveActiveSeconds: activeSec, liveUpdatedAt: FieldValue.serverTimestamp() });
            const overSecD = activeSec > (Number(task.maxSeconds) || 1800);
            const overUsdD = costUsd > (Number(task.maxBudgetUsd) || 1.5);
            if (overSecD || overUsdD) {
              try { await client.beta.sessions.cancel(task.sessionId); } catch { /* best-effort */ }
              await failDesign(db, docSnap, task, overSecD ? 'timeout' : 'over_budget', client);
            }
            continue;
          }

          // Comparison sessions are multi-turn like design: a question turn pauses for the owner;
          // a report turn charges + opens the report. Same cap guards (cumulative).
          if (task.kind === 'compare') {
            if (DONE.has(status)) {
              const turn = await extractCompareTurn(client, task.sessionId);
              if (turn.ready) await finalizeCompareReady(db, docSnap, task, turn.report, costUsd);
              else await finalizeCompareQuestions(db, docSnap, task, turn.questions);
              continue;
            }
            if (FAILED.has(status)) { await failCompare(db, docSnap, task, 'agent_failed', client); continue; }
            await docSnap.ref.update({ liveCostUsd: costUsd, liveActiveSeconds: activeSec, liveUpdatedAt: FieldValue.serverTimestamp() });
            const overSecC = activeSec > (Number(task.maxSeconds) || 1800);
            const overUsdC = costUsd > (Number(task.maxBudgetUsd) || 1.5);
            if (overSecC || overUsdC) {
              try { await client.beta.sessions.cancel(task.sessionId); } catch { /* best-effort */ }
              await failCompare(db, docSnap, task, overSecC ? 'timeout' : 'over_budget', client);
            }
            continue;
          }

          // Feature BUILD step (has featureId; planning/design/compare kinds already handled + skipped
          // above, so this is a kind:'initial' step task). On DONE, bill this step its OWN incremental
          // COGS (capped at the feature-step ceiling), then — on the default no-approval path and while
          // still inside the safety-valve batch — auto-continue the SAME warm session into the next
          // step (no re-clone, no re-discovery). The batch's final step (valve full / last step / an
          // approval org) arms a single deploy for the owner. FAILED marks the step failed (never
          // charged). Still-running feature steps fall through to the generic per-round cap guards.
          if (task.featureId) {
            if (DONE.has(status)) {
              const featureSnap = await db.collection('features').doc(task.featureId).get();
              const steps = featureSnap.exists && Array.isArray(featureSnap.data().steps) ? featureSnap.data().steps : [];
              const stepIndex = Number(task.stepIndex) || 0;
              const isLastStep = stepIndex + 1 >= steps.length;
              const nextIsAdded = !!steps[stepIndex + 1]?.added; // follow-up changes start their own session
              const batchFull = (Number(task.sessionStepCount) || 1) >= FEATURE_MAX_STEPS_PER_SESSION;
              const orgSnap = await db.collection('organisations').doc(task.orgId).get();
              const requireApproval = orgSnap.exists && orgSnap.data().requireApproval === true;
              const willAutoContinue = !requireApproval && !isLastStep && !batchFull && !nextIsAdded;

              logAgentUsage('done', docSnap.id, task, bd, roundUsd, roundSec);
              const { resultSummary, filesChanged, prUrl, idealDescription, idealKeywords, briefScore } = await extractResult(client, task.sessionId);
              await markRoundReady(docSnap.id, {
                actualCostUsd: costUsd, activeSeconds: activeSec,
                resultSummary, filesChanged, prUrl, idealDescription, idealKeywords, briefScore,
                chargeCapInr: MAX_FEATURE_STEP_CHARGE_INR, suppressDeploy: willAutoContinue,
              });
              if (willAutoContinue) {
                // Keep the session warm — do NOT delete its mounted key files yet; carry them forward.
                try {
                  await continueFeatureStep(db, task.featureId, stepIndex + 1, {
                    sessionId: task.sessionId,
                    reviewedCostUsd: costUsd,
                    reviewedSeconds: activeSec,
                    sessionStepCount: (Number(task.sessionStepCount) || 1) + 1,
                    firebaseFileIds: task.firebaseFileIds || [],
                  });
                } catch (e) {
                  console.error('pollSessions:feature_continue', docSnap.id, e?.message || e);
                }
              } else {
                await deleteSessionFiles(client, task); // batch-final — the warm session is done
              }
              continue;
            }
            if (FAILED.has(status)) {
              logAgentUsage('failed', docSnap.id, task, bd, roundUsd, roundSec);
              await markRoundFailure(docSnap.id, { error: 'agent_failed', actualCostUsd: costUsd });
              await deleteSessionFiles(client, task);
              continue;
            }
            // still running → fall through to the generic live-snapshot + per-round cap guards below.
          }

          // Terminal status first. The runtime/budget caps below are mid-flight guards that
          // stop a runaway session — they MUST NOT override a session that already finished
          // (status=completed, PR pushed). Otherwise a run that finishes a hair over budget
          // gets marked failed even though the work is real and the customer has a PR.
          if (DONE.has(status)) {
            // Round done → ready for the customer to review. We do NOT charge here; the
            // charge happens when they approve the fix (approveFix).
            logAgentUsage('done', docSnap.id, task, bd, roundUsd, roundSec);
            const { resultSummary, filesChanged, prUrl, idealDescription, idealKeywords, briefScore } = await extractResult(client, task.sessionId);
            await markRoundReady(docSnap.id, { actualCostUsd: costUsd, activeSeconds: activeSec, resultSummary, filesChanged, prUrl, idealDescription, idealKeywords, briefScore });
            continue;
          }
          if (FAILED.has(status)) {
            logAgentUsage('failed', docSnap.id, task, bd, roundUsd, roundSec);
            await markRoundFailure(docSnap.id, { error: 'agent_failed', actualCostUsd: costUsd });
            await deleteSessionFiles(client, task);
            continue;
          }

          // Still in-flight. Stamp a live snapshot for the admin UI's progress meter
          // (cost so far + active seconds + when we last polled). Customer-facing reads
          // strip these; admin reads expose them via adminListTasks.
          await docSnap.ref.update({
            liveCostUsd: costUsd,
            liveActiveSeconds: activeSec,
            liveUpdatedAt: FieldValue.serverTimestamp(),
          });

          // Enforce the per-round caps so a runaway session can't bleed us.
          const cap = task.maxBudgetUsd || Number(process.env.AGENT_MAX_BUDGET_USD) || 3;

          // Runtime backstop — the PRIMARY guard. `session.usage` can report $0 for minutes
          // while the agent really is burning tokens, so the cost check above goes blind and a
          // run can blow many times past its $ cap before the cost lands. Active runtime is
          // always reported, so we cap it per TIER. Per-round (`roundSec`, computed above)
          // so a revision isn't killed by earlier rounds. Falls back to the global
          // MAX_SESSION_SECONDS for runs with no tier cap (operator infra tests, big-job quotes).
          const maxSec = Number(task.maxSeconds) || Number(process.env.MAX_SESSION_SECONDS) || 1800;
          if (roundSec > maxSec) {
            try { await client.beta.sessions.cancel(task.sessionId); } catch { /* CONFIRM cancel */ }
            logAgentUsage('timeout', docSnap.id, task, bd, roundUsd, roundSec);
            await markRoundFailure(docSnap.id, { error: 'timeout', actualCostUsd: costUsd });
            await deleteSessionFiles(client, task);
            continue;
          }

          if (roundUsd > cap) {
            try { await client.beta.sessions.cancel(task.sessionId); } catch { /* CONFIRM cancel */ }
            logAgentUsage('over_budget', docSnap.id, task, bd, roundUsd, roundSec);
            await markRoundFailure(docSnap.id, { error: 'over_budget', actualCostUsd: costUsd });
            await deleteSessionFiles(client, task);
            continue;
          }
        } catch (e) {
          console.error('pollSessions:run', docSnap.id, e?.message || e);
        }
      }
    }

    // (2) Fetch the Vercel preview URL for completed-with-PR tasks.
    const pending = await db.collection('tasks').where('needsPreview', '==', true).limit(20).get();
    for (const docSnap of pending.docs) {
      const t = docSnap.data();
      try {
        const prNum = t.prUrl ? Number(String(t.prUrl).split('/').pop()) : null;
        if (!prNum || !t.repoFullName || !t.orgId) {
          await docSnap.ref.update({ needsPreview: false });
          continue;
        }
        const secret = await db.collection('orgSecrets').doc(t.orgId).get();
        const token = secret.exists ? secret.data().githubToken : null;
        if (!token) {
          await docSnap.ref.update({ needsPreview: false });
          continue;
        }
        const url = await fetchPrPreviewUrl(t.repoFullName, prNum, token);
        const tries = (t.previewTries || 0) + 1;
        if (url) {
          await docSnap.ref.update({ previewUrl: url, needsPreview: false });
        } else {
          await docSnap.ref.update({ previewTries: tries, needsPreview: tries < MAX_PREVIEW_TRIES });
        }
      } catch (e) {
        console.error('pollSessions:preview', docSnap.id, e?.message || e);
      }
    }

    // (2b) Firebase-host AUTO-DEPLOY: a fix just became ready — deploy its PR branch to the
    // testing site automatically (no owner action), so testing always shows the latest fix.
    const autoDeploy = await db.collection('tasks').where('needsAutoDeploy', '==', true).limit(20).get();
    const autoOrgCache = new Map();
    for (const docSnap of autoDeploy.docs) {
      const t = docSnap.data();
      try {
        const prNum = t.prUrl ? Number(String(t.prUrl).split('/').pop()) : null;
        if (!prNum || !t.repoFullName || !t.orgId) { await docSnap.ref.update({ needsAutoDeploy: false }); continue; }
        let org = autoOrgCache.get(t.orgId);
        if (!org) {
          const os = await db.collection('organisations').doc(t.orgId).get();
          org = os.exists ? os.data() : {};
          autoOrgCache.set(t.orgId, org);
        }
        if (org.deploy?.host !== 'firebase') { await docSnap.ref.update({ needsAutoDeploy: false }); continue; }
        const secret = await db.collection('orgSecrets').doc(t.orgId).get();
        const token = secret.exists ? secret.data().githubToken : null;
        if (!token) { await docSnap.ref.update({ needsAutoDeploy: false }); continue; }

        const baseBranch = org.github?.baseBranch || 'main';
        const workflow = org.deploy?.firebase?.testingWorkflow || 'bosun-deploy-testing.yml';
        const testingUrl = org.deploy?.firebase?.testingUrl || null;
        const headRef = await getPrHeadRef(t.repoFullName, prNum, token);
        if (!headRef) { await docSnap.ref.update({ needsAutoDeploy: false }); continue; }

        await dispatchWorkflow(t.repoFullName, workflow, baseBranch, { ref: headRef }, token);
        await docSnap.ref.update({
          needsAutoDeploy: false,
          previewActive: true,
          previewDeploying: true,
          previewRef: headRef,
          previewUrl: testingUrl,
          previewError: null,
          previewRequestedAt: FieldValue.serverTimestamp(),
        });
        // Meter this CI run (best-effort — never undo the deploy over a billing hiccup).
        try { await chargeCiRun(db, { orgId: t.orgId, taskId: docSnap.id, userId: t.userId, runKind: 'preview' }); }
        catch (e) { console.error('pollSessions:ci', docSnap.id, e?.message || e); }
      } catch (e) {
        console.error('pollSessions:autodeploy', docSnap.id, e?.message || e);
      }
    }

    // (3) Firebase-host preview/revert: a deploy was dispatched to the testing site. Watch the
    // repo's workflow run and clear the "deploying" spinner once it finishes (record any failure).
    const deploying = await db.collection('tasks').where('previewDeploying', '==', true).limit(20).get();
    const orgCache = new Map();
    for (const docSnap of deploying.docs) {
      const t = docSnap.data();
      try {
        if (!t.repoFullName || !t.orgId) { await docSnap.ref.update({ previewDeploying: false }); continue; }
        let org = orgCache.get(t.orgId);
        if (!org) {
          const os = await db.collection('organisations').doc(t.orgId).get();
          org = os.exists ? os.data() : {};
          orgCache.set(t.orgId, org);
        }
        const secret = await db.collection('orgSecrets').doc(t.orgId).get();
        const token = secret.exists ? secret.data().githubToken : null;
        const workflow = org.deploy?.firebase?.testingWorkflow || 'bosun-deploy-testing.yml';
        if (!token) { await docSnap.ref.update({ previewDeploying: false }); continue; }

        const run = await latestWorkflowRun(t.repoFullName, workflow, token, { branch: t.previewRef || undefined });
        // Only conclude on a run that started at/after we asked (avoids reading a stale prior run).
        const reqAt = t.previewRequestedAt?.toMillis?.() ?? 0;
        if (run && run.status === 'completed' && run.createdAt >= reqAt - 60_000) {
          await docSnap.ref.update({
            previewDeploying: false,
            previewError: run.conclusion === 'success' ? null : `deploy_${run.conclusion || 'failed'}`,
          });
        }
        // else: still queued/in-progress (or no run yet) — leave the spinner; re-check next tick.
      } catch (e) {
        console.error('pollSessions:fbpreview', docSnap.id, e?.message || e);
      }
    }
  }
);
