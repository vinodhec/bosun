// Public share link for an invoice. A 32-hex random token is minted ONCE per invoice (lazily, on
// the first share) and stored as `invoices/{id}.shareToken`; the `publicInvoice` HTTP function
// resolves it to the printable page. Unguessable, revocable by clearing the field — and it is the
// only way an invoice is reachable without signing in.
import { randomBytes } from 'node:crypto';

export async function ensureShareToken(ref, data) {
  if (data?.shareToken) return data.shareToken;
  const token = randomBytes(16).toString('hex');
  await ref.update({ shareToken: token, shareTokenAtMs: Date.now() });
  return token;
}

// The org-level "payment due" page (/d/<token> → publicDues): every invoice of the org with a
// balance due, the total, and how to pay. Same idea as above: one random token per org, minted on
// first share, stored as `organisations/{id}.duesShareToken`, revoked by clearing the field.
export async function ensureDuesToken(orgRef, org) {
  if (org?.duesShareToken) return org.duesShareToken;
  const token = randomBytes(16).toString('hex');
  await orgRef.update({ duesShareToken: token, duesShareTokenAtMs: Date.now() });
  return token;
}
