import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { computeCharge, priceFromCostUsd } from './billing.js';
import { getUsdToInrRate } from './fxRate.js';
import { applyFixAward, applyShipAward } from './gamification.js';

// Gamification points ride the SAME billing transactions, so they're as atomic and
// tamper-proof as money — but they are NOT money (never alter balance/charge; see
// shared/gamification.js). Points are credited to the round's employee (`task.userId`) on
// the charge event, idempotently: each charged round carries a `pointsAwarded` flag so a
// re-run can't double-count. Free re-fixes (kind 'unresolved', our shortfall) earn nothing.
function memberNameFrom(userData) {
  if (!userData) return '';
  // Email is the board label — it's unique, so teammates with similar display names
  // ("Admin", "Maadi", "MaadiVeedu") stay distinguishable.
  return String(userData.email || userData.displayName || '');
}

// Apply fix-points for any charged round that hasn't been counted yet. Returns the possibly-
// updated member (null if nothing changed) and the rounds array with `pointsAwarded` stamped.
function awardForChargedRounds(existingMember, rounds, task, name, nowMs) {
  let m = existingMember || null;
  let changed = false;
  const out = rounds.map((r) => {
    if (r.charged && !r.pointsAwarded && r.kind !== 'unresolved') {
      const res = applyFixAward(m, {
        name,
        complexity: task.complexity,
        freeRevisionsUsed: Number(r.freeRevisionsUsed) || 0,
        briefScore: Number(r.briefScore) || 0,
        actualCostUsd: Number(r.actualCostUsd) || 0,
        maxBudgetUsd: Number(task.maxBudgetUsd) || 0,
      }, nowMs);
      m = res.member;
      changed = true;
      return { ...r, pointsAwarded: true };
    }
    return r;
  });
  return { member: changed ? m : null, rounds: out };
}

// Billing under the bracketed cost-plus model, with a per-ORG approval toggle.
//
//   org.requireApproval = false (DEFAULT):
//     agent finishes → markRoundReady() computes this round's price from actual COGS via
//     priceFromCostUsd() and debits it immediately (auto-charge).
//   org.requireApproval = true:
//     agent finishes → markRoundReady() computes the round price the same way, stashes it
//     on `currentRoundCharge`, and waits for the customer's "Looks good"
//     (approveFix → chargeApprovedFix) to actually move money.
//
//   agent failed → markRoundFailure(): status='failed'. Never charged.
//
// Free re-fix policy is preserved: a round with kind='unresolved' is charged ₹0 (we eat the
// COGS). Every other kind ('initial' | 'new_scope') is charged its bracketed cost.

/** Structured line for Cloud Logging — concierge-phase analytics (failure rate, COGS/tier). */
export function logBillingEvent(evt, data) {
  try { console.log(`BILLING_EVENT ${JSON.stringify({ evt, ...data })}`); } catch { /* noop */ }
}

// A finished round. Records the iteration in the thread + the round's COGS (analytics). If
// the org does NOT require approval (default) we charge the owed tier price right away;
// otherwise we leave it pendingReview for the customer to approve. Idempotent: only acts on
// the running→complete transition.
export async function markRoundReady(taskId, { actualCostUsd, activeSeconds, resultSummary, filesChanged, prUrl, downloadUrl, idealDescription, idealKeywords, briefScore }) {
  const db = getFirestore();
  const taskRef = db.collection('tasks').doc(taskId);
  // Resolve the rate once, before the transaction — it may read Firestore / memo, and we don't
  // want that repeated on transaction retries.
  const rate = await getUsdToInrRate();
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(taskRef);
    if (!snap.exists) throw new Error('task_not_found');
    const task = snap.data();
    if (task.status === 'complete' || task.status === 'failed') return { alreadyFinalized: true };

    const orgRef = db.collection('organisations').doc(task.orgId);
    const orgSnap = await tx.get(orgRef); // read before any write (Firestore tx rule)
    const requireApproval = orgSnap.exists && orgSnap.data().requireApproval === true;
    // Firebase-hosting orgs have no automatic Vercel preview to poll for — the owner triggers a
    // preview deploy on demand (customerPreviewTesting). So never set needsPreview for them.
    const deployHost = (orgSnap.exists && orgSnap.data().deploy?.host) || 'vercel';

    const totalUsd = Number(actualCostUsd) || 0;
    const prevSeenUsd = Number(task.reviewedCostUsd) || 0;
    const roundUsd = Math.max(0, totalUsd - prevSeenUsd); // COGS of THIS round
    const roundCostInr = computeCharge(roundUsd, { rate }).actualCostInr;

    const pr = task.pendingRound || { kind: task.kind || 'initial', reason: null, addedInr: 0, prompt: task.prompt || '' };
    // Free re-fix (our shortfall) is the only round that doesn't get billed; every other
    // round bills the bracketed price computed from this round's actual COGS.
    const isFreeRound = pr.kind === 'unresolved';
    const roundPriceInr = isFreeRound ? 0 : priceFromCostUsd(roundUsd, { rate });

    const safeKeywords = Array.isArray(idealKeywords)
      ? idealKeywords
          .map((k) => ({
            phrase: String(k?.phrase || '').slice(0, 120),
            why: String(k?.why || '').slice(0, 100),
          }))
          .filter((k) => k.phrase && k.why)
          .slice(0, 5)
      : [];

    const priorRounds = Array.isArray(task.rounds) ? task.rounds : [];
    const roundEntry = {
      kind: pr.kind,            // 'initial' | 'unresolved' | 'new_scope'
      reason: pr.reason || null,
      prompt: pr.prompt || '',
      summary: resultSummary || '',
      changes: Array.isArray(filesChanged)
        ? filesChanged.map((f) => String(f?.description || '')).filter(Boolean).slice(0, 12)
        : [],
      idealDescription: String(idealDescription || ''),
      idealKeywords: safeKeywords,
      addedInr: roundPriceInr,            // what this round adds to what's owed (0 = free re-fix)
      charged: false,
      actualCostUsd: roundUsd,            // internal analytics
      // Gamification snapshot (drives points; never touches money). briefScore 0–100 from the
      // agent; freeRevisionsUsed at the moment this round closed (first-try bonus signal).
      briefScore: Number(briefScore) || 0,
      freeRevisionsUsed: Number(task.freeRevisionsUsed) || 0,
      pointsAwarded: false,
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
      idealDescription: String(idealDescription || ''),
      idealKeywords: safeKeywords,
      prUrl: prUrl || null,
      downloadUrl: downloadUrl || null,
      needsPreview: !!prUrl && deployHost !== 'firebase',
      previewUrl: null,
      completedAt: FieldValue.serverTimestamp(),
    };

    // Accrue this round's price on top of anything unapproved from prior rounds (which
    // happens when the customer revises before approving the previous round).
    const owedAfter = Math.max(0, Math.round((Number(task.currentRoundCharge) || 0) + roundPriceInr));

    const analytics = {
      taskId, orgId: task.orgId, complexity: task.complexity || null, model: task.model || null,
      kind: pr.kind, reason: pr.reason || null, round: priorRounds.length + 1,
      roundCostUsd: roundUsd, roundCostInr, roundPriceInr, owedInr: owedAfter,
      freeRevisionsUsed: Number(task.freeRevisionsUsed) || 0, requireApproval,
    };

    if (requireApproval) {
      // Wait for the customer to approve — no money moves yet, but record what'll be owed.
      tx.update(taskRef, {
        ...baseUpdate,
        pendingReview: true,
        approved: false,
        currentRoundCharge: owedAfter,
        rounds: [...priorRounds, roundEntry],
      });
      logBillingEvent('round_ready', { ...analytics, outcome: 'pending_review' });
      return { ready: true, pending: true };
    }

    // Default: auto-charge the bracketed price now. Read the employee (for the board's
    // denormalized name) before any write — Firestore requires reads-before-writes.
    const userSnap = await tx.get(db.collection('users').doc(task.userId));
    const owed = owedAfter;
    const newFinalCharge = (Number(task.finalCharge) || 0) + owed;
    const chargedRounds = [...priorRounds, roundEntry].map((r) => ({ ...r, charged: true }));

    // Credit gamification points for the round(s) now charged (free re-fixes earn none).
    const existingMember = orgSnap.exists ? orgSnap.data()?.orgStats?.members?.[task.userId] : null;
    const award = awardForChargedRounds(existingMember, chargedRounds, task, memberNameFrom(userSnap.data()), Date.now());
    const finalRounds = award.rounds;

    const orgUpdate = {};
    if (owed > 0) {
      const balance = orgSnap.exists ? Number(orgSnap.data().balance ?? 0) : 0;
      orgUpdate.balance = balance - owed;
      tx.set(db.collection('transactions').doc(), {
        orgId: task.orgId, userId: task.userId, type: 'debit', amount: owed,
        taskId, kind: pr.kind, createdAt: FieldValue.serverTimestamp(),
      });
    }
    if (award.member) orgUpdate[`orgStats.members.${task.userId}`] = award.member;
    if (Object.keys(orgUpdate).length) tx.update(orgRef, orgUpdate);

    tx.update(taskRef, {
      ...baseUpdate,
      pendingReview: false,
      approved: true,
      billed: newFinalCharge > 0,
      currentRoundCharge: 0,
      finalCharge: newFinalCharge,
      lastRoundCharge: owed,
      rounds: finalRounds,
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
    let finalRounds = rounds;

    if (owed > 0) {
      const orgRef = db.collection('organisations').doc(task.orgId);
      const orgSnap = await tx.get(orgRef);
      const userSnap = await tx.get(db.collection('users').doc(task.userId));
      const balance = orgSnap.exists ? Number(orgSnap.data().balance ?? 0) : 0;

      // Credit gamification points for the round(s) being charged on this approval.
      const existingMember = orgSnap.exists ? orgSnap.data()?.orgStats?.members?.[task.userId] : null;
      const award = awardForChargedRounds(existingMember, rounds, task, memberNameFrom(userSnap.data()), Date.now());
      finalRounds = award.rounds;

      const orgUpdate = { balance: balance - owed };
      if (award.member) orgUpdate[`orgStats.members.${task.userId}`] = award.member;
      tx.update(orgRef, orgUpdate);
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
      rounds: finalRounds,
      approvedAt: FieldValue.serverTimestamp(),
    });

    logBillingEvent('approved', {
      taskId, orgId: task.orgId, complexity: task.complexity || null,
      chargedInr: owed, finalChargeInr: newFinalCharge, actualCostUsd: Number(task.actualCostUsd) || 0,
    });
    return { charged: owed, finalCharge: newFinalCharge };
  });
}

// Award the "went live for review" milestone (+15 + First Fix badge) to the task's employee
// when their fix reaches testing. Own transaction (the merge that triggers this is a network
// call, kept outside any tx). Idempotent: gated on the task's `shipPointsAwarded` flag, so
// re-merging the same fix can't double-count. Best-effort — never blocks the deploy.
export async function awardShipPoints(taskId) {
  const db = getFirestore();
  const taskRef = db.collection('tasks').doc(taskId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(taskRef);
    if (!snap.exists) return { skipped: true };
    const task = snap.data();
    if (task.shipPointsAwarded) return { alreadyAwarded: true };
    const orgRef = db.collection('organisations').doc(task.orgId);
    const orgSnap = await tx.get(orgRef);
    const userSnap = await tx.get(db.collection('users').doc(task.userId));
    const existing = orgSnap.exists ? orgSnap.data()?.orgStats?.members?.[task.userId] : null;
    const { member } = applyShipAward(existing, { name: memberNameFrom(userSnap.data()) }, Date.now());
    tx.update(orgRef, { [`orgStats.members.${task.userId}`]: member });
    tx.update(taskRef, { shipPointsAwarded: true });
    return { ok: true };
  });
}

export async function markRoundFailure(taskId, { error, actualCostUsd } = {}) {
  const db = getFirestore();
  const taskRef = db.collection('tasks').doc(taskId);
  const rate = await getUsdToInrRate();
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(taskRef);
    if (!snap.exists) throw new Error('task_not_found');
    const task = snap.data();
    if (task.status === 'failed' || task.status === 'complete') return { alreadyFinalized: true };
    // Failures are NEVER charged (even over-budget terminations) — but we still EAT the
    // token/runtime cost, so record it as our COGS. Admin P&L then shows the fix as a pure
    // loss (paid ₹0, margin = −COGS) instead of pretending it cost nothing.
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
