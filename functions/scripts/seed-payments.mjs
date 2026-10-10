#!/usr/bin/env node
// One-off / bulk: record payments RECEIVED from a JSON file through the exact same transaction the
// Admin panel uses (utils/receivables.js#recordPayment) — oldest-invoice-first allocation, excess
// held as the org's advance, duplicate UTRs refused. Run from functions/ with ADC:
//   node scripts/seed-payments.mjs payments.json [--dry]
// payments.json: [{ "orgId": "...", "amountInr": 6490, "receivedAt": "2026-07-13T15:07:00+05:30",
//                   "method": "upi", "reference": "UTR 352343751410", "note": "PhonePe" }, ...]
// Rows are applied in receivedAt order so allocation matches the real timeline.
import { readFileSync } from 'node:fs';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { recordPayment } from '../utils/receivables.js';
import { invoiceDueInr, paymentStatusOf } from '../utils/payments.js';

const file = process.argv[2];
const dry = process.argv.includes('--dry');
if (!file) { console.error('usage: node scripts/seed-payments.mjs payments.json [--dry]'); process.exit(1); }
const rows = JSON.parse(readFileSync(file, 'utf8'))
  .map((r) => ({ ...r, receivedAtMs: new Date(r.receivedAt).getTime() }))
  .sort((a, b) => a.receivedAtMs - b.receivedAtMs);

initializeApp({ projectId: process.env.FIREBASE_PROJECT || 'bosun-76bba' });
const db = getFirestore();

for (const r of rows) {
  const label = `${new Date(r.receivedAtMs).toISOString().slice(0, 10)} ₹${r.amountInr} ${r.reference || ''}`;
  if (dry) { console.log('DRY', label); continue; }
  try {
    const res = await recordPayment(db, { ...r, by: 'seed-payments.mjs' });
    console.log('OK ', label, '→', res.allocations.map((a) => `${a.number}:${a.amountInr}`).join(' '), res.unallocatedInr ? `advance ${res.unallocatedInr}` : '');
  } catch (e) {
    console.log('SKIP', label, '—', e.message);
  }
}

// Closing position for every org touched.
for (const orgId of new Set(rows.map((r) => r.orgId))) {
  const snap = await db.collection('invoices').where('orgId', '==', orgId).get();
  const open = snap.docs.map((d) => d.data()).filter((i) => paymentStatusOf(i) !== 'paid');
  console.log(`\n${orgId}: ${snap.size} invoices, ${snap.size - open.length} paid, ${open.length} pending, ₹${open.reduce((a, i) => a + invoiceDueInr(i), 0)} outstanding`);
  for (const i of open.sort((a, b) => a.issuedAtMs - b.issuedAtMs)) console.log('  pending', i.number, new Date(i.issuedAtMs).toISOString().slice(0, 10), '₹' + invoiceDueInr(i));
}
