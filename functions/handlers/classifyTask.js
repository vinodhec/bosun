import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { tierFor } from '../utils/billing.js';
import { classifyComplexity } from '../utils/classify.js';
import { ANTHROPIC_API_KEY } from '../utils/secrets.js';

// Step 1 of the cost flow: a cheap Haiku call classifies the problem so we can show
// an honest estimate BEFORE running the real (expensive) fix. The returned complexity
// also sets the agent's hard budget cap in createTask (same classifier, so estimate and
// cap can never diverge). Classification cost (~₹0.50) is absorbed by us.
export const classifyTask = onCall({ region: 'asia-south1', secrets: [ANTHROPIC_API_KEY] }, async (request) => {
  if (!request.auth?.uid) throw new HttpsError('unauthenticated', 'Please sign in.');
  const problem = String(request.data?.prompt ?? '').trim();
  if (!problem) throw new HttpsError('invalid-argument', 'Please describe what is broken.');

  const { complexity, reason } = await classifyComplexity(problem);
  const tier = tierFor(complexity);
  return {
    complexity,
    reason,
    estimatedMinInr: tier.minInr,
    estimatedMaxInr: tier.maxInr,
  };
});
