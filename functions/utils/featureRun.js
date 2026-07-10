import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { classifyComplexity } from './classify.js';
import { startFixSession, continueFixSession, firebaseSAsFromSecret } from './claudeAgent.js';
import { designContextFromText } from './figma.js';
import { modelForComplexity, agentIdForModel } from './routeModel.js';
import { tierFor } from './billing.js';
import { buildDesignHandoff } from './designRun.js';

// ─── One warm session per batch of steps ────────────────────────────────────────────────────────
// A feature is built by ONE managed-agent session that runs its steps back-to-back (each step billed
// its own incremental COGS — see the poller's feature branch + markRoundReady). The session stays
// warm across steps, so the expensive "clone + read the repo" discovery is paid ONCE per batch, not
// once per step. The owner reviews + deploys the whole batch ONCE at the end.
//
// SAFETY VALVE (billing.FEATURE_MAX_STEPS_PER_SESSION): a session runs at most that many steps before
// the build hands off. The hand-off happens at a DEPLOY boundary — the owner deploys the batch (merge
// to main), then the next batch starts a FRESH session that clones the updated main (which now
// contains the earlier steps). This reuses the existing deploy→advanceFeature path and avoids any
// fragile cross-session branch juggling. A feature with ≤ valve steps is a single batch = one review.
//
// requireApproval orgs are UNCHANGED: they keep per-step review (each step arms a deploy, the owner
// approves + deploys it, advanceFeature starts the next). The in-session auto-advance below applies
// only to the default (no-approval) path — see the poller.

// The fix instruction for one feature step. `sameSession` = we are CONTINUING the warm session that
// already built the earlier steps of this batch (so they're in the agent's context + on its branch);
// otherwise this is a fresh session and any earlier steps are already merged into main.
function buildAgentPrompt(feature, stepIndex, { sameSession = false } = {}) {
  const step = feature.steps[stepIndex];
  const body = step.description ? `${step.title} — ${step.description}` : step.title;

  // A feature handed off from an approved design carries the full design context (approved mock,
  // scope, the whole clarify Q&A, build notes) so every step builds exactly what was approved. It
  // rides ahead of the step framing — the overall visual target first, then "do only this step".
  const designLead = feature.design ? buildDesignHandoff(feature.design) + '\n' : '';

  // A FOLLOW-UP change added after the feature was delivered. The whole feature is already merged
  // into the project, so the agent gets that context and builds the change on top of it.
  if (step.added) {
    const built = (feature.steps || [])
      .filter((s) => !s.added && (s.title || s.description))
      .map((s, i) => `${i + 1}. ${s.title}${s.description ? ` — ${s.description}` : ''}`)
      .join('\n');
    return (
      designLead +
      `You previously built a feature for this website owner. The feature they asked for:\n"${feature.prompt}"\n\n` +
      (built ? `It was delivered as these parts (all already merged into the project you're working on):\n${built}\n\n` : '') +
      `The owner now wants this ADDITIONAL change on top of that feature:\n"${step.changeText || body}"\n\n` +
      `Make ONLY this change. Build on what's already there — do NOT redo the feature.`
    );
  }

  const total = feature.steps.length;
  if (sameSession) {
    // Continuing the SAME warm session — the earlier steps are already built here, on the same
    // branch/PR, and the FULL plan was in the first message, so this turn is just a short nudge.
    // The agent often builds cohesively ahead of the step boundaries; telling it NOT to redo or
    // re-verify already-done work is what keeps continuation turns cheap.
    return (
      designLead +
      `Good — that step is done. Now do step ${stepIndex + 1} of ${total} of the same feature ` +
      `(the full plan is in the first message):\n${body}\n\n` +
      `Continue in THIS session, building on the steps you just completed. Keep working on the SAME ` +
      `branch and UPDATE the same pull request — do NOT open a new one. Commit and push with the git ` +
      `CLI (the repo is local — don't re-fetch files through the GitHub API for a SHA).\n` +
      `If you already built part or all of this step while completing the earlier ones, do NOT redo ` +
      `or re-explore it — quickly confirm it's in place and say so in your summary.\n\n` +
      `When done, reply with a short friendly summary and append the same RESULT_JSON last line as ` +
      `before, reusing the SAME pull request url.`
    );
  }
  // Fresh session: show the WHOLE plan so the agent can architect for the full feature (shared
  // groundwork, file layout) instead of discovering the scope one surprise step at a time — the
  // later in-session nudges above then cost almost nothing.
  const plan = feature.steps
    .map((s, i) => `${i + 1}. ${s.title}${s.description ? ` — ${s.description}` : ''}`)
    .join('\n');
  return (
    designLead +
    `A website owner asked for this feature:\n"${feature.prompt}"\n\n` +
    `It is being built as ${total} ordered step${total > 1 ? 's' : ''}:\n${plan}\n\n` +
    (stepIndex > 0
      ? `Steps 1–${stepIndex} are already built and merged into the project you're working on — build on top of them, do NOT redo them.\n\n`
      : '') +
    `Do step ${stepIndex + 1} now:\n${body}\n\n` +
    `The deliverable for THIS turn is step ${stepIndex + 1} only — later steps will be requested ` +
    `one at a time in this session, so you may lay shared groundwork for them, but do not build ` +
    `them out yet.`
  );
}

// Load the org's repo + GitHub token + Firebase service-account keys (shared by start/retry).
async function loadRepoContext(db, orgId) {
  const orgSnap = await db.collection('organisations').doc(orgId).get();
  const gh = orgSnap.exists ? orgSnap.data().github : null;
  if (!gh?.repoFullName || !gh?.vaultId) throw new Error('NO_REPO_CONNECTED');
  const secretSnap = await db.collection('orgSecrets').doc(orgId).get();
  const secretData = secretSnap.exists ? secretSnap.data() : {};
  const githubToken = secretData.githubToken;
  if (!githubToken) throw new Error('NO_REPO_CONNECTED');
  return { gh, githubToken, firebaseSAs: firebaseSAsFromSecret(secretData), org: orgSnap.data(), secretData };
}

// Write the tasks/{id} doc for one feature step. `session` carries the shared-session bookkeeping:
// for a fresh batch it's { sessionStepCount: 1, reviewedCostUsd: 0, reviewedSeconds: 0 }; for an
// in-session continuation the poller seeds reviewedCostUsd/reviewedSeconds to the session's
// cumulative-so-far, so this step's round delta (cumulative − seed) is exactly ITS own COGS.
function stepTaskFields(feature, featureId, stepIndex, displayPrompt, { complexity, model, tier, session }) {
  return {
    userId: feature.userId,
    orgId: feature.orgId,
    prompt: displayPrompt,
    repoFullName: feature.repoFullName,
    featureId,
    stepIndex,
    featureStepTitle: feature.steps?.[stepIndex]?.title || '',
    // How many steps THIS warm session has built (drives the safety valve in the poller).
    sessionStepCount: Number(session?.sessionStepCount) || 1,
    kind: 'initial',
    complexity,
    model,
    status: 'queued',
    billed: false,
    approved: false,
    pendingReview: false,
    maxBudgetUsd: tier.maxBudgetUsd,
    maxSeconds: tier.maxSeconds,
    // Seed the round baseline. For a continuation this is the shared session's cumulative cost/runtime
    // at the moment this step starts, so markRoundReady bills only this step's incremental COGS.
    reviewedCostUsd: Number(session?.reviewedCostUsd) || 0,
    reviewedSeconds: Number(session?.reviewedSeconds) || 0,
    currentRoundCharge: 0,
    finalCharge: 0,
    freeRevisionsUsed: 0,
    pendingRound: { kind: 'initial', reason: null, addedInr: 0, prompt: displayPrompt },
    createdAt: FieldValue.serverTimestamp(),
  };
}

// Point the feature's step at its task + mark it the active step. Firestore can't patch a single
// array element by index, so read-modify-write the whole steps array.
async function attachStepTask(db, featureId, stepIndex, taskId) {
  const featureRef = db.collection('features').doc(featureId);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(featureRef);
    if (!snap.exists) return;
    const f = snap.data();
    const steps = Array.isArray(f.steps) ? [...f.steps] : [];
    if (steps[stepIndex]) steps[stepIndex] = { ...steps[stepIndex], taskId, status: 'running' };
    tx.update(featureRef, { steps, currentStep: stepIndex, status: 'running', updatedAt: FieldValue.serverTimestamp() });
  });
}

/**
 * Start a feature step in a FRESH managed-agent session — used for step 0, the first step of a new
 * batch (after the previous batch was deployed to main), a follow-up "added" change, and retries.
 * `baseBranch` (retry mid-batch) tells the agent to check out an existing in-progress branch and
 * continue on it, so a failed step's retry doesn't lose the batch's earlier, un-merged commits.
 * Returns the new taskId; on dispatch failure the task is marked failed and the error rethrown.
 */
export async function startFeatureStep(db, featureId, stepIndex, { baseBranch = null } = {}) {
  const featureRef = db.collection('features').doc(featureId);
  const fSnap = await featureRef.get();
  if (!fSnap.exists) throw new Error('feature_not_found');
  const feature = fSnap.data();
  const step = feature.steps?.[stepIndex];
  if (!step) throw new Error('step_not_found');

  const { gh, githubToken, firebaseSAs, org, secretData } = await loadRepoContext(db, feature.orgId);

  // Enrich every step with the owner's Figma design + carried screenshots — same as a standalone fix.
  const figmaText = `${feature.prompt || ''}\n${feature.design?.originalPrompt || ''}`;
  const figmaDesign = await designContextFromText({ org, secretData, text: figmaText });
  const imageFileIds = [
    ...(Array.isArray(step.imageFileIds) ? step.imageFileIds : []),
    ...(Array.isArray(feature.screenshotFileIds) ? feature.screenshotFileIds : []),
  ];

  const displayPrompt = step.description ? `${step.title} — ${step.description}` : (step.title || '');
  let agentPrompt = buildAgentPrompt(feature, stepIndex, { sameSession: false });
  // A retry that must continue an existing (un-merged) branch: tell the agent to check it out first.
  if (baseBranch) {
    agentPrompt =
      `Earlier steps of this feature are already committed on the branch "${baseBranch}" (not yet ` +
      `merged). FIRST run: git fetch origin && git checkout ${baseBranch}. Then continue on that ` +
      `SAME branch and UPDATE its existing pull request — do NOT open a new one.\n\n` + agentPrompt;
  }
  const { complexity: raw } = await classifyComplexity(displayPrompt);
  const complexity = raw === 'large' ? 'complex' : raw;
  const tier = tierFor(complexity);
  const model = modelForComplexity(complexity);

  const taskRef = db.collection('tasks').doc();
  await taskRef.set({
    ...stepTaskFields(feature, featureId, stepIndex, displayPrompt, {
      complexity, model, tier, session: { sessionStepCount: 1, reviewedCostUsd: 0, reviewedSeconds: 0 },
    }),
    imageCount: imageFileIds.length,
  });

  try {
    const { sessionId, firebaseFileIds } = await startFixSession({
      prompt: agentPrompt,
      images: [],
      imageFileIds,
      repoUrl: `https://github.com/${gh.repoFullName}`,
      githubToken,
      vaultId: gh.vaultId,
      agentId: agentIdForModel(model),
      firebaseSAs,
      figmaDesign,
    });
    await taskRef.update({ status: 'running', sessionId, firebaseFileIds: firebaseFileIds || [] });
  } catch (e) {
    await taskRef.update({ status: 'failed', error: 'dispatch_failed' });
    throw e;
  }

  await attachStepTask(db, featureId, stepIndex, taskRef.id);
  return taskRef.id;
}

/**
 * Continue the SAME warm session for the next step of a batch (default, no-approval path). No
 * re-clone and no re-discovery — the agent already has the repo + earlier steps in context. The
 * poller seeds `reviewedCostUsd`/`reviewedSeconds` to the session's cumulative-so-far so this step
 * is billed only its own incremental COGS. Returns the new taskId; marks failed + rethrows on error.
 */
export async function continueFeatureStep(db, featureId, stepIndex, { sessionId, reviewedCostUsd = 0, reviewedSeconds = 0, sessionStepCount = 2, firebaseFileIds = [], prUrl = null }) {
  if (!sessionId) throw new Error('missing sessionId');
  const featureRef = db.collection('features').doc(featureId);
  const fSnap = await featureRef.get();
  if (!fSnap.exists) throw new Error('feature_not_found');
  const feature = fSnap.data();
  const step = feature.steps?.[stepIndex];
  if (!step) throw new Error('step_not_found');

  const displayPrompt = step.description ? `${step.title} — ${step.description}` : (step.title || '');
  const agentPrompt = buildAgentPrompt(feature, stepIndex, { sameSession: true });
  const { complexity: raw } = await classifyComplexity(displayPrompt);
  const complexity = raw === 'large' ? 'complex' : raw;
  const tier = tierFor(complexity);
  const model = modelForComplexity(complexity);

  const taskRef = db.collection('tasks').doc();
  await taskRef.set({
    ...stepTaskFields(feature, featureId, stepIndex, displayPrompt, {
      complexity, model, tier, session: { sessionStepCount, reviewedCostUsd, reviewedSeconds },
    }),
    // The shared session already carries the owner's screenshots/design from step 0 — no re-attach.
    imageCount: 0,
    // Carry the session + its uploaded Firebase key file_ids forward so the poller can clean them up.
    sessionId,
    firebaseFileIds: Array.isArray(firebaseFileIds) ? firebaseFileIds : [],
    // The batch's shared PR (opened at step 0). Seeded here so the batch-final step reliably has it
    // for preview + deploy even if the agent doesn't re-state the url on this continuation turn.
    prUrl: prUrl || null,
    status: 'running',
  });

  try {
    // Resume the warm session with this step's instruction (replaces the revise prompt).
    await continueFixSession({ sessionId, changes: displayPrompt, instruction: agentPrompt });
  } catch (e) {
    await taskRef.update({ status: 'failed', error: 'dispatch_failed' });
    throw e;
  }

  await attachStepTask(db, featureId, stepIndex, taskRef.id);
  return taskRef.id;
}

/**
 * Advance a feature after a BATCH is deployed to testing (its shared PR merged into main). Marks
 * every step up to and including the deployed one done (a batch may be several steps sharing one PR),
 * then dispatches the next batch's first step in a FRESH session (it now clones the updated main and
 * builds on the merged work) — or marks the feature complete. Idempotent + best-effort: it must never
 * throw and block the deploy that triggered it. (requireApproval orgs deploy one step at a time, so a
 * "batch" is a single step — same code path.)
 */
export async function advanceFeature(db, taskId) {
  try {
    const taskSnap = await db.collection('tasks').doc(taskId).get();
    if (!taskSnap.exists) return;
    const task = taskSnap.data();
    if (!task.featureId) return; // a normal standalone fix — nothing to advance
    const featureId = task.featureId;
    const stepIndex = Number(task.stepIndex) || 0;
    const featureRef = db.collection('features').doc(featureId);

    const startNext = await db.runTransaction(async (tx) => {
      const snap = await tx.get(featureRef);
      if (!snap.exists) return -1;
      const f = snap.data();
      const steps = Array.isArray(f.steps) ? [...f.steps] : [];
      if (!steps[stepIndex] || steps[stepIndex].status === 'done') return -1; // already advanced
      // Mark the whole just-deployed batch done: every not-yet-done step up to this one shared the PR.
      for (let i = 0; i <= stepIndex && i < steps.length; i++) {
        if (steps[i] && steps[i].status !== 'done') steps[i] = { ...steps[i], status: 'done' };
      }
      const next = stepIndex + 1;
      const hasNext = next < steps.length;
      tx.update(featureRef, {
        steps,
        currentStep: hasNext ? next : stepIndex,
        status: hasNext ? 'running' : 'complete',
        ...(hasNext ? {} : { completedAt: FieldValue.serverTimestamp() }),
        updatedAt: FieldValue.serverTimestamp(),
      });
      return hasNext ? next : -1;
    });

    if (startNext >= 0) {
      await startFeatureStep(db, featureId, startNext); // next batch — fresh session on updated main
    }
  } catch (e) {
    console.error('advanceFeature', taskId, e?.message || e);
  }
}
