// The ONE way credits land in an org wallet: balance bump + `credit` transaction + gapless SW/
// tax invoice, all inside the caller's Firestore transaction. Shared by the operator's
// adminAddCredits and the auto top-up trigger so the invoice/ledger logic is never forked.
import { FieldValue } from 'firebase-admin/firestore';
import { financialYear, formatInvoiceNumber, buildInvoiceRecord } from './invoice.js';

export const invoiceCounterRef = (db) => db.collection('counters').doc('invoices');

/**
 * Writes only — Firestore needs every read before any write, so the caller reads the org
 * (`org` = its data) and the invoice counter (`counterSnap`) first.
 * `txnExtra` / `invoiceExtra` / `orgExtra` are merged into the transaction doc, the invoice doc
 * and the org update respectively; `orgExtra` may be a function of `{ invoiceId, invoiceNumber }`.
 */
export function writeWalletCredit(tx, {
  db, orgId, org, counterSnap, amount, by, txnExtra = {}, invoiceExtra = {}, orgExtra = {},
}) {
  const orgRef = db.collection('organisations').doc(orgId);
  const txnRef = db.collection('transactions').doc();
  const invRef = db.collection('invoices').doc();
  const next = Number(org.balance ?? 0) + amount;

  // Gapless per-financial-year invoice number, allocated atomically with the credit.
  const fy = financialYear();
  const seq = Number(counterSnap.get(fy) ?? 0) + 1;
  const number = formatInvoiceNumber(fy, seq);
  // The wallet is credited `amount`; the invoice adds the platform fee ON TOP (buildInvoiceRecord),
  // so the customer pays credit + fee + GST while only `amount` lands in the wallet balance below.
  const invoice = buildInvoiceRecord({
    org, orgId, creditInr: amount, number, fy, seq, txnId: txnRef.id, by,
  });
  // Money the customer paid EARLIER than we invoiced (a combined payment that overshot the open
  // invoices, see utils/receivables.js) sits on the org as `advanceInr` and is applied to this
  // invoice at issue time, so it can be born partly or fully paid.
  const advance = Math.max(0, Math.round(Number(org.advanceInr ?? 0)));
  const advanceAppliedInr = Math.min(advance, invoice.payableInr);
  if (advanceAppliedInr > 0) {
    invoice.paidInr = advanceAppliedInr;
    invoice.dueInr = invoice.payableInr - advanceAppliedInr;
    invoice.paymentStatus = invoice.dueInr === 0 ? 'paid' : 'partial';
    invoice.paidAtMs = invoice.dueInr === 0 ? invoice.issuedAtMs : null;
    invoice.payments = [{ paymentId: null, source: 'advance', amountInr: advanceAppliedInr, receivedAtMs: invoice.issuedAtMs }];
  }
  // `invoiceExtra` must not undo the advance: a caller asking for 'unpaid' gets the computed status.
  const { paymentStatus: _ignored, ...extra } = invoiceExtra;

  const orgFields = typeof orgExtra === 'function'
    ? orgExtra({ invoiceId: invRef.id, invoiceNumber: number, paymentStatus: invoice.paymentStatus, advanceAppliedInr })
    : orgExtra;
  tx.update(orgRef, { balance: next, ...(advanceAppliedInr > 0 ? { advanceInr: advance - advanceAppliedInr } : {}), ...orgFields });
  tx.set(txnRef, {
    orgId, type: 'credit', amount, by, invoiceId: invRef.id, invoiceNumber: number,
    ...txnExtra,
    createdAt: FieldValue.serverTimestamp(),
  });
  tx.set(invoiceCounterRef(db), { [fy]: seq }, { merge: true });
  tx.set(invRef, { ...invoice, ...extra, createdAt: FieldValue.serverTimestamp() });
  return { balance: next, invoiceId: invRef.id, invoiceNumber: number, payableInr: invoice.payableInr, paymentStatus: invoice.paymentStatus, advanceAppliedInr };
}
