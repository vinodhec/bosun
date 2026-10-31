#!/usr/bin/env node
// Auditor pack: every SW/ invoice as PDF, the five GST reports per month (+ whole period), and CSV
// registers of invoices / purchases / payments. Read-only against Firestore.
//   cd functions && node scripts/export-audit-pack.mjs <outDir> [YYYY-MM]   (month = that IST month only)
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { renderInvoiceHtml } from '../utils/invoice.js';
import { GST_REPORTS } from '../utils/gstReport.js';
import { reportablePurchases } from '../utils/purchase.js';

const OUT = process.argv[2];
const MONTH = process.argv[3];
if (!OUT) { console.error('usage: export-audit-pack.mjs <outDir>'); process.exit(1); }
const CHROME = `${process.env.HOME}/.cache/ms-playwright/chromium-1243/chrome-linux-arm64/chrome`;

const db = getFirestore(initializeApp({ projectId: 'bosun-76bba' }));
const [invSnap, purSnap, paySnap] = await Promise.all([
  db.collection('invoices').orderBy('issuedAtMs').get(),
  db.collection('purchases').orderBy('dateMs').get(),
  db.collection('payments').get(),
]);
const ist = (ms) => new Date(ms + 5.5 * 3600e3).toISOString().slice(0, 10);
const inMonth = (ms) => !MONTH || (ms && ist(ms).slice(0, 7) === MONTH);
const invoices = invSnap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((i) => inMonth(i.issuedAtMs));
const purchases = purSnap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((p) => inMonth(p.dateMs));
const payments = paySnap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((p) => inMonth(p.receivedAtMs));
console.log(`invoices ${invoices.length}, purchases ${purchases.length}, payments ${payments.length}`);

const tmp = join(OUT, '.html'); mkdirSync(tmp, { recursive: true });
const toPdf = (html, pdfPath) => {
  const h = join(tmp, 'p.html'); writeFileSync(h, html);
  execFileSync(CHROME, ['--headless', '--no-sandbox', '--disable-gpu', '--no-pdf-header-footer',
    `--print-to-pdf=${pdfPath}`, `file://${h}`], { stdio: 'ignore' });
};
const safe = (s) => String(s || '').replace(/[\/\\:*?"<>|]/g, '-').trim();

// 1. Invoices
const invDir = join(OUT, '01 Sales invoices'); mkdirSync(invDir, { recursive: true });
for (const inv of invoices) toPdf(renderInvoiceHtml(inv), join(invDir, `${safe(inv.number)} ${safe(inv.buyer?.legalName)}.pdf`));

// 2. GST reports — per IST month across the data, plus the whole period.
const allMs = [...invoices.map((i) => i.issuedAtMs), ...purchases.map((p) => p.dateMs)].filter(Boolean);
const first = MONTH || ist(Math.min(...allMs)).slice(0, 7), last = MONTH || ist(Date.now()).slice(0, 7);
const months = [];
for (let [y, m] = first.split('-').map(Number); `${y}-${String(m).padStart(2, '0')}` <= last; m === 12 ? (y++, m = 1) : m++) months.push([y, m]);
const runReports = (dir, fromMs, toMs) => {
  mkdirSync(dir, { recursive: true });
  const inv = invoices.filter((i) => i.issuedAtMs >= fromMs && i.issuedAtMs <= toMs);
  const pur = purchases.filter((p) => p.dateMs >= fromMs && p.dateMs <= toMs);
  for (const [kind, spec] of Object.entries(GST_REPORTS)) {
    const report = spec.build({ invoices: inv, purchases: kind === 'purchase' ? pur : reportablePurchases(pur), fromMs, toMs });
    toPdf(spec.render(report), join(dir, `${spec.label}.pdf`));
  }
};
const gstDir = join(OUT, '02 GST reports');
for (const [y, m] of months) {
  const mm = String(m).padStart(2, '0');
  const fromMs = Date.parse(`${y}-${mm}-01T00:00:00+05:30`);
  const toMs = Date.parse(`${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}-01T00:00:00+05:30`) - 1;
  runReports(join(gstDir, `${y}-${mm}`), fromMs, toMs);
}
if (!MONTH) runReports(join(gstDir, `Whole period ${first} to ${last}`), Date.parse(`${first}-01T00:00:00+05:30`), Date.now());

// 3. Registers
const csv = (rows, cols) => [cols.join(','), ...rows.map((r) => cols.map((c) => {
  const v = r[c] ?? ''; const s = String(v); return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}).join(','))].join('\n') + '\n';
const regDir = join(OUT, '03 Registers'); mkdirSync(regDir, { recursive: true });
writeFileSync(join(regDir, 'Sales invoice register.csv'), csv(invoices.map((i) => ({
  number: i.number, date: ist(i.issuedAtMs), buyer: i.buyer?.legalName, buyerGstin: i.buyer?.gstin,
  placeOfSupply: i.buyer?.placeOfSupply, taxableInr: i.taxableInr, cgstInr: i.cgstInr, sgstInr: i.sgstInr,
  igstInr: i.igstInr, taxInr: i.taxInr, totalInr: i.payableInr ?? i.totalInr, status: i.status || 'issued',
  source: i.source || 'manual', paidInr: i.paidInr ?? 0, paymentStatus: i.paymentStatus || 'unpaid',
})), ['number', 'date', 'buyer', 'buyerGstin', 'placeOfSupply', 'taxableInr', 'cgstInr', 'sgstInr', 'igstInr', 'taxInr', 'totalInr', 'status', 'source', 'paidInr', 'paymentStatus']));
writeFileSync(join(regDir, 'Purchase register.csv'), csv(purchases.map((p) => ({ ...p, date: ist(p.dateMs) })),
  ['date', 'supplierName', 'supplierTaxId', 'country', 'number', 'currency', 'amountForeign', 'taxableInr', 'gstTreatment', 'gstRate', 'reverseCharge', 'igstInr', 'cgstInr', 'sgstInr', 'supplierTaxInr', 'value', 'notes']));
writeFileSync(join(regDir, 'Payments received.csv'), csv(payments.sort((a, b) => (a.receivedAtMs || 0) - (b.receivedAtMs || 0)).map((p) => ({
  ...p, buyer: invoices.find((i) => i.orgId === p.orgId)?.buyer?.legalName || p.orgId, date: p.receivedAtMs ? ist(p.receivedAtMs) : '', allocations: (p.allocations || []).map((a) => `${a.number || a.invoiceId}:${a.amountInr}`).join(' | '),
})), ['date', 'buyer', 'amountInr', 'method', 'reference', 'allocations', 'unallocatedInr', 'note']));
rmSync(tmp, { recursive: true });
console.log(`months ${first} → ${last}`);
