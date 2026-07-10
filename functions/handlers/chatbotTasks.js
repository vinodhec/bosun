import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { startChatSession, replyChatSession, buildChatSession, MAX_CLARIFY_TURNS } from '../utils/chatbotSession.js';
import { designContextFromText } from '../utils/figma.js';
import { firebaseSAsFromSecret, uploadImagesToFiles } from '../utils/claudeAgent.js';
import { agentIdForModel } from '../utils/routeModel.js';
import { sanitizeImages } from '../utils/images.js';
import { sanitizeDocuments } from '../utils/documents.js';
import { resolveOrgId } from '../utils/orgs.js';
import { ANTHROPIC_API_KEY } from '../utils/secrets.js';
import { chatChargeEstimateInr } from '../utils/billing.js';

// "Chat & build" callables — one warm session that clarifies then builds (see utils/chatbotSession.js).
// A chat is a tasks/{id} of kind:'chatbot' pollSessions finalizes turn by turn; the customer-facing
// state lives on chats/{id} (owner-read, backend-write — the cardinal rule). Nothing is charged until
// a build completes; the whole session bills ONCE (priceForChat), inside the poller.

// Operational caps for the chat SESSION. maxBudgetUsd is the COGS that maps to the ₹1500 charge cap:
// charge = COGS × 1.18 GST × ~85 ₹·$⁻¹ × 3 markup ≈ COGS × 300.9, so ₹1500 lands at ≈ $4.98 COGS.
// The poller terminates the session there so a run can't burn COGS past what the cap lets us bill.
// Cumulative across clarify turns + the build, since they share one warm session.
const CHAT_MAX_USD = 5;
const CHAT_MAX_SEC = 2400;

async function loadOrgCtx(db, orgId) {
  const orgSnap = await db.collection('organisations').doc(orgId).get();
  if (!orgSnap.exists) throw new HttpsError('failed-precondition', 'NO_ORG');
  const org = orgSnap.data();
  const gh = org.github;
  if (!gh?.repoFullName || !gh?.vaultId) throw new HttpsError('failed-precondition', 'NO_REPO_CONNECTED');
  const secretSnap = await db.collection('orgSecrets').doc(orgId).get();
  const secretData = secretSnap.exists ? secretSnap.data() : {};
  if (!secretData.githubToken) throw new HttpsError('failed-precondition', 'NO_REPO_CONNECTED');
  return { org, gh, secretData };
}

// Start the chat session and record it as a kind:'chatbot' task pollSessions finalizes.
async function dispatchChatSession(db, { chatId, userId, orgId, org, gh, secretData, ask, imageFileIds = [], screenshotCount = 0, images = [], documents = [] }) {
  const figmaDesign = await designContextFromText({ org, secretData, text: ask });
  const firebaseSAs = firebaseSAsFromSecret(secretData);
  const { sessionId, firebaseFileIds } = await startChatSession({
    ask,
    repoUrl: `https://github.com/${gh.repoFullName}`,
    githubToken: secretData.githubToken,
    vaultId: gh.vaultId,
    agentId: agentIdForModel('sonnet'),
    firebaseSAs, figmaDesign, imageFileIds, screenshotCount, images, documents,
  });
  const taskRef = db.collection('tasks').doc();
  await taskRef.set({
    userId, orgId, chatId,
    kind: 'chatbot',
    status: 'running',
    sessionId,
    firebaseFileIds: firebaseFileIds || [],
    model: 'sonnet',
    maxBudgetUsd: CHAT_MAX_USD,
    maxSeconds: CHAT_MAX_SEC,
    reviewedCostUsd: 0,
    reviewedSeconds: 0,
    createdAt: FieldValue.serverTimestamp(),
  });
  return { taskId: taskRef.id, sessionId };
}

// Kick off a chat. Persists the owner's screenshots once (Files API) so they carry into every turn +
// the build, fetches any Figma design, and starts the session. Created `clarifying`; nothing charged.
export const startChat = onCall({ region: 'asia-south1', secrets: [ANTHROPIC_API_KEY] }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Please sign in.');
  const prompt = String(request.data?.prompt ?? '').trim();
  if (!prompt) throw new HttpsError('invalid-argument', 'Please tell me what you need.');
  const images = sanitizeImages(request.data?.images);
  const documents = sanitizeDocuments(request.data?.documents);

  const db = getFirestore();
  const userSnap = await db.collection('users').doc(uid).get();
  const orgId = resolveOrgId(userSnap.exists ? userSnap.data() : null, request.data?.orgId);
  if (!orgId) throw new HttpsError('failed-precondition', 'NO_ORG');
  const { org, gh, secretData } = await loadOrgCtx(db, orgId);

  const screenshotFileIds = await uploadImagesToFiles(images);

  const chatRef = db.collection('chats').doc();
  await chatRef.set({
    userId: uid, orgId, prompt,
    repoFullName: gh.repoFullName,
    status: 'clarifying',
    awaitingOwner: false,
    turns: [{ role: 'owner', text: prompt, at: Date.now() }],
    summary: '',
    mockHtml: null,
    prUrl: null,
    previewUrl: null,
    screenshotFileIds,
    imageCount: images.length,
    chatChargeInr: 0,
    chatCostUsd: 0,
    createdAt: FieldValue.serverTimestamp(),
  });

  try {
    const { taskId, sessionId } = await dispatchChatSession(db, {
      chatId: chatRef.id, userId: uid, orgId, org, gh, secretData,
      ask: prompt, imageFileIds: screenshotFileIds, screenshotCount: images.length, documents,
    });
    await chatRef.update({ chatTaskId: taskId, sessionId });
  } catch (e) {
    console.error('startChat:dispatch', chatRef.id, e?.message || e);
    await chatRef.update({ status: 'failed', error: 'chat_dispatch_failed' });
    throw new HttpsError('internal', 'We could not start the chat. You were not charged.');
  }

  return { chatId: chatRef.id };
});

// Load a chat the caller owns in a resumable state. Returns { ref, c }.
async function loadOwnedChat(db, uid, chatId) {
  if (!chatId) throw new HttpsError('invalid-argument', 'chatId required.');
  const ref = db.collection('chats').doc(chatId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Chat not found.');
  const c = snap.data();
  if (c.userId !== uid) throw new HttpsError('permission-denied', 'Not your chat.');
  return { ref, c };
}

// Owner replies during clarifying → resume the SAME session with their answer (+ optional screenshots).
// The soft budget rail lives here: once the running charge estimate crosses CHATBOT_SOFT_INR we stop
// taking new turns and steer the owner to approve the build (leaving headroom to finish it).
export const replyToChat = onCall({ region: 'asia-south1', secrets: [ANTHROPIC_API_KEY] }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Please sign in.');
  const chatId = String(request.data?.chatId ?? '').trim();
  const answer = String(request.data?.answer ?? '').trim();
  const images = sanitizeImages(request.data?.images);
  if (answer === '' && images.length === 0) throw new HttpsError('invalid-argument', 'Please type your answer.');

  const db = getFirestore();
  const { ref, c } = await loadOwnedChat(db, uid, chatId);
  if (!['clarifying', 'ready_to_build', 'previewing'].includes(c.status) || !c.awaitingOwner) {
    throw new HttpsError('failed-precondition', 'NOT_AWAITING');
  }
  if (!c.sessionId || !c.chatTaskId) throw new HttpsError('failed-precondition', 'NO_SESSION');
  const ownerTurns = (Array.isArray(c.turns) ? c.turns : []).filter((t) => t.role === 'owner').length;
  if (ownerTurns > MAX_CLARIFY_TURNS) throw new HttpsError('failed-precondition', 'TOO_MANY_REPLIES');

  // Soft rail: if we've already spent enough that another exploratory turn risks the cap, don't take it.
  const taskSnap = await db.collection('tasks').doc(c.chatTaskId).get();
  const liveUsd = taskSnap.exists ? Number(taskSnap.data().liveCostUsd || taskSnap.data().reviewedCostUsd || 0) : 0;
  if (chatChargeEstimateInr(liveUsd).softHit) {
    throw new HttpsError('resource-exhausted', 'BUDGET_SOFT');
  }

  const turnText = answer || `🖼️ ${images.length} screenshot${images.length > 1 ? 's' : ''}`;
  await ref.update({
    turns: FieldValue.arrayUnion({ role: 'owner', text: turnText.slice(0, 1000), at: Date.now() }),
    awaitingOwner: false,
    status: 'clarifying',
  });
  try {
    await replyChatSession({ sessionId: c.sessionId, answer: answer || 'See the attached screenshot(s).', images });
    await db.collection('tasks').doc(c.chatTaskId).update({ status: 'running' });
  } catch (e) {
    console.error('replyToChat', chatId, e?.message || e);
    await ref.update({ awaitingOwner: true });
    throw new HttpsError('internal', 'We could not send your reply. Please try again.');
  }
  return { ok: true };
});

// Owner approves → resume the SAME warm session to BUILD it for real (open a PR). Status → building;
// the poller finalizes the build turn (opens/tracks the PR) and charges the whole session ONCE.
export const approveChatBuild = onCall({ region: 'asia-south1', secrets: [ANTHROPIC_API_KEY] }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Please sign in.');
  const chatId = String(request.data?.chatId ?? '').trim();
  const notes = String(request.data?.notes ?? '').trim().slice(0, 1000);

  const db = getFirestore();
  const { ref, c } = await loadOwnedChat(db, uid, chatId);
  if (!['ready_to_build', 'previewing'].includes(c.status) || !c.awaitingOwner) {
    throw new HttpsError('failed-precondition', 'NOT_READY');
  }
  if (!c.sessionId || !c.chatTaskId) throw new HttpsError('failed-precondition', 'NO_SESSION');

  await ref.update({
    status: 'building',
    awaitingOwner: false,
    turns: FieldValue.arrayUnion({ role: 'owner', text: notes ? `Go ahead — ${notes}`.slice(0, 1000) : 'Go ahead and make the change.', at: Date.now() }),
  });
  try {
    await buildChatSession({ sessionId: c.sessionId, notes });
    await db.collection('tasks').doc(c.chatTaskId).update({ status: 'running' });
  } catch (e) {
    console.error('approveChatBuild', chatId, e?.message || e);
    await ref.update({ status: c.status }); // leave it reviewable to retry
    throw new HttpsError('internal', 'We could not start building. Please try again.');
  }
  return { ok: true };
});

// The preview mock's raw HTML, owner-only — rendered client-side in a sandboxed iframe (kept OUT of
// listMyChats so that projection stays lean; the HTML is tens of KB).
export const getChatMockHtml = onCall({ region: 'asia-south1' }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Please sign in.');
  const chatId = String(request.data?.chatId ?? '').trim();
  if (!chatId) throw new HttpsError('invalid-argument', 'chatId required.');
  const db = getFirestore();
  const snap = await db.collection('chats').doc(chatId).get();
  if (!snap.exists) throw new HttpsError('not-found', 'Chat not found.');
  if (snap.data().userId !== uid) throw new HttpsError('permission-denied', 'Not your chat.');
  return { mockHtml: snap.data().mockHtml || '' };
});

// Customer-facing view of the owner's chats, newest first. Strips operator-only fields (session, task,
// raw cost). The chat thread, the ready/preview summary, and — once built — the PR/preview links.
export const listMyChats = onCall({ region: 'asia-south1' }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Please sign in.');
  const db = getFirestore();
  const userSnap = await db.collection('users').doc(uid).get();
  const orgId = resolveOrgId(userSnap.exists ? userSnap.data() : null, request.data?.orgId);
  if (!orgId) return { chats: [] };

  const snap = await db
    .collection('chats')
    .where('userId', '==', uid)
    .where('orgId', '==', orgId)
    .orderBy('createdAt', 'desc')
    .limit(10)
    .get();
  if (snap.empty) return { chats: [] };

  const chats = snap.docs.map((doc) => {
    const c = doc.data();
    return {
      id: doc.id,
      prompt: c.prompt || '',
      status: c.status || 'clarifying', // clarifying | ready_to_build | previewing | building | complete | failed
      awaitingOwner: !!c.awaitingOwner,
      turns: Array.isArray(c.turns) ? c.turns : [],
      summary: c.summary || '',
      mockUrl: c.mockUrl || null, // the visual preview mock (iframe), while previewing
      previewUrl: c.previewUrl || null, // the built change's live preview, once available
      chatChargeInr: Number(c.chatChargeInr) || 0,
      totalPaidInr: Number(c.chatChargeInr) || 0,
      createdAt: c.createdAt?.toMillis?.() ?? null,
    };
  });
  return { chats };
});
