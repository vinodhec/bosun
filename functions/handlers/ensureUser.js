import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';

// Called by the app right after sign-in. Creates the user record if missing.
// (Replaces a gen1 Auth onCreate trigger, which builds poorly in an ESM/Node-22
// codebase.) Credits live on the organisation, so a new user starts with no org —
// the operator assigns them + seeds the org's credits from the admin panel.
export const ensureUser = onCall({ region: 'asia-south1' }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Please sign in.');

  const db = getFirestore();
  const ref = db.collection('users').doc(uid);
  if (!(await ref.get()).exists) {
    await ref.set({
      email: request.auth.token?.email ?? null,
      displayName: request.auth.token?.name ?? null,
      role: 'member',
      orgId: null,
      createdAt: FieldValue.serverTimestamp(),
    });
  }
  return { ok: true };
});
