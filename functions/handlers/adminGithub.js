import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { ensureOrgGithubVault, ensureOrgJamCredential } from '../utils/vault.js';
import { ANTHROPIC_API_KEY, JAM_PAT } from '../utils/secrets.js';
import Anthropic from '@anthropic-ai/sdk';
import { startFixSession, firebaseSAsFromSecret, platformSessionUrl } from '../utils/claudeAgent.js';
import { tierFor, usdToInr } from '../utils/billing.js';
import { classifyComplexity } from '../utils/classify.js';
import { markRoundFailure, awardShipPoints } from '../utils/finalize.js';
import { advanceFeature } from '../utils/featureRun.js';
import { sessionCostUsd } from '../utils/agentResult.js';
import { resolveModel, agentIdForModel, OVERRIDABLE_MODELS } from '../utils/routeModel.js';
import { mergePullRequest, createReleaseTag, dispatchWorkflow, getPrHeadRef } from '../utils/github.js';
import { isMember } from '../utils/orgs.js';
import { sanitizeImages } from '../utils/images.js';
import { requireAdmin } from '../utils/admin.js';

const BETA = 'managed-agents-2026-04-01';

// Operator provisions an org's GitHub repo + token. Stores repoFullName + vaultId on the
// org doc (non-secret), the token in orgSecrets/{orgId} (backend-only), and sets up the
// org's vault credential for the GitHub MCP so the agent can open PRs.
export const adminSetGithubRepo = onCall(
  { region: 'asia-south1', secrets: [ANTHROPIC_API_KEY, JAM_PAT] },
  async (request) => {
    requireAdmin(request);
    const orgId = String(request.data?.orgId ?? '').trim();
    const repoFullName = String(request.data?.repoFullName ?? '')
      .trim()
      .replace(/^https?:\/\/github\.com\//i, '')
      .replace(/\.git$/i, '')
      .replace(/\/$/, '');
    const token = String(request.data?.token ?? '').trim();
    if (!orgId || !repoFullName || !token) {
      throw new HttpsError('invalid-argument', 'orgId, repoFullName and token are required.');
    }
    if (!/^[^/\s]+\/[^/\s]+$/.test(repoFullName)) {
      throw new HttpsError('invalid-argument', 'repoFullName must look like owner/repo.');
    }

    // The repo's default/integration branch — what PRs merge into and release tags are cut from.
    // Defaults to 'main'; set to 'master' (or any branch) per repo. Bosun never assumes 'main'.
    const baseBranch = String(request.data?.baseBranch ?? 'main').trim() || 'main';

    // Deploy model. 'vercel' (default) = Vercel builds previews automatically and a merge/tag
    // triggers the repo's Vercel+Firebase Actions (the original flow). 'firebase' = a Firebase-
    // hosting-only repo with NO automatic preview: Bosun deploys a PR branch to the testing site
    // on demand (preview), merges on "deploy to testing", and can redeploy the base branch (revert).
    const deployHost = request.data?.deployHost === 'firebase' ? 'firebase' : 'vercel';
    const fb = request.data?.firebase || {};
    const firebaseCfg = deployHost === 'firebase'
      ? {
          testingProject: String(fb.testingProject ?? '').trim(),
          prodProject: String(fb.prodProject ?? '').trim(),
          testingUrl: String(fb.testingUrl ?? '').trim().replace(/\/$/, ''),
          // The repo's testing workflow we dispatch for preview/revert (it also runs on a base
          // push). Defaults to the Bosun-seeded file name.
          testingWorkflow: String(fb.testingWorkflow ?? 'bosun-deploy-testing.yml').trim(),
        }
      : null;
    if (deployHost === 'firebase' && (!firebaseCfg.testingProject || !firebaseCfg.prodProject)) {
      throw new HttpsError('invalid-argument', 'firebase.testingProject and firebase.prodProject are required for a Firebase host.');
    }

    const db = getFirestore();
    const orgRef = db.collection('organisations').doc(orgId);
    const orgSnap = await orgRef.get();
    if (!orgSnap.exists) throw new HttpsError('not-found', 'Organisation not found.');

    const existingVaultId = orgSnap.data().github?.vaultId;
    const vaultId = await ensureOrgGithubVault({ orgId, vaultId: existingVaultId, token });

    // Also seed the shared Jam PAT so the agent can read a customer-shared jam.dev recording.
    // Best-effort + idempotent: a missing/invalid PAT must never block connecting the repo.
    try {
      await ensureOrgJamCredential({ vaultId, token: process.env.JAM_PAT });
    } catch (e) {
      console.warn('adminSetGithubRepo:jam_credential', orgId, e?.message || e);
    }

    await orgRef.set(
      {
        github: { repoFullName, vaultId, baseBranch, connectedAt: FieldValue.serverTimestamp() },
        deploy: { host: deployHost, ...(firebaseCfg ? { firebase: firebaseCfg } : {}) },
      },
      { merge: true }
    );
    await db.collection('orgSecrets').doc(orgId).set(
      { githubToken: token, updatedAt: FieldValue.serverTimestamp() },
      { merge: true }
    );

    return { ok: true, repoFullName };
  }
);

// Operator-only: run a fix against ANY org's connected repo (for testing). Same as
// createTask, but the org is chosen explicitly and the caller is gated by ADMIN_EMAILS.
export const adminRunFix = onCall(
  { region: 'asia-south1', secrets: [ANTHROPIC_API_KEY] },
  async (request) => {
    requireAdmin(request);
    const uid = request.auth.uid;
    const orgId = String(request.data?.orgId ?? '').trim();
    const prompt = String(request.data?.prompt ?? '').trim();
    if (!orgId || !prompt) throw new HttpsError('invalid-argument', 'orgId and prompt are required.');
    const images = sanitizeImages(request.data?.images);

    const db = getFirestore();
    const orgSnap = await db.collection('organisations').doc(orgId).get();
    if (!orgSnap.exists) throw new HttpsError('not-found', 'Organisation not found.');
    const org = orgSnap.data();
    const gh = org.github;
    if (!gh?.repoFullName || !gh?.vaultId) throw new HttpsError('failed-precondition', 'NO_REPO_CONNECTED');

    // "Run as customer" exercises the REAL customer pipeline (classify → fixed-tier price →
    // large→quote), so the operator can test pricing end-to-end. Default (false) is the old
    // plain infra test: flat cap, no classification, no charge.
    const asCustomer = request.data?.asCustomer === true;

    // Optional operator model override ('sonnet' | 'opus'), set from the "Test a fix" launcher.
    // When present it wins over the cost-aware default; we persist it so a deferred run (a
    // big-job quote confirmed later) honours the same choice. null = use the default routing.
    const modelOverride = OVERRIDABLE_MODELS.includes(request.data?.model) ? request.data.model : null;

    if (asCustomer) {
      let complexity = String(request.data?.complexity ?? '').trim();
      if (!['simple', 'medium', 'complex', 'large'].includes(complexity)) {
        ({ complexity } = await classifyComplexity(prompt));
      }

      // Big job → park for a quote (operator quotes, then confirm). Nothing runs/charges yet.
      if (complexity === 'large') {
        const quoteRef = db.collection('tasks').doc();
        await quoteRef.set({
          userId: uid, orgId, prompt, repoFullName: gh.repoFullName,
          kind: 'initial', complexity: 'large', status: 'needs_quote',
          billed: false, approved: false, pendingReview: false,
          finalCharge: 0, currentRoundCharge: 0, freeRevisionsUsed: 0,
          adminRun: true, asCustomer: true, modelOverride, imageCount: images.length,
          createdAt: FieldValue.serverTimestamp(),
        });
        return { taskId: quoteRef.id, needsQuote: true };
      }

      const tier = tierFor(complexity);
      const secretSnap = await db.collection('orgSecrets').doc(orgId).get();
      const secretData = secretSnap.exists ? secretSnap.data() : {};
      const githubToken = secretData.githubToken;
      if (!githubToken) throw new HttpsError('failed-precondition', 'NO_REPO_CONNECTED');
      const firebaseSAs = firebaseSAsFromSecret(secretData);

      const model = resolveModel(complexity, modelOverride);
      const taskRef = db.collection('tasks').doc();
      await taskRef.set({
        userId: uid, orgId, prompt, repoFullName: gh.repoFullName,
        kind: 'initial', complexity, model, modelOverride, status: 'queued',
        billed: false, approved: false, pendingReview: false,
        maxBudgetUsd: tier.maxBudgetUsd, maxSeconds: tier.maxSeconds,
        currentRoundCharge: 0, finalCharge: 0, freeRevisionsUsed: 0,
        pendingRound: { kind: 'initial', reason: null, addedInr: 0, prompt },
        adminRun: true, asCustomer: true, imageCount: 0,
        createdAt: FieldValue.serverTimestamp(),
      });
      try {
        const { sessionId, firebaseFileIds } = await startFixSession({
          prompt, images, repoUrl: `https://github.com/${gh.repoFullName}`,
          githubToken, vaultId: gh.vaultId, agentId: agentIdForModel(model), firebaseSAs,
        });
        await taskRef.update({ status: 'running', sessionId, firebaseFileIds: firebaseFileIds || [] });
      } catch {
        await taskRef.update({ status: 'failed', error: 'dispatch_failed' });
        throw new HttpsError('internal', 'Could not start the fix.');
      }
      return { taskId: taskRef.id };
    }

    // Plain infra test (operator only): flat cap, no classification, no charge.
    const maxBudgetUsd = Number(process.env.AGENT_MAX_BUDGET_USD) || 3;

    const secretSnap = await db.collection('orgSecrets').doc(orgId).get();
    const secretData = secretSnap.exists ? secretSnap.data() : {};
    const githubToken = secretData.githubToken;
    if (!githubToken) throw new HttpsError('failed-precondition', 'NO_REPO_CONNECTED');
    const firebaseSAs = firebaseSAsFromSecret(secretData);

    // Operator may force a model for testing; otherwise derive it from an optional
    // complexity hint (defaults to Sonnet, matching the customer path).
    const model = resolveModel(String(request.data?.complexity ?? '').trim(), modelOverride);
    const taskRef = db.collection('tasks').doc();
    await taskRef.set({
      userId: uid,
      orgId,
      prompt,
      repoFullName: gh.repoFullName,
      kind: 'initial',
      model,
      modelOverride,
      status: 'queued',
      billed: false,
      adminRun: true,
      maxBudgetUsd,
      imageCount: images.length,
      createdAt: FieldValue.serverTimestamp(),
    });

    try {
      const { sessionId, firebaseFileIds } = await startFixSession({
        prompt,
        images,
        repoUrl: `https://github.com/${gh.repoFullName}`,
        githubToken,
        vaultId: gh.vaultId,
        agentId: agentIdForModel(model),
        firebaseSAs,
      });
      await taskRef.update({ status: 'running', sessionId, firebaseFileIds: firebaseFileIds || [] });
    } catch {
      await taskRef.update({ status: 'failed', error: 'dispatch_failed' });
      throw new HttpsError('internal', 'Could not start the fix.');
    }
    return { taskId: taskRef.id };
  }
);

// Operator: list an org's fix sessions (tasks), newest first.
export const adminListTasks = onCall({ region: 'asia-south1' }, async (request) => {
  requireAdmin(request);
  const orgId = String(request.data?.orgId ?? '').trim();
  const db = getFirestore();
  let q = db.collection('tasks');
  if (orgId) q = q.where('orgId', '==', orgId);
  const snap = await q.orderBy('createdAt', 'desc').limit(50).get();
  const docs = snap.docs;

  // Resolve trigger emails from /users in one batched fetch so the admin can see
  // who kicked off each run without paying N round-trips per page render.
  const uids = [...new Set(docs.map((d) => d.data().userId).filter(Boolean))];
  const emailByUid = {};
  if (uids.length) {
    const userSnaps = await db.getAll(...uids.map((u) => db.collection('users').doc(u)));
    for (const us of userSnaps) {
      if (us.exists) emailByUid[us.id] = us.data().email ?? null;
    }
  }

  return {
    tasks: docs.map((d) => {
      const t = d.data();
      return {
        id: d.id,
        prompt: t.prompt ?? '',
        status: t.status ?? null,
        complexity: t.complexity ?? null,
        quotedInr: t.quotedInr ?? null,
        priceInr: t.priceInr ?? null,
        currentRoundCharge: t.currentRoundCharge ?? null,
        pendingReview: t.pendingReview ?? false,
        approved: t.approved ?? false,
        adminRun: t.adminRun ?? false,
        asCustomer: t.asCustomer ?? false,
        model: t.model ?? null,
        modelOverride: t.modelOverride ?? null, // operator-forced model, if any
        // The managed-agent session + a deep link to its trace on the Claude platform, so the
        // operator can inspect events/tool calls/cost. Admin-only (stripped from customer reads).
        sessionId: t.sessionId ?? null,
        platformUrl: platformSessionUrl(t.sessionId),
        finalCharge: t.finalCharge ?? null,
        actualCostInr: t.actualCostInr ?? null,
        prUrl: t.prUrl ?? null,
        previewUrl: t.previewUrl ?? null,
        resultSummary: t.resultSummary ?? null,
        error: t.error ?? null,
        repoFullName: t.repoFullName ?? null,
        deployedTesting: t.deployedTesting ?? false,
        deployedProd: t.deployedProd ?? false,
        // Live progress fields (only meaningful while status === 'running'; the
        // poller refreshes them ~every minute, admin UI uses them for a progress meter).
        liveCostUsd: t.liveCostUsd ?? null,
        liveActiveSeconds: t.liveActiveSeconds ?? null,
        liveUpdatedAt: t.liveUpdatedAt?.toMillis?.() ?? null,
        maxBudgetUsd: t.maxBudgetUsd ?? null,
        maxSeconds: t.maxSeconds ?? null,
        createdAt: t.createdAt?.toMillis?.() ?? null,
        userEmail: t.userId ? (emailByUid[t.userId] ?? null) : null,
      };
    }),
  };
});

// Operator: list "Plan a feature" features as their OWN group (separate from the raw fix
// Sessions list), newest first, each with the full cost breakdown — the planning (breakdown)
// charge + its COGS, then every step's paid/cost/margin, plus running totals (planning + steps).
// Each step is an ordinary fix task, so we batch-fetch those (and the planning task) in one
// round-trip and compose the view the same way listMyFeatures does, but with operator-only cost
// + session detail. orgId is optional: omit it for an all-organisations view.
export const adminListFeatures = onCall({ region: 'asia-south1' }, async (request) => {
  requireAdmin(request);
  const orgId = String(request.data?.orgId ?? '').trim();
  const db = getFirestore();
  let q = db.collection('features');
  if (orgId) q = q.where('orgId', '==', orgId);
  const snap = await q.orderBy('createdAt', 'desc').limit(50).get();
  const docs = snap.docs;
  if (!docs.length) return { features: [] };

  // One batched fetch of every step task + each feature's planning task, so the per-feature
  // breakdown costs no extra round-trips per render.
  const taskIds = new Set();
  for (const d of docs) {
    const f = d.data();
    for (const s of f.steps || []) if (s.taskId) taskIds.add(s.taskId);
    if (f.planningTaskId) taskIds.add(f.planningTaskId);
  }
  const taskById = {};
  if (taskIds.size) {
    const ids = [...taskIds];
    const taskSnaps = await db.getAll(...ids.map((id) => db.collection('tasks').doc(id)));
    for (const ts of taskSnaps) if (ts.exists) taskById[ts.id] = ts.data();
  }

  // Trigger emails (who started the feature) in one batched fetch.
  const uids = [...new Set(docs.map((d) => d.data().userId).filter(Boolean))];
  const emailByUid = {};
  if (uids.length) {
    const userSnaps = await db.getAll(...uids.map((u) => db.collection('users').doc(u)));
    for (const us of userSnaps) if (us.exists) emailByUid[us.id] = us.data().email ?? null;
  }

  const features = docs.map((d) => {
    const f = d.data();
    const rawSteps = Array.isArray(f.steps) ? f.steps : [];
    // Before the plan is approved the steps are just a proposal — no tasks, no cost yet.
    const isBuilding = f.status === 'running' || f.status === 'complete';

    let paidStepsInr = 0;
    let costStepsInr = 0;
    let activeIndex = -1;
    const steps = rawSteps.map((s, i) => {
      const t = s.taskId ? taskById[s.taskId] : null;
      const deployed = !!(t && (t.deployedTesting || t.deployedProd));
      let status;
      if (!isBuilding) status = 'proposed';
      else if (!t) status = 'pending';
      else if (deployed) status = 'done';
      else if (t.status === 'failed') status = 'failed';
      else if (t.status === 'complete') status = 'built'; // finished, not yet deployed
      else status = 'running';
      if (t) {
        paidStepsInr += Number(t.finalCharge) || 0;
        costStepsInr += Number(t.actualCostInr) || 0;
      }
      if ((status === 'running' || status === 'failed') && activeIndex === -1) activeIndex = i;
      return {
        title: s.title || '',
        description: s.description || '',
        kind: s.kind === 'dynamic' ? 'dynamic' : 'static',
        added: s.added === true, // a follow-up change appended after the feature completed
        status,
        taskId: s.taskId || null,
        taskStatus: t?.status ?? null,
        model: t?.model ?? null,
        paidInr: t ? Number(t.finalCharge) || 0 : 0,
        costInr: t ? Number(t.actualCostInr) || 0 : 0,
        costUsd: t ? Number(t.actualCostUsd) || 0 : 0,
        currentRoundCharge: t?.currentRoundCharge ?? null,
        pendingReview: t?.pendingReview ?? false,
        approved: t?.approved ?? false,
        summary: t?.resultSummary ?? null,
        error: t?.error ?? null,
        prUrl: t?.prUrl ?? null,
        previewUrl: t?.previewUrl ?? null,
        platformUrl: platformSessionUrl(t?.sessionId),
        deployedTesting: t?.deployedTesting ?? false,
        deployedProd: t?.deployedProd ?? false,
        // Live progress (meaningful only while a step is running).
        liveCostUsd: t?.liveCostUsd ?? null,
        liveActiveSeconds: t?.liveActiveSeconds ?? null,
        liveUpdatedAt: t?.liveUpdatedAt?.toMillis?.() ?? null,
        maxBudgetUsd: t?.maxBudgetUsd ?? null,
        maxSeconds: t?.maxSeconds ?? null,
      };
    });

    const allDone = isBuilding && rawSteps.length > 0 && steps.every((st) => st.status === 'done');
    // Lifecycle straight from the doc, upgraded running→complete once every step has shipped.
    const status = f.status === 'running' && allDone ? 'complete' : (f.status || 'planning');

    // Planning (breakdown) is the one NON-bracketed charge: 2× its own COGS, debited up front.
    const planningChargeInr = Number(f.planningChargeInr) || 0;
    const planningCostUsd = Number(f.planningCostUsd) || 0;
    const planningCostInr = usdToInr(planningCostUsd);
    const planningTask = f.planningTaskId ? taskById[f.planningTaskId] : null;

    const totalPaidInr = planningChargeInr + paidStepsInr;
    const totalCostInr = planningCostInr + costStepsInr;

    return {
      id: d.id,
      orgId: f.orgId ?? null,
      prompt: f.prompt || '',
      status, // planning | plan_review | plan_failed | running | complete
      error: f.error ?? null,
      stepCount: rawSteps.length,
      currentStep: activeIndex === -1 ? rawSteps.length : activeIndex,
      // Planning (breakdown) charge + COGS + a deep link to the planning session's trace.
      planningChargeInr,
      planningCostUsd,
      planningCostInr,
      planningStatus: planningTask?.status ?? null,
      planningSessionUrl: platformSessionUrl(planningTask?.sessionId),
      // Per-step breakdown + running totals (planning + every step) and the blended margin.
      steps,
      totalPaidInr,
      totalCostInr,
      totalMarginInr: totalPaidInr - totalCostInr,
      createdAt: f.createdAt?.toMillis?.() ?? null,
      updatedAt: f.updatedAt?.toMillis?.() ?? null,
      userEmail: f.userId ? (emailByUid[f.userId] ?? null) : null,
    };
  });

  return { features };
});

// Deploy to TESTING = merge the PR into its base (main). The push triggers the
// customer's deploy-testing GitHub Action (Vercel testing + Firebase testing).
// Operator kill-switch: stop a queued/running fix mid-flight. Cancels the agent session and
// marks the task failed (never charged). Works for both customer and test runs.
export const adminStopTask = onCall(
  { region: 'asia-south1', secrets: [ANTHROPIC_API_KEY] },
  async (request) => {
    requireAdmin(request);
    const taskId = String(request.data?.taskId ?? '').trim();
    if (!taskId) throw new HttpsError('invalid-argument', 'taskId required.');
    const db = getFirestore();
    const snap = await db.collection('tasks').doc(taskId).get();
    if (!snap.exists) throw new HttpsError('not-found', 'Task not found.');
    const t = snap.data();
    if (!['queued', 'running'].includes(t.status)) {
      throw new HttpsError('failed-precondition', 'This task is not running.');
    }
    // Read the session's cost BEFORE cancelling so the stopped run still records the COGS
    // we ate (markRoundFailure stores it; admin P&L shows the loss).
    let costUsd = 0;
    if (t.sessionId) {
      try {
        const client = new Anthropic({
          apiKey: process.env.ANTHROPIC_API_KEY,
          defaultHeaders: { 'anthropic-beta': BETA },
        });
        try { costUsd = sessionCostUsd(await client.beta.sessions.retrieve(t.sessionId)); } catch { /* best-effort */ }
        await client.beta.sessions.cancel(t.sessionId);
      } catch (e) {
        console.error('adminStopTask:cancel', taskId, e?.message || e);
      }
    }
    await markRoundFailure(taskId, { error: 'stopped_by_admin', actualCostUsd: costUsd });
    return { ok: true };
  }
);

// --- Deploy cores (auth-agnostic) — shared by the admin and customer entry points. ---

// Deploy to TESTING = merge the task's PR into its base (main). The push triggers the
// customer's deploy-testing GitHub Action (Vercel testing + Firebase testing).
async function deployTaskToTesting(db, taskId) {
  const ref = db.collection('tasks').doc(taskId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Task not found.');
  const t = snap.data();
  if (!t.prUrl) throw new HttpsError('failed-precondition', 'This task has no pull request to merge.');
  const prNum = Number(String(t.prUrl).split('/').pop());

  const secret = await db.collection('orgSecrets').doc(t.orgId).get();
  const token = secret.exists ? secret.data().githubToken : null;
  if (!token) throw new HttpsError('failed-precondition', 'No GitHub token for this organisation.');

  await mergePullRequest(t.repoFullName, prNum, token);
  // The merge pushes the base branch; for a Firebase host that auto-redeploys the (now merged)
  // base to the testing site, so any branch-preview that was sitting on testing is superseded.
  await ref.update({
    deployedTesting: true,
    deployedTestingAt: FieldValue.serverTimestamp(),
    previewActive: false,
    previewDeploying: false,
  });
  // Credit the "went live for review" milestone to the employee (best-effort; never blocks
  // the deploy). Idempotent — guarded by the task's shipPointsAwarded flag.
  try { await awardShipPoints(taskId); } catch (e) { console.error('awardShipPoints', taskId, e?.message || e); }
  // If this task is a feature step, merging it to main is the cue to start the next step (its
  // agent now clones the updated main and builds on this one). Best-effort, never throws.
  await advanceFeature(db, taskId);
  return { ok: true };
}

// Deploy to PRODUCTION = create a release tag at `main`'s head. Pushing the tag triggers the
// customer's deploy-prod GitHub Action (Vercel --prod + Firebase prod); Bosun never deploys
// directly. Assumes the fix is already on `main` (deploy to testing merges the PR first).
async function deployTaskToProd(db, taskId) {
  const ref = db.collection('tasks').doc(taskId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Task not found.');
  const t = snap.data();

  const orgSnap = await db.collection('organisations').doc(t.orgId).get();
  const baseBranch = (orgSnap.exists && orgSnap.data().github?.baseBranch) || 'main';

  const secret = await db.collection('orgSecrets').doc(t.orgId).get();
  const token = secret.exists ? secret.data().githubToken : null;
  if (!token) throw new HttpsError('failed-precondition', 'No GitHub token for this organisation.');

  const result = await createReleaseTag(t.repoFullName, baseBranch, token);
  await ref.update({ deployedProd: true, deployedProdAt: FieldValue.serverTimestamp(), releaseTag: result.tag });
  return { ok: true, ...result };
}

// --- Firebase-hosting-only: preview a PR branch on the testing site, and revert it. ---
// These exist because a Firebase host has no automatic per-PR preview (unlike Vercel). Bosun
// dispatches the repo's testing workflow to build + deploy a branch to the single testing site.

// Load the org's Firebase deploy config + GitHub token, asserting this is a Firebase host.
async function firebaseDeployCtx(db, task) {
  const orgSnap = await db.collection('organisations').doc(task.orgId).get();
  const org = orgSnap.exists ? orgSnap.data() : {};
  if (org.deploy?.host !== 'firebase') {
    throw new HttpsError('failed-precondition', 'PREVIEW_NOT_SUPPORTED');
  }
  const secret = await db.collection('orgSecrets').doc(task.orgId).get();
  const token = secret.exists ? secret.data().githubToken : null;
  if (!token) throw new HttpsError('failed-precondition', 'No GitHub token for this organisation.');
  return {
    token,
    baseBranch: org.github?.baseBranch || 'main',
    workflow: org.deploy?.firebase?.testingWorkflow || 'bosun-deploy-testing.yml',
    testingUrl: org.deploy?.firebase?.testingUrl || null,
  };
}

// PREVIEW = build the task's PR branch and deploy it to the testing site (without merging).
async function previewFirebaseTesting(db, taskId) {
  const ref = db.collection('tasks').doc(taskId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Task not found.');
  const t = snap.data();
  if (!t.prUrl) throw new HttpsError('failed-precondition', 'This task has no change to preview.');
  if (t.deployedTesting || t.deployedProd) throw new HttpsError('failed-precondition', 'ALREADY_DEPLOYED');
  const prNum = Number(String(t.prUrl).split('/').pop());

  const { token, baseBranch, workflow, testingUrl } = await firebaseDeployCtx(db, t);
  const headRef = await getPrHeadRef(t.repoFullName, prNum, token);
  if (!headRef) throw new HttpsError('failed-precondition', 'Could not find the change to preview.');

  // Dispatch the workflow FROM the base branch (where the file lives), telling it to build the
  // PR branch. The repo's Action does `firebase deploy --only hosting -P <testing>`.
  await dispatchWorkflow(t.repoFullName, workflow, baseBranch, { ref: headRef }, token);
  await ref.update({
    previewActive: true,        // a branch preview is now (being) deployed to testing
    previewDeploying: true,     // a deploy is in flight — cleared by the poller when it finishes
    previewRef: headRef,
    previewUrl: testingUrl,     // the single testing URL where the preview lands
    previewError: null,
    previewRequestedAt: FieldValue.serverTimestamp(),
  });
  return { ok: true, url: testingUrl };
}

// REVERT = redeploy the base branch to the testing site, discarding a branch-preview.
async function revertFirebaseTesting(db, taskId) {
  const ref = db.collection('tasks').doc(taskId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Task not found.');
  const t = snap.data();

  const { token, baseBranch, workflow, testingUrl } = await firebaseDeployCtx(db, t);
  await dispatchWorkflow(t.repoFullName, workflow, baseBranch, { ref: baseBranch }, token);
  await ref.update({
    previewActive: false,       // testing is going back to the base branch
    previewDeploying: true,
    previewRef: baseBranch,
    previewUrl: testingUrl,
    previewError: null,
    previewRequestedAt: FieldValue.serverTimestamp(),
  });
  return { ok: true, url: testingUrl };
}

// Base gate for CUSTOMER self-deploy: the signed-in user must belong to the task's org, and
// the fix must be finished and APPROVED (paid / auto-charged) before it can go anywhere —
// never deploy work that's still pending the customer's review. Testing self-deploy is open
// to every org member; production is gated separately (per-user canDeployProd, checked by the
// prod entry point below). Returns the caller's user-doc data; throws on any failure.
async function requireCustomerDeploy(db, uid, taskId) {
  if (!uid) throw new HttpsError('unauthenticated', 'Please sign in.');
  if (!taskId) throw new HttpsError('invalid-argument', 'taskId required.');
  const userSnap = await db.collection('users').doc(uid).get();
  const user = userSnap.exists ? userSnap.data() : null;
  const taskSnap = await db.collection('tasks').doc(taskId).get();
  if (!taskSnap.exists) throw new HttpsError('not-found', 'Task not found.');
  const t = taskSnap.data();
  // The task must belong to one of the user's organisations (any of them, not just the active).
  if (!isMember(user, t.orgId)) throw new HttpsError('permission-denied', 'Not your task.');
  if (t.status !== 'complete' || t.approved !== true) {
    throw new HttpsError('failed-precondition', 'NOT_DEPLOYABLE');
  }
  return user;
}

// Lighter gate for PREVIEW/REVERT (Firebase host): org membership + a finished fix that has a
// PR and isn't merged yet. Unlike deploy, this does NOT require approval — previewing on testing
// is how the owner evaluates the fix before approving/merging. Returns the caller's user-doc.
async function requireCustomerPreview(db, uid, taskId) {
  if (!uid) throw new HttpsError('unauthenticated', 'Please sign in.');
  if (!taskId) throw new HttpsError('invalid-argument', 'taskId required.');
  const userSnap = await db.collection('users').doc(uid).get();
  const user = userSnap.exists ? userSnap.data() : null;
  const taskSnap = await db.collection('tasks').doc(taskId).get();
  if (!taskSnap.exists) throw new HttpsError('not-found', 'Task not found.');
  const t = taskSnap.data();
  if (!isMember(user, t.orgId)) throw new HttpsError('permission-denied', 'Not your task.');
  if (t.status !== 'complete') throw new HttpsError('failed-precondition', 'NOT_READY');
  return user;
}

// Needs ANTHROPIC_API_KEY: deploying a feature step to testing advances the feature
// (deployTaskToTesting → advanceFeature → startFeatureStep), which dispatches the next step's
// managed-agent session. Without the secret the Anthropic client can't authenticate.
export const deployTesting = onCall({ region: 'asia-south1', secrets: [ANTHROPIC_API_KEY] }, async (request) => {
  requireAdmin(request);
  const taskId = String(request.data?.taskId ?? '');
  if (!taskId) throw new HttpsError('invalid-argument', 'taskId required.');
  return deployTaskToTesting(getFirestore(), taskId);
});

export const deployProd = onCall({ region: 'asia-south1' }, async (request) => {
  requireAdmin(request);
  const taskId = String(request.data?.taskId ?? '');
  if (!taskId) throw new HttpsError('invalid-argument', 'taskId required.');
  return deployTaskToProd(getFirestore(), taskId);
});

// Customer self-deploy to TESTING — open to any member of the task's org. Carries
// ANTHROPIC_API_KEY because advancing a feature step (below) dispatches the next step's session.
export const customerDeployTesting = onCall({ region: 'asia-south1', secrets: [ANTHROPIC_API_KEY] }, async (request) => {
  const db = getFirestore();
  const taskId = String(request.data?.taskId ?? '');
  await requireCustomerDeploy(db, request.auth?.uid, taskId);
  return deployTaskToTesting(db, taskId);
});

// Customer self-deploy to PRODUCTION (go live) — gated per-user by the admin-granted
// canDeployProd flag (adminSetUserDeploy). Testing is open to all; going live is not.
export const customerDeployProd = onCall({ region: 'asia-south1' }, async (request) => {
  const db = getFirestore();
  const taskId = String(request.data?.taskId ?? '');
  const user = await requireCustomerDeploy(db, request.auth?.uid, taskId);
  if (user?.canDeployProd !== true) {
    throw new HttpsError('permission-denied', 'PROD_DEPLOY_NOT_ALLOWED');
  }
  return deployTaskToProd(db, taskId);
});

// --- Firebase preview / revert entry points (admin + customer). No-ops for Vercel orgs:
// the cores throw PREVIEW_NOT_SUPPORTED unless org.deploy.host === 'firebase'. ---

export const previewTesting = onCall({ region: 'asia-south1' }, async (request) => {
  requireAdmin(request);
  const taskId = String(request.data?.taskId ?? '');
  if (!taskId) throw new HttpsError('invalid-argument', 'taskId required.');
  return previewFirebaseTesting(getFirestore(), taskId);
});

export const revertTesting = onCall({ region: 'asia-south1' }, async (request) => {
  requireAdmin(request);
  const taskId = String(request.data?.taskId ?? '');
  if (!taskId) throw new HttpsError('invalid-argument', 'taskId required.');
  return revertFirebaseTesting(getFirestore(), taskId);
});

// Customer "Preview" — deploy this fix's branch to the testing site so the owner can see it
// live before merging. Open to any org member (preview is the review step, not a charge).
export const customerPreviewTesting = onCall({ region: 'asia-south1' }, async (request) => {
  const db = getFirestore();
  const taskId = String(request.data?.taskId ?? '');
  await requireCustomerPreview(db, request.auth?.uid, taskId);
  return previewFirebaseTesting(db, taskId);
});

// Customer "Undo preview" — put the testing site back to the live (base-branch) version.
export const customerRevertTesting = onCall({ region: 'asia-south1' }, async (request) => {
  const db = getFirestore();
  const taskId = String(request.data?.taskId ?? '');
  await requireCustomerPreview(db, request.auth?.uid, taskId);
  return revertFirebaseTesting(db, taskId);
});
