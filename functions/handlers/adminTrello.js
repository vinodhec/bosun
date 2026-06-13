import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { listBoards, lists } from '../utils/trello.js';

// Operator-only flow to connect an org's task board for the "Plan a feature" feature. The
// Trello API key + per-user token are stored backend-only in orgSecrets/{orgId}.trello (the
// vault — never readable by, nor returned to, the browser). A NON-secret connection status
// (board/list names, connected flag) is mirrored onto the org doc so the customer's /plan page
// can tell whether their board is ready, without ever seeing the credentials.

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

async function trelloCreds(db, orgId) {
  const snap = await db.collection('orgSecrets').doc(orgId).get();
  const trello = snap.exists ? snap.data().trello : null;
  if (!trello?.key || !trello?.token) throw new HttpsError('failed-precondition', 'NO_BOARD_CREDENTIALS');
  return trello;
}

// Step 1: save the org's Trello key + token (vault-only). Does not pick a board yet.
export const adminConnectTrello = onCall({ region: 'asia-south1' }, async (request) => {
  requireAdmin(request);
  const orgId = String(request.data?.orgId ?? '').trim();
  const key = String(request.data?.key ?? '').trim();
  const token = String(request.data?.token ?? '').trim();
  if (!orgId || !key || !token) throw new HttpsError('invalid-argument', 'orgId, key and token are required.');

  const db = getFirestore();
  const orgRef = db.collection('organisations').doc(orgId);
  if (!(await orgRef.get()).exists) throw new HttpsError('not-found', 'Organisation not found.');

  await db.collection('orgSecrets').doc(orgId).set(
    { trello: { key, token, updatedAt: FieldValue.serverTimestamp() } },
    { merge: true }
  );
  // Connection isn't usable until a target list is picked — reflect that on the org doc.
  await orgRef.set({ trello: { connected: false, hasCredentials: true } }, { merge: true });
  return { ok: true };
});

// Step 2: list the boards visible to the connected token (operator picks one).
export const adminListTrelloBoards = onCall({ region: 'asia-south1' }, async (request) => {
  requireAdmin(request);
  const orgId = String(request.data?.orgId ?? '').trim();
  if (!orgId) throw new HttpsError('invalid-argument', 'orgId required.');
  const db = getFirestore();
  const { key, token } = await trelloCreds(db, orgId);
  try {
    return { boards: await listBoards({ key, token }) };
  } catch (e) {
    console.error('adminListTrelloBoards', orgId, e?.status || '', e?.message || e);
    throw new HttpsError('failed-precondition', 'Could not reach the board. Check the key and token.');
  }
});

// Step 3: list the lists (columns) on a chosen board (operator picks the target list).
export const adminListTrelloLists = onCall({ region: 'asia-south1' }, async (request) => {
  requireAdmin(request);
  const orgId = String(request.data?.orgId ?? '').trim();
  const boardId = String(request.data?.boardId ?? '').trim();
  if (!orgId || !boardId) throw new HttpsError('invalid-argument', 'orgId and boardId required.');
  const db = getFirestore();
  const { key, token } = await trelloCreds(db, orgId);
  try {
    return { lists: await lists({ key, token, boardId }) };
  } catch (e) {
    console.error('adminListTrelloLists', orgId, e?.status || '', e?.message || e);
    throw new HttpsError('failed-precondition', 'Could not load the columns for that board.');
  }
});

// Step 4: save the chosen board + list as the publish target. Credentials stay in the vault;
// the non-secret board/list names land on the org doc so the customer page can show readiness.
export const adminSetTrelloTarget = onCall({ region: 'asia-south1' }, async (request) => {
  requireAdmin(request);
  const orgId = String(request.data?.orgId ?? '').trim();
  const boardId = String(request.data?.boardId ?? '').trim();
  const listId = String(request.data?.listId ?? '').trim();
  const boardName = String(request.data?.boardName ?? '').trim().slice(0, 200);
  const listName = String(request.data?.listName ?? '').trim().slice(0, 200);
  if (!orgId || !boardId || !listId) throw new HttpsError('invalid-argument', 'orgId, boardId and listId required.');

  const db = getFirestore();
  const orgRef = db.collection('organisations').doc(orgId);
  if (!(await orgRef.get()).exists) throw new HttpsError('not-found', 'Organisation not found.');

  await db.collection('orgSecrets').doc(orgId).set(
    { trello: { boardId, listId, boardName, listName, updatedAt: FieldValue.serverTimestamp() } },
    { merge: true }
  );
  await orgRef.set(
    { trello: { connected: true, hasCredentials: true, boardName, listName, connectedAt: FieldValue.serverTimestamp() } },
    { merge: true }
  );
  return { ok: true };
});
