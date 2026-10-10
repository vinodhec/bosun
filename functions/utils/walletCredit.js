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

  const orgFields = typeof orgExtra === 'function' ? orgExtra({ invoiceId: invRef.id, invoiceNumber: number }) : orgExtra;
  tx.update(orgRef, { balance: next, ...orgFields });
  tx.set(txnRef, {
    orgId, type: 'credit', amount, by, invoiceId: invRef.id, invoiceNumber: number,
    ...txnExtra,
    createdAt: FieldValue.serverTimestamp(),
  });
  tx.set(invoiceCounterRef(db), { [fy]: seq }, { merge: true });
  tx.set(invRef, { ...invoice, ...invoiceExtra, createdAt: FieldValue.serverTimestamp() });
  return { balance: next, invoiceId: invRef.id, invoiceNumber: number, payableInr: invoice.payableInr };
}
