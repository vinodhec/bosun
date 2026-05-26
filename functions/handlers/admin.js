import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';

// Operator-only admin callables. Gated by an ADMIN_EMAILS allowlist (comma-separated).
// Credits live at the ORGANISATION level; the operator seeds them manually.
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

const REGION = 'asia-south1';

export const adminCreateOrg = onCall({ region: REGION }, async (request) => {
  requireAdmin(request);
  const name = String(request.data?.name ?? '').trim();
  if (!name) throw new HttpsError('invalid-argument', 'Organisation name required.');
  const db = getFirestore();
  const ref = db.collection('organisations').doc();
  await ref.set({ name, balance: 0, createdAt: FieldValue.serverTimestamp() });
  return { orgId: ref.id, name };
});

export const adminAddCredits = onCall({ region: REGION }, async (request) => {
  const by = requireAdmin(request);
  const orgId = String(request.data?.orgId ?? '');
  const amount = Math.round(Number(request.data?.amount));
  if (!orgId) throw new HttpsError('invalid-argument', 'orgId required.');
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new HttpsError('invalid-argument', 'amount must be a positive number.');
  }
  const db = getFirestore();
  const orgRef = db.collection('organisations').doc(orgId);
  const balance = await db.runTransaction(async (tx) => {
    const snap = await tx.get(orgRef);
    if (!snap.exists) throw new HttpsError('not-found', 'Organisation not found.');
    const next = Number(snap.data().balance ?? 0) + amount;
    tx.update(orgRef, { balance: next });
    tx.set(db.collection('transactions').doc(), {
      orgId, type: 'credit', amount, by, createdAt: FieldValue.serverTimestamp(),
    });
    return next;
  });
  return { orgId, balance };
});

export const adminListOrgs = onCall({ region: REGION }, async (request) => {
  requireAdmin(request);
  const db = getFirestore();
  const snap = await db.collection('organisations').orderBy('name').get();
  return {
    orgs: snap.docs.map((d) => ({
      id: d.id,
      name: d.data().name,
      balance: d.data().balance ?? 0,
      repo: d.data().github?.repoFullName ?? null,
    })),
  };
});

export const adminSetUserOrg = onCall({ region: REGION }, async (request) => {
  requireAdmin(request);
  const uid = String(request.data?.uid ?? '');
  const orgId = String(request.data?.orgId ?? '');
  if (!uid || !orgId) throw new HttpsError('invalid-argument', 'uid and orgId required.');
  const db = getFirestore();
  if (!(await db.collection('organisations').doc(orgId).get()).exists) {
    throw new HttpsError('not-found', 'Organisation not found.');
  }
  await db.collection('users').doc(uid).set({ orgId }, { merge: true });
  // Custom claim lets security rules + the app scope reads to the user's org.
  await getAuth().setCustomUserClaims(uid, { orgId });
  return { uid, orgId };
});
