import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { classifyComplexity } from '../utils/classify.js';
import { ANTHROPIC_API_KEY } from '../utils/secrets.js';

// Step 1 of the fix flow: a cheap Haiku call classifies the problem. The complexity drives
// the agent's hard budget + runtime caps and model routing in createTask. Price is bracketed
// cost-plus computed after the run from actual COGS — nothing is quoted upfront, so the
// response carries no estimate. Classification cost (~₹0.50) is absorbed by us.
export const classifyTask = onCall({ region: 'asia-south1', secrets: [ANTHROPIC_API_KEY] }, async (request) => {
  if (!request.auth?.uid) throw new HttpsError('unauthenticated', 'Please sign in.');
  const problem = String(request.data?.prompt ?? '').trim();
  if (!problem) throw new HttpsError('invalid-argument', 'Please describe what is broken.');

  const { complexity, reason } = await classifyComplexity(problem);
  return { complexity, reason };
});
