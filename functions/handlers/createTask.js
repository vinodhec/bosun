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

  // No upfront estimate: run the fix, then charge actual cost × 2. A single flat budget
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
    createdAt: FieldValue.serverTimestamp(),
  });

  try {
    const { sessionId } = await startFixSession({ prompt, repoUrl, githubToken, vaultId: gh.vaultId, agentId: agentIdForModel(model) });
    await taskRef.update({ status: 'running', sessionId });
  } catch {
    await taskRef.update({ status: 'failed', error: 'dispatch_failed' });
    throw new HttpsError('internal', 'We could not start the fix. You were not charged.');
  }

  return { taskId: taskRef.id };
});
