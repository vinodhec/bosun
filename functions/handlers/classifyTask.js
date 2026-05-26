import { onCall, HttpsError } from 'firebase-functions/v2/https';
import Anthropic from '@anthropic-ai/sdk';
import { tierFor } from '../utils/billing.js';
import { ANTHROPIC_API_KEY } from '../utils/secrets.js';

// Step 1 of the cost flow: a cheap Haiku call classifies the problem so we can show
// an honest estimate BEFORE running the real (expensive) fix. The returned complexity
// also sets the agent's hard budget cap in createTask. Classification cost (~₹0.50) is
// absorbed by us, never charged to the user.
export const classifyTask = onCall({ region: 'asia-south1', secrets: [ANTHROPIC_API_KEY] }, async (request) => {
  if (!request.auth?.uid) throw new HttpsError('unauthenticated', 'Please sign in.');
  const problem = String(request.data?.prompt ?? '').trim();
  if (!problem) throw new HttpsError('invalid-argument', 'Please describe what is broken.');

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  let complexity = 'medium';
  let reason = '';
  try {
    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5',
      max_tokens: 200,
      system: 'You classify website fix requests. Respond with JSON only — no prose, no code fences.',
      messages: [
        {
          role: 'user',
          content:
            `Classify this website fix request.\n` +
            `Request: "${problem}"\n\n` +
            `Respond JSON only:\n` +
            `{"complexity":"simple|medium|complex","reason":"one short line in plain English, no technical words"}\n\n` +
            `Guide:\n` +
            `- simple  = one small change, e.g. something not showing or a styling issue\n` +
            `- medium  = a whole page or several parts affected\n` +
            `- complex = something stops working / many parts affected`,
        },
      ],
    });
    const text = msg.content.find((c) => c.type === 'text')?.text ?? '{}';
    const json = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
    if (['simple', 'medium', 'complex'].includes(json.complexity)) complexity = json.complexity;
    reason = String(json.reason || '').slice(0, 160);
  } catch {
    // On any classifier hiccup, fall back to `medium` — safe middle estimate.
  }

  const tier = tierFor(complexity);
  return {
    complexity,
    reason,
    estimatedMinInr: tier.minInr,
    estimatedMaxInr: tier.maxInr,
  };
});
