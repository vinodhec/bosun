// Auto top-up trigger. Fires on EVERY org update, so the ~dozen debit paths (finalize, sourcing,
// metered lanes, assistant, reels, planning…) need no changes — whichever one pulls the balance
// under the org's threshold, this notices. See utils/autoTopUp.js for the config + guards.
import { onDocumentUpdated } from 'firebase-functions/v2/firestore';
import { getFirestore } from 'firebase-admin/firestore';
import { autoTopUpDecision, AUTO_TOPUP_BY } from '../utils/autoTopUp.js';
import { writeWalletCredit, invoiceCounterRef } from '../utils/walletCredit.js';

const REGION = 'asia-south1';

export const autoTopUpOnBalance = onDocumentUpdated(
  { document: 'organisations/{orgId}', region: REGION, retry: false },
  async (event) => {
    const after = event.data?.after?.data();
    // Cheap pre-check outside the transaction — the vast majority of org writes stop here.
    if (!after?.autoTopUp?.enabled || !autoTopUpDecision(after).fire) return;

    const result = await runAutoTopUp(getFirestore(), event.params.orgId);
    if (result) {
      console.log(`autoTopUp: org ${event.params.orgId} +₹${result.amountInr} → ₹${result.balance} (${result.invoiceNumber}, unpaid)`);
    }
  },
);

/** One guarded auto top-up for `orgId`, or null if a guard says no. Exported for the validator. */
export async function runAutoTopUp(db, orgId) {
  const orgRef = db.collection('organisations').doc(orgId);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(orgRef);
    if (!snap.exists) return null;
    const org = snap.data();
    // Re-decide on the transaction's read: concurrent/redelivered triggers serialize on the org
    // doc, and the first one's state bump (unpaid / monthCount) makes the rest see a guard.
    const d = autoTopUpDecision(org);
    if (!d.fire) return null;
    const counterSnap = await tx.get(invoiceCounterRef(db));

    const st = org.autoTopUpState || {};
    const nowMs = Date.now();
    const reason = `Auto top-up (balance ₹${Math.round(Number(org.balance ?? 0))} fell below ₹${org.autoTopUp.thresholdInr})`;
    const res = writeWalletCredit(tx, {
      db, orgId, org, counterSnap, amount: d.amountInr, by: AUTO_TOPUP_BY,
      txnExtra: { source: 'auto_topup', description: reason },
      invoiceExtra: { source: 'auto_topup' },
      // The invoice is born unpaid unless an advance held on the org settled it (walletCredit.js);
      // only an OPEN invoice counts against `maxUnpaid`. Recording the payment later
      // (utils/receivables.js) is what decrements these counters.
      orgExtra: ({ invoiceId, invoiceNumber, paymentStatus }) => ({
        autoTopUpState: {
          unpaid: (Number(st.unpaid) || 0) + (paymentStatus === 'paid' ? 0 : 1),
          unpaidCreditInr: (Number(st.unpaidCreditInr) || 0) + (paymentStatus === 'paid' ? 0 : d.amountInr),
          month: d.month,
          monthCount: d.monthCount + 1,
          lastAtMs: nowMs,
          lastInvoiceId: invoiceId,
          lastInvoiceNumber: invoiceNumber,
        },
      }),
    });
    return { ...res, amountInr: d.amountInr };
  });
}
