// GST tax-invoice helpers. A wallet top-up (adminAddCredits) issues ONE tax invoice for the
// credited amount as taxable value + 18% GST (see shared/billing.js#gstBreakdown). Pure helpers
// only — the atomic Firestore reads/writes (counter + invoice doc) live in admin.js so they run
// inside the same transaction as the credit. Invoices are backend-only writes (cardinal rule).
import { gstBreakdown, INVOICE_SAC_CODE, OUTPUT_GST_RATE, PLATFORM_FEE_RATE, platformFeeInr } from '../shared/billing.js';
import { SIGNATURE_DATA_URI } from './signatureAsset.js';
import { LOGO_DATA_URI } from './logoAsset.js';

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
  // Logo (Murugan emblem) shown top-left of the invoice. Inline data URI (self-contained HTML).
  logoDataUri: LOGO_DATA_URI,
  // Scanned signature (+ printed name) of the proprietor / authorized signatory, shown above the
  // "Authorized Signatory" line. Inline transparent-PNG data URI. Empty = printed line only.
  signatureDataUri: SIGNATURE_DATA_URI,
  bank: { name: 'ICICI Bank, Erode Main Branch', account: '606205039174', ifsc: 'ICIC0006062', holder: 'SRI BALAMURUGAN TRADERS' },
};

// Software-line invoice series, kept SEPARATE from the proprietor's existing trading-business
// invoices (auditor's requirement) — 'SW' marks it as the software series under the same GSTIN.
const INVOICE_PREFIX = 'SW';

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
 * Build the frozen invoice record for a top-up. `creditInr` is the wallet-credit amount (whole
 * rupees) that actually lands in the wallet; a PLATFORM_FEE_RATE platform fee is charged ON TOP as
 * a second taxable line, and GST is computed ONCE on the combined (credit + fee) taxable base. So
 * a ₹5000 top-up bills ₹5000 credit + ₹500 fee + 18% GST on ₹5500 = ₹6490 payable, wallet +₹5000.
 * Everything the invoice needs is snapshotted so a later change to the org's billing profile (or to
 * the fee rate) never mutates a historical invoice.
 */
export function buildInvoiceRecord({ org, orgId, creditInr, number, fy, seq, txnId, by, issuedAtMs }) {
  const buyer = buyerFromOrg(org);
  const credit = Math.round(Number(creditInr));
  const feeInr = platformFeeInr(credit);
  const gst = gstBreakdown(credit + feeInr, { intraState: buyer.intraState });
  return {
    number, fy, seq,
    orgId,
    kind: 'topup',
    status: 'issued',
    txnId: txnId || null,
    issuedBy: by || null,
    issuedAtMs: issuedAtMs || Date.now(),
    // Snapshot supplier WITHOUT the heavy branding data URIs (identical on every invoice) — the
    // renderer pulls the logo/signature from the live SUPPLIER constant, keeping each doc tiny.
    supplier: (({ logoDataUri, signatureDataUri, ...rest }) => rest)(SUPPLIER),
    buyer,
    reverseCharge: false,
    lineItems: [
      {
        // Framed as prepaid access to an AUTOMATED platform (SaaS, SAC 998315) — not bespoke
        // IT consultancy — which supports the presumptive-business (44AD) substance.
        description: 'Subscription credits — automated website platform access',
        sac: INVOICE_SAC_CODE,
        taxableInr: credit,
      },
      {
        description: `Platform fee (${Math.round(PLATFORM_FEE_RATE * 100)}%)`,
        sac: INVOICE_SAC_CODE,
        taxableInr: feeInr,
      },
    ],
    gstRate: OUTPUT_GST_RATE,
    platformFeeInr: feeInr,                                // the fee line, snapshotted for reporting
    taxableInr: gst.taxable,                               // credit + fee (the combined GST base)
    cgstInr: gst.cgst,
    sgstInr: gst.sgst,
    igstInr: gst.igst,
    taxInr: gst.tax,
    totalInr: gst.total,                                  // taxable + tax, to the paise (for GST returns)
    roundOffInr: Math.round((Math.round(gst.total) - gst.total) * 100) / 100,
    payableInr: Math.round(gst.total),                    // rounded to whole rupee — what the customer pays
    creditInr: credit,                                    // credits actually added to the wallet (fee excluded)
  };
}

// Indian-system number to words for whole rupees (…Thousand, …Lakh, …Crore). e.g. 234560 →
// "Two Lakh Thirty Four Thousand Five Hundred Sixty Rupees only".
export function amountInWords(num) {
  num = Math.round(Number(num) || 0);
  if (num === 0) return 'Zero Rupees only';
  const ones = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
    'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
  const tens = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
  const two = (n) => (n < 20 ? ones[n] : tens[Math.floor(n / 10)] + (n % 10 ? ' ' + ones[n % 10] : ''));
  const three = (n) => (Math.floor(n / 100) ? ones[Math.floor(n / 100)] + ' Hundred' + (n % 100 ? ' ' + two(n % 100) : '') : two(n % 100));
  let w = '';
  const crore = Math.floor(num / 10000000); num %= 10000000;
  const lakh = Math.floor(num / 100000); num %= 100000;
  const thousand = Math.floor(num / 1000); num %= 1000;
  if (crore) w += three(crore) + ' Crore ';
  if (lakh) w += two(lakh) + ' Lakh ';
  if (thousand) w += two(thousand) + ' Thousand ';
  if (num) w += three(num) + ' ';
  return w.trim() + ' Rupees only';
}

/** The safe list-view shape (no need to ship the full frozen snapshot to list rows). */
export function invoiceSummary(inv) {
  return {
    number: inv.number,
    issuedAtMs: inv.issuedAtMs || null,
    buyerName: inv.buyer?.legalName || null,
    taxableInr: inv.taxableInr,
    taxInr: inv.taxInr,
    totalInr: inv.payableInr ?? inv.totalInr,
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
  // Branding (logo/signature) comes from the live SUPPLIER constant, not the (stripped) snapshot.
  const s = { ...inv.supplier, logoDataUri: SUPPLIER.logoDataUri, signatureDataUri: SUPPLIER.signatureDataUri };
  const b = inv.buyer || {};
  const posState = b.state || s.state;
  const posCode = b.stateCode || (b.intraState ? s.stateCode : null);
  const placeOfSupply = posCode ? `${posState} (State code ${posCode})` : (b.placeOfSupply || posState);
  const payable = inv.payableInr ?? Math.round(inv.totalInr);
  const roundOff = inv.roundOffInr ?? Math.round((payable - inv.totalInr) * 100) / 100;
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
  .foot{margin-top:24px;font-size:12px;color:#444;border-top:1px solid #eee;padding-top:14px}
  .payrow{display:flex;gap:20px;align-items:flex-start;justify-content:space-between}
  .sign{text-align:center;min-width:190px}
  .sigspace{min-height:56px;display:flex;align-items:flex-end;justify-content:center}
  .sigspace img{max-height:64px;max-width:200px}
  .sigline{border-top:1px solid #999;padding-top:4px;margin-top:2px} @media print{body{margin:0}}
</style></head><body>
  <div class="head">
    <div>${s.logoDataUri ? `<img src="${s.logoDataUri}" alt="" style="max-height:52px;max-width:200px;margin-bottom:8px;display:block" />` : ''}<h1>${esc(s.legalName)}</h1>
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
    <div><div class="lbl">Place of supply</div><div>${esc(placeOfSupply)}</div>
      <div class="lbl" style="margin-top:8px">Reverse charge</div><div>No</div></div>
  </div>
  <table><thead><tr><th>Description</th><th>SAC</th><th class="r">Taxable value</th></tr></thead>
  <tbody>${(inv.lineItems || []).map((li) => `<tr><td>${esc(li.description)}</td><td>${esc(li.sac || li.hsn)}</td><td class="r">${inr(li.taxableInr)}</td></tr>`).join('')}</tbody></table>
  <table class="totals"><tbody>
    <tr><td>Taxable value</td><td class="r">${inr(inv.taxableInr)}</td></tr>
    ${taxRows}
    ${roundOff ? `<tr><td>Round off</td><td class="r">${roundOff < 0 ? '−' : '+'}${inr(Math.abs(roundOff))}</td></tr>` : ''}
    <tr class="grand"><td>Total</td><td class="r">${inr(payable)}</td></tr>
  </tbody></table>
  <div style="clear:both"></div>
  <div style="margin-top:10px;font-size:12px"><span class="lbl" style="display:inline">Amount in words:</span> <b>${esc(amountInWords(payable))}</b></div>
  <div class="foot">
    <div class="payrow">
      <div style="flex:1">
        <div class="lbl">Pay by UPI / bank transfer</div>
        ${s.bank ? `<div style="font-weight:600">${esc(s.bank.holder || s.legalName)}</div>
        <div>${esc(s.bank.name)}</div>
        <div>A/C ${esc(s.bank.account)} · IFSC ${esc(s.bank.ifsc)}</div>` : ''}
      </div>
      <div class="sign">
        <div style="font-weight:600">For ${esc(s.legalName)}</div>
        <div class="sigspace">${s.signatureDataUri ? `<img src="${s.signatureDataUri}" alt="signature" />` : ''}</div>
        <div class="sigline">Authorized Signatory</div>
      </div>
    </div>
    <div class="muted" style="margin-top:14px">Subject to Erode, Tamil Nadu jurisdiction. E. &amp; O.E.</div>
  </div>
</body></html>`;
}
