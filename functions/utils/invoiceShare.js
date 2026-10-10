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
