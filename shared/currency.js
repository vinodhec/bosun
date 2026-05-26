/**
 * Currency helpers — CANONICAL source of truth.
 * Imported by both the web app (/src/utils) and Cloud Functions (/functions/utils).
 * Do not fork this logic; edit it here only.
 *
 * The USD->INR rate lives in ONE place so it can be audited/updated centrally.
 * IMPORTANT: the backend must treat its own authoritative rate (from env /
 * Remote Config) as the source for *billing*. The frontend uses DEFAULT_USD_TO_INR
 * only to show non-binding estimates.
 */

/** Fallback rate. Keep roughly in sync with reality; backend overrides for billing. */
export const DEFAULT_USD_TO_INR = 83;

/** Convert USD to INR. Guards against NaN / negative. */
export function usdToInr(usd, rate = DEFAULT_USD_TO_INR) {
  const n = Number(usd);
  if (!Number.isFinite(n) || n < 0) return 0;
  return n * rate;
}

/** Format a number as INR, no decimals: 1250 -> "₹1,250". */
export function formatINR(n) {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    maximumFractionDigits: 0,
  }).format(Number(n) || 0);
}
