import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { continueFixSession, startFixSession } from '../utils/claudeAgent.js';
import { modelForComplexity, agentIdForModel } from '../utils/routeModel.js';
import { MAX_FREE_REVISIONS, REVISION_REASONS, isFreeRevision } from '../utils/billing.js';
import { chargeApprovedFix } from '../utils/finalize.js';
import { ANTHROPIC_API_KEY } from '../utils/secrets.js';

// Customer-facing view of their fix sessions. Returns ONLY safe fields — never the PR
// link, model, raw API cost, or margin. Internals stay backend-only.
export const listMySessions = onCall({ region: 'asia-south1' }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Please sign in.');

  const db = getFirestore();
  const snap = await db
    .collection('tasks')
    .where('userId', '==', uid)
    .orderBy('createdAt', 'desc')
    .limit(20)
    .get();

  return {
    sessions: snap.docs.map((d) => {
      const t = d.data();
      const merged = !!(t.deployedTesting || t.deployedProd);
      const pendingReview = !!t.pendingReview;
      return {
        id: d.id,
        problem: t.prompt ?? '',
        status: t.status ?? null, // queued | running | complete | failed | needs_quote | quoted | cancelled
        complexity: t.complexity ?? null,
        quoteInr: t.status === 'quoted' ? (Number(t.priceInr) || 0) : null,
        summary: t.resultSummary ?? null,
        changes: Array.isArray(t.filesChanged)
          ? t.filesChanged.map((f) => String(f?.description || '')).filter(Boolean).slice(0, 12)
          : [],
        previewUrl: t.previewUrl ?? null,
        buildingPreview: !!t.needsPreview,
        // Money: what they've already paid, and what tapping "Looks good" will charge now.
        paidInr: Number(t.finalCharge) || 0,
        owedInr: pendingReview ? Number(t.currentRoundCharge) || 0 : 0,
        priceInr: t.priceInr ?? null,
        // Approval state (approve-before-charge): a finished round waits for the customer.
        pendingReview,
        approved: !!t.approved,
        freeRevisionsLeft: Math.max(0, MAX_FREE_REVISIONS - (Number(t.freeRevisionsUsed) || 0)),
        // The change request currently being applied — echoed while it runs.
        revisePrompt: t.revisePrompt ?? null,
        // The iteration thread: initial fix + each revision, with per-round prompt, summary,
        // plain-English changes, and what (if anything) that round added to the price.
        rounds: Array.isArray(t.rounds)
          ? t.rounds.map((r) => ({
              kind: r.kind || 'initial', // 'initial' | 'unresolved' | 'new_scope'
              prompt: String(r.prompt || ''),
              summary: String(r.summary || ''),
              changes: Array.isArray(r.changes)
                ? r.changes.map((c) => String(c || '')).filter(Boolean).slice(0, 12)
                : [],
              addedInr: Number(r.addedInr) || 0,
              free: r.kind !== 'initial' && (Number(r.addedInr) || 0) === 0,
              charged: !!r.charged,
              at: r.at ?? null,
            }))
          : [],
        canApprove: t.status === 'complete' && pendingReview,
        canRevise: t.status === 'complete' && !merged,
        deployed: merged,
        createdAt: t.createdAt?.toMillis?.() ?? null,
      };
    }),
  };
});

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
    if (m.startsWith('INSUFFICIENT_BALANCE')) throw new HttpsError('failed-precondition', m);
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

    const priceInr = Number(task.priceInr) || 0;
    const addedInr = free ? 0 : priceInr;
    const owedAfter = (Number(task.currentRoundCharge) || 0) + addedInr;

    // Ensure the org can cover what will be owed at approval before we spend the work.
    if (owedAfter > 0) {
      const orgSnap = await db.collection('organisations').doc(task.orgId).get();
      if (Number(orgSnap.data()?.balance ?? 0) < owedAfter) {
        throw new HttpsError('failed-precondition', `INSUFFICIENT_BALANCE:${owedAfter}`);
      }
    }

    // Dispatch first; only flip the task to 'running' once the agent has the instruction, so
    // a dispatch failure leaves the fix exactly as it was (still awaiting review, no charge).
    try {
      await continueFixSession({ sessionId: task.sessionId, changes });
    } catch (e) {
      console.error('reviseSession:dispatch', taskId, e?.message || e);
      throw new HttpsError('internal', 'We could not start the changes. You were not charged.');
    }

    await taskRef.update({
      status: 'running',
      pendingReview: false,
      approved: false,
      kind: reason,
      round: (Number(task.round) || 0) + 1,
      revisePrompt: changes,
      currentRoundCharge: owedAfter,
      freeRevisionsUsed: free ? freeUsed + 1 : freeUsed,
      pendingRound: { kind: reason, reason, addedInr, prompt: changes },
      previewUrl: null,
      needsPreview: false,
      previewTries: 0,
      revisedAt: FieldValue.serverTimestamp(),
    });

    return { ok: true, free, addedInr, owedInr: owedAfter };
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

    const quoteInr = Number(task.priceInr) || 0;
    const orgSnap = await db.collection('organisations').doc(task.orgId).get();
    if (Number(orgSnap.data()?.balance ?? 0) < quoteInr) {
      throw new HttpsError('failed-precondition', `INSUFFICIENT_BALANCE:${quoteInr}`);
    }
    const gh = orgSnap.data()?.github;
    if (!gh?.repoFullName || !gh?.vaultId) throw new HttpsError('failed-precondition', 'NO_REPO_CONNECTED');
    const secretSnap = await db.collection('orgSecrets').doc(task.orgId).get();
    const githubToken = secretSnap.exists ? secretSnap.data().githubToken : null;
    if (!githubToken) throw new HttpsError('failed-precondition', 'NO_REPO_CONNECTED');

    const model = modelForComplexity(task.complexity);
    const repoUrl = `https://github.com/${gh.repoFullName}`;
    try {
      const { sessionId } = await startFixSession({
        prompt: task.prompt, images: [], repoUrl, githubToken, vaultId: gh.vaultId, agentId: agentIdForModel(model),
      });
      await taskRef.update({ status: 'running', sessionId, model, confirmedAt: FieldValue.serverTimestamp() });
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
