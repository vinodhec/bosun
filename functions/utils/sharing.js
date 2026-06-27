import { HttpsError } from 'firebase-functions/v2/https';
import { isMember } from './orgs.js';

// Share & fork helpers, shared by the design / fix / feature share callables. A member of the SAME
// organisation can open a shared item and fork it into their own. Access is always through callables
// (Admin SDK) returning a safe projection — we never open the owner-only doc to other members via
// rules. The shareToken is an unguessable capability so doc ids can't be probed.

// Verify the requester is a member of the item's org (read from their own users doc).
export async function requireOrgMember(db, uid, orgId) {
  const userSnap = await db.collection('users').doc(uid).get();
  if (!isMember(userSnap.exists ? userSnap.data() : null, orgId)) {
    throw new HttpsError('permission-denied', 'NOT_A_MEMBER');
  }
}

// Load a shared doc and verify the requester may see it: it exists, sharing is on, the token matches,
// and the requester is a member of its org. Returns { ref, d }.
export async function loadShared(db, collection, uid, id, shareToken) {
  if (!id) throw new HttpsError('invalid-argument', 'id required.');
  const ref = db.collection(collection).doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'NOT_FOUND');
  const d = snap.data();
  if (!d.shared || !d.shareToken || d.shareToken !== String(shareToken || '')) {
    throw new HttpsError('permission-denied', 'NOT_SHARED');
  }
  await requireOrgMember(db, uid, d.orgId);
  return { ref, d };
}
