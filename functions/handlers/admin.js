import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { DEFAULT_USD_TO_INR } from '../utils/billing.js';

// Operator-only admin callables. Gated by an ADMIN_EMAILS allowlist (comma-separated).
// Credits live at the ORGANISATION level; the operator seeds them manually.
function requireAdmin(request) {
  const email = request.auth?.token?.email;
  const allow = (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (!email || !allow.includes(email.toLowerCase())) {
    throw new HttpsError('permission-denied', 'Admin only.');
  }
  return email;
}

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
      allowCustomerDeploy: d.data().allowCustomerDeploy === true, // can the customer self-deploy from the dashboard?
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

// Toggle whether this org's customers can deploy their own approved fixes (Testing +
// Production) straight from the dashboard. Default (false) = deploy stays operator-only.
export const adminSetOrgDeploy = onCall({ region: REGION }, async (request) => {
  requireAdmin(request);
  const orgId = String(request.data?.orgId ?? '');
  const allowCustomerDeploy = request.data?.allowCustomerDeploy === true;
  if (!orgId) throw new HttpsError('invalid-argument', 'orgId required.');
  const db = getFirestore();
  const ref = db.collection('organisations').doc(orgId);
  if (!(await ref.get()).exists) throw new HttpsError('not-found', 'Organisation not found.');
  await ref.update({ allowCustomerDeploy });
  return { orgId, allowCustomerDeploy };
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
    }

    if (t.status === 'complete') { totals.fixesDone++; bump(t.orgId, (s) => s.fixesDone++); }
    else if (t.status === 'failed') { totals.failedRuns++; bump(t.orgId, (s) => s.failedRuns++); }
    else if (t.status === 'queued' || t.status === 'running') { totals.inProgress++; bump(t.orgId, (s) => s.inProgress++); }

    if (t.prUrl) { totals.prsDelivered++; bump(t.orgId, (s) => s.prsDelivered++); }
    if (t.deployedTesting === true) { totals.deploysTesting++; bump(t.orgId, (s) => s.deploysTesting++); }
    if (t.deployedProd === true) { totals.deploysProd++; bump(t.orgId, (s) => s.deploysProd++); }
  }

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
  return { rate, totals, averages, trailing, byOrg, generatedAt: now };
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
  let uid;
  try {
    ({ uid } = await getAuth().getUserByEmail(email));
  } catch {
    throw new HttpsError('not-found', 'No user with that email (have they signed in yet?).');
  }
  await db.collection('users').doc(uid).set({ orgId }, { merge: true });
  // Custom claim lets security rules + the app scope reads to the user's org.
  await getAuth().setCustomUserClaims(uid, { orgId });
  return { uid, email, orgId };
});
