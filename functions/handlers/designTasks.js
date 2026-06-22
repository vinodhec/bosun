import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { startDesignSession, replyDesignSession, MAX_CLARIFY_TURNS } from '../utils/designSession.js';
import { startDesignBuild } from '../utils/designRun.js';
import { sessionView } from '../utils/sessionView.js';
import { designContextFromText } from '../utils/figma.js';
import { firebaseSAsFromSecret, uploadImagesToFiles } from '../utils/claudeAgent.js';
import { agentIdForModel } from '../utils/routeModel.js';
import { sanitizeImages } from '../utils/images.js';
import { resolveOrgId } from '../utils/orgs.js';
import { ANTHROPIC_API_KEY } from '../utils/secrets.js';

// "Design a screen" — a clarify-first flow that previews a NEW screen as a live HTML mock the owner
// approves BEFORE any real build. The clarify chat + mock render run as a CODE-AWARE managed-agent
// session (clones the repo, learns the site's look, never edits) — async, so it's a tasks/{id} of
// kind:'design' that pollSessions finalizes turn by turn. The design phase is charged like planning
// (priceForPlanning = 2× its real COGS) when a mock is ready; the real build after approval is a
// normal fix, charged the bracketed way. Nothing is charged or built until the owner acts.
//
// designs/{id}.status: clarifying → mockup_review → building → complete (failed on a bad session).

// Operational caps for the design SESSION (exploration + a text mock — cheap; no screenshots).
// Cumulative across clarify turns + refines, since they resume the same session.
const DESIGN_MAX_USD = 1.5;
const DESIGN_MAX_SEC = 1800;

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

// Start (or restart, after a fresh prompt) the design session and record it as a kind:'design' task
// pollSessions will finalize. Returns the task id. `ask` is the text the mock is based on.
async function dispatchDesignSession(db, { designId, userId, orgId, org, gh, secretData, ask, imageFileIds = [], screenshotCount = 0 }) {
  const figmaDesign = await designContextFromText({ org, secretData, text: ask });
  const firebaseSAs = firebaseSAsFromSecret(secretData);
  const { sessionId, firebaseFileIds } = await startDesignSession({
    ask,
    repoUrl: `https://github.com/${gh.repoFullName}`,
    githubToken: secretData.githubToken,
    vaultId: gh.vaultId,
    agentId: agentIdForModel('sonnet'),
    firebaseSAs,
    figmaDesign,
    imageFileIds,
    screenshotCount,
  });
  const taskRef = db.collection('tasks').doc();
  await taskRef.set({
    userId,
    orgId,
    designId,
    kind: 'design',
    status: 'running',
    sessionId,
    firebaseFileIds: firebaseFileIds || [],
    model: 'sonnet',
    maxBudgetUsd: DESIGN_MAX_USD,
    maxSeconds: DESIGN_MAX_SEC,
    reviewedCostUsd: 0,
    reviewedSeconds: 0,
    createdAt: FieldValue.serverTimestamp(),
  });
  return { taskId: taskRef.id, sessionId };
}

// "Design a screen": kick off the clarify + mock session. We persist the owner's screenshots once
// (Files API) so they carry into the design AND the build, fetch any Figma design, and start the
// session. The design is created `clarifying`; NOTHING is charged or built yet.
export const planDesign = onCall({ region: 'asia-south1', secrets: [ANTHROPIC_API_KEY] }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Please sign in.');
  const prompt = String(request.data?.prompt ?? '').trim();
  if (!prompt) throw new HttpsError('invalid-argument', 'Please describe the screen you want.');
  const images = sanitizeImages(request.data?.images);

  const db = getFirestore();
  const userSnap = await db.collection('users').doc(uid).get();
  const orgId = resolveOrgId(userSnap.exists ? userSnap.data() : null, request.data?.orgId);
  if (!orgId) throw new HttpsError('failed-precondition', 'NO_ORG');
  const { org, gh, secretData } = await loadOrgCtx(db, orgId);

  const screenshotFileIds = await uploadImagesToFiles(images);

  const designRef = db.collection('designs').doc();
  await designRef.set({
    userId: uid,
    orgId,
    prompt,
    repoFullName: gh.repoFullName,
    status: 'clarifying',
    awaitingOwner: false,
    turns: [{ role: 'owner', text: prompt, at: Date.now() }],
    brief: '',
    mockUrl: null,
    screenshotFileIds,
    imageCount: images.length,
    designChargeInr: 0,
    designCostUsd: 0,
    createdAt: FieldValue.serverTimestamp(),
  });

  try {
    const { taskId, sessionId } = await dispatchDesignSession(db, {
      designId: designRef.id, userId: uid, orgId, org, gh, secretData,
      ask: prompt, imageFileIds: screenshotFileIds, screenshotCount: images.length,
    });
    await designRef.update({ designTaskId: taskId, sessionId });
  } catch (e) {
    console.error('planDesign:dispatch', designRef.id, e?.message || e);
    await designRef.update({ status: 'failed', error: 'design_dispatch_failed' });
    throw new HttpsError('internal', 'We could not start designing this screen. You were not charged.');
  }

  return { designId: designRef.id };
});

// Owner answers the agent's clarifying questions → resume the SAME session with their reply.
export const replyToClarify = onCall({ region: 'asia-south1', secrets: [ANTHROPIC_API_KEY] }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Please sign in.');
  const designId = String(request.data?.designId ?? '').trim();
  const answer = String(request.data?.answer ?? '').trim();
  if (!designId) throw new HttpsError('invalid-argument', 'designId required.');
  if (!answer) throw new HttpsError('invalid-argument', 'Please type your answer.');

  const db = getFirestore();
  const designRef = db.collection('designs').doc(designId);
  const snap = await designRef.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Design not found.');
  const d = snap.data();
  if (d.userId !== uid) throw new HttpsError('permission-denied', 'Not your design.');
  if (d.status !== 'clarifying' || !d.awaitingOwner) throw new HttpsError('failed-precondition', 'NOT_AWAITING');
  if (!d.sessionId || !d.designTaskId) throw new HttpsError('failed-precondition', 'NO_SESSION');
  const ownerTurns = (Array.isArray(d.turns) ? d.turns : []).filter((t) => t.role === 'owner').length;
  if (ownerTurns > MAX_CLARIFY_TURNS) throw new HttpsError('failed-precondition', 'TOO_MANY_REPLIES');

  await designRef.update({
    turns: FieldValue.arrayUnion({ role: 'owner', text: answer.slice(0, 1000), at: Date.now() }),
    awaitingOwner: false,
  });
  try {
    await replyDesignSession({ sessionId: d.sessionId, answer });
    await db.collection('tasks').doc(d.designTaskId).update({ status: 'running' });
  } catch (e) {
    console.error('replyToClarify', designId, e?.message || e);
    await designRef.update({ awaitingOwner: true }); // let them retry
    throw new HttpsError('internal', 'We could not send your answer. Please try again.');
  }
  return { ok: true };
});

// Owner wants the mock changed before building → resume the session with the change; a fresh mock is
// produced and charged like the first (priceForPlanning), same as reviseFeaturePlan.
export const refineMockup = onCall({ region: 'asia-south1', secrets: [ANTHROPIC_API_KEY] }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Please sign in.');
  const designId = String(request.data?.designId ?? '').trim();
  const changes = String(request.data?.changes ?? '').trim();
  if (!designId) throw new HttpsError('invalid-argument', 'designId required.');
  if (!changes) throw new HttpsError('invalid-argument', 'Please describe the change you want.');

  const db = getFirestore();
  const designRef = db.collection('designs').doc(designId);
  const snap = await designRef.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Design not found.');
  const d = snap.data();
  if (d.userId !== uid) throw new HttpsError('permission-denied', 'Not your design.');
  if (d.status !== 'mockup_review') throw new HttpsError('failed-precondition', 'NOT_REVIEWABLE');
  if (!d.sessionId || !d.designTaskId) throw new HttpsError('failed-precondition', 'NO_SESSION');

  await designRef.update({
    status: 'clarifying',
    awaitingOwner: false,
    turns: FieldValue.arrayUnion({ role: 'owner', text: changes.slice(0, 1000), at: Date.now() }),
  });
  try {
    await replyDesignSession({ sessionId: d.sessionId, answer: `Please change the mockup: ${changes}` });
    await db.collection('tasks').doc(d.designTaskId).update({ status: 'running' });
  } catch (e) {
    console.error('refineMockup', designId, e?.message || e);
    await designRef.update({ status: 'mockup_review' }); // leave the existing mock intact to retry
    throw new HttpsError('internal', 'We could not start that change. Your mockup is unchanged.');
  }
  return { ok: true };
});

// Owner approves the mock → build the screen for real (a normal bracketed fix carrying designId).
export const approveDesign = onCall({ region: 'asia-south1', secrets: [ANTHROPIC_API_KEY] }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Please sign in.');
  const designId = String(request.data?.designId ?? '').trim();
  if (!designId) throw new HttpsError('invalid-argument', 'designId required.');
  // The owner may add extra build instructions when approving — these ride into the build handoff.
  const notes = String(request.data?.notes ?? '').trim().slice(0, 1500);

  const db = getFirestore();
  const designRef = db.collection('designs').doc(designId);
  const snap = await designRef.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Design not found.');
  const d = snap.data();
  if (d.userId !== uid) throw new HttpsError('permission-denied', 'Not your design.');
  if (d.status !== 'mockup_review') throw new HttpsError('failed-precondition', 'NOT_REVIEWABLE');
  if (!d.brief) throw new HttpsError('failed-precondition', 'NO_MOCK');

  try {
    const buildTaskId = await startDesignBuild(db, designId, { notes });
    await designRef.update({ status: 'building', buildTaskId, buildNotes: notes || null });
    // The design session task is done with its job (clarify + mock); stop polling it.
    if (d.designTaskId) await db.collection('tasks').doc(d.designTaskId).update({ status: 'complete' }).catch(() => {});
  } catch (e) {
    console.error('approveDesign', designId, e?.message || e);
    throw new HttpsError('internal', 'We could not start building. You were not charged for a build.');
  }
  return { ok: true };
});

// Customer-facing view of their designs, newest first: the clarify chat, the live mock URL (for the
// iframe), the running total paid, and — while building — the build's session view (so the dashboard
// reuses the normal fix card for deploy/go-live). Strips operator-only fields.
export const listMyDesigns = onCall({ region: 'asia-south1' }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Please sign in.');
  const db = getFirestore();

  const userSnap = await db.collection('users').doc(uid).get();
  const userCanDeployProd = userSnap.exists && userSnap.data().canDeployProd === true;
  const orgId = resolveOrgId(userSnap.exists ? userSnap.data() : null, request.data?.orgId);
  if (!orgId) return { designs: [] };

  let deploy = null;
  const os = await db.collection('organisations').doc(orgId).get();
  const dep = os.exists ? os.data().deploy : null;
  if (dep && dep.host === 'firebase') deploy = { host: 'firebase', testingUrl: dep.firebase?.testingUrl || null };

  const snap = await db
    .collection('designs')
    .where('userId', '==', uid)
    .where('orgId', '==', orgId)
    .orderBy('createdAt', 'desc')
    .limit(10)
    .get();
  if (snap.empty) return { designs: [] };

  // Fetch build tasks to surface the active build card + derive completion from its deploy state.
  const buildIds = snap.docs.map((d) => d.data().buildTaskId).filter(Boolean);
  const taskById = {};
  if (buildIds.length) {
    const taskSnaps = await db.getAll(...buildIds.map((id) => db.collection('tasks').doc(id)));
    for (const ts of taskSnaps) if (ts.exists) taskById[ts.id] = ts.data();
  }

  const designs = snap.docs.map((doc) => {
    const d = doc.data();
    const build = d.buildTaskId ? taskById[d.buildTaskId] : null;
    const buildPaidInr = build ? Number(build.finalCharge) || 0 : 0;
    const deployed = !!(build && (build.deployedTesting || build.deployedProd));
    // Lifecycle straight from the doc, but upgrade building→complete once the build is on testing.
    let status = d.status || 'clarifying';
    if (status === 'building' && deployed) status = 'complete';

    return {
      id: doc.id,
      prompt: d.prompt || '',
      status, // clarifying | mockup_review | building | complete | failed
      awaitingOwner: !!d.awaitingOwner,
      turns: Array.isArray(d.turns) ? d.turns : [],
      brief: d.brief || '',
      mockUrl: d.mockUrl || null,
      designChargeInr: Number(d.designChargeInr) || 0,
      totalPaidInr: (Number(d.designChargeInr) || 0) + buildPaidInr,
      session: build ? sessionView(build, d.buildTaskId, { userCanDeployProd, deploy }) : null,
      canGoLive: status === 'complete' && userCanDeployProd && !!d.buildTaskId,
      goLiveTaskId: status === 'complete' ? d.buildTaskId : null,
      createdAt: d.createdAt?.toMillis?.() ?? null,
    };
  });

  return { designs };
});
