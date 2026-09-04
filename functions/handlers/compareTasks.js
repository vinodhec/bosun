import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { startCompareSession, replyCompareSession, MAX_CLARIFY_TURNS } from '../utils/compareSession.js';
import { designContextFromText } from '../utils/figma.js';
import { saveCompareShots } from '../utils/compareShots.js';
import { firebaseSAsFromSecret, uploadImagesToFiles } from '../utils/claudeAgent.js';
import { agentIdForModel } from '../utils/routeModel.js';
import { sanitizeImages } from '../utils/images.js';
import { sanitizeDocuments } from '../utils/documents.js';
import { resolveOrgId } from '../utils/orgs.js';
import { ANTHROPIC_API_KEY } from '../utils/secrets.js';
import { assertCanStartWork, assertOrgCanStartWork } from '../utils/walletGate.js';

// "Size up the competition" — a standalone, code-aware comparison. The agent reads the owner's OWN
// repo to learn what their site does, weighs it against competitors (fetched server-side and/or the
// owner's screenshots), and produces a two-sided scorecard with scoped, one-tap actions. It's a
// clarify-first managed-agent SESSION (clones the repo, never edits), so it's async — a tasks/{id} of
// kind:'compare' that pollSessions finalizes turn by turn. The phase is charged like design/planning
// (priceForCompare = a flat multiple of its real COGS) when the report is ready. Each action the owner
// taps routes into the normal Fix / Design / Plan pipelines (done client-side), each charged the usual
// way. Nothing is charged until a report is ready.
//
// comparisons/{id}.status: analysing → report_ready (awaitingOwner pauses analysing for the owner;
// failed on a bad session).

// Operational caps for the comparison SESSION — exploration + a text report; cheap. Cumulative across
// clarify turns + refines, since they resume the same session.
const COMPARE_MAX_USD = 1.5;
const COMPARE_MAX_SEC = 1800;

async function loadOrgCtx(db, orgId) {
  const orgSnap = await db.collection('organisations').doc(orgId).get();
  if (!orgSnap.exists) throw new HttpsError('failed-precondition', 'NO_ORG');
  const org = orgSnap.data();
  // Wallet gate: an org in the red cannot start new agent work (utils/walletGate.js).
  assertCanStartWork(org);
  const gh = org.github;
  if (!gh?.repoFullName || !gh?.vaultId) throw new HttpsError('failed-precondition', 'NO_REPO_CONNECTED');
  const secretSnap = await db.collection('orgSecrets').doc(orgId).get();
  const secretData = secretSnap.exists ? secretSnap.data() : {};
  if (!secretData.githubToken) throw new HttpsError('failed-precondition', 'NO_REPO_CONNECTED');
  return { org, gh, secretData };
}

// Start (or restart, on a refine) the comparison session and record it as a kind:'compare' task
// pollSessions will finalize. `ask` is the text the comparison is based on. Returns { taskId }.
async function dispatchCompareSession(db, { comparisonId, userId, orgId, org, gh, secretData, ask, imageFileIds = [], screenshotCount = 0, documents = [] }) {
  // The agent researches competitors itself via its own web_search / web_fetch tools (the managed-agent
  // environment has unrestricted egress) — Bosun does no server-side scraping. We only enrich with a
  // Figma link if the org has one connected (degrades to null on any problem).
  const figmaDesign = await designContextFromText({ org, secretData, text: ask });
  const firebaseSAs = firebaseSAsFromSecret(secretData);
  const { sessionId, firebaseFileIds } = await startCompareSession({
    ask,
    repoUrl: `https://github.com/${gh.repoFullName}`,
    githubToken: secretData.githubToken,
    vaultId: gh.vaultId,
    agentId: agentIdForModel('sonnet'),
    firebaseSAs,
    figmaDesign,
    imageFileIds,
    screenshotCount,
    documents,
  });
  const taskRef = db.collection('tasks').doc();
  await taskRef.set({
    userId,
    orgId,
    comparisonId,
    kind: 'compare',
    status: 'running',
    sessionId,
    firebaseFileIds: firebaseFileIds || [],
    model: 'sonnet',
    maxBudgetUsd: COMPARE_MAX_USD,
    maxSeconds: COMPARE_MAX_SEC,
    reviewedCostUsd: 0,
    reviewedSeconds: 0,
    createdAt: FieldValue.serverTimestamp(),
  });
  return { taskId: taskRef.id, sessionId };
}

// "Size up the competition": kick off the comparison session. We persist the owner's screenshots once
// (Files API) so they carry through refines, fetch competitor + Figma context, and start the session.
// The comparison is created `analysing`; NOTHING is charged or built yet.
export const startComparison = onCall({ region: 'asia-south1', secrets: [ANTHROPIC_API_KEY] }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Please sign in.');
  const prompt = String(request.data?.prompt ?? '').trim();
  if (!prompt) throw new HttpsError('invalid-argument', 'Please tell us what to compare, and who against.');
  const images = sanitizeImages(request.data?.images);
  // Reference documents (a feature checklist, positioning notes) to weigh in the comparison.
  const documents = sanitizeDocuments(request.data?.documents);

  const db = getFirestore();
  const userSnap = await db.collection('users').doc(uid).get();
  const orgId = resolveOrgId(userSnap.exists ? userSnap.data() : null, request.data?.orgId);
  if (!orgId) throw new HttpsError('failed-precondition', 'NO_ORG');
  const { org, gh, secretData } = await loadOrgCtx(db, orgId);

  // Screenshots are OPTIONAL — the owner can compare with words alone (the prompt IS "what to check").
  // When provided, we send them to the agent (Files API, for vision) AND persist them to Storage so the
  // report can show them back ("ours vs theirs"). Both no-op cleanly on an empty list.
  const comparisonRef = db.collection('comparisons').doc();
  const screenshotFileIds = await uploadImagesToFiles(images);
  const screenshotUrls = await saveCompareShots(comparisonRef.id, images);
  await comparisonRef.set({
    userId: uid,
    orgId,
    prompt,
    repoFullName: gh.repoFullName,
    status: 'analysing',
    awaitingOwner: false,
    turns: [{ role: 'owner', text: prompt, at: Date.now() }],
    report: null,
    screenshotFileIds,
    screenshotUrls,        // owner-loadable URLs for the report gallery (empty when none attached)
    imageCount: images.length,
    compareChargeInr: 0,
    compareCostUsd: 0,
    createdAt: FieldValue.serverTimestamp(),
  });

  try {
    const { taskId, sessionId } = await dispatchCompareSession(db, {
      comparisonId: comparisonRef.id, userId: uid, orgId, org, gh, secretData,
      ask: prompt, imageFileIds: screenshotFileIds, screenshotCount: images.length, documents,
    });
    await comparisonRef.update({ compareTaskId: taskId, sessionId });
  } catch (e) {
    console.error('startComparison:dispatch', comparisonRef.id, e?.message || e);
    await comparisonRef.update({ status: 'failed', error: 'compare_dispatch_failed' });
    throw new HttpsError('internal', 'We could not start this comparison. You were not charged.');
  }

  return { comparisonId: comparisonRef.id };
});

// Owner answers the agent's questions (e.g. sends competitor screenshots, names competitors, picks
// which part of the site they mean) → resume the SAME session with their reply + any screenshots.
export const replyToComparison = onCall({ region: 'asia-south1', secrets: [ANTHROPIC_API_KEY] }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Please sign in.');
  const comparisonId = String(request.data?.comparisonId ?? '').trim();
  const answer = String(request.data?.answer ?? '').trim();
  if (!comparisonId) throw new HttpsError('invalid-argument', 'comparisonId required.');
  if (!answer) throw new HttpsError('invalid-argument', 'Please type your answer.');
  const images = sanitizeImages(request.data?.images);

  const db = getFirestore();
  const ref = db.collection('comparisons').doc(comparisonId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Comparison not found.');
  const c = snap.data();
  if (c.userId !== uid) throw new HttpsError('permission-denied', 'Not your comparison.');
  if (c.status !== 'analysing' || !c.awaitingOwner) throw new HttpsError('failed-precondition', 'NOT_AWAITING');
  await assertOrgCanStartWork(db, c.orgId); // wallet gate — see utils/walletGate.js
  if (!c.sessionId || !c.compareTaskId) throw new HttpsError('failed-precondition', 'NO_SESSION');
  const ownerTurns = (Array.isArray(c.turns) ? c.turns : []).filter((t) => t.role === 'owner').length;
  if (ownerTurns > MAX_CLARIFY_TURNS) throw new HttpsError('failed-precondition', 'TOO_MANY_REPLIES');

  // Persist any screenshots the owner attached with their reply, so they join the report gallery too.
  const newUrls = await saveCompareShots(comparisonId, images);
  await ref.update({
    turns: FieldValue.arrayUnion({ role: 'owner', text: answer.slice(0, 1000), at: Date.now() }),
    awaitingOwner: false,
    ...(newUrls.length ? { screenshotUrls: FieldValue.arrayUnion(...newUrls) } : {}),
  });
  try {
    await replyCompareSession({ sessionId: c.sessionId, answer, images });
    await db.collection('tasks').doc(c.compareTaskId).update({ status: 'running' });
  } catch (e) {
    console.error('replyToComparison', comparisonId, e?.message || e);
    await ref.update({ awaitingOwner: true }); // let them retry
    throw new HttpsError('internal', 'We could not send your answer. Please try again.');
  }
  return { ok: true };
});

// Owner wants the comparison re-run (look again / focus on something) → resume the session with the
// note; a fresh report is produced and charged as a cheap refine (priceForCompare isRefine).
export const refineComparison = onCall({ region: 'asia-south1', secrets: [ANTHROPIC_API_KEY] }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Please sign in.');
  const comparisonId = String(request.data?.comparisonId ?? '').trim();
  const changes = String(request.data?.changes ?? '').trim();
  if (!comparisonId) throw new HttpsError('invalid-argument', 'comparisonId required.');
  if (!changes) throw new HttpsError('invalid-argument', 'Please describe what to look at again.');

  const db = getFirestore();
  const ref = db.collection('comparisons').doc(comparisonId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Comparison not found.');
  const c = snap.data();
  if (c.userId !== uid) throw new HttpsError('permission-denied', 'Not your comparison.');
  if (c.status !== 'report_ready') throw new HttpsError('failed-precondition', 'NOT_REVIEWABLE');
  await assertOrgCanStartWork(db, c.orgId); // wallet gate — a refine is another paid run
  if (!c.sessionId || !c.compareTaskId) throw new HttpsError('failed-precondition', 'NO_SESSION');

  await ref.update({
    status: 'analysing',
    awaitingOwner: false,
    turns: FieldValue.arrayUnion({ role: 'owner', text: changes.slice(0, 1000), at: Date.now() }),
  });
  try {
    await replyCompareSession({ sessionId: c.sessionId, answer: `Please look again: ${changes}` });
    await db.collection('tasks').doc(c.compareTaskId).update({ status: 'running' });
  } catch (e) {
    console.error('refineComparison', comparisonId, e?.message || e);
    await ref.update({ status: 'report_ready' }); // leave the existing report intact to retry
    throw new HttpsError('internal', 'We could not start that. Your comparison is unchanged.');
  }
  return { ok: true };
});

// Customer-facing view of their comparisons, newest first: the clarify chat, the two-sided scorecard,
// and the scoped findings (each routes into Fix / Design / Plan on the client). Strips operator fields.
export const listMyComparisons = onCall({ region: 'asia-south1' }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Please sign in.');
  const db = getFirestore();

  const userSnap = await db.collection('users').doc(uid).get();
  const orgId = resolveOrgId(userSnap.exists ? userSnap.data() : null, request.data?.orgId);
  if (!orgId) return { comparisons: [] };

  const snap = await db
    .collection('comparisons')
    .where('userId', '==', uid)
    .where('orgId', '==', orgId)
    .orderBy('createdAt', 'desc')
    .limit(10)
    .get();
  if (snap.empty) return { comparisons: [] };

  const comparisons = snap.docs.map((doc) => {
    const c = doc.data();
    return {
      id: doc.id,
      prompt: c.prompt || '',
      status: c.status || 'analysing', // analysing | report_ready | failed
      awaitingOwner: !!c.awaitingOwner,
      turns: Array.isArray(c.turns) ? c.turns : [],
      report: c.report || null,
      reportUrl: c.reportUrl || null, // durable shareable HTML (Storage), like a design's mockUrl
      screenshotUrls: Array.isArray(c.screenshotUrls) ? c.screenshotUrls : [],
      compareChargeInr: Number(c.compareChargeInr) || 0,
      totalPaidInr: Number(c.compareChargeInr) || 0,
      createdAt: c.createdAt?.toMillis?.() ?? null,
    };
  });

  return { comparisons };
});
