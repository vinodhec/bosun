// Payments received against tax invoices (receivables). The operator records the rupee amount
// when money lands — "sometimes one invoice, sometimes several combined" — and the SYSTEM decides
// where it goes: oldest unpaid invoice first (FIFO), then the next, until the amount runs out. Any
// excess is held as an ADVANCE on the organisation and applied to the next invoice issued.
//
// Pure helpers only. The atomic reads/writes (payment doc + invoice updates + org advance) live in
// handlers/admin.js so they run inside one Firestore transaction. Money is backend-only (cardinal
// rule): `payments/{id}` is operator data (no client read), and the per-invoice `paidInr/dueInr/
// paymentStatus` fields are the only thing the customer sees.

export const PAYMENT_METHODS = ['upi', 'bank', 'cash', 'other'];

/** Whole rupees the customer owes on an invoice. Legacy invoices (issued before payment tracking)
 *  have no paidInr → the full payable is due. */
export function invoiceDueInr(inv) {
  const payable = Math.round(Number(inv.payableInr ?? inv.totalInr ?? 0));
  const paid = Math.round(Number(inv.paidInr ?? 0));
  return Math.max(0, payable - paid);
}

/** 'paid' | 'partial' | 'unpaid' from the amounts (never trust a stale stored status). */
export function paymentStatusOf(inv) {
  const payable = Math.round(Number(inv.payableInr ?? inv.totalInr ?? 0));
  const paid = Math.round(Number(inv.paidInr ?? 0));
  if (payable <= 0 || paid >= payable) return 'paid';
  if (paid > 0) return 'partial';
  return 'unpaid';
}

/**
 * Allocate `amountInr` across open invoices, OLDEST FIRST. `invoices` is [{ id, number, issuedAtMs,
 * dueInr }] (any order). Returns `{ allocations: [{ invoiceId, number, amountInr }], unallocatedInr }`.
 * A `preferInvoiceId` (the operator saying "this is for THAT invoice") is served first; the rest
 * of the money still flows FIFO. Whole rupees throughout.
 */
export function allocatePayment(amountInr, invoices, { preferInvoiceId = null } = {}) {
  let left = Math.round(Number(amountInr) || 0);
  const open = invoices
    .filter((i) => Math.round(Number(i.dueInr || 0)) > 0)
    .sort((a, b) => {
      if (preferInvoiceId) {
        if (a.id === preferInvoiceId) return -1;
        if (b.id === preferInvoiceId) return 1;
      }
      return (a.issuedAtMs || 0) - (b.issuedAtMs || 0) || String(a.number).localeCompare(String(b.number));
    });
  const allocations = [];
  for (const inv of open) {
    if (left <= 0) break;
    const take = Math.min(left, Math.round(Number(inv.dueInr)));
    allocations.push({ invoiceId: inv.id, number: inv.number, amountInr: take });
    left -= take;
  }
  return { allocations, unallocatedInr: left };
}

/** Receivables roll-up over a list of invoices (summary rows or full docs). */
export function receivablesSummary(invoices) {
  const out = { count: 0, paid: 0, partial: 0, unpaid: 0, billedInr: 0, paidInr: 0, dueInr: 0 };
  for (const inv of invoices) {
    const payable = Math.round(Number(inv.payableInr ?? inv.totalInr ?? 0));
    const paid = Math.min(payable, Math.round(Number(inv.paidInr ?? 0)));
    const status = paymentStatusOf(inv);
    out.count += 1;
    out[status] += 1;
    out.billedInr += payable;
    out.paidInr += paid;
    out.dueInr += payable - paid;
  }
  out.pending = out.partial + out.unpaid;
  return out;
}

/** Safe list-view shape for a payment. */
export function paymentSummary(id, p) {
  return {
    id,
    orgId: p.orgId,
    amountInr: p.amountInr,
    receivedAtMs: p.receivedAtMs || null,
    method: p.method || 'other',
    reference: p.reference || null,
    note: p.note || null,
    allocations: Array.isArray(p.allocations) ? p.allocations : [],
    unallocatedInr: p.unallocatedInr || 0,
    by: p.by || null,
  };
}
