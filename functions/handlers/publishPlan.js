import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { priceForPlan } from '../utils/billing.js';
import { normalisePlanTasks } from '../utils/planTasks.js';
import { createCard } from '../utils/trello.js';

// Build a Trello card description from a task: the description, then a bullet list of
// acceptance criteria, then any dependencies. Markdown — Trello renders it on the card.
function cardDescription(task) {
  const parts = [];
  if (task.description) parts.push(task.description);
  if (task.acceptanceCriteria?.length) {
    parts.push(['**Acceptance criteria**', ...task.acceptanceCriteria.map((c) => `- ${c}`)].join('\n'));
  }
  if (task.dependsOn?.length) {
    parts.push(`**Needs first:** ${task.dependsOn.join(', ')}`);
  }
  return parts.join('\n\n');
}

// "Plan a feature" — step 2 (PUBLISH, CHARGED). Takes the owner-approved/edited task list and
// publishes one card per task to the org's connected task board, then bills the flat plan price
// ONCE. Idempotent via a client-supplied planId (the doc id), so a retry of the same publish
// never duplicates cards or double-charges. Charge lands only on a successful publish — if the
// board writes fail, the task is marked failed and nothing is charged.
export const publishPlan = onCall({ region: 'asia-south1' }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Please sign in.');

  const planId = String(request.data?.planId ?? '').trim();
  if (!planId || !/^[A-Za-z0-9_-]{6,64}$/.test(planId)) {
    throw new HttpsError('invalid-argument', 'A valid planId is required.');
  }
  const tasks = normalisePlanTasks(request.data?.tasks);
  if (!tasks.length) throw new HttpsError('invalid-argument', 'Add at least one task before sending.');
  const featurePrompt = String(request.data?.prompt ?? '').trim().slice(0, 2000);

  const db = getFirestore();

  const userSnap = await db.collection('users').doc(uid).get();
  const orgId = userSnap.exists ? userSnap.data().orgId : null;
  if (!orgId) throw new HttpsError('failed-precondition', 'NO_ORG');

  const orgSnap = await db.collection('organisations').doc(orgId).get();
  if (!orgSnap.exists) throw new HttpsError('failed-precondition', 'NO_ORG');
  const org = orgSnap.data();

  const price = priceForPlan();
  if ((Number(org.balance) || 0) < price) throw new HttpsError('failed-precondition', 'LOW_BALANCE');

  // Board credentials live in the vault (orgSecrets) — backend-only, never sent to the client.
  const secretSnap = await db.collection('orgSecrets').doc(orgId).get();
  const trello = secretSnap.exists ? secretSnap.data().trello : null;
  if (!trello?.key || !trello?.token || !trello?.listId) {
    throw new HttpsError('failed-precondition', 'NO_BOARD_CONNECTED');
  }

  // The plan task doc id IS the idempotency key. Two identical publishes resolve to the same doc.
  const taskRef = db.collection('tasks').doc(`plan_${planId}`);

  // Short-circuit: already published → return its cards, no new cards and no new charge.
  const existing = await taskRef.get();
  if (existing.exists && existing.data().status === 'complete') {
    return { cards: existing.data().cards || [], alreadyPublished: true, charged: 0 };
  }

  // Lock the planId so a duplicate concurrent publish can't double-create cards. The doc is
  // created (status 'publishing') only if it doesn't already exist in a terminal state.
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(taskRef);
    if (snap.exists && snap.data().status === 'complete') return; // race — handled by short-circuit below
    tx.set(
      taskRef,
      {
        type: 'plan',
        userId: uid,
        orgId,
        prompt: featurePrompt,
        planId,
        tasks,
        boardId: trello.boardId || null,
        listId: trello.listId,
        status: 'publishing',
        billed: false,
        finalCharge: 0,
        cards: [],
        createdAt: FieldValue.serverTimestamp(),
      },
      { merge: true }
    );
  });

  // Create one card per task (network — outside any transaction).
  const cards = [];
  try {
    for (const task of tasks) {
      const card = await createCard({
        key: trello.key,
        token: trello.token,
        listId: trello.listId,
        name: task.title,
        desc: cardDescription(task),
      });
      cards.push({ id: card.id, url: card.url, title: task.title });
    }
  } catch (e) {
    console.error('publishPlan:trello', taskRef.id, e?.status || '', e?.message || e);
    await taskRef.update({ status: 'failed', error: 'board_write_failed' });
    throw new HttpsError('internal', 'We could not add the tasks to your board. You were not charged.');
  }

  // Bill once, atomically, gated on billed:false — same pattern as the fix flow.
  const charged = await db.runTransaction(async (tx) => {
    const snap = await tx.get(taskRef);
    if (snap.data()?.billed) return 0; // already charged — idempotent

    const orgRef = db.collection('organisations').doc(orgId);
    const oSnap = await tx.get(orgRef);
    const balance = oSnap.exists ? Number(oSnap.data().balance ?? 0) : 0;

    tx.update(orgRef, { balance: balance - price });
    tx.set(db.collection('transactions').doc(), {
      orgId,
      userId: uid,
      type: 'debit',
      amount: price,
      taskId: taskRef.id,
      kind: 'plan',
      createdAt: FieldValue.serverTimestamp(),
    });
    tx.update(taskRef, {
      status: 'complete',
      billed: true,
      finalCharge: price,
      cards,
      completedAt: FieldValue.serverTimestamp(),
    });
    return price;
  });

  return { cards, charged };
});
