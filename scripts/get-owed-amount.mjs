#!/usr/bin/env node
/**
 * Computes the total money owed by Bosun:
 * Base amount (₹80,000) + sum of invoice taxable amounts (ignoring taxes).
 *
 * Usage:
 *   node scripts/get-owed-amount.mjs [--json]
 */
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const require = createRequire(path.join(__dirname, '../functions/package.json'));
const { GoogleAuth } = require('google-auth-library');

const BASE_OWED_INR = 80000;
const PROJECT_ID = 'bosun-76bba';

async function fetchInvoices() {
  const auth = new GoogleAuth({ scopes: 'https://www.googleapis.com/auth/cloud-platform' });
  const client = await auth.getClient();
  const token = await client.getAccessToken();

  const url = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/invoices?pageSize=100`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token.token}` }
  });

  if (!res.ok) {
    throw new Error(`Firestore query failed: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  const docs = data.documents || [];

  const invoices = docs.map(d => {
    const f = d.fields || {};
    return {
      id: d.name.split('/').pop(),
      number: f.number?.stringValue || '',
      buyer: f.buyer?.mapValue?.fields?.legalName?.stringValue || '',
      taxableInr: parseInt(f.taxableInr?.integerValue || '0', 10),
      taxInr: parseInt(f.taxInr?.integerValue || '0', 10),
      totalInr: parseInt(f.totalInr?.integerValue || '0', 10),
      status: f.status?.stringValue || 'issued',
      createdAt: f.createdAt?.timestampValue || ''
    };
  });

  // Sort by invoice number / date
  invoices.sort((a, b) => a.number.localeCompare(b.number));

  const invoicesTaxableTotal = invoices.reduce((sum, inv) => sum + inv.taxableInr, 0);
  const invoicesTaxTotal = invoices.reduce((sum, inv) => sum + inv.taxInr, 0);
  const totalOwed = BASE_OWED_INR + invoicesTaxableTotal;

  return {
    baseOwedInr: BASE_OWED_INR,
    invoiceCount: invoices.length,
    invoicesTaxableTotal,
    invoicesTaxTotal,
    totalOwedInr: totalOwed,
    invoices
  };
}

async function main() {
  const isJson = process.argv.includes('--json');
  try {
    const result = await fetchInvoices();
    if (isJson) {
      console.log(JSON.stringify(result, null, 2));
      return;
    }

    console.log('====================================================');
    console.log('           BOSUN OWED AMOUNT BREAKDOWN              ');
    console.log('====================================================');
    console.log(`Base Owed Amount:              ₹${result.baseOwedInr.toLocaleString('en-IN')}`);
    console.log(`Invoices Found:                ${result.invoiceCount}`);
    console.log(`Invoices Taxable (excl taxes): ₹${result.invoicesTaxableTotal.toLocaleString('en-IN')}`);
    console.log(`Invoices Tax (GST - ignored):  ₹${result.invoicesTaxTotal.toLocaleString('en-IN')}`);
    console.log('----------------------------------------------------');
    console.log(`TOTAL OWED (Base + Taxable):   ₹${result.totalOwedInr.toLocaleString('en-IN')}`);
    console.log('====================================================\n');

    console.log('Detailed Invoices (excluding taxes):');
    console.log('No. | Invoice Number    | Buyer           | Taxable (₹) | Date');
    console.log('----+-------------------+-----------------+-------------+---------------------');
    result.invoices.forEach((inv, idx) => {
      const num = String(idx + 1).padStart(2, ' ');
      const invNum = inv.number.padEnd(17, ' ');
      const buyer = inv.buyer.padEnd(15, ' ');
      const val = String(inv.taxableInr).padStart(11, ' ');
      const date = inv.createdAt.slice(0, 10);
      console.log(`${num}  | ${invNum} | ${buyer} | ${val} | ${date}`);
    });
  } catch (err) {
    console.error('Error fetching Bosun invoices:', err);
    process.exit(1);
  }
}

main();
