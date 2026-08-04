// Vendor bills for the SOFTWARE line — the inward-supply half of the GST reports.
//
// The software line buys one thing: Anthropic API credits. Anthropic is a US supplier, so every
// bill is an IMPORT OF SERVICES, and how it is taxed depends entirely on whether our GSTIN was on
// the Anthropic account when the bill was raised:
//
//   'rcm'           — GSTIN on file. Anthropic charges 0% and prints "tax to be paid on reverse
//                     charge basis". WE owe IGST @18% in cash and claim the same amount back as
//                     import-of-services ITC. Net ₹0 tax. This is the only treatment that reaches
//                     GSTR-2 / GSTR-3B.
//   'oidar_charged' — GSTIN NOT on file, so Anthropic charged 18% under its OIDAR registration
//                     (9924USA29003OSI). That tax never lands in our GSTR-2B, so it is NOT
//                     claimable — it is plain cost. Recorded for the expense trail and shown on
//                     the Purchase Report, but deliberately excluded from GSTR-2/3B: the strict
//                     position is that RCM still applied and the CA decides whether to pay twice.
//   'domestic'      — an ordinary Indian supplier billing our GSTIN. Normal ITC.
//   'refunded'      — cancelled or refunded. No supply, no tax; kept only so the bill's absence
//                     from the return is explained rather than unexplained.
//
// Foreign bills are in USD but GST is a rupee tax, so `taxableInr` is the rupee value ACTUALLY
// debited (bank/card statement), not a converted guess — `amountForeign`/`currency` ride along so
// the row can be tied back to the vendor invoice.
import { OUTPUT_GST_RATE } from '../shared/billing.js';

export const GST_TREATMENTS = ['rcm', 'oidar_charged', 'domestic', 'refunded'];

// Which treatments contribute tax to GSTR-2 / GSTR-3B. See the note above for why
// 'oidar_charged' is not one of them.
const REPORTABLE = new Set(['rcm', 'domestic']);

const r2 = (n) => Math.round((Number(n) || 0) * 100) / 100;

/**
 * Normalise an operator-entered vendor bill into the stored record. Tax is DERIVED, never typed:
 * an RCM import is always IGST (the supplier is outside India, so it is inter-state by
 * definition), and a domestic bill splits CGST/SGST or lands in IGST from `intraState`.
 */
export function buildPurchaseRecord({
  supplierName, supplierTaxId, country, number, dateMs, currency, amountForeign,
  taxableInr, gstTreatment, gstRate, intraState, supplierTaxInr, notes, by,
}) {
  const treatment = GST_TREATMENTS.includes(gstTreatment) ? gstTreatment : 'rcm';
  const taxable = r2(taxableInr);
  const rate = Number.isFinite(Number(gstRate)) ? Number(gstRate) : OUTPUT_GST_RATE;
  const importOfServices = treatment === 'rcm' || treatment === 'oidar_charged';

  let igst = 0, cgst = 0, sgst = 0;
  if (REPORTABLE.has(treatment)) {
    const tax = r2(taxable * rate);
    // An import of services is inter-state under s.7(5) IGST regardless of where we sit, so RCM
    // is always IGST. Only a domestic intra-state bill splits into CGST + SGST.
    if (treatment === 'domestic' && intraState) { cgst = r2(tax / 2); sgst = r2(tax - r2(tax / 2)); }
    else igst = tax;
  }

  return {
    supplierName: String(supplierName || '').trim(),
    supplierTaxId: supplierTaxId ? String(supplierTaxId).trim() : null,
    supplierGstin: treatment === 'domestic' ? (supplierTaxId ? String(supplierTaxId).trim() : null) : null,
    country: String(country || 'India').trim(),
    number: String(number || '').trim(),
    dateMs: Number(dateMs) || Date.now(),
    currency: String(currency || 'INR').trim().toUpperCase(),
    amountForeign: amountForeign == null ? null : r2(amountForeign),
    taxableInr: taxable,
    gstTreatment: treatment,
    gstRate: rate,
    reverseCharge: treatment === 'rcm',
    importOfServices,
    igstInr: igst, cgstInr: cgst, sgstInr: sgst,
    // What the SUPPLIER charged us. Only meaningful for 'oidar_charged', where it is a real cash
    // outflow that is nonetheless not claimable — kept separate from igst/cgst/sgst so it can
    // never be mistaken for creditable tax.
    supplierTaxInr: supplierTaxInr == null ? 0 : r2(supplierTaxInr),
    value: r2(taxable + igst + cgst + sgst + (supplierTaxInr == null ? 0 : r2(supplierTaxInr))),
    // Place of supply for an inward supply is where WE are — always Tamil Nadu.
    pos: 'Tamil Nadu',
    notes: notes ? String(notes).trim() : null,
    recordedBy: by || null,
    recordedAtMs: Date.now(),
  };
}

/** Only the bills that belong in GSTR-2 / GSTR-3B — see REPORTABLE. */
export function reportablePurchases(purchases) {
  return purchases.filter((p) => REPORTABLE.has(p.gstTreatment));
}

/** The safe list-view shape for the Admin panel. */
export function purchaseSummary(p) {
  return {
    supplierName: p.supplierName,
    number: p.number,
    dateMs: p.dateMs,
    currency: p.currency,
    amountForeign: p.amountForeign,
    taxableInr: p.taxableInr,
    gstTreatment: p.gstTreatment,
    igstInr: p.igstInr,
    supplierTaxInr: p.supplierTaxInr,
    value: p.value,
    notes: p.notes,
  };
}
