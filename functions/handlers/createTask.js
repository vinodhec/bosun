import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { tierFor, requiredBalanceFor } from '../utils/billing.js';
import { classifyComplexity } from '../utils/classify.js';
import { fetchRepoTree } from '../utils/github.js';
import { startFixSession } from '../utils/claudeAgent.js';
import { modelForComplexity, agentIdForModel } from '../utils/routeModel.js';
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

  // The GitHub token (operator-provisioned) is backend-only — never exposed to clients. We
  // need it both to mount the repo for the agent AND to read the file map for classification.
  const secretSnap = await db.collection('orgSecrets').doc(orgId).get();
  const githubToken = secretSnap.exists ? secretSnap.data().githubToken : null;
  if (!githubToken) throw new HttpsError('failed-precondition', 'NO_REPO_CONNECTED');

  // Complexity drives BOTH the model and the hard budget cap, so the spend cap always
  // matches the tier we quoted. An explicit valid value (estimate step) is trusted as-is;
  // otherwise we classify here — code-aware, feeding the classifier the repo's real file
  // map so it judges scope against the actual project instead of the request text alone.
  // Server-authoritative either way; the repo read is best-effort (falls back to text-only).
  let complexity = String(request.data?.complexity ?? '').trim();
  if (!['simple', 'medium', 'complex', 'large'].includes(complexity)) {
    const repoTree = await fetchRepoTree(gh.repoFullName, githubToken).catch(() => null);
    ({ complexity } = await classifyComplexity(prompt, { repoTree }));
  }

  // BIG JOBS: a 'large' task is bigger than our standard tiers — it has no fixed price. We
  // park it for the operator to quote (adminQuoteTask); nothing runs and nothing is charged
  // until the customer confirms the quote (confirmQuote).
  if (complexity === 'large') {
    const quoteRef = db.collection('tasks').doc();
    await quoteRef.set({
      userId: uid,
      orgId,
      prompt,
      repoFullName: gh.repoFullName,
      kind: 'initial',
      complexity: 'large',
      status: 'needs_quote',
      billed: false,
      approved: false,
      pendingReview: false,
      finalCharge: 0,
      currentRoundCharge: 0,
      freeRevisionsUsed: 0,
      imageCount: images.length, // screenshots aren't carried to the deferred run
      createdAt: FieldValue.serverTimestamp(),
    });
    return { taskId: quoteRef.id, needsQuote: true };
  }

  // Bind the agent's hard budget cap to the tier (NOT a flat global cap), so a "simple"
  // run can never spend the "complex" budget. The customer pays the FIXED tier price on
  // approval; `required` is that price — gate on it so we never run work we can't bill.
  const rate = Number(process.env.USD_TO_INR) || undefined;
  const tier = tierFor(complexity);
  const maxBudgetUsd = tier.maxBudgetUsd;
  const maxSeconds = tier.maxSeconds; // tier runtime cap — second guard alongside the $ cap
  const priceInr = tier.priceInr;
  const required = requiredBalanceFor(complexity, { rate });

  const balance = Number(org.balance ?? 0);
  if (balance < required) throw new HttpsError('failed-precondition', `INSUFFICIENT_BALANCE:${required}`);

  // Cost-aware routing: Sonnet handles all but `complex` fixes; Opus is reserved for those.
  const model = modelForComplexity(complexity);
  const repoUrl = `https://github.com/${gh.repoFullName}`;
  const taskRef = db.collection('tasks').doc();
  await taskRef.set({
    userId: uid,
    orgId,
    prompt,
    repoFullName: gh.repoFullName,
    kind: 'initial',
    complexity: complexity || null,
    model,
    status: 'queued',
    billed: false,
    approved: false,
    pendingReview: false,
    maxBudgetUsd,
    maxSeconds,
    priceInr, // the fixed price this fix will cost on approval
    currentRoundCharge: priceInr, // owed for the current (initial) cycle; charged on approval
    finalCharge: 0,
    freeRevisionsUsed: 0,
    // Metadata the poller folds into the round thread when the agent finishes.
    pendingRound: { kind: 'initial', reason: null, addedInr: priceInr, prompt },
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
