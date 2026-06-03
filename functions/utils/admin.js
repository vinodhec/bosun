import { HttpsError } from 'firebase-functions/v2/https';

// Operator allowlist for the admin/operator-only callables (admin.js + adminGithub.js).
//
// Read from ADMIN_EMAILS (comma-separated) when present — local dev via functions/.env,
// production via the deploy-time env. It falls back to the founding operator so the gate
// never silently denies EVERY admin when the var is missing from a given deploy path:
// functions/.env is gitignored and the CI "Deploy" workflow doesn't set ADMIN_EMAILS, so a
// function deployed from anywhere but a machine carrying that local .env would otherwise ship
// with an empty allowlist. This mirrors the frontend default in Navbar.jsx
// (VITE_ADMIN_EMAILS || 'vinodhec@gmail.com'), keeping the cosmetic client check and the real
// server gate in agreement. An explicit ADMIN_EMAILS always wins, so the allowlist stays
// overridable (e.g. to add/replace operators).
const DEFAULT_ADMIN_EMAILS = 'vinodhec@gmail.com';

export function adminAllowlist() {
  return (process.env.ADMIN_EMAILS || DEFAULT_ADMIN_EMAILS)
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

// Throws permission-denied unless the caller is a verified operator. Returns the caller's
// email on success so callers can stamp it into the ledger (transactions.by).
export function requireAdmin(request) {
  const email = request.auth?.token?.email;
  if (!email || !adminAllowlist().includes(email.toLowerCase())) {
    throw new HttpsError('permission-denied', 'Admin only.');
  }
  return email;
}
