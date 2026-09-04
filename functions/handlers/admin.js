import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { getUsdToInrRate } from '../utils/fxRate.js';
import { applyFixAward, applyShipAward, emptyMember } from '../utils/gamification.js';
import { requireAdmin } from '../utils/admin.js';
import { financialYear, formatInvoiceNumber, buildInvoiceRecord, renderInvoiceHtml, invoiceSummary } from '../utils/invoice.js';
import { GST_REPORTS } from '../utils/gstReport.js';
import { GST_TREATMENTS, buildPurchaseRecord, purchaseSummary, reportablePurchases } from '../utils/purchase.js';
import { SELFPOST_COMPOSE_PRICE_PAISE, AUTOPOST_USAGE_PRICE_PAISE, DAILY_PLAN_PRICE_PAISE, ASSISTANT_MESSAGE_PRICE_PAISE } from '../shared/billing.js';

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
    // The wallet is credited `amount`; the invoice adds the platform fee ON TOP (buildInvoiceRecord),
    // so the customer pays credit + fee + GST while only `amount` lands in the wallet balance below.
    const invoice = buildInvoiceRecord({
      org: snap.data(), orgId, creditInr: amount, number, fy, seq, txnId: txnRef.id, by,
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

// Operator: one of the five GST reports for the SOFTWARE invoice line over a date range —
// `kind` is a GST_REPORTS key (sale | purchase | gstr1 | gstr2 | gstr3b), defaulting to gstr1 for
// callers predating the other four. `from`/`to` are 'YYYY-MM-DD' (inclusive), anchored to IST so
// the day boundaries match Indian dates. Returns printable HTML; the CA merges it with the trading
// business for the single-GSTIN filing.
//
// The purchase-side reports (purchase, gstr2, and the ITC half of gstr3b) render NIL: the software
// line's only inward supplies are imports of services under reverse charge, and Bosun records no
// vendor bills. See the header of utils/gstReport.js.
export const adminGstReport = onCall({ region: REGION }, async (request) => {
  requireAdmin(request);
  const kind = String(request.data?.kind ?? 'gstr1').trim();
  const spec = GST_REPORTS[kind];
  if (!spec) throw new HttpsError('invalid-argument', `kind must be one of ${Object.keys(GST_REPORTS).join(', ')}.`);
  const { fromMs, toMs } = parseIstRange(request.data);

  const db = getFirestore();
  const [saleSnap, purchaseSnap] = await Promise.all([
    db.collection('invoices')
      .where('issuedAtMs', '>=', fromMs).where('issuedAtMs', '<=', toMs).orderBy('issuedAtMs').get(),
    db.collection('purchases')
      .where('dateMs', '>=', fromMs).where('dateMs', '<=', toMs).orderBy('dateMs').get(),
  ]);
  const invoices = saleSnap.docs.map((d) => d.data());
  const allPurchases = purchaseSnap.docs.map((d) => d.data());
  // The Purchase Report shows EVERY recorded bill (including the ones we cannot claim, so their
  // absence from the return is visible); GSTR-2 and GSTR-3B see only the reportable ones.
  const purchases = kind === 'purchase' ? allPurchases : reportablePurchases(allPurchases);
  const report = spec.build({ invoices, purchases, fromMs, toMs });
  // A summary the panel can show for ANY kind — the per-report `totals` shapes differ, so derive
  // the headline figures from the invoices rather than from the report.
  const taxable = invoices.reduce((a, i) => a + (i.taxableInr || 0), 0);
  const tax = invoices.reduce((a, i) => a + (i.taxInr || 0), 0);
  return {
    html: spec.render(report),
    kind,
    label: spec.label,
    count: invoices.length,
    purchaseCount: purchases.length,
    totals: { taxable: Math.round(taxable * 100) / 100, tax: Math.round(tax * 100) / 100 },
  };
});

// 'YYYY-MM-DD' from/to (inclusive) → an [ms, ms] range anchored to IST, so day boundaries match
// Indian dates rather than UTC. Shared by every date-ranged operator report.
function parseIstRange(data) {
  const from = String(data?.from ?? '').trim();
  const to = String(data?.to ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    throw new HttpsError('invalid-argument', 'from and to must be YYYY-MM-DD.');
  }
  const fromMs = Date.parse(`${from}T00:00:00+05:30`);
  const toMs = Date.parse(`${to}T23:59:59.999+05:30`);
  if (!(fromMs <= toMs)) throw new HttpsError('invalid-argument', 'from must be on or before to.');
  return { fromMs, toMs };
}

// Operator: record a vendor bill for the software line (Anthropic API credits). Backend-only
// write, like every other money-bearing collection — the browser never writes `purchases`.
// `gstTreatment` decides whether the bill reaches GSTR-2/3B; see utils/purchase.js.
export const adminRecordPurchase = onCall({ region: REGION }, async (request) => {
  const by = requireAdmin(request);
  const d = request.data || {};
  const supplierName = String(d.supplierName ?? '').trim();
  const date = String(d.date ?? '').trim();
  if (!supplierName) throw new HttpsError('invalid-argument', 'supplierName required.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpsError('invalid-argument', 'date must be YYYY-MM-DD.');
  if (d.gstTreatment && !GST_TREATMENTS.includes(String(d.gstTreatment))) {
    throw new HttpsError('invalid-argument', `gstTreatment must be one of ${GST_TREATMENTS.join(', ')}.`);
  }
  const taxableInr = Number(d.taxableInr);
  if (!Number.isFinite(taxableInr) || taxableInr < 0) {
    throw new HttpsError('invalid-argument', 'taxableInr must be a non-negative number (the rupees actually debited).');
  }
  const record = buildPurchaseRecord({
    supplierName,
    supplierTaxId: d.supplierTaxId,
    country: d.country,
    number: d.number,
    dateMs: Date.parse(`${date}T12:00:00+05:30`),
    currency: d.currency,
    amountForeign: d.amountForeign,
    taxableInr,
    gstTreatment: d.gstTreatment,
    gstRate: d.gstRate,
    intraState: d.intraState !== false,
    supplierTaxInr: d.supplierTaxInr,
    notes: d.notes,
    by,
  });
  const db = getFirestore();
  const ref = await db.collection('purchases').add({ ...record, createdAt: FieldValue.serverTimestamp() });
  return { id: ref.id, purchase: purchaseSummary(record) };
});

// Operator: list recorded vendor bills over a date range (newest first).
export const adminListPurchases = onCall({ region: REGION }, async (request) => {
  requireAdmin(request);
  const { fromMs, toMs } = parseIstRange(request.data);
  const db = getFirestore();
  const snap = await db
    .collection('purchases')
    .where('dateMs', '>=', fromMs)
    .where('dateMs', '<=', toMs)
    .orderBy('dateMs', 'desc')
    .get();
  return { purchases: snap.docs.map((s) => ({ id: s.id, ...purchaseSummary(s.data()) })) };
});

// Operator: remove a mis-keyed vendor bill. Purchases carry no ledger side-effects (they never
// touch a wallet), so a plain delete is safe — unlike transactions, which are append-only.
export const adminDeletePurchase = onCall({ region: REGION }, async (request) => {
  requireAdmin(request);
  const id = String(request.data?.purchaseId ?? '').trim();
  if (!id) throw new HttpsError('invalid-argument', 'purchaseId required.');
  await getFirestore().collection('purchases').doc(id).delete();
  return { ok: true };
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
      billing: d.data().billing || null, // GST buyer profile (see adminSetOrgBilling); null = unset.
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

// Set / update an org's GST BILLING PROFILE — the buyer block on its tax invoices
// (organisations/{id}.billing, read by invoice.js#buyerFromOrg). Backend-only write (cardinal
// rule): there is no client path to org.billing, so this is the ONE place a customer's GST
// details are set. GSTIN is optional (blank = unregistered / B2C buyer). The 2-digit stateCode
// drives intra- vs inter-state GST (CGST+SGST when it equals the supplier's TN '33', else IGST)
// and defaults to the GSTIN's leading state digits; buyerFromOrg derives intraState from it.
export const adminSetOrgBilling = onCall({ region: REGION }, async (request) => {
  requireAdmin(request);
  const orgId = String(request.data?.orgId ?? '').trim();
  if (!orgId) throw new HttpsError('invalid-argument', 'orgId required.');
  const d = request.data || {};
  const clean = (v) => { const s = String(v ?? '').trim(); return s || null; };

  const gstin = clean(d.gstin)?.toUpperCase() ?? null;
  if (gstin && !/^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/.test(gstin)) {
    throw new HttpsError('invalid-argument', 'GSTIN must be a valid 15-character GSTIN.');
  }
  const stateCode = clean(d.stateCode) || (gstin ? gstin.slice(0, 2) : null);
  if (stateCode && !/^[0-9]{2}$/.test(stateCode)) {
    throw new HttpsError('invalid-argument', 'stateCode must be the 2-digit GST state code.');
  }

  const billing = {
    legalName: clean(d.legalName),
    gstin,
    state: clean(d.state),
    stateCode,
    address: clean(d.address),
  };
  if (typeof d.intraState === 'boolean') billing.intraState = d.intraState;

  const db = getFirestore();
  const ref = db.collection('organisations').doc(orgId);
  if (!(await ref.get()).exists) throw new HttpsError('not-found', 'Organisation not found.');
  await ref.update({ billing });
  return { orgId, billing };
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

  const [orgsSnap, tasksSnap, creditSnap, laneSnap, waivedSnap] = await Promise.all([
    db.collection('organisations').get(),
    db.collection('tasks').get(),
    db.collection('transactions').where('type', '==', 'credit').get(),
    // The three metered lanes, all debit txns with `amount` = ₹ charged and `count` = units settled.
    // Revenue for these lives HERE, not on tasks — they never touch the managed-agent pipeline.
    //   sourcing        — one row per run batch,  count = leads relayed
    //   selfpost_compose— WhatsApp message composed for an owner (₹0.25, accrued)
    //   autopost_usage  — customer's sweep auto-published a Bosun lead (₹0.50, accrued)
    //   daily_plan      — nightly admin work-queue plan (₹200/plan-day flat, accrued)
    //   whatsapp_usage  — outreach-bot delivered messages (₹1.65) + accepted postings (₹3), accrued
    db.collection('transactions')
      .where('kind', 'in', ['sourcing', 'selfpost_compose', 'autopost_usage', 'daily_plan', 'whatsapp_usage', 'conversion_popup'])
      .get(),
    // Waived meter events (testing / goodwill pause): recorded but never debited — the reconcilable
    // "what we chose not to charge" figure. Single-field filter (auto-indexed).
    db.collection('usage_meter_log').where('waived', '==', true).limit(5000).get(),
  ]);
  const sourcingSnap = { docs: laneSnap.docs.filter((d) => d.data().kind === 'sourcing') };

  // Roll up waived (uncharged) revenue by service + org — what the operator could add back / start
  // charging once testing signs off. Never debited, so this is pure "held-back" visibility.
  const waivedByService = {};
  let waivedTotalInr = 0;
  for (const d of waivedSnap.docs) {
    const w = d.data();
    const inr = (Number(w.waivedPaise) || 0) / 100;
    waivedByService[w.service] = (waivedByService[w.service] || 0) + inr;
    waivedTotalInr += inr;
  }
  const waived = { totalInr: waivedTotalInr, byService: waivedByService, events: waivedSnap.size };

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

  // ── The metered lanes, side by side. Sourcing was the only one this endpoint reported, which made
  // the relay look like the whole property business — the WhatsApp compose (₹0.25/message) and the
  // auto-post meter (₹0.50/publish) were earning invisibly. All three are sliced identically so they
  // can be added up honestly.
  const LANES = {
    sourcing: { label: 'Leads relayed', unit: 'lead', pricePaise: null },
    selfpost_compose: { label: 'WhatsApp messages', unit: 'message', pricePaise: SELFPOST_COMPOSE_PRICE_PAISE },
    autopost_usage: { label: 'Auto-posted listings', unit: 'post', pricePaise: AUTOPOST_USAGE_PRICE_PAISE },
    daily_plan: { label: 'Daily work plans', unit: 'plan-day', pricePaise: DAILY_PLAN_PRICE_PAISE },
    whatsapp_usage: { label: 'WhatsApp outreach', unit: 'event', pricePaise: null }, // mixed ₹1.65 / ₹3
    conversion_popup: { label: 'Popups opened', unit: 'popup', pricePaise: null }, // random ₹0.25–0.35 each
    assistant_message: { label: 'Website assistant replies', unit: 'reply', pricePaise: ASSISTANT_MESSAGE_PRICE_PAISE },
  };
  const laneBlank = () => ({
    revenueInr: 0, units: 0, txns: 0,
    today: { revenueInr: 0, units: 0 },
    d1: { revenueInr: 0, units: 0 }, d7: { revenueInr: 0, units: 0 }, d30: { revenueInr: 0, units: 0 },
    byOrg: new Map(),
  });
  const laneAgg = Object.fromEntries(Object.keys(LANES).map((k) => [k, laneBlank()]));
  for (const d of laneSnap.docs) {
    const t = d.data();
    const agg = laneAgg[t.kind];
    if (!agg) continue;
    const amt = Number(t.amount) || 0;
    const units = Number(t.count) || 0;
    agg.revenueInr += amt; agg.units += units; agg.txns += 1;
    if (t.orgId) {
      const cur = agg.byOrg.get(t.orgId) || { orgId: t.orgId, name: orgStats.get(t.orgId)?.name || '(unknown)', revenueInr: 0, units: 0 };
      cur.revenueInr += amt; cur.units += units;
      agg.byOrg.set(t.orgId, cur);
    }
    const whenMs = t.createdAt?.toMillis?.() ?? null;
    if (whenMs == null) continue;
    const age = now - whenMs;
    if (age <= DAY_MS) { agg.d1.revenueInr += amt; agg.d1.units += units; }
    if (age <= 7 * DAY_MS) { agg.d7.revenueInr += amt; agg.d7.units += units; }
    if (age <= 30 * DAY_MS) { agg.d30.revenueInr += amt; agg.d30.units += units; }
    if (whenMs >= todayStartMs) { agg.today.revenueInr += amt; agg.today.units += units; }
  }

  // Sub-rupee charges accrue on the org and only debit as they cross ₹1, so at any instant some
  // earned revenue is still held as paise. Surface it — otherwise the lane totals look short and
  // nobody can tell whether it's drift or just the carry.
  let composeAccrualPaise = 0;
  let autopostAccrualPaise = 0;
  let plannerAccrualPaise = 0;
  let waAccrualPaise = 0;
  let popupAccrualPaise = 0;
  let assistantAccrualPaise = 0;
  for (const o of orgsSnap.docs) {
    assistantAccrualPaise += Number(o.data().assistantAccrualPaise) || 0;
    composeAccrualPaise += Number(o.data().composeAccrualPaise) || 0;
    autopostAccrualPaise += Number(o.data().autopostAccrualPaise) || 0;
    plannerAccrualPaise += Number(o.data().plannerAccrualPaise) || 0;
    waAccrualPaise += Number(o.data().waAccrualPaise) || 0;
    popupAccrualPaise += Number(o.data().popupAccrualPaise) || 0;
  }

  const lanes = Object.entries(LANES).map(([kind, meta]) => {
    const a = laneAgg[kind];
    return {
      kind,
      label: meta.label,
      unit: meta.unit,
      priceInr: meta.pricePaise != null ? meta.pricePaise / 100 : null,
      revenueInr: a.revenueInr,
      units: a.units,
      txns: a.txns,
      avgInrPerUnit: a.units > 0 ? a.revenueInr / a.units : 0,
      today: a.today,
      trailing: { d1: a.d1, d7: a.d7, d30: a.d30 },
      pendingAccrualInr: kind === 'selfpost_compose' ? composeAccrualPaise / 100
        : kind === 'autopost_usage' ? autopostAccrualPaise / 100
        : kind === 'daily_plan' ? plannerAccrualPaise / 100
        : kind === 'whatsapp_usage' ? waAccrualPaise / 100
        : kind === 'conversion_popup' ? popupAccrualPaise / 100
        : kind === 'assistant_message' ? assistantAccrualPaise / 100 : 0,
      byOrg: [...a.byOrg.values()].sort((x, y) => y.revenueInr - x.revenueInr),
    };
  });

  // Whole property business = the three lanes together. Apify (estimated per relayed lead) is the
  // only COGS across them — compose/auto-post COGS is a Gemini Flash call and a webhook, both
  // rounding error against ₹0.25/₹0.50.
  const laneRevenue = lanes.reduce((n, l) => n + l.revenueInr, 0);
  const propertyTotal = {
    revenueInr: laneRevenue,
    estCostInr: estCost(srcTotals.leads),
    profitInr: laneRevenue - estCost(srcTotals.leads),
    marginPct: laneRevenue > 0 ? Math.round(((laneRevenue - estCost(srcTotals.leads)) / laneRevenue) * 100) : 0,
    today: { revenueInr: lanes.reduce((n, l) => n + l.today.revenueInr, 0) },
    trailing: {
      d1: { revenueInr: lanes.reduce((n, l) => n + l.trailing.d1.revenueInr, 0) },
      d7: { revenueInr: lanes.reduce((n, l) => n + l.trailing.d7.revenueInr, 0) },
      d30: { revenueInr: lanes.reduce((n, l) => n + l.trailing.d30.revenueInr, 0) },
    },
    pendingAccrualInr: (composeAccrualPaise + autopostAccrualPaise + plannerAccrualPaise + waAccrualPaise + popupAccrualPaise) / 100,
  };

  // ── Session pool: the base-fee coverage (1,50,000 processed sessions / month). sessionMeter.<yyyymm>
  // is bumped by the nightly session-intelligence run; overage (₹0.20/session) is reconciled from
  // this counter at invoice time, not auto-billed — this block is how the operator watches it.
  const SESSION_POOL_MONTHLY = 150000;
  const SESSION_OVERAGE_INR = 0.2;
  const istNow = new Date(now + 5.5 * 60 * 60 * 1000);
  const monthKey = `${istNow.getUTCFullYear()}${String(istNow.getUTCMonth() + 1).padStart(2, '0')}`;
  let sessionsThisMonth = 0;
  for (const o of orgsSnap.docs) {
    sessionsThisMonth += Number(o.data().sessionMeter?.[monthKey]) || 0;
  }
  const sessionPool = {
    monthKey,
    processed: sessionsThisMonth,
    poolSize: SESSION_POOL_MONTHLY,
    usedPct: Math.round((sessionsThisMonth / SESSION_POOL_MONTHLY) * 100),
    overageSessions: Math.max(0, sessionsThisMonth - SESSION_POOL_MONTHLY),
    overageInr: Math.max(0, sessionsThisMonth - SESSION_POOL_MONTHLY) * SESSION_OVERAGE_INR,
    overageRateInr: SESSION_OVERAGE_INR,
  };

  // Conversion rulebook — the live rules the nightly agent last delivered for each org (from
  // intelRuns), so the operator can SEE what Bosun is running on the portal + last night's changes.
  // Until the first nightly tuning run, the portal runs the platform's built-in defaults (the
  // engagement engine still works) — surfaced as `defaultsActive`.
  let conversionRules = null;
  for (const orgDoc of orgsSnap.docs) {
    const cfg = orgDoc.data().sourcing || {};
    if (!cfg.intelligence?.enabled) continue;
    try {
      // Bosun's own record of the last tuning (changes/outcomes/proposals).
      const daySnap = await db
        .collection('intelRuns')
        .doc(orgDoc.id)
        .collection('days')
        .orderBy('dateKey', 'desc')
        .limit(3)
        .get();
      const lastRun = daySnap.docs.map((d) => d.data()).find((d) => Array.isArray(d.rules) && d.rules.length);

      // The AUTHORITATIVE live rulebook is what the customer site is actually serving — fetch it
      // from the platform's public rules endpoint (derived from the planner base URL) so the panel
      // shows the real rules even before the first nightly tuning (when they're the built-in defaults).
      let liveRules = [];
      let liveSource = null;
      try {
        const planUrl = cfg.planner?.planUrl || cfg.intelligence?.packUrl || '';
        const base = planUrl ? new URL(planUrl).origin : '';
        if (base) {
          const resp = await fetch(`${base}/api/engagement/rules`, { signal: AbortSignal.timeout(8000) });
          if (resp.ok) {
            const body = await resp.json();
            liveRules = Array.isArray(body.rules) ? body.rules : [];
            liveSource = body.source || null;
          }
        }
      } catch (e) {
        console.error('adminMetrics:liveRules:err', orgDoc.id, e?.message || e);
      }

      const rules = liveRules.length ? liveRules : lastRun?.rules || [];
      conversionRules = {
        orgId: orgDoc.id,
        orgName: orgDoc.data().name || orgDoc.id,
        defaultsActive: liveSource === 'defaults' || (!liveRules.length && !lastRun),
        source: liveSource,
        dateKey: lastRun?.dateKey || null,
        rules,
        ruleChanges: lastRun?.ruleChanges || [],
        actions: lastRun?.actions || null,
        devTasksProposed: lastRun?.devTasksProposed || 0,
      };
    } catch (e) {
      console.error('adminMetrics:conversionRules:err', orgDoc.id, e?.message || e);
    }
    break; // one sourcing org in practice
  }

  return { rate, totals, today, averages, trailing, byOrg, sourcing, lanes, propertyTotal, sessionPool, waived, conversionRules, generatedAt: now };
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
