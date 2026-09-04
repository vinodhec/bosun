import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { randomUUID } from 'node:crypto';
import { loadShared } from '../utils/sharing.js';
import { startPlanningSession, normalizeSteps } from '../utils/featurePlan.js';
import { startFeatureStep } from '../utils/featureRun.js';
import { sessionView } from '../utils/sessionView.js';
import { designContextFromText } from '../utils/figma.js';
import { firebaseSAsFromSecret, uploadImagesToFiles } from '../utils/claudeAgent.js';
import { getPrHeadRef } from '../utils/github.js';
import { agentIdForModel } from '../utils/routeModel.js';
import { sanitizeImages } from '../utils/images.js';
import { sanitizeDocuments } from '../utils/documents.js';
import { resolveOrgId } from '../utils/orgs.js';
import { ANTHROPIC_API_KEY } from '../utils/secrets.js';
import { assertCanStartWork, assertOrgCanStartWork } from '../utils/walletGate.js';

// Operational caps for a planning session — exploration, not a build, so it should be quick and
// cheap. pollSessions terminates a planning session that crosses either.
const PLANNING_MAX_USD = 0.75;
const PLANNING_MAX_SEC = 600;

// Feature lifecycle: planning → plan_review → running → complete (plan_failed on a failed plan;
// refine/redo loop back to planning). Planning is a CODE-AWARE managed-agent session (clone repo +
// read it + see the design), so it's async — started here, finalized in pollSessions (which parses
// the steps, charges 2× the session's real cost, and opens the plan for review). Nothing builds and
// nothing is charged until the owner approves the plan (approveFeaturePlan).

async function loadOrgCtx(db, orgId) {
  const orgSnap = await db.collection('organisations').doc(orgId).get();
  if (!orgSnap.exists) throw new HttpsError('failed-precondition', 'NO_ORG');
  const org = orgSnap.data();
  // Wallet gate: an org in the red cannot start new agent work (utils/walletGate.js).
  assertCanStartWork(org);
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
async function dispatchPlanning(db, { featureId, userId, orgId, org, gh, secretData, ask, imageFileIds = [], screenshotCount = 0, priorSteps = null, changeNote = '', documents = [], mode = 'initial' }) {
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
    documents,
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
  // Reference documents (a CSV page plan, a spec) that inform the plan. Inline text, not persisted.
  const documents = sanitizeDocuments(request.data?.documents);

  const db = getFirestore();
  const userSnap = await db.collection('users').doc(uid).get();
  const orgId = resolveOrgId(userSnap.exists ? userSnap.data() : null, request.data?.orgId);
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
      ask: prompt, imageFileIds: screenshotFileIds, screenshotCount: images.length, documents, mode: 'initial',
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
  await assertOrgCanStartWork(db, f.orgId); // wallet gate — approving starts a paid build step

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

// Cheap, no-charge plan edit for a feature still in plan_review. The owner tweaks the prepopulated
// steps (title/description/kind, add/remove) directly — NO managed-agent session, NO charge. This is
// the light edit path for a design-origin feature (whose steps were prepopulated from the design, so
// they're already grounded); reviseFeaturePlan stays for a true AI re-plan. Backend-only write of the
// (non-financial) steps array, so it complies with the cardinal rule.
export const editFeaturePlan = onCall({ region: 'asia-south1' }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Please sign in.');
  const featureId = String(request.data?.featureId ?? '').trim();
  if (!featureId) throw new HttpsError('invalid-argument', 'featureId required.');
  const raw = Array.isArray(request.data?.steps) ? request.data.steps : null;
  if (!raw) throw new HttpsError('invalid-argument', 'steps required.');

  // Normalise + cap with the SHARED normalizer (same as the planner output), then re-stamp the
  // review state onto each — these are still proposed steps with no task yet.
  const steps = normalizeSteps(raw).map((s) => ({ ...s, status: 'proposed', taskId: null }));
  if (steps.length === 0) throw new HttpsError('invalid-argument', 'Please keep at least one step.');

  const db = getFirestore();
  const featureRef = db.collection('features').doc(featureId);
  const fSnap = await featureRef.get();
  if (!fSnap.exists) throw new HttpsError('not-found', 'Feature not found.');
  const f = fSnap.data();
  if (f.userId !== uid) throw new HttpsError('permission-denied', 'Not your feature.');
  if (f.status !== 'plan_review') throw new HttpsError('failed-precondition', 'NOT_REVIEWABLE');

  await featureRef.update({ steps, updatedAt: FieldValue.serverTimestamp() });
  return { ok: true };
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

  // Scope to the user's active (or requested) org — features are shown per-org.
  const orgId = resolveOrgId(userSnap.exists ? userSnap.data() : null, request.data?.orgId);
  if (!orgId) return { features: [] };

  // Org deploy config → Firebase preview/revert affordances on the active step's session view.
  let deploy = null;
  const os = await db.collection('organisations').doc(orgId).get();
  const d = os.exists ? os.data().deploy : null;
  if (d && d.host === 'firebase') deploy = { host: 'firebase', testingUrl: d.firebase?.testingUrl || null };

  const snap = await db
    .collection('features')
    .where('userId', '==', uid)
    .where('orgId', '==', orgId)
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
      // The step states: proposed (plan not approved) → pending (no task yet) → running (agent
      // building) → ready (agent finished + charged, PR open, awaiting the owner's deploy) → done
      // (deployed to testing/prod). 'ready' is distinct from 'running' so a finished step that's
      // waiting on the OWNER never looks like one we're still working on. The feature only reaches
      // 'complete' once every step is 'done' (deployed) — a 'ready' step keeps it building.
      let status;
      if (!isBuilding) status = 'proposed';
      else if (!t) status = 'pending';
      else if (deployed) status = 'done';
      else if (t.status === 'failed') status = 'failed';
      // An intermediate step of a warm-session batch: billed + built, but it shares the batch's
      // single PR and waits for the batch's one deploy — show it as 'built', never a deploy card.
      else if (t.status === 'complete' && t.featureIntermediate) status = 'built';
      else if (t.status === 'complete') status = 'ready';
      else status = 'running';

      // The active step (the one needing attention) is whichever is building, finished-and-waiting-
      // to-deploy, or failed — its full session is attached so the card can show progress / deploy /
      // retry. 'built' intermediate steps are done-in-batch, not awaiting the owner, so not active.
      const isActive = status === 'running' || status === 'ready' || status === 'failed';
      if (t) { paidStepsInr += Number(t.finalCharge) || 0; lastTaskId = s.taskId; }
      if (isActive && activeIndex === -1) activeIndex = i;

      return {
        title: s.title || '',
        description: s.description || '',
        kind: s.kind === 'dynamic' ? 'dynamic' : 'static',
        status,
        summary: t?.resultSummary ?? null,
        paidInr: t ? Number(t.finalCharge) || 0 : 0,
        session: t && isActive ? sessionView(t, s.taskId, { userCanDeployProd, deploy }) : null,
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
      // Handed off from a "Design a screen"? Surface the origin so the card can show an editable,
      // prepopulated plan + a link back to the design (no planning charge was taken for these).
      fromDesign: !!f.fromDesign,
      designId: f.designId || null,
      designPrompt: f.design?.originalPrompt || '',
      planningChargeInr,
      totalPaidInr: planningChargeInr + paidStepsInr,
      steps,
      canGoLive: status === 'complete' && userCanDeployProd && !!lastTaskId,
      goLiveTaskId: status === 'complete' ? lastTaskId : null,
      // Sharing state for the "Share with my team" control (token builds the link).
      shared: !!f.shared,
      shareToken: f.shareToken || null,
      forkedFromFeatureId: f.forkedFromFeatureId || null,
      createdAt: f.createdAt?.toMillis?.() ?? null,
    };
  });

  return { features };
});

// ─── Share & fork a feature ───────────────────────────────────────────────────────────────────
// A teammate can SHARE a feature's PLAN (the ordered steps) with another member of the SAME org, who
// FORKS it into their own feature: we copy the prompt + proposed steps into a fresh feature in
// plan_review (NO re-plan, NO planning charge — just like a design hand-off), and they review →
// approve → build it in their own thread. Same org ⇒ same repo + same wallet; each step is charged
// the normal way when it builds. Access is via these callables (Admin SDK), never via rules.

// Only a feature with a real plan is worth sharing.
const SHAREABLE_FEATURE = ['plan_review', 'running', 'complete'];

export const shareFeature = onCall({ region: 'asia-south1' }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Please sign in.');
  const featureId = String(request.data?.featureId ?? '').trim();
  if (!featureId) throw new HttpsError('invalid-argument', 'featureId required.');
  const db = getFirestore();
  const ref = db.collection('features').doc(featureId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Feature not found.');
  const f = snap.data();
  if (f.userId !== uid) throw new HttpsError('permission-denied', 'Not your feature.');
  if (!SHAREABLE_FEATURE.includes(f.status)) throw new HttpsError('failed-precondition', 'NOT_SHAREABLE');
  const shareToken = f.shareToken || randomUUID();
  await ref.update({ shared: true, shareToken, sharedBy: uid, sharedAt: FieldValue.serverTimestamp() });
  return { ok: true, shareToken };
});

export const unshareFeature = onCall({ region: 'asia-south1' }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Please sign in.');
  const featureId = String(request.data?.featureId ?? '').trim();
  if (!featureId) throw new HttpsError('invalid-argument', 'featureId required.');
  const db = getFirestore();
  const ref = db.collection('features').doc(featureId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Feature not found.');
  if (snap.data().userId !== uid) throw new HttpsError('permission-denied', 'Not your feature.');
  await ref.update({ shared: false });
  return { ok: true };
});

// A teammate opens a feature share link — read-only view of the plan (the ordered steps in plain
// English). Strips operator/internal fields.
export const getSharedFeature = onCall({ region: 'asia-south1' }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Please sign in.');
  const db = getFirestore();
  const { d } = await loadShared(db, 'features', uid, String(request.data?.featureId ?? '').trim(), request.data?.shareToken);
  const steps = (Array.isArray(d.steps) ? d.steps : []).map((s) => ({
    title: s.title || '',
    description: s.description || '',
  }));
  return {
    feature: {
      prompt: d.prompt || '',
      steps,
      status: d.status || 'plan_review',
      isOwn: d.userId === uid,
    },
  };
});

// A teammate forks the shared feature into their OWN (same org/repo). Instant + free: we copy the
// prompt + proposed steps into a new feature in plan_review — no re-plan, no planning charge. The
// fork does NOT carry the original's screenshotFileIds (those Anthropic Files-API IDs may have been
// deleted; a build step referencing a dead file fails). Returns the new featureId.
export const forkFeature = onCall({ region: 'asia-south1' }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Please sign in.');
  const db = getFirestore();
  const sourceId = String(request.data?.featureId ?? '').trim();
  const { d } = await loadShared(db, 'features', uid, sourceId, request.data?.shareToken);
  if (d.userId === uid) throw new HttpsError('failed-precondition', 'ALREADY_YOURS');

  const proposed = (Array.isArray(d.steps) && d.steps.length ? d.steps : [])
    .map((s) => ({
      title: s.title || '',
      description: s.description || '',
      kind: s.kind === 'dynamic' ? 'dynamic' : 'static',
      status: 'proposed',
      taskId: null,
    }));
  if (proposed.length === 0) throw new HttpsError('failed-precondition', 'NO_PLAN');

  const forkRef = db.collection('features').doc();
  await forkRef.set({
    userId: uid,
    orgId: d.orgId,
    prompt: `(Building on a shared plan) ${d.prompt || ''}`.slice(0, 1000),
    repoFullName: d.repoFullName,
    status: 'plan_review',
    currentStep: 0,
    steps: proposed,
    screenshotFileIds: [], // do NOT carry stale Files-API ids — they may no longer exist
    imageCount: 0,
    planningChargeInr: 0, // no planning session ran — the plan was copied
    forkedFromFeatureId: sourceId,
    createdAt: FieldValue.serverTimestamp(),
  });
  return { ok: true, featureId: forkRef.id };
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
  await assertOrgCanStartWork(db, f.orgId); // wallet gate — see utils/walletGate.js

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
  await assertOrgCanStartWork(db, f.orgId); // wallet gate — a retry is a fresh run

  const stepIndex = Number(f.currentStep) || 0;
  const cur = f.steps?.[stepIndex];
  if (cur?.taskId) {
    const tSnap = await db.collection('tasks').doc(cur.taskId).get();
    if (tSnap.exists && tSnap.data().status !== 'failed') {
      throw new HttpsError('failed-precondition', 'NOT_RETRYABLE');
    }
  }

  // If earlier steps of the current (un-merged) batch already produced a shared PR, the failed
  // step ran in a now-dead warm session and those commits live on that branch. Continue on it so
  // the retry doesn't lose them; else (step 0, or the batch was already deployed) start fresh.
  let baseBranch = null;
  if (stepIndex > 0) {
    const { secretData } = await loadOrgCtx(db, f.orgId);
    const token = secretData.githubToken;
    for (let i = stepIndex - 1; i >= 0; i--) {
      const pid = f.steps?.[i]?.taskId;
      if (!pid) continue;
      const ps = await db.collection('tasks').doc(pid).get();
      const pt = ps.exists ? ps.data() : null;
      if (pt?.prUrl && !pt.deployedTesting && !pt.deployedProd) {
        const prNum = Number(String(pt.prUrl).split('/').pop());
        if (prNum && f.repoFullName && token) {
          baseBranch = await getPrHeadRef(f.repoFullName, prNum, token).catch(() => null);
        }
        break;
      }
    }
  }

  try {
    await startFeatureStep(db, featureId, stepIndex, { baseBranch });
  } catch (e) {
    console.error('retryFeatureStep', featureId, e?.message || e);
    throw new HttpsError('internal', 'We could not start this step. You were not charged.');
  }
  return { ok: true };
});
