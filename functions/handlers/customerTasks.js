import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { continueFixSession } from '../utils/claudeAgent.js';
import { maxChargeForBudget } from '../utils/billing.js';
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
      return {
        id: d.id,
        problem: t.prompt ?? '',
        status: t.status ?? null, // queued | running | complete | failed
        summary: t.resultSummary ?? null,
        // Plain-English descriptions only — drop file names / any technical bits.
        changes: Array.isArray(t.filesChanged)
          ? t.filesChanged.map((f) => String(f?.description || '')).filter(Boolean).slice(0, 12)
          : [],
        previewUrl: t.previewUrl ?? null,
        buildingPreview: !!t.needsPreview,
        charge: t.finalCharge ?? null, // what they pay (cumulative across revisions)
        canRevise: t.status === 'complete' && !merged,
        deployed: merged,
        createdAt: t.createdAt?.toMillis?.() ?? null,
      };
    }),
  };
});

// Resume the SAME session with more changes. Allowed only while the fix is complete and
// NOT yet deployed (PR not merged). Cost accrues on the same session; pollSessions bills
// the incremental round. Revisions are charged actual × 2 with NO ₹75 floor.
export const reviseSession = onCall(
  { region: 'asia-south1', secrets: [ANTHROPIC_API_KEY] },
  async (request) => {
    const uid = request.auth?.uid;
    if (!uid) throw new HttpsError('unauthenticated', 'Please sign in.');

    const taskId = String(request.data?.taskId ?? '').trim();
    const changes = String(request.data?.changes ?? '').trim();
    if (!taskId) throw new HttpsError('invalid-argument', 'taskId required.');
    if (!changes) throw new HttpsError('invalid-argument', 'Please describe the changes you want.');

    const db = getFirestore();
    const taskRef = db.collection('tasks').doc(taskId);
    const snap = await taskRef.get();
    if (!snap.exists) throw new HttpsError('not-found', 'Session not found.');
    const task = snap.data();

    if (task.userId !== uid) throw new HttpsError('permission-denied', 'Not your session.');
    if (!task.sessionId) throw new HttpsError('failed-precondition', 'NO_SESSION');
    if (task.status !== 'complete') throw new HttpsError('failed-precondition', 'NOT_READY');
    if (task.deployedTesting || task.deployedProd) {
      // Once it's live, the session is closed — a further change is a brand-new fix.
      throw new HttpsError('failed-precondition', 'ALREADY_DEPLOYED');
    }

    // Must hold enough credit to cover another full round (same flat cap as a new fix).
    const rate = Number(process.env.USD_TO_INR) || undefined;
    const maxBudgetUsd = task.maxBudgetUsd || Number(process.env.AGENT_MAX_BUDGET_USD) || 3;
    const required = maxChargeForBudget(maxBudgetUsd, { rate });
    const orgSnap = await db.collection('organisations').doc(task.orgId).get();
    if (Number(orgSnap.data()?.balance ?? 0) < required) {
      throw new HttpsError('failed-precondition', `INSUFFICIENT_BALANCE:${required}`);
    }

    // Re-open the round: status back to running, kind='unresolved' (no floor), billed=false
    // so pollSessions finalizes + bills the incremental cost. billedCostUsd carries forward.
    await taskRef.update({
      status: 'running',
      billed: false,
      kind: 'unresolved',
      round: (Number(task.round) || 0) + 1,
      revisePrompt: changes,
      previewUrl: null,
      needsPreview: false,
      previewTries: 0,
      revisedAt: FieldValue.serverTimestamp(),
    });

    try {
      await continueFixSession({ sessionId: task.sessionId, changes });
    } catch (e) {
      // Roll back to the prior completed state — we never charge for a failed dispatch.
      await taskRef.update({ status: 'complete', billed: true });
      console.error('reviseSession:dispatch', taskId, e?.message || e);
      throw new HttpsError('internal', 'We could not start the changes. You were not charged.');
    }

    return { ok: true };
  }
);
