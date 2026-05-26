import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { computeCharge, appliesFloor } from './billing.js';

// The SINGLE billing implementation. Atomic + idempotent (guarded by task.billed).
// Deducts from the task's ORGANISATION. Fair revisions ('unresolved') skip the ₹75 floor.
//
// ROUND-AWARE: `actualCostUsd` is the session's CUMULATIVE cost. We bill only the
// INCREMENTAL cost since the last billed round (task.billedCostUsd), so each revision on
// the same session charges for just the new work. finalCharge accumulates across rounds.

export async function billTaskSuccess(taskId, { actualCostUsd, resultSummary, filesChanged, prUrl, downloadUrl }) {
  const db = getFirestore();
  const taskRef = db.collection('tasks').doc(taskId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(taskRef);
    if (!snap.exists) throw new Error('task_not_found');
    const task = snap.data();
    if (task.billed) return { alreadyBilled: true, finalCharge: task.finalCharge ?? 0 };

    const rate = Number(process.env.USD_TO_INR) || undefined;
    const kind = task.kind || 'initial'; // revisions set kind='unresolved' (no ₹75 floor)

    const totalUsd = Number(actualCostUsd) || 0;
    const prevBilledUsd = Number(task.billedCostUsd) || 0;
    const roundUsd = Math.max(0, totalUsd - prevBilledUsd); // cost of THIS round only

    const { finalCharge: roundCharge } = computeCharge(roundUsd, {
      rate,
      applyFloor: appliesFloor(kind),
    });
    const cumulativeInr = computeCharge(totalUsd, { rate }).actualCostInr;
    const newFinalCharge = (Number(task.finalCharge) || 0) + roundCharge;

    // Append THIS round to the task's thread (initial fix + each revision) so the UI can
    // show prompt + summary + cost for every iteration, not just the latest. The revision
    // text/summary are overwritten each round, so we snapshot them here. A serverTimestamp
    // sentinel can't live inside an array element, so we store epoch millis.
    const priorRounds = Array.isArray(task.rounds) ? task.rounds : [];
    const roundEntry = {
      kind, // 'initial' | 'unresolved' (a revision)
      prompt: kind === 'initial' ? (task.prompt || '') : (task.revisePrompt || ''),
      summary: resultSummary || '',
      changes: Array.isArray(filesChanged)
        ? filesChanged.map((f) => String(f?.description || '')).filter(Boolean).slice(0, 12)
        : [],
      charge: roundCharge, // rupees billed for this round only
      at: Date.now(),
    };

    const orgRef = db.collection('organisations').doc(task.orgId);
    const orgSnap = await tx.get(orgRef);
    const balance = orgSnap.exists ? Number(orgSnap.data().balance ?? 0) : 0;
    const newBalance = Math.max(0, balance - roundCharge);

    tx.update(orgRef, { balance: newBalance });
    tx.update(taskRef, {
      status: 'complete',
      billed: true,
      billedCostUsd: totalUsd, // high-water mark of cost we've billed
      actualCostUsd: totalUsd,
      actualCostInr: cumulativeInr,
      finalCharge: newFinalCharge, // cumulative across rounds
      lastRoundCharge: roundCharge,
      rounds: [...priorRounds, roundEntry], // the iteration thread
      resultSummary: resultSummary || '',
      filesChanged: Array.isArray(filesChanged) ? filesChanged : [],
      prUrl: prUrl || null,
      downloadUrl: downloadUrl || null,
      needsPreview: !!prUrl, // a Vercel preview may appear on the PR — poll for it
      previewUrl: null, // a new round produces a fresh preview; re-fetch it
      completedAt: FieldValue.serverTimestamp(),
    });
    tx.set(db.collection('transactions').doc(), {
      orgId: task.orgId,
      userId: task.userId,
      type: 'debit',
      amount: roundCharge,
      taskId,
      kind,
      createdAt: FieldValue.serverTimestamp(),
    });
    return { charged: roundCharge, newBalance, finalCharge: newFinalCharge };
  });
}

export async function billTaskFailure(taskId, { error }) {
  const db = getFirestore();
  const taskRef = db.collection('tasks').doc(taskId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(taskRef);
    if (!snap.exists) throw new Error('task_not_found');
    if (snap.data().billed) return { alreadyBilled: true };
    // Failures are NEVER charged (even over-budget terminations — we eat the cost).
    tx.update(taskRef, {
      status: 'failed',
      error: error || 'failed',
      completedAt: FieldValue.serverTimestamp(),
    });
    return { failed: true };
  });
}
