// GSTR-1 (outward supplies) report for the SOFTWARE invoice line only — the slice the CA merges
// with the trading business for the single-GSTIN return. Purchases (Anthropic credits, an RCM
// import of services) are handled by the CA, not here. Pure builders + printable HTML.
import { SUPPLIER } from './invoice.js';

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const num = (n) => Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const dmy = (ms) => (ms ? new Date(ms).toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' }).replace(/\//g, '-') : '');

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
  const from = new Date(rep.fromMs), to = new Date(rep.toMs);
  const mon = (d) => d.toLocaleString('en-US', { month: 'long' });
  const b2bRows = rep.b2b.map((r) => `<tr>
    <td>${esc(r.gstin)}</td><td>${esc(r.number)}</td><td>${dmy(r.dateMs)}</td>
    <td class="r">${num(r.value)}</td><td class="r">${r.rate}.0</td><td class="r">0.0</td>
    <td class="r">${num(r.taxable)}</td><td class="r">${num(r.igst)}</td><td class="r">${num(r.cgst)}</td>
    <td class="r">${num(r.sgst)}</td><td class="r">0.0</td><td>${esc(r.pos)}</td></tr>`).join('');
  const b2cRows = rep.b2c.map((r) => `<tr>
    <td>${esc(r.pos)}</td><td class="r">${r.rate}.0</td><td class="r">${num(r.taxable)}</td>
    <td class="r">${num(r.igst)}</td><td class="r">${num(r.cgst)}</td><td class="r">${num(r.sgst)}</td></tr>`).join('');
  const t = rep.totals;
  return `<!doctype html><html><head><meta charset="utf-8"><title>GSTR-1 ${mon(from)} ${from.getFullYear()}</title>
<style>
  body{font:13px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#111;max-width:1000px;margin:24px auto;padding:0 16px}
  h1{text-align:center;font-size:20px} h2{text-align:center;font-size:15px;margin:22px 0 8px}
  table{width:100%;border-collapse:collapse;margin-top:6px} th,td{border:1px solid #bbb;padding:5px 7px;text-align:left;vertical-align:top}
  th{background:#f4f4f4;font-size:11px} .r{text-align:right} .meta td{border:1px solid #ccc}
  .tot{font-weight:700;background:#fafafa} .soft{color:#666;font-size:11px;text-align:center;margin-top:24px}
  @media print{body{margin:0}}
</style></head><body>
  <h1>GSTR 1 Report — Software line</h1>
  <table class="meta"><tbody>
    <tr><td>From</td><td>${mon(from)} ${from.getFullYear()}</td><td>To</td><td>${mon(to)} ${to.getFullYear()}</td></tr>
    <tr><td>GSTIN</td><td>${esc(rep.supplier.gstin)}</td><td>Legal name</td><td>${esc(rep.supplier.legalName)}</td></tr>
  </tbody></table>
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
  <tbody><tr class="tot"><td colspan="3">Totals</td><td class="r">0.0</td><td class="r">0.0</td></tr></tbody></table>
  <p class="soft">Software (SW/) invoice line only — merge with the trading-business figures for the full GSTIN return.
  Purchases (Anthropic credits) are an RCM import of services, handled separately by the CA.</p>
</body></html>`;
}
