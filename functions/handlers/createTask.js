import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { maxChargeForBudget } from '../utils/billing.js';
import { startFixSession } from '../utils/claudeAgent.js';
import { chooseModel, agentIdForModel } from '../utils/routeModel.js';
import { ANTHROPIC_API_KEY } from '../utils/secrets.js';

// Validate balance + the org's connected repo, create the task, and start a managed-agent
// session. The user is NOT charged here — billing happens in pollSessions after success.
export const createTask = onCall({ region: 'asia-south1', secrets: [ANTHROPIC_API_KEY] }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Please sign in.');

  const prompt = String(request.data?.prompt ?? '').trim();
  if (!prompt) throw new HttpsError('invalid-argument', 'Please describe what is broken.');

  // Optional screenshots the owner pasted in (base64). Validated + capped before we
  // forward them to the agent so a screenshot can show what words can't.
  const images = sanitizeImages(request.data?.images);

  // No upfront estimate: run the fix, then charge actual cost × 2.5. A single flat budget
  // cap guards against a runaway run and sets the balance we require to start.
  const rate = Number(process.env.USD_TO_INR) || undefined;
  const maxBudgetUsd = Number(process.env.AGENT_MAX_BUDGET_USD) || 3;
  const required = maxChargeForBudget(maxBudgetUsd, { rate });

  const db = getFirestore();

  // The user's organisation holds both the credits and the connected repo.
  const userSnap = await db.collection('users').doc(uid).get();
  const orgId = userSnap.exists ? userSnap.data().orgId : null;
  if (!orgId) throw new HttpsError('failed-precondition', 'NO_ORG');

  const orgSnap = await db.collection('organisations').doc(orgId).get();
  if (!orgSnap.exists) throw new HttpsError('failed-precondition', 'NO_ORG');
  const org = orgSnap.data();

  const gh = org.github;
  if (!gh?.repoFullName || !gh?.vaultId) throw new HttpsError('failed-precondition', 'NO_REPO_CONNECTED');

  const balance = Number(org.balance ?? 0);
  if (balance < required) throw new HttpsError('failed-precondition', `INSUFFICIENT_BALANCE:${required}`);

  // The GitHub token (operator-provisioned) is backend-only — never exposed to clients.
  const secretSnap = await db.collection('orgSecrets').doc(orgId).get();
  const githubToken = secretSnap.exists ? secretSnap.data().githubToken : null;
  if (!githubToken) throw new HttpsError('failed-precondition', 'NO_REPO_CONNECTED');

  // Conservative model routing: Sonnet for trivial cosmetic fixes, else Opus.
  const model = await chooseModel(prompt);
  const repoUrl = `https://github.com/${gh.repoFullName}`;
  const taskRef = db.collection('tasks').doc();
  await taskRef.set({
    userId: uid,
    orgId,
    prompt,
    repoFullName: gh.repoFullName,
    kind: 'initial',
    model,
    status: 'queued',
    billed: false,
    maxBudgetUsd,
    imageCount: images.length, // we don't persist the screenshots, only that there were some
    createdAt: FieldValue.serverTimestamp(),
  });

  try {
    const { sessionId } = await startFixSession({ prompt, images, repoUrl, githubToken, vaultId: gh.vaultId, agentId: agentIdForModel(model) });
    await taskRef.update({ status: 'running', sessionId });
  } catch {
    await taskRef.update({ status: 'failed', error: 'dispatch_failed' });
    throw new HttpsError('internal', 'We could not start the fix. You were not charged.');
  }

  return { taskId: taskRef.id };
});

// Screenshots are sent inline as base64 (we never store them — better for privacy and
// no cleanup). Keep this in sync with the client-side guard in Dashboard.jsx.
const MAX_IMAGES = 2;
const ALLOWED_MEDIA = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const MAX_IMAGE_B64 = 5 * 1024 * 1024; // ~3.7 MB decoded per image — well within callable limits

function sanitizeImages(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const out = [];
  for (const img of raw.slice(0, MAX_IMAGES)) {
    const mediaType = String(img?.mediaType ?? img?.media_type ?? '').toLowerCase();
    const data = typeof img?.data === 'string' ? img.data : '';
    if (!ALLOWED_MEDIA.has(mediaType)) {
      throw new HttpsError('invalid-argument', 'Only PNG, JPG, WEBP or GIF screenshots are allowed.');
    }
    if (!data || data.length > MAX_IMAGE_B64) {
      throw new HttpsError('invalid-argument', 'Each screenshot must be under ~3.5 MB.');
    }
    out.push({ mediaType, data });
  }
  return out;
}
