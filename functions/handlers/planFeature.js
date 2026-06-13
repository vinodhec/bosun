import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { decomposeFeature } from '../utils/planTasks.js';
import { ANTHROPIC_API_KEY } from '../utils/secrets.js';

// "Plan a feature" — step 1 (PREVIEW, FREE). A cheap Haiku call breaks the owner's plain-
// language feature request into individual tasks they can review/edit before anything is
// published. Exactly like classifyTask, the model cost is absorbed by us — nothing is charged
// here. The charge lands only on publishPlan, after the owner approves the list.
export const planFeature = onCall({ region: 'asia-south1', secrets: [ANTHROPIC_API_KEY] }, async (request) => {
  if (!request.auth?.uid) throw new HttpsError('unauthenticated', 'Please sign in.');
  const prompt = String(request.data?.prompt ?? '').trim();
  if (!prompt) throw new HttpsError('invalid-argument', 'Please describe the feature you want.');

  const { tasks } = await decomposeFeature(prompt);
  return { tasks };
});
