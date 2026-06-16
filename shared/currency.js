/**
 * Currency helpers — CANONICAL source of truth.
 * Imported by both the web app (/src/utils) and Cloud Functions (/functions/utils).
 * Do not fork this logic; edit it here only.
 *
 * The USD->INR rate lives in ONE place so it can be audited/updated centrally.
 * IMPORTANT: for *billing*, the backend resolves a live rate via functions/utils/fxRate.js
 * (a daily-refreshed value cached in config/fxRate, overridable by the USD_TO_INR env pin);
 * DEFAULT_USD_TO_INR below is only the cold-start fallback used before any live rate has been
 * fetched. The frontend uses DEFAULT_USD_TO_INR only to show non-binding estimates.
 */

/**
 * Cold-start fallback rate. The live billing rate comes from config/fxRate (see fxRate.js); this
 * is only used until the first daily refresh lands, and for the frontend's non-binding estimates.
 * Keep it roughly current so neither path is wildly off before a live rate exists.
 */
export const DEFAULT_USD_TO_INR = 90;

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
