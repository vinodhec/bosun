import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { tierFor } from '../utils/billing.js';
import { classifyComplexity } from '../utils/classify.js';
import { startFixSession, firebaseSAsFromSecret } from '../utils/claudeAgent.js';
import { designContextFromText } from '../utils/figma.js';
import { modelForComplexity, agentIdForModel } from '../utils/routeModel.js';
import { sanitizeImages } from '../utils/images.js';
import { sanitizeDocuments } from '../utils/documents.js';
import { resolveOrgId } from '../utils/orgs.js';
import { ANTHROPIC_API_KEY } from '../utils/secrets.js';

// Normalise the optional "which page?" field: trim, cap length, add https:// to a bare domain, and
// return null if it isn't a parseable URL so nothing junky is stored or fed to the agent.
function sanitizePageUrl(raw) {
  let s = String(raw ?? '').trim();
  if (!s) return null;
  if (s.length > 500) s = s.slice(0, 500);
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  try { return new URL(s).toString(); } catch { return null; }
}

// Validate balance + the org's connected repo, create the task, and start a managed-agent
// session. The user is NOT charged here — billing happens in pollSessions after success.
export const createTask = onCall({ region: 'asia-south1', secrets: [ANTHROPIC_API_KEY] }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Please sign in.');

  const prompt = String(request.data?.prompt ?? '').trim();
  if (!prompt) throw new HttpsError('invalid-argument', 'Please describe what is broken.');

  // Complexity drives BOTH the model and the hard budget cap, so the spend cap always
  // matches the tier we quoted. The estimate step (classifyTask) passes it; the quick-fix
  // path (Dashboard) sends none, so we classify here — server-authoritative either way.
  let complexity = String(request.data?.complexity ?? '').trim();
  if (!['simple', 'medium', 'complex', 'large'].includes(complexity)) {
    ({ complexity } = await classifyComplexity(prompt));
  }

  // Optional screenshots the owner pasted in (base64). Validated + capped before we
  // forward them to the agent so a screenshot can show what words can't.
  const images = sanitizeImages(request.data?.images);

  // Optional reference documents (a CSV page plan, a spec) the owner attached (inline text). The
  // agent treats them as the source of truth for exact values / per-page details. Not persisted.
  const documents = sanitizeDocuments(request.data?.documents);

  // Optional: the page on the owner's live site where the problem shows. A LOCALIZATION hint for
  // the agent (matched against AGENTS.md's route map to find the source file) — never browsed. We
  // normalise a bare domain to https, cap the length, and drop anything that isn't a plausible URL
  // so junk never reaches the prompt.
  const pageUrl = sanitizePageUrl(request.data?.pageUrl);

  const db = getFirestore();

  // The user's organisation holds both the credits and the connected repo. A user may belong to
  // several orgs; the fix targets the one the client passes (their active org), verified here.
  const userSnap = await db.collection('users').doc(uid).get();
  const orgId = resolveOrgId(userSnap.exists ? userSnap.data() : null, request.data?.orgId);
  if (!orgId) throw new HttpsError('failed-precondition', 'NO_ORG');

  const orgSnap = await db.collection('organisations').doc(orgId).get();
  if (!orgSnap.exists) throw new HttpsError('failed-precondition', 'NO_ORG');
  const org = orgSnap.data();

  const gh = org.github;
  if (!gh?.repoFullName || !gh?.vaultId) throw new HttpsError('failed-precondition', 'NO_REPO_CONNECTED');

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
      documentCount: documents.length, // nor are attached documents
      pageUrl: pageUrl || null, // but the page hint IS carried into confirmQuote's run
      createdAt: FieldValue.serverTimestamp(),
    });
    return { taskId: quoteRef.id, needsQuote: true };
  }

  // Bind the agent's hard budget cap to the tier (NOT a flat global cap), so a "simple"
  // run can never spend the "complex" budget. Price is bracketed cost-plus — computed
  // from actual COGS in markRoundReady once the run finishes; nothing is quoted upfront.
  // Balance is NOT gated — orgs are allowed to go negative; the operator reconciles via
  // top-ups or manual deductions.
  const tier = tierFor(complexity);
  const maxBudgetUsd = tier.maxBudgetUsd;
  const maxSeconds = tier.maxSeconds; // tier runtime cap — second guard alongside the $ cap

  // The GitHub token (operator-provisioned) is backend-only — never exposed to clients.
  // The same backend-only doc may hold read-only Firebase service-account keys for the org.
  const secretSnap = await db.collection('orgSecrets').doc(orgId).get();
  const secretData = secretSnap.exists ? secretSnap.data() : {};
  const githubToken = secretData.githubToken;
  if (!githubToken) throw new HttpsError('failed-precondition', 'NO_REPO_CONNECTED');
  const firebaseSAs = firebaseSAsFromSecret(secretData);

  // If the owner pasted a Figma link AND the org has a connected Figma account, pull the design
  // (exact spec + rendered image) so the agent can build it pixel-perfect. Degrades to null on any
  // problem — a design link must never block the fix.
  const figmaDesign = await designContextFromText({ org, secretData, text: prompt });

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
    currentRoundCharge: 0, // bracketed price is computed in markRoundReady from actual COGS
    finalCharge: 0,
    freeRevisionsUsed: 0,
    // Metadata the poller folds into the round thread when the agent finishes.
    pendingRound: { kind: 'initial', reason: null, addedInr: 0, prompt },
    imageCount: images.length, // we don't persist the screenshots, only that there were some
    documentCount: documents.length, // nor the documents, only that there were some
    pageUrl: pageUrl || null, // the page the owner pointed us at (localization hint), if any
    createdAt: FieldValue.serverTimestamp(),
  });

  try {
    const { sessionId, firebaseFileIds } = await startFixSession({ prompt, images, repoUrl, githubToken, vaultId: gh.vaultId, agentId: agentIdForModel(model), firebaseSAs, figmaDesign, pageUrl, documents });
    await taskRef.update({ status: 'running', sessionId, firebaseFileIds: firebaseFileIds || [] });
  } catch (e) {
    // Surface the real cause to the operator (Cloud Logging + an operator-only field). The
    // customer-facing `error` stays generic; sessionView never exposes errorDetail. A common
    // cause is a stale vault_id 404-ing after an account migration — see utils/vault.js.
    console.error('createTask:dispatch_failed', taskRef.id, orgId, e?.status, e?.message || e);
    await taskRef.update({
      status: 'failed',
      error: 'dispatch_failed',
      errorDetail: String(e?.message || e).slice(0, 500),
    });
    throw new HttpsError('internal', 'We could not start the fix. You were not charged.');
  }

  return { taskId: taskRef.id };
});
