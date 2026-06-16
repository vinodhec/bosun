// Live USD->INR exchange rate — fetched daily, cached in Firestore, read by the billing path.
//
// The canonical fallback (DEFAULT_USD_TO_INR) is a stale constant; relying on it means every
// charge converts COGS at a rate that drifts further from reality over time. Instead a daily
// scheduled job (handlers/fxRate.js) pulls the live rate from a free FX feed and persists it to
// config/fxRate; billing reads it here. The Firestore doc is backend-only — the default-deny
// rule in firestore.rules covers it, so no rules change is needed (the Admin SDK bypasses rules).
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { DEFAULT_USD_TO_INR } from './billing.js';

// Sanity band. A feed returning something outside this is almost certainly broken (wrong base
// currency, an error payload parsed as a number, etc.) — reject it and keep the last good value.
const MIN_SANE = 50;
const MAX_SANE = 150;

// Free, key-less FX feed. Override with FX_RATE_URL if it ever needs swapping. Must expose USD as
// the base and INR under `rates` (the open.er-api.com / open exchange-rates-api shape).
const FX_URL = process.env.FX_RATE_URL || 'https://open.er-api.com/v6/latest/USD';

// Per-instance memo so the billing path doesn't read Firestore on every charge. The cached doc
// only changes once a day, but a warm instance can live for hours — so a short TTL is plenty.
let memo = { rate: null, at: 0 };
const MEMO_TTL_MS = 60 * 60 * 1000; // 1h

function sane(n) {
  const r = Number(n);
  return Number.isFinite(r) && r >= MIN_SANE && r <= MAX_SANE ? r : null;
}

// Fetch the live rate and persist it to config/fxRate. Returns the new rate, or null if the feed
// was unreachable / returned garbage — in which case billing keeps using the last cached value.
export async function refreshFxRate() {
  let data;
  try {
    const res = await fetch(FX_URL, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`http_${res.status}`);
    data = await res.json();
  } catch (err) {
    console.error(`FX_REFRESH_FAIL fetch ${err?.message || err}`);
    return null;
  }
  const rate = sane(data?.rates?.INR);
  if (!rate) {
    console.error(`FX_REFRESH_FAIL bad_rate ${JSON.stringify(data?.rates?.INR)}`);
    return null;
  }
  await getFirestore().collection('config').doc('fxRate').set(
    { usdToInr: rate, source: FX_URL, fetchedAt: FieldValue.serverTimestamp() },
    { merge: true },
  );
  memo = { rate, at: Date.now() };
  console.log(`FX_REFRESH_OK ${rate}`);
  return rate;
}

// The USD->INR rate to use for billing. Priority:
//   1. process.env.USD_TO_INR  — an explicit operator pin (manual override) always wins.
//   2. the live rate cached in config/fxRate by refreshFxRate (memoized per instance).
//   3. DEFAULT_USD_TO_INR      — last-resort fallback if nothing has been fetched yet.
// Always resolves to a concrete number, so callers can pass it straight into the billing math.
export async function getUsdToInrRate() {
  const pinned = Number(process.env.USD_TO_INR);
  if (Number.isFinite(pinned) && pinned > 0) return pinned;

  const now = Date.now();
  if (memo.rate && now - memo.at < MEMO_TTL_MS) return memo.rate;

  try {
    const snap = await getFirestore().collection('config').doc('fxRate').get();
    const cached = sane(snap.exists ? snap.data()?.usdToInr : null);
    if (cached) {
      memo = { rate: cached, at: now };
      return cached;
    }
  } catch (err) {
    console.error(`FX_READ_FAIL ${err?.message || err}`);
  }
  return DEFAULT_USD_TO_INR;
}
