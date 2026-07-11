#!/usr/bin/env node
// Controlled end-to-end test of the LIVE adminAddCredits → invoice pipeline on a throwaway org.
// Mints an admin ID token, calls the deployed callable over HTTP, verifies the minted invoice +
// linked transaction + counter, renders the invoice, then cleans EVERYTHING up — including
// restoring the invoice counter so the first REAL invoice is still SBT/<fy>/0001.
//   cd functions && node scripts/e2e-invoice-test.mjs
import { writeFileSync } from 'node:fs';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import { renderInvoiceHtml } from '../utils/invoice.js';

const PROJECT = 'mybosun-55015';
const WEB_API_KEY = 'AIzaSyBCrM6y83hiSd9XJegR6YBOU12T0djCZH8';
const CALLABLE_URL = 'https://adminaddcredits-ckrqtqwyqq-el.a.run.app';
const ADMIN_UID = 'Ms7OAjDmChSwPsLtcRCApiR4nHO2'; // vinodhec@gmail.com (on ADMIN_EMAILS)
const OUT = '/private/tmp/claude-501/-Users-maadiveedu-bosun/9d44b39e-3409-4262-ac1d-5de03b9a07fe/scratchpad/e2e-invoice.html';

const app = initializeApp({ projectId: PROJECT, serviceAccountId: `firebase-adminsdk-fbsvc@${PROJECT}.iam.gserviceaccount.com` });
const db = getFirestore(app);
const auth = getAuth(app);

const orgRef = db.collection('organisations').doc();
const counterRef = db.collection('counters').doc('invoices');
let priorCounter = null;
let result = null;

try {
  // 1. Throwaway TN-registered org (so we see CGST+SGST like a real MaadiVeedu invoice).
  await orgRef.set({
    name: 'ZZ TEST — delete me', balance: 0,
    billing: { legalName: 'TEST BUYER PVT LTD', gstin: '33TESTB1234T1Z0', state: 'Tamil Nadu',
      stateCode: '33', intraState: true, placeOfSupply: '33-Tamil Nadu', address: '1 Test Street, Chennai - 600001' },
    createdAt: FieldValue.serverTimestamp(),
  });
  console.log('created throwaway org', orgRef.id);

  // Snapshot the counter so we can restore it after (keep production numbering pristine).
  priorCounter = (await counterRef.get()).data() || {};

  // 2. Admin ID token: custom token → Identity Toolkit exchange.
  const customToken = await auth.createCustomToken(ADMIN_UID);
  const exch = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=${WEB_API_KEY}`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: customToken, returnSecureToken: true }),
  }).then((r) => r.json());
  if (!exch.idToken) throw new Error('token exchange failed: ' + JSON.stringify(exch));
  console.log('minted admin ID token');

  // 3. Call the LIVE adminAddCredits callable (₹2000 top-up).
  const res = await fetch(CALLABLE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${exch.idToken}` },
    body: JSON.stringify({ data: { orgId: orgRef.id, amount: 2000 } }),
  }).then((r) => r.json());
  if (res.error) throw new Error('callable error: ' + JSON.stringify(res.error));
  result = res.result;
  console.log('adminAddCredits →', JSON.stringify(result));

  // 4. Verify what the LIVE function wrote.
  const invSnap = await db.collection('invoices').doc(result.invoiceId).get();
  const inv = invSnap.data();
  const txQ = await db.collection('transactions').where('orgId', '==', orgRef.id).get();
  const counterNow = (await counterRef.get()).data() || {};
  console.log('\n--- VERIFY ---');
  console.log('invoice number     :', inv.number, '(fn returned', result.invoiceNumber + ')');
  console.log('taxable/cgst/sgst  :', inv.taxableInr, inv.cgstInr, inv.sgstInr, '→ total', inv.totalInr);
  console.log('credit to wallet   :', inv.creditInr, '| org balance now', result.balance);
  console.log('txn linked to inv  :', txQ.docs[0]?.data().invoiceId === result.invoiceId, '| txn type', txQ.docs[0]?.data().type);
  console.log('counter fy bump    :', JSON.stringify(counterNow));
  console.log('buyer on invoice   :', inv.buyer.legalName, inv.buyer.gstin);
  console.log('supplier on invoice:', inv.supplier.legalName, '|', inv.supplier.address ? 'address ✓' : 'NO ADDRESS');

  writeFileSync(OUT, renderInvoiceHtml(inv));
  console.log('rendered →', OUT);
} finally {
  // 5. CLEANUP — remove all test artifacts and restore the counter.
  console.log('\n--- CLEANUP ---');
  if (result?.invoiceId) { await db.collection('invoices').doc(result.invoiceId).delete(); console.log('deleted invoice'); }
  const txQ = await db.collection('transactions').where('orgId', '==', orgRef.id).get();
  for (const d of txQ.docs) await d.ref.delete();
  if (txQ.size) console.log('deleted', txQ.size, 'transaction(s)');
  await orgRef.delete(); console.log('deleted throwaway org');
  if (priorCounter !== null) { await counterRef.set(priorCounter); console.log('restored counter →', JSON.stringify(priorCounter)); }
}
process.exit(0);
