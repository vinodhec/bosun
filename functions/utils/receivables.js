// The receivables TRANSACTIONS — record a payment received (allocated oldest-invoice-first, excess
// held as the org's `advanceInr`) and undo one. Shared by the admin callables and the one-off
// seeding script (scripts/seed-payments.mjs) so both paths run the exact same money logic.
// Errors carry a callable-style `code` the handler maps onto HttpsError.
import { FieldValue } from 'firebase-admin/firestore';
import { PAYMENT_METHODS, allocatePayment, invoiceDueInr, paymentStatusOf } from './payments.js';

const fail = (code, message) => Object.assign(new Error(message), { code });

// Auto top-up invoices (source 'auto_topup') are the org's credit line: `autoTopUpState.unpaid` /
// `unpaidCreditInr` count the OPEN ones and gate the next auto top-up (utils/autoTopUp.js). When a
// payment settles one, or an undo re-opens one, those counters move with it — here, in the same
// transaction, so the ledger and the credit line can never disagree.
function autoTopUpDelta(invoices /* [{ data, wasPaid, nowPaid }] */) {
  let unpaid = 0, creditInr = 0;
  for (const { data, wasPaid, nowPaid } of invoices) {
    if (data.source !== 'auto_topup' || wasPaid === nowPaid) continue;
    const sign = nowPaid ? -1 : 1;
    unpaid += sign; creditInr += sign * (Math.round(Number(data.creditInr)) || 0);
  }
  return { unpaid, creditInr };
}
function applyAutoTopUpDelta(tx, orgRef, orgData, delta) {
  if (!delta.unpaid && !delta.creditInr) return {};
  const st = orgData?.autoTopUpState || {};
  return {
    'autoTopUpState.unpaid': Math.max(0, (Number(st.unpaid) || 0) + delta.unpaid),
    'autoTopUpState.unpaidCreditInr': Math.max(0, (Number(st.unpaidCreditInr) || 0) + delta.creditInr),
  };
}

export async function recordPayment(db, { orgId, amountInr, receivedAtMs, method, reference, note, preferInvoiceId, by }) {
  orgId = String(orgId ?? '').trim();
  const amount = Math.round(Number(amountInr));
  if (!orgId) throw fail('invalid-argument', 'orgId required.');
  if (!Number.isFinite(amount) || amount <= 0) throw fail('invalid-argument', 'amountInr must be a positive number.');
  method = PAYMENT_METHODS.includes(method) ? method : 'other';
  reference = String(reference ?? '').trim().slice(0, 120) || null;
  note = String(note ?? '').trim().slice(0, 500) || null;
  receivedAtMs = Number.isFinite(Number(receivedAtMs)) && Number(receivedAtMs) > 0 ? Number(receivedAtMs) : Date.now();
  preferInvoiceId = String(preferInvoiceId ?? '').trim() || null;

  // Duplicate guard: the same UTR / reference for the same org is the same money.
  if (reference) {
    const dup = await db.collection('payments').where('orgId', '==', orgId).where('reference', '==', reference).limit(1).get();
    if (!dup.empty) throw fail('already-exists', `A payment with reference ${reference} is already recorded.`);
  }

  const orgRef = db.collection('organisations').doc(orgId);
  const payRef = db.collection('payments').doc();
  const result = await db.runTransaction(async (tx) => {
    const orgSnap = await tx.get(orgRef);
    if (!orgSnap.exists) throw fail('not-found', 'Organisation not found.');
    // Every invoice of the org (a small set) — open ones are filtered in memory so legacy invoices
    // without paidInr still count as due.
    const invSnap = await tx.get(db.collection('invoices').where('orgId', '==', orgId));
    const open = invSnap.docs
      .map((doc) => ({ id: doc.id, ref: doc.ref, data: doc.data() }))
      .filter((i) => (i.data.status || 'issued') !== 'cancelled')
      .map((i) => ({ ...i, number: i.data.number, issuedAtMs: i.data.issuedAtMs || 0, dueInr: invoiceDueInr(i.data) }));
    if (preferInvoiceId && !open.some((i) => i.id === preferInvoiceId)) {
      throw fail('invalid-argument', 'That invoice does not belong to this organisation.');
    }
    const { allocations, unallocatedInr } = allocatePayment(amount, open, { preferInvoiceId });

    tx.set(payRef, {
      orgId, amountInr: amount, receivedAtMs, method, reference, note, by: by || null,
      allocations, unallocatedInr,
      createdAt: FieldValue.serverTimestamp(),
    });
    const touched = [];
    const transitions = [];
    for (const a of allocations) {
      const inv = open.find((i) => i.id === a.invoiceId);
      const paidInr = Math.round(Number(inv.data.paidInr ?? 0)) + a.amountInr;
      const next = { ...inv.data, paidInr };
      const paymentStatus = paymentStatusOf(next);
      transitions.push({ data: inv.data, wasPaid: paymentStatusOf(inv.data) === 'paid', nowPaid: paymentStatus === 'paid' });
      tx.update(inv.ref, {
        paidInr,
        dueInr: invoiceDueInr(next),
        paymentStatus,
        paidAtMs: paymentStatus === 'paid' ? receivedAtMs : null,
        payments: FieldValue.arrayUnion({ paymentId: payRef.id, amountInr: a.amountInr, receivedAtMs }),
      });
      touched.push({ invoiceId: a.invoiceId, number: a.number, amountInr: a.amountInr, paymentStatus, dueInr: invoiceDueInr(next) });
    }
    const advanceInr = Math.max(0, Math.round(Number(orgSnap.data().advanceInr ?? 0))) + unallocatedInr;
    const orgUpdate = {
      ...(unallocatedInr > 0 ? { advanceInr } : {}),
      ...applyAutoTopUpDelta(tx, orgRef, orgSnap.data(), autoTopUpDelta(transitions)),
    };
    if (Object.keys(orgUpdate).length) tx.update(orgRef, orgUpdate);
    return { paymentId: payRef.id, allocations: touched, unallocatedInr, advanceInr };
  });
  return { orgId, amountInr: amount, ...result };
}

export async function deletePayment(db, paymentId) {
  const payRef = db.collection('payments').doc(paymentId);
  return db.runTransaction(async (tx) => {
    const paySnap = await tx.get(payRef);
    if (!paySnap.exists) throw fail('not-found', 'Payment not found.');
    const p = paySnap.data();
    const orgRef = db.collection('organisations').doc(p.orgId);
    const orgSnap = await tx.get(orgRef);
    const allocations = Array.isArray(p.allocations) ? p.allocations : [];
    const invSnaps = await Promise.all(allocations.map((a) => tx.get(db.collection('invoices').doc(a.invoiceId))));
    const unallocated = Math.round(Number(p.unallocatedInr ?? 0));
    const advance = Math.max(0, Math.round(Number(orgSnap.data()?.advanceInr ?? 0)));
    if (unallocated > 0 && advance < unallocated) {
      throw fail('failed-precondition', 'Part of this payment was already applied to a later invoice as an advance — it can no longer be deleted.');
    }
    const transitions = [];
    invSnaps.forEach((snap, i) => {
      if (!snap.exists) return;
      const inv = snap.data();
      const paidInr = Math.max(0, Math.round(Number(inv.paidInr ?? 0)) - allocations[i].amountInr);
      const next = { ...inv, paidInr };
      const paymentStatus = paymentStatusOf(next);
      transitions.push({ data: inv, wasPaid: paymentStatusOf(inv) === 'paid', nowPaid: paymentStatus === 'paid' });
      tx.update(snap.ref, {
        paidInr,
        dueInr: invoiceDueInr(next),
        paymentStatus,
        paidAtMs: paymentStatus === 'paid' ? (inv.paidAtMs || null) : null,
        payments: (Array.isArray(inv.payments) ? inv.payments : []).filter((x) => x.paymentId !== paymentId),
      });
    });
    const orgUpdate = {
      ...(unallocated > 0 ? { advanceInr: advance - unallocated } : {}),
      ...applyAutoTopUpDelta(tx, orgRef, orgSnap.data(), autoTopUpDelta(transitions)),
    };
    if (orgSnap.exists && Object.keys(orgUpdate).length) tx.update(orgRef, orgUpdate);
    tx.delete(payRef);
    return { paymentId, orgId: p.orgId, reversedInr: p.amountInr };
  });
}
