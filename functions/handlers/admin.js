import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { DEFAULT_USD_TO_INR } from '../utils/billing.js';
import { applyFixAward, applyShipAward, emptyMember } from '../utils/gamification.js';
import { requireAdmin } from '../utils/admin.js';

// Operator-only admin callables. Gated by an ADMIN_EMAILS allowlist (see utils/admin.js).
// Credits live at the ORGANISATION level; the operator seeds them manually.

const REGION = 'asia-south1';

export const adminCreateOrg = onCall({ region: REGION }, async (request) => {
  requireAdmin(request);
  const name = String(request.data?.name ?? '').trim();
  if (!name) throw new HttpsError('invalid-argument', 'Organisation name required.');
  const db = getFirestore();
  const ref = db.collection('organisations').doc();
  await ref.set({ name, balance: 0, createdAt: FieldValue.serverTimestamp() });
  return { orgId: ref.id, name };
});

export const adminAddCredits = onCall({ region: REGION }, async (request) => {
  const by = requireAdmin(request);
  const orgId = String(request.data?.orgId ?? '');
  const amount = Math.round(Number(request.data?.amount));
  if (!orgId) throw new HttpsError('invalid-argument', 'orgId required.');
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new HttpsError('invalid-argument', 'amount must be a positive number.');
  }
  const db = getFirestore();
  const orgRef = db.collection('organisations').doc(orgId);
  const balance = await db.runTransaction(async (tx) => {
    const snap = await tx.get(orgRef);
    if (!snap.exists) throw new HttpsError('not-found', 'Organisation not found.');
    const next = Number(snap.data().balance ?? 0) + amount;
    tx.update(orgRef, { balance: next });
    tx.set(db.collection('transactions').doc(), {
      orgId, type: 'credit', amount, by, createdAt: FieldValue.serverTimestamp(),
    });
    return next;
  });
  return { orgId, balance };
});

// Operator-only manual deduction. Used for refunds-in-reverse, fee corrections, or settling
// a negative balance the other way. The `description` is required so every deduction has a
// human reason in the ledger. Balance is allowed to go negative.
export const adminDeductCredits = onCall({ region: REGION }, async (request) => {
  const by = requireAdmin(request);
  const orgId = String(request.data?.orgId ?? '');
  const amount = Math.round(Number(request.data?.amount));
  const description = String(request.data?.description ?? '').trim();
  if (!orgId) throw new HttpsError('invalid-argument', 'orgId required.');
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new HttpsError('invalid-argument', 'amount must be a positive number.');
  }
  if (!description) throw new HttpsError('invalid-argument', 'description required.');
  const db = getFirestore();
  const orgRef = db.collection('organisations').doc(orgId);
  const balance = await db.runTransaction(async (tx) => {
    const snap = await tx.get(orgRef);
    if (!snap.exists) throw new HttpsError('not-found', 'Organisation not found.');
    const next = Number(snap.data().balance ?? 0) - amount;
    tx.update(orgRef, { balance: next });
    tx.set(db.collection('transactions').doc(), {
      orgId, type: 'debit', amount, by, description,
      kind: 'admin_adjustment', createdAt: FieldValue.serverTimestamp(),
    });
    return next;
  });
  return { orgId, balance };
});

// Per-org ledger: the full credit/debit history for one organisation, newest first, with a
// running balance. Credits come from top-ups (adminAddCredits); debits from fix charges
// (markRoundReady / chargeApprovedFix) and manual adjustments (adminDeductCredits). The
// aggregate adminMetrics only sums totals — this is the line-by-line statement. Read-only.
export const adminListTransactions = onCall({ region: REGION }, async (request) => {
  requireAdmin(request);
  const orgId = String(request.data?.orgId ?? '').trim();
  if (!orgId) throw new HttpsError('invalid-argument', 'orgId required.');
  const db = getFirestore();

  const orgSnap = await db.collection('organisations').doc(orgId).get();
  if (!orgSnap.exists) throw new HttpsError('not-found', 'Organisation not found.');
  const balance = Number(orgSnap.data().balance ?? 0);

  const snap = await db
    .collection('transactions')
    .where('orgId', '==', orgId)
    .orderBy('createdAt', 'desc')
    .limit(200)
    .get();
  const docs = snap.docs;

  // Resolve the triggering employee's email for fix charges (one batched read, like
  // adminListTasks) so the ledger shows WHO ran the fix, not an opaque uid.
  const uids = [...new Set(docs.map((d) => d.data().userId).filter(Boolean))];
  const emailByUid = {};
  if (uids.length) {
    const userSnaps = await db.getAll(...uids.map((u) => db.collection('users').doc(u)));
    for (const us of userSnaps) if (us.exists) emailByUid[us.id] = us.data().email ?? null;
  }

  // Running balance: the newest row settles at the org's current balance; each older row is
  // current minus the signed sum of everything more recent. Walk newest→oldest. (Balance may
  // be negative — that's allowed; the operator reconciles via top-ups/deductions.)
  let runningAfter = balance;
  const transactions = docs.map((d) => {
    const t = d.data();
    const amount = Number(t.amount) || 0;
    const type = t.type === 'credit' ? 'credit' : 'debit';
    const balanceAfter = runningAfter;
    runningAfter -= type === 'credit' ? amount : -amount; // balance just before this txn
    return {
      id: d.id,
      type,
      amount,
      kind: t.kind ?? null,            // 'initial' | 'new_scope' | 'unresolved' | 'admin_adjustment'
      description: t.description ?? null,
      by: t.by ?? null,               // operator email (manual credit/deduction)
      userEmail: t.userId ? (emailByUid[t.userId] ?? null) : null, // employee who ran the fix
      taskId: t.taskId ?? null,
      createdAt: t.createdAt?.toMillis?.() ?? null,
      balanceAfter,
    };
  });

  return { orgId, name: orgSnap.data().name ?? '(unnamed)', balance, transactions };
});

export const adminListOrgs = onCall({ region: REGION }, async (request) => {
  requireAdmin(request);
  const db = getFirestore();
  const snap = await db.collection('organisations').orderBy('name').get();
  return {
    orgs: snap.docs.map((d) => ({
      id: d.id,
      name: d.data().name,
      balance: d.data().balance ?? 0,
      repo: d.data().github?.repoFullName ?? null,
      requireApproval: d.data().requireApproval === true, // does this org need "Looks good" before charging?
    })),
  };
});

// Toggle whether this org's fixes need the customer's "Looks good" before being charged.
// Default (false) = auto-charge the flat tier price the moment a fix is ready.
export const adminSetOrgApproval = onCall({ region: REGION }, async (request) => {
  requireAdmin(request);
  const orgId = String(request.data?.orgId ?? '');
  const requireApproval = request.data?.requireApproval === true;
  if (!orgId) throw new HttpsError('invalid-argument', 'orgId required.');
  const db = getFirestore();
  const ref = db.collection('organisations').doc(orgId);
  if (!(await ref.get()).exists) throw new HttpsError('not-found', 'Organisation not found.');
  await ref.update({ requireApproval });
  return { orgId, requireApproval };
});

// List the people assigned to an org, each with their per-user "can publish to production"
// grant. Powers the admin's deploy-access controls: publishing to testing is open to every
// member, but going live (production) is granted per-user (adminSetUserDeploy).
export const adminListUsers = onCall({ region: REGION }, async (request) => {
  requireAdmin(request);
  const orgId = String(request.data?.orgId ?? '').trim();
  if (!orgId) throw new HttpsError('invalid-argument', 'orgId required.');
  const db = getFirestore();
  const snap = await db.collection('users').where('orgId', '==', orgId).get();
  const users = snap.docs
    .map((d) => ({ uid: d.id, email: d.data().email ?? null, canDeployProd: d.data().canDeployProd === true }))
    .sort((a, b) => (a.email || '').localeCompare(b.email || ''));
  return { orgId, users };
});

// Grant / revoke a single user's permission to publish their org's fixes to PRODUCTION (go
// live). Testing self-deploy is open to every org member; production is gated per-user by this
// flag, read server-side in customerDeployProd and surfaced via listMySessions.
export const adminSetUserDeploy = onCall({ region: REGION }, async (request) => {
  requireAdmin(request);
  const uid = String(request.data?.uid ?? '').trim();
  const canDeployProd = request.data?.canDeployProd === true;
  if (!uid) throw new HttpsError('invalid-argument', 'uid required.');
  const db = getFirestore();
  const ref = db.collection('users').doc(uid);
  if (!(await ref.get()).exists) throw new HttpsError('not-found', 'User not found.');
  await ref.update({ canDeployProd });
  return { uid, canDeployProd };
});

// Quote a BIG job (a 'large' task parked in needs_quote / needs_requote). The operator
// eyeballs the scope and sets a fixed rupee price + a budget cap. Moves it to 'quoted' for
// the customer to confirm. Nothing runs or is charged until they confirm (confirmQuote).
export const adminQuoteTask = onCall({ region: REGION }, async (request) => {
  requireAdmin(request);
  const taskId = String(request.data?.taskId ?? '').trim();
  const quoteInr = Math.round(Number(request.data?.quoteInr));
  const maxBudgetUsd = Number(request.data?.maxBudgetUsd) || 8; // default ~$8 cap for big jobs
  if (!taskId) throw new HttpsError('invalid-argument', 'taskId required.');
  if (!Number.isFinite(quoteInr) || quoteInr <= 0) throw new HttpsError('invalid-argument', 'quoteInr must be positive.');

  const db = getFirestore();
  const ref = db.collection('tasks').doc(taskId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Task not found.');
  const t = snap.data();
  if (t.status !== 'needs_quote' && t.status !== 'needs_requote') {
    throw new HttpsError('failed-precondition', 'This task is not awaiting a quote.');
  }
  await ref.update({
    status: 'quoted',
    priceInr: quoteInr,
    currentRoundCharge: quoteInr, // owed on success
    maxBudgetUsd,
    pendingRound: { kind: t.kind || 'initial', reason: null, addedInr: quoteInr, prompt: t.prompt || '' },
    quotedInr: quoteInr,
    quotedAt: FieldValue.serverTimestamp(),
  });
  return { taskId, quoteInr };
});

// Business dashboard: aggregate the whole book into one operator-facing snapshot —
// revenue (what customers paid), what we paid Anthropic (raw COGS), profit/margin, and
// delivery counts (fixes, PRs, deploys). Totals + a per-org breakdown. Read-only.
//
// Money model (per shared/billing.js):
//   revenueInr  = Σ task.finalCharge   — what customers actually paid us
//   costInr     = Σ task.actualCostInr — raw Anthropic COGS in INR (no markup)
//   anthropicUsd= Σ task.actualCostUsd — the same COGS in USD (what we pay Anthropic)
//   profitInr   = revenueInr − costInr  (a failed run is paid ₹0 but still cost us → a loss)
//   creditsAddedInr = Σ credit transactions — cash collected via top-ups / manual credit
//   balanceInr  = Σ org.balance         — unspent prepaid credit still owed to customers
export const adminMetrics = onCall({ region: REGION }, async (request) => {
  requireAdmin(request);
  const db = getFirestore();
  const rate = Number(process.env.USD_TO_INR) || DEFAULT_USD_TO_INR;

  const [orgsSnap, tasksSnap, creditSnap] = await Promise.all([
    db.collection('organisations').get(),
    db.collection('tasks').get(),
    db.collection('transactions').where('type', '==', 'credit').get(),
  ]);

  const blank = () => ({
    revenueInr: 0, costInr: 0, anthropicUsd: 0, profitInr: 0,
    fixesDone: 0, failedRuns: 0, inProgress: 0,
    prsDelivered: 0, deploysTesting: 0, deploysProd: 0,
    creditsAddedInr: 0,
  });

  const orgStats = new Map();
  for (const d of orgsSnap.docs) {
    const o = d.data();
    orgStats.set(d.id, { orgId: d.id, name: o.name || '(unnamed)', balanceInr: Number(o.balance) || 0, ...blank() });
  }
  const bump = (orgId, fn) => { const s = orgStats.get(orgId); if (s) fn(s); };

  const totals = { orgs: orgsSnap.size, tasksTotal: tasksSnap.size, balanceInr: 0, ...blank() };

  // Time-based slices for revenue & profit. Run-rate divides lifetime totals by how long
  // we've been live (earliest task → now). Trailing windows sum what was booked in the last
  // 24h / 7d / 30d, attributed to when the job finished (completedAt, else createdAt).
  const DAY_MS = 86400000;
  const now = Date.now();
  let firstCreatedMs = null;
  const win = { d1: { rev: 0, cost: 0 }, d7: { rev: 0, cost: 0 }, d30: { rev: 0, cost: 0 } };

  // "Today" = IST calendar day (India-first SaaS). Distinct from the rolling d1 window —
  // operator wants today-since-midnight, not the last 24 hours.
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const nowIst = new Date(now + IST_OFFSET_MS);
  const todayStartMs = Date.UTC(nowIst.getUTCFullYear(), nowIst.getUTCMonth(), nowIst.getUTCDate()) - IST_OFFSET_MS;
  const today = {
    revenueInr: 0, costInr: 0, profitInr: 0,
    failedRuns: 0, failedCostInr: 0, freeRetriesGiven: 0,
    startMs: todayStartMs,
  };

  for (const d of tasksSnap.docs) {
    const t = d.data();
    const paid = Number(t.finalCharge) || 0;
    const costInr = Number(t.actualCostInr) || 0;
    const costUsd = Number(t.actualCostUsd) || 0;

    totals.revenueInr += paid; totals.costInr += costInr; totals.anthropicUsd += costUsd;
    bump(t.orgId, (s) => { s.revenueInr += paid; s.costInr += costInr; s.anthropicUsd += costUsd; });

    const createdMs = t.createdAt?.toMillis?.() ?? null;
    if (createdMs != null) firstCreatedMs = firstCreatedMs == null ? createdMs : Math.min(firstCreatedMs, createdMs);
    const whenMs = t.completedAt?.toMillis?.() ?? createdMs;
    if (whenMs != null) {
      const age = now - whenMs;
      if (age <= DAY_MS) { win.d1.rev += paid; win.d1.cost += costInr; }
      if (age <= 7 * DAY_MS) { win.d7.rev += paid; win.d7.cost += costInr; }
      if (age <= 30 * DAY_MS) { win.d30.rev += paid; win.d30.cost += costInr; }
      if (whenMs >= todayStartMs) {
        today.revenueInr += paid;
        today.costInr += costInr;
        if (t.status === 'failed') {
          today.failedRuns++;
          today.failedCostInr += costInr;
        }
      }
    }

    // Free retries we gave today: a revision sets kind='unresolved' and bumps
    // freeRevisionsUsed (capped at MAX_FREE_REVISIONS=1). revisedAt is when it happened.
    const revisedMs = t.revisedAt?.toMillis?.() ?? null;
    if (revisedMs != null && revisedMs >= todayStartMs
        && t.kind === 'unresolved' && (Number(t.freeRevisionsUsed) || 0) > 0) {
      today.freeRetriesGiven++;
    }

    if (t.status === 'complete') { totals.fixesDone++; bump(t.orgId, (s) => s.fixesDone++); }
    else if (t.status === 'failed') { totals.failedRuns++; bump(t.orgId, (s) => s.failedRuns++); }
    else if (t.status === 'queued' || t.status === 'running') { totals.inProgress++; bump(t.orgId, (s) => s.inProgress++); }

    if (t.prUrl) { totals.prsDelivered++; bump(t.orgId, (s) => s.prsDelivered++); }
    if (t.deployedTesting === true) { totals.deploysTesting++; bump(t.orgId, (s) => s.deploysTesting++); }
    if (t.deployedProd === true) { totals.deploysProd++; bump(t.orgId, (s) => s.deploysProd++); }
  }

  today.profitInr = today.revenueInr - today.costInr;

  for (const d of creditSnap.docs) {
    const amt = Number(d.data().amount) || 0;
    totals.creditsAddedInr += amt;
    bump(d.data().orgId, (s) => { s.creditsAddedInr += amt; });
  }

  for (const s of orgStats.values()) {
    s.profitInr = s.revenueInr - s.costInr;
    totals.balanceInr += s.balanceInr;
  }
  totals.profitInr = totals.revenueInr - totals.costInr;
  totals.marginPct = totals.revenueInr > 0 ? Math.round((totals.profitInr / totals.revenueInr) * 100) : 0;

  // Run-rate averages: lifetime totals spread evenly across the active span.
  const MONTH_DAYS = 30.4375; // average calendar month
  const spanDays = firstCreatedMs ? Math.max(1, (now - firstCreatedMs) / DAY_MS) : 1;
  const avg = (total) => ({
    daily: total / spanDays,
    weekly: total / (spanDays / 7),
    monthly: total / (spanDays / MONTH_DAYS),
  });
  const averages = { spanDays, revenue: avg(totals.revenueInr), profit: avg(totals.profitInr) };

  // Trailing windows: actuals booked in each recent period.
  const trailing = {
    d1: { revenueInr: win.d1.rev, profitInr: win.d1.rev - win.d1.cost },
    d7: { revenueInr: win.d7.rev, profitInr: win.d7.rev - win.d7.cost },
    d30: { revenueInr: win.d30.rev, profitInr: win.d30.rev - win.d30.cost },
  };

  const byOrg = [...orgStats.values()].sort((a, b) => b.revenueInr - a.revenueInr);
  return { rate, totals, today, averages, trailing, byOrg, generatedAt: now };
});

export const adminSetUserOrg = onCall({ region: REGION }, async (request) => {
  requireAdmin(request);
  const email = String(request.data?.email ?? '').trim().toLowerCase();
  const orgId = String(request.data?.orgId ?? '');
  if (!email || !orgId) throw new HttpsError('invalid-argument', 'email and orgId required.');
  const db = getFirestore();
  if (!(await db.collection('organisations').doc(orgId).get()).exists) {
    throw new HttpsError('not-found', 'Organisation not found.');
  }
  // Resolve the email to a Firebase Auth uid (the user must have signed in at least once).
  let uid, userRecord;
  try {
    userRecord = await getAuth().getUserByEmail(email);
    uid = userRecord.uid;
  } catch {
    throw new HttpsError('not-found', 'No user with that email (have they signed in yet?).');
  }
  await db.collection('users').doc(uid).set({ orgId }, { merge: true });
  // Custom claim lets security rules + the app scope reads to the user's org.
  await getAuth().setCustomUserClaims(uid, { orgId });
  // Seed an empty leaderboard row so this teammate shows up on the board from day one
  // (the activation nudge — see docs/GAMIFICATION.md §6.1), never overwriting existing stats.
  const name = email || userRecord.displayName; // email is the board label (unique)
  const orgSnap = await db.collection('organisations').doc(orgId).get();
  if (!orgSnap.data()?.orgStats?.members?.[uid]) {
    await db.collection('organisations').doc(orgId).set(
      { orgStats: { members: { [uid]: emptyMember(name) } } },
      { merge: true },
    );
  }
  return { uid, email, orgId };
});

// --- Gamification backfill (operator-only) -------------------------------------------------
//
// Rebuilds the leaderboard (orgStats.members) for one org, or every org, from existing fix
// history — so the board isn't empty after launch. A FULL RECOMPUTE: it replays the same
// pure award functions the live billing path uses, in chronological order, then writes the
// authoritative member map. Idempotent — safe to re-run; it overwrites the map each time and
// stamps each counted task (rounds[].pointsAwarded / shipPointsAwarded) so the FORWARD path
// can never double-count what the backfill already credited.

async function backfillOrgGamification(db, orgId) {
  // Roster: every assigned employee gets a row (even dormant ones — activation, §6.1).
  const members = {};
  const userSnap = await db.collection('users').where('orgId', '==', orgId).get();
  for (const u of userSnap.docs) {
    const d = u.data();
    members[u.id] = emptyMember(d.email || d.displayName || ''); // email is the board label
  }

  // All completed fixes for the org, oldest first (streak math is chronological).
  const taskSnap = await db.collection('tasks').where('orgId', '==', orgId).where('status', '==', 'complete').get();
  const tasks = taskSnap.docs
    .map((t) => ({ id: t.id, ref: t.ref, data: t.data() }))
    .sort((a, b) => (a.data.createdAt?.toMillis?.() || 0) - (b.data.createdAt?.toMillis?.() || 0));

  const ensure = (uid, name) => { if (!members[uid]) members[uid] = emptyMember(name); return members[uid]; };
  const batch = db.batch();
  let counted = 0;

  for (const t of tasks) {
    const task = t.data;
    const uid = task.userId;
    if (!uid) continue;
    const createdMs = task.createdAt?.toMillis?.() || 0;
    const name = members[uid]?.name || '';

    // Each charged, chargeable round earns fix-points (free re-fixes earn none). Legacy tasks
    // (pre-threads) have no rounds[]; synthesize a single initial round from the task fields.
    const rounds = Array.isArray(task.rounds) && task.rounds.length
      ? task.rounds
      : (task.billed || task.approved)
        ? [{ kind: 'initial', charged: true, actualCostUsd: Number(task.actualCostUsd) || 0, briefScore: 0, at: createdMs }]
        : [];

    let touched = false;
    // Full recompute: count EVERY charged, chargeable round regardless of `pointsAwarded`
    // (that flag only stops the LIVE billing path from re-adding what's already counted).
    // We still STAMP the flag below so the live path won't double-count after this rebuild.
    const stamped = rounds.map((r) => {
      if (r.charged && r.kind !== 'unresolved') {
        const { member } = applyFixAward(ensure(uid, name), {
          name,
          complexity: task.complexity,
          freeRevisionsUsed: Number(r.freeRevisionsUsed) || 0,
          briefScore: Number(r.briefScore) || 0,
          actualCostUsd: Number(r.actualCostUsd) || 0,
          maxBudgetUsd: Number(task.maxBudgetUsd) || 0,
        }, Number(r.at) || createdMs);
        members[uid] = member;
        counted++;
        touched = true;
        return { ...r, pointsAwarded: true };
      }
      return r;
    });

    const taskUpdate = {};
    // Only stamp real, persisted rounds (skip synthesized legacy rounds — nothing to write).
    if (touched && Array.isArray(task.rounds) && task.rounds.length) taskUpdate.rounds = stamped;

    // The "went live for review" milestone (+ First Fix badge), once per task. Counted on
    // every recompute (the flag only gates the live path); stamped so the live path won't re-add.
    if (task.deployedTesting) {
      const shipMs = task.deployedTestingAt?.toMillis?.() || createdMs;
      const { member } = applyShipAward(ensure(uid, name), { name }, shipMs);
      members[uid] = member;
      taskUpdate.shipPointsAwarded = true;
      touched = true;
    }
    if (Object.keys(taskUpdate).length) batch.update(t.ref, taskUpdate);
  }

  await batch.commit();
  await db.collection('organisations').doc(orgId).update({ 'orgStats.members': members });
  return { orgId, members: Object.keys(members).length, roundsCounted: counted, tasks: tasks.length };
}

export const adminBackfillGamification = onCall({ region: REGION }, async (request) => {
  requireAdmin(request);
  const db = getFirestore();
  const orgId = String(request.data?.orgId ?? '').trim();
  if (orgId) {
    if (!(await db.collection('organisations').doc(orgId).get()).exists) {
      throw new HttpsError('not-found', 'Organisation not found.');
    }
    return { ok: true, results: [await backfillOrgGamification(db, orgId)] };
  }
  // No orgId → backfill every org.
  const orgs = await db.collection('organisations').get();
  const results = [];
  for (const o of orgs.docs) results.push(await backfillOrgGamification(db, o.id));
  return { ok: true, results };
});
