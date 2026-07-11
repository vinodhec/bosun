import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { getUsdToInrRate } from '../utils/fxRate.js';
import { applyFixAward, applyShipAward, emptyMember } from '../utils/gamification.js';
import { requireAdmin } from '../utils/admin.js';
import { financialYear, formatInvoiceNumber, buildInvoiceRecord, renderInvoiceHtml, invoiceSummary } from '../utils/invoice.js';

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
  const counterRef = db.collection('counters').doc('invoices');
  const txnRef = db.collection('transactions').doc();
  const invRef = db.collection('invoices').doc();
  const result = await db.runTransaction(async (tx) => {
    // Reads first (Firestore requires all reads before any write in a transaction).
    const snap = await tx.get(orgRef);
    if (!snap.exists) throw new HttpsError('not-found', 'Organisation not found.');
    const counterSnap = await tx.get(counterRef);

    const next = Number(snap.data().balance ?? 0) + amount;

    // Gapless per-financial-year invoice number, allocated atomically with the credit.
    const fy = financialYear();
    const seq = Number(counterSnap.get(fy) ?? 0) + 1;
    const number = formatInvoiceNumber(fy, seq);
    const invoice = buildInvoiceRecord({
      org: snap.data(), orgId, taxableInr: amount, number, fy, seq, txnId: txnRef.id, by,
    });

    // Writes.
    tx.update(orgRef, { balance: next });
    tx.set(txnRef, {
      orgId, type: 'credit', amount, by, invoiceId: invRef.id, invoiceNumber: number,
      createdAt: FieldValue.serverTimestamp(),
    });
    tx.set(counterRef, { [fy]: seq }, { merge: true });
    tx.set(invRef, { ...invoice, createdAt: FieldValue.serverTimestamp() });
    return { balance: next, invoiceId: invRef.id, invoiceNumber: number };
  });
  return { orgId, ...result };
});

// Operator: list an org's issued tax invoices (newest first), plus printable HTML on demand.
export const adminListInvoices = onCall({ region: REGION }, async (request) => {
  requireAdmin(request);
  const orgId = String(request.data?.orgId ?? '').trim();
  if (!orgId) throw new HttpsError('invalid-argument', 'orgId required.');
  const db = getFirestore();
  const snap = await db
    .collection('invoices')
    .where('orgId', '==', orgId)
    .orderBy('issuedAtMs', 'desc')
    .limit(200)
    .get();
  return { invoices: snap.docs.map((d) => ({ id: d.id, ...invoiceSummary(d.data()) })) };
});

// Operator: printable HTML for one invoice (Admin panel "download" / print).
export const adminInvoiceHtml = onCall({ region: REGION }, async (request) => {
  requireAdmin(request);
  const invoiceId = String(request.data?.invoiceId ?? '').trim();
  if (!invoiceId) throw new HttpsError('invalid-argument', 'invoiceId required.');
  const db = getFirestore();
  const snap = await db.collection('invoices').doc(invoiceId).get();
  if (!snap.exists) throw new HttpsError('not-found', 'Invoice not found.');
  return { html: renderInvoiceHtml(snap.data()) };
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
      // Non-secret Figma connection status (handle only — never the token).
      figma: d.data().figma?.connected
        ? { connected: true, handle: d.data().figma.handle || '', email: d.data().figma.email || '' }
        : null,
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
  // Members are those whose orgIds array contains this org (legacy single-org users were
  // backfilled to orgIds during migration).
  const snap = await db.collection('users').where('orgIds', 'array-contains', orgId).get();
  const users = snap.docs
    .map((d) => ({
      uid: d.id,
      email: d.data().email ?? null,
      canDeployProd: d.data().canDeployProd === true,
      canViewInvoices: d.data().canViewInvoices === true,
      orgIds: Array.isArray(d.data().orgIds) ? d.data().orgIds : (d.data().orgId ? [d.data().orgId] : []),
    }))
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

// Grant / revoke a single user's permission to VIEW their org's tax invoices. Off by default —
// invoices are visible only to the specific people the operator grants (e.g. the owner/finance
// contact), not every org member. Enforced server-side in listMyInvoices / getMyInvoiceHtml.
export const adminSetUserInvoices = onCall({ region: REGION }, async (request) => {
  requireAdmin(request);
  const uid = String(request.data?.uid ?? '').trim();
  const canViewInvoices = request.data?.canViewInvoices === true;
  if (!uid) throw new HttpsError('invalid-argument', 'uid required.');
  const db = getFirestore();
  const ref = db.collection('users').doc(uid);
  if (!(await ref.get()).exists) throw new HttpsError('not-found', 'User not found.');
  await ref.update({ canViewInvoices });
  return { uid, canViewInvoices };
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
  const rate = await getUsdToInrRate();

  const [orgsSnap, tasksSnap, creditSnap, sourcingSnap] = await Promise.all([
    db.collection('organisations').get(),
    db.collection('tasks').get(),
    db.collection('transactions').where('type', '==', 'credit').get(),
    // Sourced-listing relay is a separate metered lane: one debit txn per run batch, `amount` = the
    // ₹ we charged, `count` = leads relayed. Revenue lives here (a debit), NOT on tasks.
    db.collection('transactions').where('kind', '==', 'sourcing').get(),
  ]);

  // Apify (SERP + FB enrichment) is the only sourcing COGS and we don't meter it per run — sourcing
  // is a deliberately near-zero-COGS lane. Estimate it for a profit view; clearly labelled "est".
  const SOURCING_APIFY_EST_INR_PER_LEAD = 0.4;

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

    // A design/planning SESSION carries revenue but isn't a "fix delivered" — only real
    // builds/fixes (and feature steps) count toward fixesDone.
    if (t.status === 'complete' && t.kind !== 'design' && t.kind !== 'planning') { totals.fixesDone++; bump(t.orgId, (s) => s.fixesDone++); }
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

  // ── Sourcing lane: revenue (Σ amount) + leads (Σ count) from the sourcing debit txns, sliced the
  // same way as the fix business (today / trailing / per-org). Profit uses the estimated Apify COGS.
  const estCost = (leads) => (Number(leads) || 0) * SOURCING_APIFY_EST_INR_PER_LEAD;
  const srcTotals = { revenueInr: 0, leads: 0, batches: 0 };
  const srcToday = { revenueInr: 0, leads: 0 };
  const srcWin = { d1: { rev: 0, leads: 0 }, d7: { rev: 0, leads: 0 }, d30: { rev: 0, leads: 0 } };
  const srcByOrg = new Map();
  const srcBump = (orgId, amt, leads) => {
    let s = srcByOrg.get(orgId);
    if (!s) { s = { orgId, name: orgStats.get(orgId)?.name || '(unknown)', revenueInr: 0, leads: 0 }; srcByOrg.set(orgId, s); }
    s.revenueInr += amt; s.leads += leads;
  };
  for (const d of sourcingSnap.docs) {
    const t = d.data();
    const amt = Number(t.amount) || 0;
    const leads = Number(t.count) || 0;
    srcTotals.revenueInr += amt; srcTotals.leads += leads; srcTotals.batches += 1;
    if (t.orgId) srcBump(t.orgId, amt, leads);
    const whenMs = t.createdAt?.toMillis?.() ?? null;
    if (whenMs != null) {
      const age = now - whenMs;
      if (age <= DAY_MS) { srcWin.d1.rev += amt; srcWin.d1.leads += leads; }
      if (age <= 7 * DAY_MS) { srcWin.d7.rev += amt; srcWin.d7.leads += leads; }
      if (age <= 30 * DAY_MS) { srcWin.d30.rev += amt; srcWin.d30.leads += leads; }
      if (whenMs >= todayStartMs) { srcToday.revenueInr += amt; srcToday.leads += leads; }
    }
  }
  const srcWindow = (w) => ({ revenueInr: w.rev, leads: w.leads, profitInr: w.rev - estCost(w.leads) });
  const sourcing = {
    revenueInr: srcTotals.revenueInr,
    leads: srcTotals.leads,
    batches: srcTotals.batches,
    estCostInr: estCost(srcTotals.leads),
    profitInr: srcTotals.revenueInr - estCost(srcTotals.leads),
    marginPct: srcTotals.revenueInr > 0 ? Math.round(((srcTotals.revenueInr - estCost(srcTotals.leads)) / srcTotals.revenueInr) * 100) : 0,
    estInrPerLead: SOURCING_APIFY_EST_INR_PER_LEAD,
    avgInrPerLead: srcTotals.leads > 0 ? srcTotals.revenueInr / srcTotals.leads : 0,
    today: { revenueInr: srcToday.revenueInr, leads: srcToday.leads, profitInr: srcToday.revenueInr - estCost(srcToday.leads) },
    trailing: { d1: srcWindow(srcWin.d1), d7: srcWindow(srcWin.d7), d30: srcWindow(srcWin.d30) },
    byOrg: [...srcByOrg.values()].sort((a, b) => b.revenueInr - a.revenueInr),
  };

  return { rate, totals, today, averages, trailing, byOrg, sourcing, generatedAt: now };
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
  // ADD this org to the user's memberships (a user can belong to several). Keep the legacy
  // single `orgId` as a mirror of the active org, and default the active org to this one if the
  // user has no valid active org yet.
  const userRef = db.collection('users').doc(uid);
  const cur = (await userRef.get()).data() || {};
  const orgIds = [...new Set([...(Array.isArray(cur.orgIds) ? cur.orgIds : (cur.orgId ? [cur.orgId] : [])), orgId])];
  const activeOrgId = cur.activeOrgId && orgIds.includes(cur.activeOrgId) ? cur.activeOrgId : orgId;
  await userRef.set({ orgId: activeOrgId, orgIds, activeOrgId }, { merge: true });
  // Custom claim lets security rules scope reads to ALL the user's orgs (orgIds), with `orgId`
  // kept as the active mirror for backward-compatibility.
  await getAuth().setCustomUserClaims(uid, { orgId: activeOrgId, orgIds });
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
  return { uid, email, orgId, orgIds, activeOrgId };
});

// Remove an org from a user's memberships. Fixes up the active org + claim if the removed org
// was the active one. Leaderboard stats are left in place (history).
export const adminRemoveUserOrg = onCall({ region: REGION }, async (request) => {
  requireAdmin(request);
  const email = String(request.data?.email ?? '').trim().toLowerCase();
  const orgId = String(request.data?.orgId ?? '');
  if (!email || !orgId) throw new HttpsError('invalid-argument', 'email and orgId required.');
  const db = getFirestore();
  let uid;
  try {
    uid = (await getAuth().getUserByEmail(email)).uid;
  } catch {
    throw new HttpsError('not-found', 'No user with that email.');
  }
  const userRef = db.collection('users').doc(uid);
  const cur = (await userRef.get()).data() || {};
  const prev = Array.isArray(cur.orgIds) ? cur.orgIds : (cur.orgId ? [cur.orgId] : []);
  const orgIds = prev.filter((id) => id !== orgId);
  const activeOrgId = orgIds.includes(cur.activeOrgId) ? cur.activeOrgId : (orgIds[0] || null);
  await userRef.set({ orgIds, activeOrgId, orgId: activeOrgId }, { merge: true });
  await getAuth().setCustomUserClaims(uid, { orgId: activeOrgId, orgIds });
  return { uid, email, orgId, orgIds, activeOrgId };
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
