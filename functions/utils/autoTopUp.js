// Auto top-up — a per-org CREDIT LINE: when the wallet falls below `thresholdInr`, credit
// `amountInr` straight away and issue the normal SW/ tax invoice as UNPAID, which the owner pays
// afterwards. Operator-configured (adminSetAutoTopUp), never client-written (cardinal rule).
//
// Pure helpers only — the Firestore trigger + transaction live in handlers/autoTopUp.js.
//
//   organisations/{id}.autoTopUp      = { enabled, thresholdInr, amountInr, maxPerMonth, maxUnpaid }
//   organisations/{id}.autoTopUpState = { unpaid, unpaidCreditInr, month, monthCount,
//                                         lastAtMs, lastInvoiceId, lastInvoiceNumber }
//
// Credit-risk guards (both bound how much we can be owed): `maxUnpaid` auto invoices outstanding
// at once (default 1 — the next auto top-up waits until the last one is marked paid), and
// `maxPerMonth` auto top-ups per IST calendar month.

export const AUTO_TOPUP_DEFAULTS = { maxPerMonth: 4, maxUnpaid: 1 };
export const AUTO_TOPUP_MIN_AMOUNT_INR = 100;
export const AUTO_TOPUP_BY = 'system:auto-topup';

const int = (v) => Math.round(Number(v));

/** Validate an operator-supplied config. Returns { config } or { error } (a human sentence). */
export function normalizeAutoTopUp(input = {}) {
  const enabled = input.enabled === true;
  const thresholdInr = int(input.thresholdInr);
  const amountInr = int(input.amountInr);
  const maxPerMonth = input.maxPerMonth == null || input.maxPerMonth === '' ? AUTO_TOPUP_DEFAULTS.maxPerMonth : int(input.maxPerMonth);
  const maxUnpaid = input.maxUnpaid == null || input.maxUnpaid === '' ? AUTO_TOPUP_DEFAULTS.maxUnpaid : int(input.maxUnpaid);
  if (!Number.isFinite(thresholdInr) || thresholdInr < 0) return { error: 'Threshold must be ₹0 or more.' };
  if (!Number.isFinite(amountInr) || amountInr < AUTO_TOPUP_MIN_AMOUNT_INR) {
    return { error: `Top-up amount must be at least ₹${AUTO_TOPUP_MIN_AMOUNT_INR}.` };
  }
  if (!Number.isFinite(maxPerMonth) || maxPerMonth < 1) return { error: 'Max per month must be at least 1.' };
  if (!Number.isFinite(maxUnpaid) || maxUnpaid < 1) return { error: 'Max unpaid must be at least 1.' };
  return { config: { enabled, thresholdInr, amountInr, maxPerMonth, maxUnpaid } };
}

/** IST calendar month key, e.g. '2026-10' — the `maxPerMonth` window. */
export function istMonthKey(ms = Date.now()) {
  return new Date(ms + 5.5 * 3600 * 1000).toISOString().slice(0, 7);
}

/**
 * Should this org get an auto top-up right now? LEVEL-triggered (balance < threshold), not
 * edge-triggered, so a missed or redelivered event self-heals and marking an invoice paid while
 * still below the line fires the next one. The guards are what stop repeats — the caller MUST
 * evaluate this inside the transaction that writes the credit.
 * Returns { fire: true, amountInr, month, monthCount } or { fire: false, reason }.
 */
export function autoTopUpDecision(org, nowMs = Date.now()) {
  const cfg = org?.autoTopUp;
  if (!cfg?.enabled) return { fire: false, reason: 'disabled' };
  const balance = Number(org.balance ?? 0);
  if (!(balance < Number(cfg.thresholdInr))) return { fire: false, reason: 'above_threshold' };
  const amountInr = int(cfg.amountInr);
  if (!Number.isFinite(amountInr) || amountInr <= 0) return { fire: false, reason: 'bad_amount' };

  const st = org.autoTopUpState || {};
  const maxUnpaid = Number(cfg.maxUnpaid) || AUTO_TOPUP_DEFAULTS.maxUnpaid;
  if ((Number(st.unpaid) || 0) >= maxUnpaid) return { fire: false, reason: 'unpaid_limit' };

  const month = istMonthKey(nowMs);
  const monthCount = st.month === month ? Number(st.monthCount) || 0 : 0;
  const maxPerMonth = Number(cfg.maxPerMonth) || AUTO_TOPUP_DEFAULTS.maxPerMonth;
  if (monthCount >= maxPerMonth) return { fire: false, reason: 'monthly_limit' };

  return { fire: true, amountInr, month, monthCount };
}
