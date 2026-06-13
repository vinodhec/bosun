import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { classifyComplexity } from './classify.js';
import { startFixSession, firebaseSAsFromSecret } from './claudeAgent.js';
import { designContextFromText } from './figma.js';
import { modelForComplexity, agentIdForModel } from './routeModel.js';
import { tierFor } from './billing.js';

// The fix instruction for one feature step. The agent treats it like a normal fix; we add
// light framing so it builds ONLY this step. Earlier steps are already merged into main (each
// step is merged when the owner deploys it to testing — see deployTaskToTesting), so the repo
// the agent clones already contains them and it can build on top.
function buildAgentPrompt(feature, stepIndex) {
  const step = feature.steps[stepIndex];
  const total = feature.steps.length;
  const body = step.description ? `${step.title} — ${step.description}` : step.title;
  return (
    `This is step ${stepIndex + 1} of ${total} of a larger feature the website owner asked for:\n` +
    `"${feature.prompt}"\n\n` +
    (stepIndex > 0
      ? `The earlier steps are already built and live in the project you're working on — build on top of them, do NOT redo them.\n\n`
      : '') +
    `Do ONLY this step now:\n${body}`
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

/**
 * Start (or restart) the task for one feature step: classify it, write tasks/{id} carrying
 * featureId + stepIndex, dispatch the managed-agent session, then point the feature's step at
 * the new task. Mirrors createTask. A step is pre-scoped by the breakdown, so it never parks
 * for an operator quote — a 'large' classification is capped to 'complex' so it always runs.
 * Returns the new taskId; on dispatch failure the task is marked failed and the error rethrown.
 */
export async function startFeatureStep(db, featureId, stepIndex) {
  const featureRef = db.collection('features').doc(featureId);
  const fSnap = await featureRef.get();
  if (!fSnap.exists) throw new Error('feature_not_found');
  const feature = fSnap.data();
  const step = feature.steps?.[stepIndex];
  if (!step) throw new Error('step_not_found');

  const { gh, githubToken, firebaseSAs, org, secretData } = await loadRepoContext(db, feature.orgId);

  // If the owner's feature request included a Figma link and the org is connected, enrich every
  // step with the design (exact spec + rendered image) so each step is built pixel-perfect — same
  // as a standalone fix (createTask). The link lives in feature.prompt, which each step embeds.
  const figmaDesign = await designContextFromText({ org, secretData, text: feature.prompt });
  // Carry the owner's original screenshots forward into every step (persisted once at plan time as
  // Files API ids), attached by file_id — alongside Figma (above) and Jam (rides in the prompt).
  const imageFileIds = Array.isArray(feature.screenshotFileIds) ? feature.screenshotFileIds : [];

  // The owner sees a clean title/description (displayPrompt); the agent gets the full framing
  // (build on earlier steps, do only this step) via agentPrompt. They're decoupled so the
  // dashboard never shows the engineered instruction. Classify on the clean work, not the framing.
  const displayPrompt = step.description ? `${step.title} — ${step.description}` : (step.title || '');
  const agentPrompt = buildAgentPrompt(feature, stepIndex);
  const { complexity: raw } = await classifyComplexity(displayPrompt);
  const complexity = raw === 'large' ? 'complex' : raw;
  const tier = tierFor(complexity);
  const model = modelForComplexity(complexity);

  const taskRef = db.collection('tasks').doc();
  await taskRef.set({
    userId: feature.userId,
    orgId: feature.orgId,
    prompt: displayPrompt,
    repoFullName: gh.repoFullName,
    // Links this task to its feature + position. listMySessions filters these out (they show
    // inside the feature card, not as standalone fixes); deploying one advances the feature.
    featureId,
    stepIndex,
    featureStepTitle: step.title || '',
    kind: 'initial',
    complexity,
    model,
    status: 'queued',
    billed: false,
    approved: false,
    pendingReview: false,
    maxBudgetUsd: tier.maxBudgetUsd,
    maxSeconds: tier.maxSeconds,
    currentRoundCharge: 0, // bracketed price computed in markRoundReady from actual COGS — same as any fix
    finalCharge: 0,
    freeRevisionsUsed: 0,
    pendingRound: { kind: 'initial', reason: null, addedInr: 0, prompt: displayPrompt },
    imageCount: imageFileIds.length, // owner's original screenshots carried into the step
    createdAt: FieldValue.serverTimestamp(),
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

  // Point the feature's step at this task + mark it the active step. Firestore can't patch a
  // single array element by index, so read-modify-write the whole steps array.
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(featureRef);
    if (!snap.exists) return;
    const f = snap.data();
    const steps = Array.isArray(f.steps) ? [...f.steps] : [];
    if (steps[stepIndex]) steps[stepIndex] = { ...steps[stepIndex], taskId: taskRef.id, status: 'running' };
    tx.update(featureRef, {
      steps,
      currentStep: stepIndex,
      status: 'running',
      updatedAt: FieldValue.serverTimestamp(),
    });
  });

  return taskRef.id;
}

/**
 * Advance a feature after one of its steps is deployed to testing (merged into main). Marks
 * that step done; if a later step remains, dispatches it — its agent now clones the updated
 * main, so it builds on this step — otherwise marks the feature complete. Idempotent (a step
 * already marked done won't double-advance or double-start the next) and best-effort: it must
 * never throw and block the deploy that triggered it.
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
      steps[stepIndex] = { ...steps[stepIndex], status: 'done' };
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
      await startFeatureStep(db, featureId, startNext); // dispatch the next step (network — outside the tx)
    }
  } catch (e) {
    console.error('advanceFeature', taskId, e?.message || e);
  }
}
