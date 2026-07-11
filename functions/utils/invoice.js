// GST tax-invoice helpers. A wallet top-up (adminAddCredits) issues ONE tax invoice for the
// credited amount as taxable value + 18% GST (see shared/billing.js#gstBreakdown). Pure helpers
// only — the atomic Firestore reads/writes (counter + invoice doc) live in admin.js so they run
// inside the same transaction as the credit. Invoices are backend-only writes (cardinal rule).
import { gstBreakdown, INVOICE_SAC_CODE, OUTPUT_GST_RATE } from '../shared/billing.js';

// The GST-registered supplier. Invoices show THIS legal name only — never the "Bosun" brand.
// NOTE: `address` is legally required on a tax invoice — fill the real registered address before
// issuing invoices to customers (placeholder kept explicit so it can't ship unnoticed).
export const SUPPLIER = {
  legalName: 'SRI BALAMURUGAN TRADERS',
  proprietor: 'THANGAVEL S',
  gstin: '33ACJPT9393A1ZC',
  stateCode: '33',
  state: 'Tamil Nadu',
  address: '96 N.M.K Compound, Old Karur Road, opp PWD office, Konavaikkal, Erode, Tamil Nadu - 638002',
  pincode: '638002',
  phone: '9443025052, 9443125052',
  bank: { name: 'ICICI Bank', account: '606205039174', ifsc: 'ICIC0006062' },
};

const INVOICE_PREFIX = 'SBT'; // Sri BalaMurugan Traders

/** Indian financial year label for a date: Apr 1–Mar 31 → 'YYYY-YY' (e.g. 2026-27). */
export function financialYear(date = new Date()) {
  const y = date.getFullYear();
  const startYear = date.getMonth() >= 3 ? y : y - 1; // months are 0-based; 3 = April
  return `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
}

/** Gapless per-FY invoice number, e.g. SBT/2026-27/0001. */
export function formatInvoiceNumber(fy, seq) {
  return `${INVOICE_PREFIX}/${fy}/${String(seq).padStart(4, '0')}`;
}

/** Buyer block from an org's billing profile (see organisations/{id}.billing), or an
 *  unregistered fallback using the org name. Determines intra- vs inter-state. */
export function buyerFromOrg(org) {
  const b = org?.billing || {};
  const stateCode = b.stateCode || null;
  const intraState =
    typeof b.intraState === 'boolean' ? b.intraState
    : stateCode ? stateCode === SUPPLIER.stateCode
    : true; // default: assume same-state as supplier (TN) when place of supply is unknown
  return {
    legalName: b.legalName || org?.name || 'Customer',
    gstin: b.gstin || null,                 // null → unregistered (B2C)
    address: b.address || null,
    state: b.state || null,
    stateCode,
    placeOfSupply: b.placeOfSupply || (stateCode ? `${stateCode}-${b.state || ''}` : null),
    placeOfSupplyKnown: !!stateCode,
    intraState,
  };
}

/**
 * Build the frozen invoice record for a top-up. `taxableInr` is the wallet-credit amount
 * (whole rupees); GST is added on top. Everything the invoice needs is snapshotted so a later
 * change to the org's billing profile never mutates a historical invoice.
 */
export function buildInvoiceRecord({ org, orgId, taxableInr, number, fy, seq, txnId, by, issuedAtMs }) {
  const buyer = buyerFromOrg(org);
  const gst = gstBreakdown(taxableInr, { intraState: buyer.intraState });
  return {
    number, fy, seq,
    orgId,
    kind: 'topup',
    status: 'issued',
    txnId: txnId || null,
    issuedBy: by || null,
    issuedAtMs: issuedAtMs || Date.now(),
    supplier: { ...SUPPLIER },
    buyer,
    reverseCharge: false,
    lineItems: [
      {
        // Framed as prepaid access to an AUTOMATED platform (SaaS, SAC 998315) — not bespoke
        // IT consultancy — which supports the presumptive-business (44AD) substance.
        description: 'Subscription credits — automated website platform access',
        sac: INVOICE_SAC_CODE,
        taxableInr: gst.taxable,
      },
    ],
    gstRate: OUTPUT_GST_RATE,
    taxableInr: gst.taxable,
    cgstInr: gst.cgst,
    sgstInr: gst.sgst,
    igstInr: gst.igst,
    taxInr: gst.tax,
    totalInr: gst.total,
    creditInr: Math.round(Number(taxableInr)), // credits actually added to the wallet
  };
}

/** The safe list-view shape (no need to ship the full frozen snapshot to list rows). */
export function invoiceSummary(inv) {
  return {
    number: inv.number,
    issuedAtMs: inv.issuedAtMs || null,
    buyerName: inv.buyer?.legalName || null,
    taxableInr: inv.taxableInr,
    taxInr: inv.taxInr,
    totalInr: inv.totalInr,
    creditInr: inv.creditInr,
    status: inv.status || 'issued',
  };
}

const inr = (n) => `₹${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

/** Self-contained printable HTML for one invoice (customer opens it and saves as PDF). */
export function renderInvoiceHtml(inv) {
  const d = new Date(inv.issuedAtMs || Date.now());
  const date = d.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  const s = inv.supplier || {};
  const b = inv.buyer || {};
  const taxRows = inv.igstInr
    ? `<tr><td>IGST @ ${Math.round(inv.gstRate * 100)}%</td><td class="r">${inr(inv.igstInr)}</td></tr>`
    : `<tr><td>CGST @ ${Math.round(inv.gstRate * 50)}%</td><td class="r">${inr(inv.cgstInr)}</td></tr>
       <tr><td>SGST @ ${Math.round(inv.gstRate * 50)}%</td><td class="r">${inr(inv.sgstInr)}</td></tr>`;
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(inv.number)}</title>
<style>
  body{font:14px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#111;max-width:720px;margin:32px auto;padding:0 20px}
  h1{font-size:20px;margin:0 0 2px} .muted{color:#666;font-size:12px}
  .head{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #111;padding-bottom:12px}
  .meta{text-align:right} .parties{display:flex;gap:24px;margin:18px 0}
  .parties>div{flex:1} .lbl{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#888;margin-bottom:4px}
  table{width:100%;border-collapse:collapse;margin-top:12px} th,td{padding:8px 10px;border-bottom:1px solid #eee;text-align:left}
  th{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#888;border-bottom:1px solid #ccc}
  .r{text-align:right} .totals{margin-left:auto;width:280px;margin-top:12px}
  .totals td{border:0;padding:4px 10px} .grand{font-weight:700;font-size:16px;border-top:2px solid #111}
  .foot{margin-top:28px;font-size:12px;color:#555} @media print{body{margin:0}}
</style></head><body>
  <div class="head">
    <div><h1>${esc(s.legalName)}</h1>
      ${s.address ? `<div class="muted">${esc(s.address)}</div>` : ''}
      ${s.phone ? `<div class="muted">Ph: ${esc(s.phone)}</div>` : ''}
      <div class="muted">GSTIN: ${esc(s.gstin)}</div></div>
    <div class="meta"><div style="font-weight:700">TAX INVOICE</div>
      <div class="muted">No: ${esc(inv.number)}</div><div class="muted">Date: ${esc(date)}</div></div>
  </div>
  <div class="parties">
    <div><div class="lbl">Bill to</div><div style="font-weight:600">${esc(b.legalName)}</div>
      ${b.address ? `<div class="muted">${esc(b.address)}</div>` : ''}
      ${b.gstin ? `<div class="muted">GSTIN: ${esc(b.gstin)}</div>` : `<div class="muted">Unregistered</div>`}</div>
    <div><div class="lbl">Place of supply</div><div>${esc(b.placeOfSupply || s.state)}</div>
      <div class="lbl" style="margin-top:8px">Reverse charge</div><div>No</div></div>
  </div>
  <table><thead><tr><th>Description</th><th>SAC</th><th class="r">Taxable value</th></tr></thead>
  <tbody>${(inv.lineItems || []).map((li) => `<tr><td>${esc(li.description)}</td><td>${esc(li.sac || li.hsn)}</td><td class="r">${inr(li.taxableInr)}</td></tr>`).join('')}</tbody></table>
  <table class="totals"><tbody>
    <tr><td>Taxable value</td><td class="r">${inr(inv.taxableInr)}</td></tr>
    ${taxRows}
    <tr class="grand"><td>Total</td><td class="r">${inr(inv.totalInr)}</td></tr>
  </tbody></table>
  <div class="foot">
    ${s.bank ? `<div>Bank: ${esc(s.bank.name)} · A/C ${esc(s.bank.account)} · IFSC ${esc(s.bank.ifsc)}</div>` : ''}
    <div style="margin-top:10px">This is a computer-generated tax invoice.</div>
  </div>
</body></html>`;
}
