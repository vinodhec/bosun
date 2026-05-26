import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { computeCharge } from './billing.js';

// Billing under the fixed-tier model, with a per-ORG approval toggle.
//
//   org.requireApproval = false (DEFAULT):
//     agent finishes → markRoundReady() charges the flat tier price immediately (auto-charge).
//   org.requireApproval = true:
//     agent finishes → markRoundReady() marks the fix pendingReview; the customer's
//     "Looks good" (approveFix → chargeApprovedFix) is what charges and unlocks going live.
//
//   agent failed → markRoundFailure(): status='failed'. Never charged.
//
// Price is the FIXED tier price (shared/billing.js), accrued on the task as
// `currentRoundCharge`. Actual token COGS is recorded for instrumentation only.

/** Structured line for Cloud Logging — concierge-phase analytics (failure rate, COGS/tier). */
export function logBillingEvent(evt, data) {
  try { console.log(`BILLING_EVENT ${JSON.stringify({ evt, ...data })}`); } catch { /* noop */ }
}

// A finished round. Records the iteration in the thread + the round's COGS (analytics). If
// the org does NOT require approval (default) we charge the owed tier price right away;
// otherwise we leave it pendingReview for the customer to approve. Idempotent: only acts on
// the running→complete transition.
export async function markRoundReady(taskId, { actualCostUsd, activeSeconds, resultSummary, filesChanged, prUrl, downloadUrl }) {
  const db = getFirestore();
  const taskRef = db.collection('tasks').doc(taskId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(taskRef);
    if (!snap.exists) throw new Error('task_not_found');
    const task = snap.data();
    if (task.status === 'complete' || task.status === 'failed') return { alreadyFinalized: true };

    const orgRef = db.collection('organisations').doc(task.orgId);
    const orgSnap = await tx.get(orgRef); // read before any write (Firestore tx rule)
    const requireApproval = orgSnap.exists && orgSnap.data().requireApproval === true;

    const rate = Number(process.env.USD_TO_INR) || undefined;
    const totalUsd = Number(actualCostUsd) || 0;
    const prevSeenUsd = Number(task.reviewedCostUsd) || 0;
    const roundUsd = Math.max(0, totalUsd - prevSeenUsd); // COGS of THIS round (analytics only)
    const roundCostInr = computeCharge(roundUsd, { rate }).actualCostInr;

    const pr = task.pendingRound || { kind: task.kind || 'initial', reason: null, addedInr: 0, prompt: task.prompt || '' };
    const priorRounds = Array.isArray(task.rounds) ? task.rounds : [];
    const roundEntry = {
      kind: pr.kind,            // 'initial' | 'unresolved' | 'new_scope'
      reason: pr.reason || null,
      prompt: pr.prompt || '',
      summary: resultSummary || '',
      changes: Array.isArray(filesChanged)
        ? filesChanged.map((f) => String(f?.description || '')).filter(Boolean).slice(0, 12)
        : [],
      addedInr: Number(pr.addedInr) || 0, // what this round adds to what's owed (0 = free re-fix)
      charged: false,
      actualCostUsd: roundUsd,            // internal analytics
      at: Date.now(),
    };

    const baseUpdate = {
      status: 'complete',
      reviewedCostUsd: totalUsd,
      reviewedSeconds: Number(activeSeconds) || Number(task.reviewedSeconds) || 0, // baseline for the next round's runtime cap
      actualCostUsd: totalUsd,
      actualCostInr: computeCharge(totalUsd, { rate }).actualCostInr,
      resultSummary: resultSummary || '',
      filesChanged: Array.isArray(filesChanged) ? filesChanged : [],
      prUrl: prUrl || null,
      downloadUrl: downloadUrl || null,
      needsPreview: !!prUrl,
      previewUrl: null,
      completedAt: FieldValue.serverTimestamp(),
    };

    const analytics = {
      taskId, orgId: task.orgId, complexity: task.complexity || null, model: task.model || null,
      kind: pr.kind, reason: pr.reason || null, round: priorRounds.length + 1,
      roundCostUsd: roundUsd, roundCostInr, owedInr: Number(task.currentRoundCharge) || 0,
      freeRevisionsUsed: Number(task.freeRevisionsUsed) || 0, requireApproval,
    };

    if (requireApproval) {
      // Wait for the customer to approve — no money moves yet.
      tx.update(taskRef, { ...baseUpdate, pendingReview: true, approved: false, rounds: [...priorRounds, roundEntry] });
      logBillingEvent('round_ready', { ...analytics, outcome: 'pending_review' });
      return { ready: true, pending: true };
    }

    // Default: auto-charge the owed tier price now.
    const owed = Math.max(0, Math.round(Number(task.currentRoundCharge) || 0));
    const newFinalCharge = (Number(task.finalCharge) || 0) + owed;
    const chargedRounds = [...priorRounds, roundEntry].map((r) => ({ ...r, charged: true }));

    if (owed > 0) {
      const balance = orgSnap.exists ? Number(orgSnap.data().balance ?? 0) : 0;
      tx.update(orgRef, { balance: Math.max(0, balance - owed) });
      tx.set(db.collection('transactions').doc(), {
        orgId: task.orgId, userId: task.userId, type: 'debit', amount: owed,
        taskId, kind: pr.kind, createdAt: FieldValue.serverTimestamp(),
      });
    }
    tx.update(taskRef, {
      ...baseUpdate,
      pendingReview: false,
      approved: true,
      billed: newFinalCharge > 0,
      currentRoundCharge: 0,
      finalCharge: newFinalCharge,
      lastRoundCharge: owed,
      rounds: chargedRounds,
      approvedAt: FieldValue.serverTimestamp(),
    });
    logBillingEvent('round_ready', { ...analytics, outcome: 'auto_charged', chargedInr: owed, finalChargeInr: newFinalCharge });
    return { ready: true, charged: owed };
  });
}

// Charge the flat tier price owed for the current cycle, on the customer's approval (only
// used when org.requireApproval = true). Atomic + idempotent (guarded by pendingReview).
export async function chargeApprovedFix(taskId, uid) {
  const db = getFirestore();
  const taskRef = db.collection('tasks').doc(taskId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(taskRef);
    if (!snap.exists) throw new Error('task_not_found');
    const task = snap.data();
    if (task.userId !== uid) throw new Error('not_owner');
    if (task.status !== 'complete' || !task.pendingReview) throw new Error('not_pending_review');

    const owed = Math.max(0, Math.round(Number(task.currentRoundCharge) || 0));
    const rounds = Array.isArray(task.rounds) ? task.rounds.map((r) => ({ ...r, charged: true })) : [];
    const newFinalCharge = (Number(task.finalCharge) || 0) + owed;

    if (owed > 0) {
      const orgRef = db.collection('organisations').doc(task.orgId);
      const orgSnap = await tx.get(orgRef);
      const balance = orgSnap.exists ? Number(orgSnap.data().balance ?? 0) : 0;
      if (balance < owed) throw new Error(`INSUFFICIENT_BALANCE:${owed}`);
      tx.update(orgRef, { balance: Math.max(0, balance - owed) });
      tx.set(db.collection('transactions').doc(), {
        orgId: task.orgId, userId: task.userId, type: 'debit', amount: owed,
        taskId, kind: task.pendingRound?.kind || 'initial', createdAt: FieldValue.serverTimestamp(),
      });
    }

    tx.update(taskRef, {
      pendingReview: false,
      approved: true,
      billed: newFinalCharge > 0,
      currentRoundCharge: 0,
      finalCharge: newFinalCharge,
      lastRoundCharge: owed,
      rounds,
      approvedAt: FieldValue.serverTimestamp(),
    });

    logBillingEvent('approved', {
      taskId, orgId: task.orgId, complexity: task.complexity || null,
      chargedInr: owed, finalChargeInr: newFinalCharge, actualCostUsd: Number(task.actualCostUsd) || 0,
    });
    return { charged: owed, finalCharge: newFinalCharge };
  });
}

export async function markRoundFailure(taskId, { error, actualCostUsd } = {}) {
  const db = getFirestore();
  const taskRef = db.collection('tasks').doc(taskId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(taskRef);
    if (!snap.exists) throw new Error('task_not_found');
    const task = snap.data();
    if (task.status === 'failed' || task.status === 'complete') return { alreadyFinalized: true };
    // Failures are NEVER charged (even over-budget terminations) — but we still EAT the
    // token/runtime cost, so record it as our COGS. Admin P&L then shows the fix as a pure
    // loss (paid ₹0, margin = −COGS) instead of pretending it cost nothing.
    const rate = Number(process.env.USD_TO_INR) || undefined;
    const costUsd = Number(actualCostUsd) || Number(task.actualCostUsd) || Number(task.reviewedCostUsd) || 0;
    const costInr = computeCharge(costUsd, { rate }).actualCostInr; // raw COGS in INR (no markup)
    tx.update(taskRef, {
      status: 'failed',
      error: error || 'failed',
      pendingReview: false,
      actualCostUsd: costUsd,
      actualCostInr: costInr,
      completedAt: FieldValue.serverTimestamp(),
    });
    logBillingEvent('failed', {
      taskId, orgId: task.orgId, complexity: task.complexity || null,
      reason: error || 'failed', actualCostUsd: costUsd, actualCostInr: costInr,
    });
    return { failed: true };
  });
}
