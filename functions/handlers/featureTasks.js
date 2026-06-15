import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { startPlanningSession } from '../utils/featurePlan.js';
import { startCheckupSession } from '../utils/checkup.js';
import { startFeatureStep } from '../utils/featureRun.js';
import { sessionView } from '../utils/sessionView.js';
import { designContextFromText } from '../utils/figma.js';
import { firebaseSAsFromSecret, uploadImagesToFiles } from '../utils/claudeAgent.js';
import { agentIdForModel } from '../utils/routeModel.js';
import { sanitizeImages } from '../utils/images.js';
import { ANTHROPIC_API_KEY } from '../utils/secrets.js';

// Operational caps for a planning session — exploration, not a build, so it should be quick and
// cheap. pollSessions terminates a planning session that crosses either.
const PLANNING_MAX_USD = 0.75;
const PLANNING_MAX_SEC = 600;

// A check-up reads the WHOLE site (not just the files for one ask), so it gets a touch more
// headroom than a single-feature plan. pollSessions terminates a check-up that crosses either.
const CHECKUP_MAX_USD = 1.0;
const CHECKUP_MAX_SEC = 600;

// Feature lifecycle: planning → plan_review → running → complete (plan_failed on a failed plan;
// refine/redo loop back to planning). Planning is a CODE-AWARE managed-agent session (clone repo +
// read it + see the design), so it's async — started here, finalized in pollSessions (which parses
// the steps, charges 2× the session's real cost, and opens the plan for review). Nothing builds and
// nothing is charged until the owner approves the plan (approveFeaturePlan).

async function loadOrgCtx(db, orgId) {
  const orgSnap = await db.collection('organisations').doc(orgId).get();
  if (!orgSnap.exists) throw new HttpsError('failed-precondition', 'NO_ORG');
  const org = orgSnap.data();
  const gh = org.github;
  if (!gh?.repoFullName || !gh?.vaultId) throw new HttpsError('failed-precondition', 'NO_REPO_CONNECTED');
  const secretSnap = await db.collection('orgSecrets').doc(orgId).get();
  const secretData = secretSnap.exists ? secretSnap.data() : {};
  if (!secretData.githubToken) throw new HttpsError('failed-precondition', 'NO_REPO_CONNECTED');
  return { org, gh, secretData };
}

// Start a planning session for a feature and record it as a kind:'planning' task that pollSessions
// will finalize. Returns the planning taskId. `ask` is the text the plan is based on; `priorSteps`
// + `changeNote` drive a refine; screenshots ride along by file_id (carried from the original ask).
async function dispatchPlanning(db, { featureId, userId, orgId, org, gh, secretData, ask, imageFileIds = [], screenshotCount = 0, priorSteps = null, changeNote = '', mode = 'initial' }) {
  const figmaDesign = await designContextFromText({ org, secretData, text: ask });
  const firebaseSAs = firebaseSAsFromSecret(secretData);
  const { sessionId, firebaseFileIds } = await startPlanningSession({
    ask,
    repoUrl: `https://github.com/${gh.repoFullName}`,
    githubToken: secretData.githubToken,
    vaultId: gh.vaultId,
    agentId: agentIdForModel('sonnet'),
    firebaseSAs,
    figmaDesign,
    imageFileIds,
    screenshotCount,
    priorSteps,
    changeNote,
  });
  const taskRef = db.collection('tasks').doc();
  await taskRef.set({
    userId,
    orgId,
    featureId,
    kind: 'planning',
    mode,
    status: 'running',
    sessionId,
    firebaseFileIds: firebaseFileIds || [],
    model: 'sonnet',
    maxBudgetUsd: PLANNING_MAX_USD,
    maxSeconds: PLANNING_MAX_SEC,
    reviewedCostUsd: 0,
    reviewedSeconds: 0,
    createdAt: FieldValue.serverTimestamp(),
  });
  return taskRef.id;
}

// "Plan a feature": kick off a code-aware planning session. We persist the owner's screenshots once
// (Files API) so they carry into the plan AND every build step, fetch the Figma design, and start
// the session. The feature is created as `planning`; NOTHING is charged or built yet.
export const planFeature = onCall({ region: 'asia-south1', secrets: [ANTHROPIC_API_KEY] }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Please sign in.');
  const prompt = String(request.data?.prompt ?? '').trim();
  if (!prompt) throw new HttpsError('invalid-argument', 'Please describe the feature you want.');
  const images = sanitizeImages(request.data?.images);

  const db = getFirestore();
  const userSnap = await db.collection('users').doc(uid).get();
  const orgId = userSnap.exists ? userSnap.data().orgId : null;
  if (!orgId) throw new HttpsError('failed-precondition', 'NO_ORG');
  const { org, gh, secretData } = await loadOrgCtx(db, orgId);

  // Persist the screenshots once so they survive into the build steps (Firestore can't hold them).
  const screenshotFileIds = await uploadImagesToFiles(images);

  const featureRef = db.collection('features').doc();
  await featureRef.set({
    userId: uid,
    orgId,
    prompt,
    repoFullName: gh.repoFullName,
    status: 'planning',
    currentStep: 0,
    steps: [],
    screenshotFileIds,           // carried into the plan + every step by file_id
    imageCount: images.length,
    planningChargeInr: 0,        // set by pollSessions when the plan is ready (2× session COGS)
    createdAt: FieldValue.serverTimestamp(),
  });

  try {
    const planningTaskId = await dispatchPlanning(db, {
      featureId: featureRef.id, userId: uid, orgId, org, gh, secretData,
      ask: prompt, imageFileIds: screenshotFileIds, screenshotCount: images.length, mode: 'initial',
    });
    await featureRef.update({ planningTaskId });
  } catch (e) {
    console.error('planFeature:dispatch', featureRef.id, e?.message || e);
    await featureRef.update({ status: 'plan_failed', error: 'plan_dispatch_failed' });
    throw new HttpsError('internal', 'We could not start planning this feature. You were not charged.');
  }

  return { featureId: featureRef.id };
});

// Owner approves the proposed plan → build starts at step 1. The plan stays exactly as shown.
export const approveFeaturePlan = onCall({ region: 'asia-south1', secrets: [ANTHROPIC_API_KEY] }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Please sign in.');
  const featureId = String(request.data?.featureId ?? '').trim();
  if (!featureId) throw new HttpsError('invalid-argument', 'featureId required.');

  const db = getFirestore();
  const fSnap = await db.collection('features').doc(featureId).get();
  if (!fSnap.exists) throw new HttpsError('not-found', 'Feature not found.');
  const f = fSnap.data();
  if (f.userId !== uid) throw new HttpsError('permission-denied', 'Not your feature.');
  if (f.status !== 'plan_review') throw new HttpsError('failed-precondition', 'NOT_REVIEWABLE');
  if (!Array.isArray(f.steps) || f.steps.length === 0) throw new HttpsError('failed-precondition', 'NO_PLAN');

  // startFeatureStep flips the feature to running and points step 0 at its task (figma + the
  // carried screenshots attached). On dispatch failure the feature stays plan_review to retry.
  try {
    await startFeatureStep(db, featureId, 0);
  } catch (e) {
    console.error('approveFeaturePlan', featureId, e?.message || e);
    throw new HttpsError('internal', 'We could not start building. You were not charged for a build.');
  }
  return { ok: true };
});

// Owner wants the plan changed before building. mode:'refine' adjusts the current plan with their
// note; mode:'replace' re-plans from a brand-new prompt. Either way a fresh planning session runs
// (charged like the first plan) and the feature returns to plan_review when it's ready.
export const reviseFeaturePlan = onCall({ region: 'asia-south1', secrets: [ANTHROPIC_API_KEY] }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Please sign in.');
  const featureId = String(request.data?.featureId ?? '').trim();
  const mode = String(request.data?.mode ?? 'refine').trim();
  if (!featureId) throw new HttpsError('invalid-argument', 'featureId required.');
  if (!['refine', 'replace'].includes(mode)) throw new HttpsError('invalid-argument', 'bad mode.');
  const changes = String(request.data?.changes ?? '').trim();
  const newPrompt = String(request.data?.prompt ?? '').trim();
  if (mode === 'refine' && !changes) throw new HttpsError('invalid-argument', 'Please describe the changes.');
  if (mode === 'replace' && !newPrompt) throw new HttpsError('invalid-argument', 'Please describe the feature.');

  const db = getFirestore();
  const featureRef = db.collection('features').doc(featureId);
  const fSnap = await featureRef.get();
  if (!fSnap.exists) throw new HttpsError('not-found', 'Feature not found.');
  const f = fSnap.data();
  if (f.userId !== uid) throw new HttpsError('permission-denied', 'Not your feature.');
  if (f.status !== 'plan_review') throw new HttpsError('failed-precondition', 'NOT_REVIEWABLE');

  const { org, gh, secretData } = await loadOrgCtx(db, f.orgId);
  const ask = mode === 'replace' ? newPrompt : (f.prompt || '');
  const priorSteps = mode === 'refine' ? (Array.isArray(f.steps) ? f.steps : []) : null;

  await featureRef.update({ status: 'planning', ...(mode === 'replace' ? { prompt: newPrompt } : {}) });
  try {
    const planningTaskId = await dispatchPlanning(db, {
      featureId, userId: uid, orgId: f.orgId, org, gh, secretData,
      ask,
      imageFileIds: Array.isArray(f.screenshotFileIds) ? f.screenshotFileIds : [],
      screenshotCount: Number(f.imageCount) || 0,
      priorSteps,
      changeNote: changes,
      mode,
    });
    await featureRef.update({ planningTaskId });
  } catch (e) {
    console.error('reviseFeaturePlan', featureId, e?.message || e);
    await featureRef.update({ status: 'plan_review' }); // leave the old plan intact to retry
    throw new HttpsError('internal', 'We could not re-plan. Your existing plan is unchanged.');
  }
  return { ok: true, mode };
});

// Customer-facing view of their features, newest first. Surfaces the lifecycle status, the proposed
// steps (with static/dynamic kind), the running total paid, and — only while building — the full
// session view of the active step (so the dashboard reuses the normal fix card on it).
export const listMyFeatures = onCall({ region: 'asia-south1' }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Please sign in.');
  const db = getFirestore();

  const userSnap = await db.collection('users').doc(uid).get();
  const userCanDeployProd = userSnap.exists && userSnap.data().canDeployProd === true;

  const snap = await db
    .collection('features')
    .where('userId', '==', uid)
    .orderBy('createdAt', 'desc')
    .limit(10)
    .get();
  if (snap.empty) return { features: [] };

  const taskIds = [];
  for (const d of snap.docs) {
    for (const s of d.data().steps || []) if (s.taskId) taskIds.push(s.taskId);
  }
  const taskById = {};
  if (taskIds.length) {
    const taskSnaps = await db.getAll(...taskIds.map((id) => db.collection('tasks').doc(id)));
    for (const ts of taskSnaps) if (ts.exists) taskById[ts.id] = ts.data();
  }

  const features = snap.docs.map((d) => {
    const f = d.data();
    const rawSteps = Array.isArray(f.steps) ? f.steps : [];
    // Before the plan is approved the steps are just a proposal — no tasks, no active card.
    const isBuilding = f.status === 'running' || f.status === 'complete';

    let paidStepsInr = 0;
    let activeIndex = -1;
    let lastTaskId = null;
    const steps = rawSteps.map((s, i) => {
      const t = isBuilding && s.taskId ? taskById[s.taskId] : null;
      const deployed = !!(t && (t.deployedTesting || t.deployedProd));
      let status;
      if (!isBuilding) status = 'proposed';
      else if (!t) status = 'pending';
      else if (deployed) status = 'done';
      else if (t.status === 'failed') status = 'failed';
      else status = 'running';

      if (t) { paidStepsInr += Number(t.finalCharge) || 0; lastTaskId = s.taskId; }
      if ((status === 'running' || status === 'failed') && activeIndex === -1) activeIndex = i;

      return {
        title: s.title || '',
        description: s.description || '',
        kind: s.kind === 'dynamic' ? 'dynamic' : 'static',
        status,
        summary: t?.resultSummary ?? null,
        paidInr: t ? Number(t.finalCharge) || 0 : 0,
        session: t && (status === 'running' || status === 'failed') ? sessionView(t, s.taskId, { userCanDeployProd }) : null,
      };
    });

    const allDone = isBuilding && rawSteps.length > 0 && steps.every((st) => st.status === 'done');
    const planningChargeInr = Number(f.planningChargeInr) || 0;
    // Lifecycle status straight from the doc, except we upgrade running→complete once every step ships.
    const status = f.status === 'running' && allDone ? 'complete' : (f.status || (allDone ? 'complete' : 'running'));

    return {
      id: d.id,
      prompt: f.prompt || '',
      status, // planning | plan_review | plan_failed | running | complete
      stepCount: rawSteps.length,
      currentStep: activeIndex === -1 ? rawSteps.length : activeIndex,
      planningChargeInr,
      totalPaidInr: planningChargeInr + paidStepsInr,
      steps,
      canGoLive: status === 'complete' && userCanDeployProd && !!lastTaskId,
      goLiveTaskId: status === 'complete' ? lastTaskId : null,
      createdAt: f.createdAt?.toMillis?.() ?? null,
    };
  });

  return { features };
});

// Add another change to a feature AFTER all its steps are done. It runs as a NEW step on the same
// feature — same review/approve/charge lifecycle, so its cost rolls into the feature's running
// total — and the agent gets the whole feature as context (it's all merged into the repo, plus the
// original design/screenshots) so it understands what it's extending. This replaces opening a
// separate standalone fix for follow-up tweaks.
export const addFeatureChange = onCall({ region: 'asia-south1', secrets: [ANTHROPIC_API_KEY] }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Please sign in.');
  const featureId = String(request.data?.featureId ?? '').trim();
  const changes = String(request.data?.changes ?? '').trim();
  if (!featureId) throw new HttpsError('invalid-argument', 'featureId required.');
  if (!changes) throw new HttpsError('invalid-argument', 'Please describe the change you want.');
  const images = sanitizeImages(request.data?.images);

  const db = getFirestore();
  const featureRef = db.collection('features').doc(featureId);
  const fSnap = await featureRef.get();
  if (!fSnap.exists) throw new HttpsError('not-found', 'Feature not found.');
  const f = fSnap.data();
  if (f.userId !== uid) throw new HttpsError('permission-denied', 'Not your feature.');
  // Only once the feature is fully built (every step on testing). Finish the steps first otherwise.
  if (f.status !== 'complete') throw new HttpsError('failed-precondition', 'NOT_COMPLETE');

  // This change may carry its own screenshots (what the owner is pointing at now); persist them.
  const newFileIds = await uploadImagesToFiles(images);

  // Append the change as a new step, atomically, and flip the feature back to building.
  let newIndex = -1;
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(featureRef);
    if (!snap.exists) return;
    const steps = Array.isArray(snap.data().steps) ? [...snap.data().steps] : [];
    steps.push({
      title: 'Your extra change',
      description: changes.slice(0, 400),
      kind: 'static',
      status: 'pending',
      taskId: null,
      added: true,
      changeText: changes,
      imageFileIds: newFileIds,
    });
    newIndex = steps.length - 1;
    tx.update(featureRef, { steps, status: 'running', currentStep: newIndex, updatedAt: FieldValue.serverTimestamp() });
  });
  if (newIndex < 0) throw new HttpsError('not-found', 'Feature not found.');

  try {
    await startFeatureStep(db, featureId, newIndex);
  } catch (e) {
    console.error('addFeatureChange', featureId, e?.message || e);
    throw new HttpsError('internal', 'We could not start this change. You were not charged.');
  }
  return { ok: true };
});

// Retry the current step of a building feature when it failed to run. Failed runs were never
// charged, so no new charge. Only valid while the feature is building.
export const retryFeatureStep = onCall({ region: 'asia-south1', secrets: [ANTHROPIC_API_KEY] }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Please sign in.');
  const featureId = String(request.data?.featureId ?? '').trim();
  if (!featureId) throw new HttpsError('invalid-argument', 'featureId required.');

  const db = getFirestore();
  const fSnap = await db.collection('features').doc(featureId).get();
  if (!fSnap.exists) throw new HttpsError('not-found', 'Feature not found.');
  const f = fSnap.data();
  if (f.userId !== uid) throw new HttpsError('permission-denied', 'Not your feature.');
  if (f.status !== 'running') throw new HttpsError('failed-precondition', 'NOT_BUILDING');

  const stepIndex = Number(f.currentStep) || 0;
  const cur = f.steps?.[stepIndex];
  if (cur?.taskId) {
    const tSnap = await db.collection('tasks').doc(cur.taskId).get();
    if (tSnap.exists && tSnap.data().status !== 'failed') {
      throw new HttpsError('failed-precondition', 'NOT_RETRYABLE');
    }
  }

  try {
    await startFeatureStep(db, featureId, stepIndex);
  } catch (e) {
    console.error('retryFeatureStep', featureId, e?.message || e);
    throw new HttpsError('internal', 'We could not start this step. You were not charged.');
  }
  return { ok: true };
});

// "Check my website": kick off a code-aware review session that explores the WHOLE site and
// proposes a prioritised list of improvement ideas (each tagged value + effort). It's FREE — we
// absorb the cost (like classify), because the check-up exists to feed the paid plan/fix flow: the
// owner picks an idea, it pre-fills "Plan a feature", and they plan it from there. Async: the
// check-up is created `running`; pollSessions parses the items and flips it to `ready`. A check-up
// is a kind:'checkup' task so pollSessions picks it up (mirrors the planning session).
export const requestCheckup = onCall({ region: 'asia-south1', secrets: [ANTHROPIC_API_KEY] }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Please sign in.');

  const db = getFirestore();
  const userSnap = await db.collection('users').doc(uid).get();
  const orgId = userSnap.exists ? userSnap.data().orgId : null;
  if (!orgId) throw new HttpsError('failed-precondition', 'NO_ORG');
  const { gh, secretData } = await loadOrgCtx(db, orgId);

  const checkupRef = db.collection('checkups').doc();
  await checkupRef.set({
    userId: uid,
    orgId,
    repoFullName: gh.repoFullName,
    status: 'running',
    items: [],
    createdAt: FieldValue.serverTimestamp(),
  });

  try {
    const { sessionId, firebaseFileIds } = await startCheckupSession({
      repoUrl: `https://github.com/${gh.repoFullName}`,
      githubToken: secretData.githubToken,
      vaultId: gh.vaultId,
      agentId: agentIdForModel('sonnet'),
      firebaseSAs: firebaseSAsFromSecret(secretData),
    });
    const taskRef = db.collection('tasks').doc();
    await taskRef.set({
      userId: uid,
      orgId,
      checkupId: checkupRef.id,
      kind: 'checkup',
      status: 'running',
      sessionId,
      firebaseFileIds: firebaseFileIds || [],
      model: 'sonnet',
      maxBudgetUsd: CHECKUP_MAX_USD,
      maxSeconds: CHECKUP_MAX_SEC,
      reviewedCostUsd: 0,
      reviewedSeconds: 0,
      createdAt: FieldValue.serverTimestamp(),
    });
    await checkupRef.update({ taskId: taskRef.id });
  } catch (e) {
    console.error('requestCheckup:dispatch', checkupRef.id, e?.message || e);
    await checkupRef.update({ status: 'failed', error: 'checkup_dispatch_failed' });
    throw new HttpsError('internal', 'We could not start the check-up. You were not charged.');
  }

  return { checkupId: checkupRef.id };
});

// Customer-facing view of their website check-ups, newest first. Each carries the prioritised
// improvement ideas (value + effort) once ready, so the dashboard can show them and let the owner
// send any one into "Plan a feature". No money fields — the check-up itself is free.
export const listMyCheckups = onCall({ region: 'asia-south1' }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Please sign in.');
  const db = getFirestore();

  const snap = await db
    .collection('checkups')
    .where('userId', '==', uid)
    .orderBy('createdAt', 'desc')
    .limit(5)
    .get();
  if (snap.empty) return { checkups: [] };

  const norm = (v, fallback, allowed) => (allowed.includes(v) ? v : fallback);
  const checkups = snap.docs.map((d) => {
    const c = d.data();
    const items = Array.isArray(c.items) ? c.items.map((it) => ({
      title: it.title || '',
      description: it.description || '',
      value: norm(it.value, 'medium', ['low', 'medium', 'high']),
      effort: norm(it.effort, 'medium', ['low', 'medium', 'high']),
      category: it.category || '',
    })) : [];
    return {
      id: d.id,
      status: c.status || 'running', // running | ready | failed
      items,
      createdAt: c.createdAt?.toMillis?.() ?? null,
    };
  });

  return { checkups };
});
