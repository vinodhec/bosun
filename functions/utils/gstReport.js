// GST reports for the SOFTWARE invoice line only — the slice the CA merges with the trading
// business for the single-GSTIN return. Five reports, mirroring the set the trading business's
// accounting package produces: Sale Report, Purchase Report, GSTR-1, GSTR-2, GSTR-3B.
//
// Sales come from `invoices` (issued on every wallet top-up). Purchases come from `purchases` —
// operator-recorded vendor bills, built by utils/purchase.js, which is also where the GST
// treatment of an import of services is decided. The caller passes the rows; nothing here touches
// Firestore, so every builder below is pure and testable.
//
// The Purchase Report is handed EVERY recorded bill so a non-claimable one is visible; GSTR-2 and
// GSTR-3B are handed only the reportable ones (see purchase.js#reportablePurchases).
import { SUPPLIER } from './invoice.js';

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const num = (n) => Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const rs = (n) => `Rs ${Math.round(Number(n) || 0).toLocaleString('en-IN')}`;
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const dmy = (ms) => (ms ? new Date(ms).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' }).replace(/\//g, '-') : '');
const monthName = (d) => d.toLocaleString('en-US', { month: 'long' });

// One stylesheet + page shell for all five reports, so they print as a consistent set.
const STYLE = `
  body{font:13px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#111;max-width:1000px;margin:24px auto;padding:0 16px}
  h1{text-align:center;font-size:20px} h2{text-align:center;font-size:15px;margin:22px 0 8px}
  h3{font-size:13px;margin:18px 0 4px}
  table{width:100%;border-collapse:collapse;margin-top:6px} th,td{border:1px solid #bbb;padding:5px 7px;text-align:left;vertical-align:top}
  th{background:#f4f4f4;font-size:11px} .r{text-align:right} .meta td{border:1px solid #ccc}
  .tot{font-weight:700;background:#fafafa} .soft{color:#666;font-size:11px;text-align:center;margin-top:24px}
  .sec{background:#eee;font-weight:600} .grand{text-align:right;font-weight:700;font-size:15px;margin-top:14px}
  .nil{text-align:center;color:#888}
  @media print{body{margin:0}}`;

// The row-per-invoice reports carry 10–13 columns and will not fit A4 portrait — they print
// landscape at a smaller size so no column falls off the right edge. GSTR-3B is a narrow summary
// and stays portrait.
const WIDE = `
  @page{size:A4 landscape;margin:10mm}
  body{max-width:none;font-size:11px;margin:0}
  th,td{padding:4px 5px} th{font-size:10px}`;

const page = (title, body, wide = false) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>${STYLE}${wide ? WIDE : '@page{size:A4 portrait;margin:12mm}'}</style></head><body>${body}</body></html>`;

// The footer every report carries — states plainly what this covers and what it does not.
const FOOT = `<p class="soft">Software (SW/) invoice line only — merge with the trading-business figures for the full
  GSTIN ${esc(SUPPLIER.gstin)} return. The line's inward supplies are Anthropic API credits, an import of services:
  reverse-charge IGST payable in cash with a matching import-of-services ITC, net nil. Bills raised before the GSTIN
  reached the vendor were charged GST under its OIDAR registration and are NOT claimable — confirm the treatment with the CA.</p>`;

const periodMeta = (fromMs, toMs) => {
  const f = new Date(fromMs), t = new Date(toMs);
  return `<table class="meta"><tbody>
    <tr><td>From Year</td><td>${f.getFullYear()}</td><td>To Year</td><td>${t.getFullYear()}</td></tr>
    <tr><td>From Month</td><td>${monthName(f)}</td><td>To Month</td><td>${monthName(t)}</td></tr>
  </tbody></table>`;
};

const supplierMeta = () => `<table class="meta"><tbody>
  <tr><td>1. GSTIN:</td><td>${esc(SUPPLIER.gstin)}</td></tr>
  <tr><td>2.(a) Legal name of the registered person:</td><td>${esc(SUPPLIER.legalName)}</td></tr>
  <tr><td>(b) Trade name, if any</td><td></td></tr>
  <tr><td>3.(a) Aggregate Turnover in the preceeding Financial Year:</td><td></td></tr>
</tbody></table>`;

/** Aggregate a period's invoices into GSTR-1 shape: B2B rows individually, B2C aggregated by
 *  place-of-supply + rate, plus a returns (credit-note) table and grand totals. */
export function buildGstr1({ invoices, fromMs, toMs }) {
  const b2b = [];
  const b2cMap = new Map();
  const returns = []; // credit notes — none in the system yet
  const tot = { value: 0, taxable: 0, igst: 0, cgst: 0, sgst: 0 };
  for (const inv of invoices) {
    const value = inv.payableInr ?? inv.totalInr ?? 0;
    const taxable = inv.taxableInr ?? 0;
    const igst = inv.igstInr ?? 0, cgst = inv.cgstInr ?? 0, sgst = inv.sgstInr ?? 0;
    const rate = Math.round((inv.gstRate ?? 0.18) * 100);
    const pos = inv.buyer?.state || inv.buyer?.placeOfSupply || SUPPLIER.state;
    tot.value += value; tot.taxable += taxable; tot.igst += igst; tot.cgst += cgst; tot.sgst += sgst;
    if (inv.buyer?.gstin) {
      b2b.push({ gstin: inv.buyer.gstin, number: inv.number, dateMs: inv.issuedAtMs, value, rate, taxable, igst, cgst, sgst, pos });
    } else {
      const key = `${pos}|${rate}`;
      const a = b2cMap.get(key) || { pos, rate, value: 0, taxable: 0, igst: 0, cgst: 0, sgst: 0 };
      a.value += value; a.taxable += taxable; a.igst += igst; a.cgst += cgst; a.sgst += sgst;
      b2cMap.set(key, a);
    }
  }
  for (const k of Object.keys(tot)) tot[k] = r2(tot[k]);
  b2b.sort((x, y) => (x.dateMs || 0) - (y.dateMs || 0));
  return {
    fromMs, toMs,
    supplier: { gstin: SUPPLIER.gstin, legalName: SUPPLIER.legalName },
    b2b, b2c: [...b2cMap.values()], returns, totals: tot,
  };
}

/** Printable GSTR-1 HTML, matching the operator's existing report layout. */
export function renderGstr1Html(rep) {
  const from = new Date(rep.fromMs);
  const mon = monthName;
  const b2bRows = rep.b2b.map((r) => `<tr>
    <td>${esc(r.gstin)}</td><td>${esc(r.number)}</td><td>${dmy(r.dateMs)}</td>
    <td class="r">${num(r.value)}</td><td class="r">${r.rate}.0</td><td class="r">0.0</td>
    <td class="r">${num(r.taxable)}</td><td class="r">${num(r.igst)}</td><td class="r">${num(r.cgst)}</td>
    <td class="r">${num(r.sgst)}</td><td class="r">0.0</td><td>${esc(r.pos)}</td></tr>`).join('');
  const b2cRows = rep.b2c.map((r) => `<tr>
    <td>${esc(r.pos)}</td><td class="r">${r.rate}.0</td><td class="r">${num(r.taxable)}</td>
    <td class="r">${num(r.igst)}</td><td class="r">${num(r.cgst)}</td><td class="r">${num(r.sgst)}</td></tr>`).join('');
  const t = rep.totals;
  return page(`GSTR-1 ${mon(from)} ${from.getFullYear()}`, `
  <h1>GSTR 1 Report — Software line</h1>
  ${periodMeta(rep.fromMs, rep.toMs)}
  ${supplierMeta()}
  <h2>B2B — Sale (outward supplies to registered persons)</h2>
  <table><thead><tr>
    <th>GSTIN/UIN No.</th><th>Inv No.</th><th>Date</th><th>Value</th><th>Rate</th><th>CESS Rate</th>
    <th>Taxable Value</th><th>Integrated Tax</th><th>Central Tax</th><th>State/UT Tax</th><th>CESS</th><th>Place Of Supply</th>
  </tr></thead><tbody>
    ${b2bRows || `<tr><td colspan="12" style="text-align:center;color:#888">No B2B invoices in this period</td></tr>`}
    <tr class="tot"><td colspan="3">Totals</td><td class="r">${num(t.value)}</td><td colspan="2"></td>
      <td class="r">${num(t.taxable)}</td><td class="r">${num(t.igst)}</td><td class="r">${num(t.cgst)}</td>
      <td class="r">${num(t.sgst)}</td><td class="r">0.0</td><td></td></tr>
  </tbody></table>
  ${rep.b2c.length ? `<h2>B2C — Sale (unregistered, aggregated)</h2>
  <table><thead><tr><th>Place Of Supply</th><th>Rate</th><th>Taxable Value</th><th>Integrated Tax</th><th>Central Tax</th><th>State/UT Tax</th></tr></thead>
  <tbody>${b2cRows}</tbody></table>` : ''}
  <h2>Sale Return (credit notes)</h2>
  <table><thead><tr><th>Return No.</th><th>Date</th><th>Inv No.</th><th>Taxable Value</th><th>Total Tax</th></tr></thead>
  <tbody><tr class="tot"><td colspan="3">Totals</td><td class="r">0.00</td><td class="r">0.00</td></tr></tbody></table>
  ${FOOT}`, true);
}

/* ------------------------------------------------------------------ Sale Report (day book) */

/** The plain sales day book: one row per invoice, newest first, with the money received against
 *  it. A top-up invoice is issued at the moment credits are granted, and credits are granted on
 *  payment — so an issued invoice counts as received unless it carries an explicit `paidInr`. */
export function buildSaleReport({ invoices, fromMs, toMs }) {
  const rows = invoices
    .map((inv) => {
      const total = inv.payableInr ?? inv.totalInr ?? 0;
      const received = inv.paidInr ?? total;
      return {
        dateMs: inv.issuedAtMs,
        ref: inv.number,
        party: inv.buyer?.legalName || 'Customer',
        gstin: inv.buyer?.gstin || null,
        txnType: 'Sale',
        dueMs: inv.dueAtMs ?? inv.issuedAtMs,
        total,
        received,
        balance: r2(total - received),
      };
    })
    .sort((a, b) => (b.dateMs || 0) - (a.dateMs || 0));
  const totals = rows.reduce(
    (a, r) => ({ total: a.total + r.total, received: a.received + r.received, balance: a.balance + r.balance }),
    { total: 0, received: 0, balance: 0 },
  );
  for (const k of Object.keys(totals)) totals[k] = r2(totals[k]);
  return { fromMs, toMs, rows, totals };
}

/** Printable Sale Report — the trading business's day-book layout. */
export function renderSaleReportHtml(rep) {
  const pay = `ICICI C/A ${SUPPLIER.bank.account}`;
  const body = rep.rows.map((r) => `<tr>
    <td>${dmy(r.dateMs)}</td><td>${esc(r.ref)}</td><td>${esc(r.party)}</td>
    <td>${esc(r.gstin || '—')}</td><td>${esc(r.txnType)}</td><td>${dmy(r.dueMs)}</td>
    <td class="r">${rs(r.total)}</td><td>${esc(pay)}</td>
    <td class="r">${rs(r.received)}</td><td class="r">${rs(r.balance)}</td></tr>`).join('');
  return page(`Sale Report ${dmy(rep.fromMs)} – ${dmy(rep.toMs)}`, `
  <h1>Sale Report — Software line</h1>
  <h3 style="text-align:center">Duration: From ${dmy(rep.fromMs)} to ${dmy(rep.toMs)}</h3>
  <h2>Sale</h2>
  <table><thead><tr>
    <th>Date</th><th>Ref No.</th><th>Party Name</th><th>Party's GSTIN No.</th><th>Txn Type</th>
    <th>Due Date</th><th class="r">Total Amount</th><th>Payment Type</th>
    <th class="r">Received/Paid Amount</th><th class="r">Balance Amount</th>
  </tr></thead><tbody>
    ${body || `<tr><td colspan="10" class="nil">No sales in this period</td></tr>`}
  </tbody></table>
  <p class="grand">Total Sale: ${rs(rep.totals.total)}</p>
  <p class="grand" style="font-size:13px;font-weight:400">Received: ${rs(rep.totals.received)} · Outstanding: ${rs(rep.totals.balance)}</p>
  ${FOOT}`, true);
}

/* ------------------------------------------------------------ Purchase Report + GSTR-2 (inward) */

/** Inward supplies. `purchases` is empty until vendor bills are recorded (see the file header) —
 *  the builder is written for the real shape so filling it later needs no layout change. */
export function buildPurchaseReport({ purchases = [], fromMs, toMs }) {
  const rows = purchases
    .map((p) => {
      const total = p.value ?? r2((p.taxableInr || 0) + (p.igstInr || 0) + (p.cgstInr || 0) + (p.sgstInr || 0));
      const paid = p.paidInr ?? total;
      return {
        dateMs: p.dateMs, ref: p.number || '', party: p.supplierName || '',
        gstin: p.supplierGstin || p.supplierTaxId || null, txnType: 'Purchase', dueMs: p.dueAtMs ?? p.dateMs,
        total, paid, balance: r2(total - paid),
        treatment: p.gstTreatment || 'domestic',
        foreign: p.currency && p.currency !== 'INR' ? `${p.currency} ${num(p.amountForeign)}` : null,
      };
    })
    .sort((a, b) => (b.dateMs || 0) - (a.dateMs || 0));
  const totals = rows.reduce(
    (a, r) => ({ total: a.total + r.total, paid: a.paid + r.paid, balance: a.balance + r.balance }),
    { total: 0, paid: 0, balance: 0 },
  );
  for (const k of Object.keys(totals)) totals[k] = r2(totals[k]);
  return { fromMs, toMs, rows, totals };
}

// How each GST treatment is explained on the Purchase Report, so a bill that is recorded but
// deliberately kept out of GSTR-2/3B says WHY on its own row.
const TREATMENT_LABEL = {
  rcm: 'Reverse charge — IGST payable by us, claimed back as import-of-services ITC',
  oidar_charged: 'OIDAR — supplier charged GST, NOT claimable, excluded from the return',
  domestic: 'Domestic supplier — normal ITC',
  refunded: 'Cancelled / refunded — no supply, excluded from the return',
};

export function renderPurchaseReportHtml(rep) {
  const body = rep.rows.map((r) => `<tr>
    <td>${dmy(r.dateMs)}</td><td>${esc(r.ref)}</td><td>${esc(r.party)}</td>
    <td>${esc(r.gstin || '—')}</td><td>${esc(r.foreign || '—')}</td><td>${dmy(r.dueMs)}</td>
    <td class="r">${rs(r.total)}</td><td class="r">${rs(r.paid)}</td><td class="r">${rs(r.balance)}</td>
    <td style="font-size:11px">${esc(TREATMENT_LABEL[r.treatment] || r.treatment)}</td></tr>`).join('');
  return page(`Purchase Report ${dmy(rep.fromMs)} – ${dmy(rep.toMs)}`, `
  <h1>Purchase Report — Software line</h1>
  <h3 style="text-align:center">Duration: From ${dmy(rep.fromMs)} to ${dmy(rep.toMs)}</h3>
  <h2>Purchase</h2>
  <table><thead><tr>
    <th>Date</th><th>Ref No.</th><th>Party Name</th><th>Party's Tax ID</th><th>Foreign Value</th>
    <th>Due Date</th><th class="r">Total Amount</th><th class="r">Paid Amount</th><th class="r">Balance Amount</th>
    <th>GST treatment</th>
  </tr></thead><tbody>
    ${body || `<tr><td colspan="10" class="nil">NIL — no purchase bills recorded for the software line in this period</td></tr>`}
  </tbody></table>
  <p class="grand">Total Purchase: ${rs(rep.totals.total)}</p>
  <p class="soft" style="text-align:left">This report lists EVERY recorded bill. Only rows marked
  &ldquo;reverse charge&rdquo; or &ldquo;domestic supplier&rdquo; carry into GSTR-2 and GSTR-3B — the rest are shown
  so their absence from the return is visible rather than silent.</p>
  ${FOOT}`, true);
}

/** GSTR-2 shape: inward supplies row-per-bill plus purchase returns, with totals. */
export function buildGstr2({ purchases = [], fromMs, toMs }) {
  const rows = purchases.map((p) => ({
    gstin: p.supplierGstin || p.supplierTaxId || null,
    number: p.number || '',
    dateMs: p.dateMs,
    value: p.value ?? r2((p.taxableInr || 0) + (p.igstInr || 0) + (p.cgstInr || 0) + (p.sgstInr || 0)),
    reverseCharge: !!p.reverseCharge,
    rate: Math.round((p.gstRate ?? 0.18) * 100),
    taxable: p.taxableInr || 0,
    igst: p.igstInr || 0, cgst: p.cgstInr || 0, sgst: p.sgstInr || 0,
    pos: p.pos || SUPPLIER.state,
  })).sort((a, b) => (a.dateMs || 0) - (b.dateMs || 0));
  const totals = rows.reduce(
    (a, r) => ({
      value: a.value + r.value, taxable: a.taxable + r.taxable,
      igst: a.igst + r.igst, cgst: a.cgst + r.cgst, sgst: a.sgst + r.sgst,
    }),
    { value: 0, taxable: 0, igst: 0, cgst: 0, sgst: 0 },
  );
  for (const k of Object.keys(totals)) totals[k] = r2(totals[k]);
  return { fromMs, toMs, supplier: { gstin: SUPPLIER.gstin, legalName: SUPPLIER.legalName }, rows, totals };
}

export function renderGstr2Html(rep) {
  const from = new Date(rep.fromMs);
  const body = rep.rows.map((r) => `<tr>
    <td>${esc(r.gstin || '—')}</td><td>${esc(r.number)}</td><td>${dmy(r.dateMs)}</td>
    <td class="r">${num(r.value)}</td><td>${r.reverseCharge ? 'Yes' : 'No'}</td><td class="r">${r.rate}.0</td>
    <td class="r">0.0</td><td class="r">${num(r.taxable)}</td><td class="r">${num(r.igst)}</td>
    <td class="r">${num(r.cgst)}</td><td class="r">${num(r.sgst)}</td><td class="r">0.0</td>
    <td>${esc(r.pos)}</td></tr>`).join('');
  const t = rep.totals;
  return page(`GSTR-2 ${monthName(from)} ${from.getFullYear()}`, `
  <h1>GSTR 2 Report — Software line</h1>
  ${periodMeta(rep.fromMs, rep.toMs)}
  ${supplierMeta()}
  <h2>Purchase</h2>
  <table><thead><tr>
    <th>GSTIN/UIN No.</th><th>Inv No.</th><th>Date</th><th>Value</th><th>Reverse Charge</th><th>Rate</th>
    <th>CESS Rate</th><th>Taxable Value</th><th>Integrated Tax</th><th>Central Tax</th><th>State/UT Tax</th>
    <th>CESS</th><th>Place Of Supply</th>
  </tr></thead><tbody>
    ${body || `<tr><td colspan="13" class="nil">NIL — no inward supply bills recorded for the software line in this period</td></tr>`}
    <tr class="tot"><td colspan="3">Totals</td><td class="r">${num(t.value)}</td><td colspan="3"></td>
      <td class="r">${num(t.taxable)}</td><td class="r">${num(t.igst)}</td><td class="r">${num(t.cgst)}</td>
      <td class="r">${num(t.sgst)}</td><td class="r">0.0</td><td></td></tr>
  </tbody></table>
  <h2>Purchase Return (debit notes)</h2>
  <table><thead><tr><th>Return No.</th><th>Date</th><th>Inv No.</th><th>Taxable Value</th><th>Total Tax</th></tr></thead>
  <tbody><tr class="tot"><td colspan="3">Totals</td><td class="r">0.00</td><td class="r">0.00</td></tr></tbody></table>
  ${FOOT}`, true);
}

/* ------------------------------------------------------------------------------- GSTR-3B */

/** GSTR-3B summary. Section 1 and 2 come from the sales invoices; section 3 (ITC) and the
 *  reverse-charge line in 1(d) come from `purchases`, which is empty today — so the ITC block
 *  prints as zeros rather than as a claim we cannot substantiate. */
export function buildGstr3b({ invoices, purchases = [], fromMs, toMs }) {
  const out = { taxable: 0, igst: 0, cgst: 0, sgst: 0 };
  const interStateB2C = new Map(); // POS → { taxable, igst }
  for (const inv of invoices) {
    out.taxable += inv.taxableInr ?? 0;
    out.igst += inv.igstInr ?? 0;
    out.cgst += inv.cgstInr ?? 0;
    out.sgst += inv.sgstInr ?? 0;
    // 3B section 2 wants inter-state supplies to UNREGISTERED persons, broken out by POS.
    if (!inv.buyer?.gstin && (inv.igstInr ?? 0) > 0) {
      const pos = inv.buyer?.state || inv.buyer?.placeOfSupply || '—';
      const a = interStateB2C.get(pos) || { pos, taxable: 0, igst: 0 };
      a.taxable += inv.taxableInr ?? 0;
      a.igst += inv.igstInr ?? 0;
      interStateB2C.set(pos, a);
    }
  }
  // Inward supplies liable to reverse charge (3.1(d)) and the matching import-of-services ITC.
  const rcm = { taxable: 0, igst: 0, cgst: 0, sgst: 0 };
  const itcImportServices = { igst: 0, cgst: 0, sgst: 0 };
  const itcOther = { igst: 0, cgst: 0, sgst: 0 };
  for (const p of purchases) {
    const bucket = p.reverseCharge ? rcm : null;
    if (bucket) {
      bucket.taxable += p.taxableInr || 0;
      bucket.igst += p.igstInr || 0; bucket.cgst += p.cgstInr || 0; bucket.sgst += p.sgstInr || 0;
    }
    const itc = p.importOfServices ? itcImportServices : itcOther;
    itc.igst += p.igstInr || 0; itc.cgst += p.cgstInr || 0; itc.sgst += p.sgstInr || 0;
  }
  const round = (o) => { for (const k of Object.keys(o)) o[k] = r2(o[k]); return o; };
  return {
    fromMs, toMs,
    supplier: { gstin: SUPPLIER.gstin, legalName: SUPPLIER.legalName },
    outward: round(out),
    interStateB2C: [...interStateB2C.values()].map(round),
    rcm: round(rcm),
    itc: { importServices: round(itcImportServices), other: round(itcOther) },
    invoiceCount: invoices.length,
  };
}

export function renderGstr3bHtml(rep) {
  const from = new Date(rep.fromMs);
  const o = rep.outward, rc = rep.rcm, itcS = rep.itc.importServices, itcO = rep.itc.other;
  const zero = `<td class="r">0.00</td><td class="r">0.00</td><td class="r">0.00</td><td class="r">0.00</td>`;
  const posRows = rep.interStateB2C.map((r) => `<tr>
    <td>${esc(r.pos)}</td><td class="r">${num(r.taxable)}</td><td class="r">${num(r.igst)}</td>
    <td class="r">0.00</td><td class="r">0.00</td><td class="r">0.00</td><td class="r">0.00</td></tr>`).join('');
  return page(`GSTR-3B ${monthName(from)} ${from.getFullYear()}`, `
  <h1>GSTR-3B Report — Software line</h1>
  ${periodMeta(rep.fromMs, rep.toMs)}
  ${supplierMeta()}

  <h3>1. Details of outward supplies and Inward supplies liable to reverse charge</h3>
  <table><thead><tr>
    <th>Nature of Supplies</th><th class="r">Total taxable value</th><th class="r">Integrated Tax</th>
    <th class="r">Central Tax</th><th class="r">State/UT Tax</th><th class="r">CESS</th>
  </tr></thead><tbody>
    <tr><td>(a) Outward taxable supplies (other than zero rated, nil rated and exempted)</td>
      <td class="r">${num(o.taxable)}</td><td class="r">${num(o.igst)}</td>
      <td class="r">${num(o.cgst)}</td><td class="r">${num(o.sgst)}</td><td class="r">0.00</td></tr>
    <tr><td>(b) Outward taxable supplies (zero rated)</td>${zero}<td class="r">0.00</td></tr>
    <tr><td>(c) Other outward supplies (nil rated, exempted)</td>${zero}<td class="r">0.00</td></tr>
    <tr><td>(d) Inward supplies (liable to reverse charge)</td>
      <td class="r">${num(rc.taxable)}</td><td class="r">${num(rc.igst)}</td>
      <td class="r">${num(rc.cgst)}</td><td class="r">${num(rc.sgst)}</td><td class="r">0.00</td></tr>
    <tr><td>(e) Non-GST outward supplies</td>${zero}<td class="r">0.00</td></tr>
  </tbody></table>

  <h3>2. Details of Inter-State supplies made to unregistered persons, composition dealers and UIN holders</h3>
  <table><thead><tr>
    <th>Place of Supply (State/UT)</th><th class="r">Unregistered — Taxable Value</th><th class="r">Unregistered — IGST</th>
    <th class="r">Composition — Taxable Value</th><th class="r">Composition — IGST</th>
    <th class="r">UIN — Taxable Value</th><th class="r">UIN — IGST</th>
  </tr></thead><tbody>
    ${posRows || `<tr><td colspan="7" class="nil">None — all outward supplies in this period are intra-State</td></tr>`}
  </tbody></table>

  <h3>3. Details of eligible Input Tax Credit</h3>
  <table><thead><tr>
    <th>Details</th><th class="r">Integrated Tax</th><th class="r">Central Tax</th><th class="r">State/UT Tax</th><th class="r">CESS</th>
  </tr></thead><tbody>
    <tr class="sec"><td colspan="5">(A) ITC Available (whether in full or part)</td></tr>
    <tr><td>(1) Import of goods</td><td class="r">0.00</td><td class="r">0.00</td><td class="r">0.00</td><td class="r">0.00</td></tr>
    <tr><td>(2) Import of services</td>
      <td class="r">${num(itcS.igst)}</td><td class="r">${num(itcS.cgst)}</td><td class="r">${num(itcS.sgst)}</td><td class="r">0.00</td></tr>
    <tr><td>(3) Inward supplies liable to reverse charge (other than 1 &amp; 2 above)</td>
      <td class="r">0.00</td><td class="r">0.00</td><td class="r">0.00</td><td class="r">0.00</td></tr>
    <tr><td>(4) Inward supplies from ISD</td><td class="r">0.00</td><td class="r">0.00</td><td class="r">0.00</td><td class="r">0.00</td></tr>
    <tr><td>(5) All other ITC</td>
      <td class="r">${num(itcO.igst)}</td><td class="r">${num(itcO.cgst)}</td><td class="r">${num(itcO.sgst)}</td><td class="r">0.00</td></tr>
    <tr class="sec"><td colspan="5">(D) Ineligible ITC</td></tr>
    <tr><td>(1) As per section 17(5)</td><td class="r">0.00</td><td class="r">0.00</td><td class="r">0.00</td><td class="r">0.00</td></tr>
    <tr><td>(2) Others</td><td class="r">0.00</td><td class="r">0.00</td><td class="r">0.00</td><td class="r">0.00</td></tr>
  </tbody></table>

  <h3>4. Details of exempt, nil-rated and non-GST inward supplies</h3>
  <table><thead><tr>
    <th>Nature of Supplies</th><th class="r">Inter-State Supplies</th><th class="r">Intra-State Supplies</th>
  </tr></thead><tbody>
    <tr><td>From a supplier under composition scheme, exempt and nil rated supply</td><td class="r">0.00</td><td class="r">0.00</td></tr>
    <tr><td>Non GST supply</td><td class="r">0.00</td><td class="r">0.00</td></tr>
  </tbody></table>
  ${FOOT}`);
}

/* ------------------------------------------------------------------------------ dispatch */

/** kind → { label, build, render, needs } — the one place admin.js dispatches on. */
export const GST_REPORTS = {
  sale:      { label: 'Sale Report',     build: buildSaleReport,     render: renderSaleReportHtml },
  purchase:  { label: 'Purchase Report', build: buildPurchaseReport, render: renderPurchaseReportHtml },
  gstr1:     { label: 'GSTR-1',          build: buildGstr1,          render: renderGstr1Html },
  gstr2:     { label: 'GSTR-2',          build: buildGstr2,          render: renderGstr2Html },
  gstr3b:    { label: 'GSTR-3B',         build: buildGstr3b,         render: renderGstr3bHtml },
};
