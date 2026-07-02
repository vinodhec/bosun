import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { randomUUID } from 'node:crypto';
import { loadShared } from '../utils/sharing.js';
import { continueFixSession, startFixSession, firebaseSAsFromSecret } from '../utils/claudeAgent.js';
import { designContextFromText } from '../utils/figma.js';
import { resolveModel, agentIdForModel } from '../utils/routeModel.js';
import { MAX_FREE_REVISIONS, REVISION_REASONS, isFreeRevision } from '../utils/billing.js';
import { sanitizeImages } from '../utils/images.js';
import { sanitizeDocuments } from '../utils/documents.js';
import { chargeApprovedFix } from '../utils/finalize.js';
import { sessionView } from '../utils/sessionView.js';
import { resolveOrgId, isMember } from '../utils/orgs.js';
import { ANTHROPIC_API_KEY } from '../utils/secrets.js';

// Customer-facing view of their fix sessions. Returns ONLY safe fields — never the PR
// link, model, raw API cost, or margin. Internals stay backend-only.
export const listMySessions = onCall({ region: 'asia-south1' }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Please sign in.');

  const db = getFirestore();

  // Whether this customer may publish to PRODUCTION (go live). Per-user grant, set by the
  // operator (adminSetUserDeploy). One read, applied to every card's `canDeployProd` below.
  // Publishing to testing is open to every org member; the PR link is never exposed —
  // deploy goes by taskId.
  const userSnap = await db.collection('users').doc(uid).get();
  const userCanDeployProd = userSnap.exists && userSnap.data().canDeployProd === true;

  // Scope the list to the user's active (or requested) org — each fix belongs to one org.
  const orgId = resolveOrgId(userSnap.exists ? userSnap.data() : null, request.data?.orgId);
  if (!orgId) return { sessions: [] };

  // The org's deploy config drives the Firebase preview/revert buttons (null host → Vercel flow).
  const deploy = await orgDeployConfig(db, orgId);

  const snap = await db
    .collection('tasks')
    .where('userId', '==', uid)
    .where('orgId', '==', orgId)
    .orderBy('createdAt', 'desc')
    .limit(20)
    .get();

  return {
    // Feature steps, design builds AND comparison sessions are filtered out here — they belong to a
    // feature/design/comparison and are shown inside that card (listMyFeatures / listMyDesigns /
    // listMyComparisons), never as standalone fixes. sessionView is the shared task → safe-view
    // projection used by all of them.
    sessions: snap.docs
      .filter((d) => !d.data().featureId && !d.data().designId && !d.data().comparisonId)
      .map((d) => sessionView(d.data(), d.id, { userCanDeployProd, deploy })),
  };
});

// Switch the user's ACTIVE organisation (the one the dashboard scopes to). Verifies the user is
// a member, then updates `users.activeOrgId` (+ the legacy `orgId` mirror). No claim re-mint is
// needed — firestore.rules gate on the `orgIds` membership claim, not the active selection.
export const setActiveOrg = onCall({ region: 'asia-south1' }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Please sign in.');
  const orgId = String(request.data?.orgId ?? '').trim();
  if (!orgId) throw new HttpsError('invalid-argument', 'orgId required.');

  const db = getFirestore();
  const userRef = db.collection('users').doc(uid);
  const snap = await userRef.get();
  if (!isMember(snap.exists ? snap.data() : null, orgId)) {
    throw new HttpsError('permission-denied', 'Not a member of that organisation.');
  }
  await userRef.update({ activeOrgId: orgId, orgId, activeOrgAt: FieldValue.serverTimestamp() });
  return { ok: true, orgId };
});

// The org's deploy surface for the customer view: { host, testingUrl }, or null for a Vercel
// org / no org. Shared by listMySessions and listMyFeatures so the two never drift.
async function orgDeployConfig(db, orgId) {
  if (!orgId) return null;
  const snap = await db.collection('organisations').doc(orgId).get();
  if (!snap.exists) return null;
  const d = snap.data().deploy;
  if (!d || d.host !== 'firebase') return null;
  return { host: 'firebase', testingUrl: d.firebase?.testingUrl || null };
}

// Approve a finished fix ("Looks good"). THIS is when money moves: we charge the flat tier
// price owed for the current cycle (0 for a free re-fix cycle) and unlock going live.
export const approveFix = onCall({ region: 'asia-south1' }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Please sign in.');
  const taskId = String(request.data?.taskId ?? '').trim();
  if (!taskId) throw new HttpsError('invalid-argument', 'taskId required.');

  try {
    const { charged, finalCharge } = await chargeApprovedFix(taskId, uid);
    return { ok: true, charged, finalCharge };
  } catch (e) {
    const m = String(e?.message || '');
    if (m === 'not_owner') throw new HttpsError('permission-denied', 'Not your fix.');
    if (m === 'not_pending_review') throw new HttpsError('failed-precondition', 'NOT_PENDING');
    if (m === 'task_not_found') throw new HttpsError('not-found', 'Fix not found.');
    console.error('approveFix', taskId, m);
    throw new HttpsError('internal', 'We could not confirm the fix. You were not charged.');
  }
});

// "Request changes": resume the SAME session for another round. Allowed only while a fix is
// awaiting review and NOT yet live. `reason` decides the price:
//   'unresolved' (didn't work / not what I meant) → FREE, capped at MAX_FREE_REVISIONS.
//   'new_scope'  (something new)                  → adds one tier price to what's owed.
// Nothing is charged here — the accrued amount is charged when the customer approves.
export const reviseSession = onCall(
  { region: 'asia-south1', secrets: [ANTHROPIC_API_KEY] },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'Please sign in.');

    const taskId = String(request.data?.taskId ?? '').trim();
    const changes = String(request.data?.changes ?? '').trim();
    let reason = String(request.data?.reason ?? 'unresolved').trim();
    if (!REVISION_REASONS.includes(reason)) reason = 'unresolved';
    if (!taskId) throw new HttpsError('invalid-argument', 'taskId required.');
    if (!changes) throw new HttpsError('invalid-argument', 'Please describe the changes you want.');

    // Optional fresh screenshots attached to this change request (validated + capped).
    const images = sanitizeImages(request.data?.images);
    // Optional reference documents attached to this change request (inline text, not persisted).
    const documents = sanitizeDocuments(request.data?.documents);

    const db = getFirestore();
    const taskRef = db.collection('tasks').doc(taskId);
    const snap = await taskRef.get();
    if (!snap.exists) throw new HttpsError('not-found', 'Session not found.');
    const task = snap.data();

    if (task.userId !== uid) throw new HttpsError('permission-denied', 'Not your session.');
    if (!task.sessionId) throw new HttpsError('failed-precondition', 'NO_SESSION');
    // Revisions are allowed on any completed (not-yet-live) fix — whether it's awaiting
    // approval (requireApproval orgs) or already auto-charged (default orgs).
    if (task.status !== 'complete') throw new HttpsError('failed-precondition', 'NOT_READY');
    if (task.deployedTesting || task.deployedProd) {
      throw new HttpsError('failed-precondition', 'ALREADY_DEPLOYED');
    }

    const free = isFreeRevision(reason);
    const freeUsed = Number(task.freeRevisionsUsed) || 0;
    if (free && freeUsed >= MAX_FREE_REVISIONS) {
      // Out of free re-fixes — they must approve what they have, or ask for it as new scope.
      throw new HttpsError('failed-precondition', 'TOO_MANY_FREE_REVISIONS');
    }

    // A Figma link in the change request enriches the revision the same way as the initial fix
    // (exact spec + rendered image), so design tweaks land pixel-perfect too. Null on any problem.
    const orgSnap = await db.collection('organisations').doc(task.orgId).get();
    const secretSnap = await db.collection('orgSecrets').doc(task.orgId).get();
    const figmaDesign = await designContextFromText({
      org: orgSnap.exists ? orgSnap.data() : null,
      secretData: secretSnap.exists ? secretSnap.data() : {},
      text: changes,
    });

    // Dispatch first; only flip the task to 'running' once the agent has the instruction, so
    // a dispatch failure leaves the fix exactly as it was (still awaiting review, no charge).
    try {
      await continueFixSession({ sessionId: task.sessionId, changes, images, figmaDesign, documents });
    } catch (e) {
      console.error('reviseSession:dispatch', taskId, e?.message || e);
      throw new HttpsError('internal', 'We could not start the changes. You were not charged.');
    }

    // Price is computed in markRoundReady from this round's actual COGS — `currentRoundCharge`
    // already holds any unapproved amount from the prior round, which markRoundReady adds to.
    await taskRef.update({
      status: 'running',
      pendingReview: false,
      approved: false,
      kind: reason,
      round: (Number(task.round) || 0) + 1,
      revisePrompt: changes,
      freeRevisionsUsed: free ? freeUsed + 1 : freeUsed,
      pendingRound: { kind: reason, reason, addedInr: 0, prompt: changes },
      previewUrl: null,
      needsPreview: false,
      previewTries: 0,
      revisedAt: FieldValue.serverTimestamp(),
    });

    return { ok: true, free };
  }
);

// Customer accepts the operator's quote for a big job → we dispatch the agent. Charging
// follows the normal path: the flat quote is charged when the fix is ready (or on approval,
// per the org toggle). Screenshots aren't carried (not persisted), so the run uses the text.
export const confirmQuote = onCall(
  { region: 'asia-south1', secrets: [ANTHROPIC_API_KEY] },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'Please sign in.');
    const taskId = String(request.data?.taskId ?? '').trim();
    if (!taskId) throw new HttpsError('invalid-argument', 'taskId required.');

    const db = getFirestore();
    const taskRef = db.collection('tasks').doc(taskId);
    const snap = await taskRef.get();
    if (!snap.exists) throw new HttpsError('not-found', 'Quote not found.');
    const task = snap.data();
    if (task.userId !== uid) throw new HttpsError('permission-denied', 'Not your quote.');
    if (task.status !== 'quoted') throw new HttpsError('failed-precondition', 'NOT_QUOTED');

    const orgSnap = await db.collection('organisations').doc(task.orgId).get();
    const gh = orgSnap.data()?.github;
    if (!gh?.repoFullName || !gh?.vaultId) throw new HttpsError('failed-precondition', 'NO_REPO_CONNECTED');
    const secretSnap = await db.collection('orgSecrets').doc(task.orgId).get();
    const secretData = secretSnap.exists ? secretSnap.data() : {};
    const githubToken = secretData.githubToken;
    if (!githubToken) throw new HttpsError('failed-precondition', 'NO_REPO_CONNECTED');
    const firebaseSAs = firebaseSAsFromSecret(secretData);

    // Honour an operator model override stamped on the quote (adminRunFix), else default routing.
    const model = resolveModel(task.complexity, task.modelOverride);
    const repoUrl = `https://github.com/${gh.repoFullName}`;
    try {
      const { sessionId, firebaseFileIds } = await startFixSession({
        prompt: task.prompt, images: [], repoUrl, githubToken, vaultId: gh.vaultId, agentId: agentIdForModel(model), firebaseSAs, pageUrl: task.pageUrl || null,
      });
      await taskRef.update({ status: 'running', sessionId, model, firebaseFileIds: firebaseFileIds || [], confirmedAt: FieldValue.serverTimestamp() });
    } catch (e) {
      console.error('confirmQuote:dispatch', taskId, e?.message || e);
      throw new HttpsError('internal', 'We could not start the work. You were not charged.');
    }
    return { ok: true };
  }
);

// Customer declines a quote (or wants to reduce scope). Nothing was charged.
export const declineQuote = onCall({ region: 'asia-south1' }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Please sign in.');
  const taskId = String(request.data?.taskId ?? '').trim();
  if (!taskId) throw new HttpsError('invalid-argument', 'taskId required.');
  const db = getFirestore();
  const taskRef = db.collection('tasks').doc(taskId);
  const snap = await taskRef.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Quote not found.');
  const task = snap.data();
  if (task.userId !== uid) throw new HttpsError('permission-denied', 'Not your quote.');
  if (!['quoted', 'needs_quote', 'needs_requote'].includes(task.status)) {
    throw new HttpsError('failed-precondition', 'NOT_QUOTED');
  }
  await taskRef.update({ status: 'cancelled', cancelledAt: FieldValue.serverTimestamp() });
  return { ok: true };
});

// ─── Share & fork a fix ───────────────────────────────────────────────────────────────────────
// A teammate can SHARE a finished fix (the chat + what we changed) with another member of the SAME
// org, who uses it as a STARTING POINT: opening the share link pre-fills their normal "fix a website"
// box with the shared brief, so they tweak it and run it as their own fix. Same org ⇒ same repo +
// same wallet, so there's nothing to copy and nothing to bill until they actually submit a fix.

// The plain-English brief worth carrying forward: the polished idealDescription if we have one
// (a ready-to-paste prompt), else the owner's original words.
function fixBrief(task) {
  return String(task.idealDescription || task.prompt || '').slice(0, 1000);
}

// Owner turns sharing ON for a finished fix. Mints a capability token for the link (reused if already
// shared). Returns the token so the client can build the share URL.
export const shareSession = onCall({ region: 'asia-south1' }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Please sign in.');
  const taskId = String(request.data?.taskId ?? '').trim();
  if (!taskId) throw new HttpsError('invalid-argument', 'taskId required.');
  const db = getFirestore();
  const ref = db.collection('tasks').doc(taskId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Fix not found.');
  const t = snap.data();
  if (t.userId !== uid) throw new HttpsError('permission-denied', 'Not your fix.');
  if (t.status !== 'complete') throw new HttpsError('failed-precondition', 'NOT_SHAREABLE'); // nothing finished to share
  const shareToken = t.shareToken || randomUUID();
  await ref.update({ shared: true, shareToken, sharedBy: uid, sharedAt: FieldValue.serverTimestamp() });
  return { ok: true, shareToken };
});

export const unshareSession = onCall({ region: 'asia-south1' }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Please sign in.');
  const taskId = String(request.data?.taskId ?? '').trim();
  if (!taskId) throw new HttpsError('invalid-argument', 'taskId required.');
  const db = getFirestore();
  const ref = db.collection('tasks').doc(taskId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Fix not found.');
  if (snap.data().userId !== uid) throw new HttpsError('permission-denied', 'Not your fix.');
  await ref.update({ shared: false });
  return { ok: true };
});

// A teammate opens a fix share link — read-only view of the chat + what changed, plus the `brief`
// the client uses to pre-fill their fix box ("use as a starting point"). Strips operator fields.
export const getSharedSession = onCall({ region: 'asia-south1' }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Please sign in.');
  const db = getFirestore();
  const { d } = await loadShared(db, 'tasks', uid, String(request.data?.taskId ?? '').trim(), request.data?.shareToken);
  // sessionView is the customer-safe projection; we hand back a read-only subset + the brief to seed a fix.
  const view = sessionView(d, request.data?.taskId, {});
  return {
    session: {
      problem: view.problem,
      summary: view.summary,
      changes: view.changes,
      rounds: view.rounds,
      brief: fixBrief(d),
      isOwn: d.userId === uid,
    },
  };
});
