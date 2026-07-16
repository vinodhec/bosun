/**
 * Inbound customer→Bosun HMAC auth, shared by every endpoint the customer calls (sourcingCompose,
 * usageMeter). The customer signs `${timestamp}.${rawBody}` with the per-org relay secret from the
 * vault (orgSecrets/{orgId}.sourcing.secret) — the same scheme utils/sourcing.js#signPayload uses
 * outbound, in the opposite direction.
 *
 * WHY THIS RETURNS A REASON. The old copies of this check returned a bare boolean and the callers
 * rejected with a bare 401, logging nothing. That made a failed integration indistinguishable from
 * no integration at all: on 2026-07-16 the platform reported 14 auto-posted listings while
 * usageMeter showed zero events, and the only way to tell "never called" from "called and rejected"
 * was to read Cloud Run's httpRequest logs. A wrong secret and a clock-skewed timestamp both looked
 * like silence. So the verdict carries a reason the caller can log.
 *
 * The reason is for OUR logs, never the response body — telling a caller whether the secret or the
 * timestamp was wrong helps an attacker probe. Callers return a flat 401.
 */
import crypto from 'node:crypto';

/** Replay window. A signature older (or further in the future) than this is refused. */
export const MAX_SIGNATURE_AGE_MS = 5 * 60 * 1000;

/**
 * Verify the customer's HMAC over `${timestamp}.${rawBody}`.
 *
 * The comparison stays constant-time and the accept condition is byte-identical to the two copies
 * this replaces — only the failure path gained detail.
 *
 * @returns {{ok: boolean, reason: string|null, skewMs?: number}} `reason` is null iff ok.
 */
export function verifyCustomerSignature(rawBody, signature, timestamp, secret) {
  if (!secret) return { ok: false, reason: 'no-secret-for-org' };
  if (!signature) return { ok: false, reason: 'missing-signature-header' };
  if (!timestamp) return { ok: false, reason: 'missing-timestamp-header' };

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return { ok: false, reason: 'timestamp-not-a-number' };
  const skewMs = Date.now() - ts;
  // Distinguishing skew from a bad digest is the whole point: a clock drift on the customer's box
  // and a wrong secret are completely different fixes, and both used to surface as one silent 401.
  if (Math.abs(skewMs) > MAX_SIGNATURE_AGE_MS) return { ok: false, reason: 'timestamp-outside-replay-window', skewMs };

  const expected = 'sha256=' + crypto.createHmac('sha256', String(secret)).update(`${ts}.${rawBody}`).digest('hex');
  const a = Buffer.from(String(signature));
  const b = Buffer.from(expected);
  // A length mismatch means the header isn't even shaped like our digest (missing the `sha256=`
  // prefix is the classic one) — worth separating from a genuine digest mismatch, which means the
  // secret or the signed bytes differ.
  if (a.length !== b.length) return { ok: false, reason: 'signature-malformed-or-wrong-length', skewMs };
  if (!crypto.timingSafeEqual(a, b)) return { ok: false, reason: 'signature-mismatch-check-secret-and-raw-body', skewMs };
  return { ok: true, reason: null, skewMs };
}

/**
 * One-line structured rejection log. Every non-2xx path on a customer endpoint should call this, so
 * "did they call us and get refused?" is answerable from the function's own logs instead of
 * Cloud Run's request log.
 *
 * Deliberately never logs the signature, the secret, or the body — only their shape.
 */
export function logReject(endpoint, { orgId, status, reason, extra = {} } = {}) {
  console.warn(`${endpoint}:reject`, orgId || '(no-org)', JSON.stringify({ status, reason, ...extra }));
}
