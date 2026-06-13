import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getMe } from '../utils/figma.js';

// Operator-only flow to connect an org's Figma account for design-to-code. The Figma Personal
// Access Token is stored backend-only in orgSecrets/{orgId}.figma (the vault — never readable by,
// nor returned to, the browser). A NON-secret status (connected flag + the Figma handle/email it
// belongs to) is mirrored onto the org doc so the Admin panel can show which account is linked.
// There's no per-task target to pick (unlike Trello): the customer supplies the design link itself,
// so connecting a valid token is the whole setup.

function requireAdmin(request) {
  const email = request.auth?.token?.email;
  const allow = (process.env.ADMIN_EMAILS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (!email || !allow.includes(email.toLowerCase())) {
    throw new HttpsError('permission-denied', 'Admin only.');
  }
  return email;
}

// Save the org's Figma token (vault-only) after validating it against the live API. The /me call
// both proves the token works and gives us the account identity to show in the panel.
export const adminConnectFigma = onCall({ region: 'asia-south1' }, async (request) => {
  requireAdmin(request);
  const orgId = String(request.data?.orgId ?? '').trim();
  const token = String(request.data?.token ?? '').trim();
  if (!orgId || !token) throw new HttpsError('invalid-argument', 'orgId and token are required.');

  const db = getFirestore();
  const orgRef = db.collection('organisations').doc(orgId);
  if (!(await orgRef.get()).exists) throw new HttpsError('not-found', 'Organisation not found.');

  let me;
  try {
    me = await getMe({ token });
  } catch (e) {
    console.error('adminConnectFigma:validate', orgId, e?.status || '', e?.message || e);
    throw new HttpsError('failed-precondition', 'That design token did not work. Check it and try again.');
  }

  await db.collection('orgSecrets').doc(orgId).set(
    { figma: { token, updatedAt: FieldValue.serverTimestamp() } },
    { merge: true }
  );
  await orgRef.set(
    { figma: { connected: true, hasCredentials: true, handle: me.handle, email: me.email, connectedAt: FieldValue.serverTimestamp() } },
    { merge: true }
  );
  return { ok: true, handle: me.handle, email: me.email };
});

// Remove the org's Figma connection — drop the token from the vault and clear the status mirror.
export const adminDisconnectFigma = onCall({ region: 'asia-south1' }, async (request) => {
  requireAdmin(request);
  const orgId = String(request.data?.orgId ?? '').trim();
  if (!orgId) throw new HttpsError('invalid-argument', 'orgId required.');

  const db = getFirestore();
  await db.collection('orgSecrets').doc(orgId).set({ figma: FieldValue.delete() }, { merge: true });
  await db.collection('organisations').doc(orgId).set(
    { figma: { connected: false, hasCredentials: false } },
    { merge: true }
  );
  return { ok: true };
});
