import Anthropic from '@anthropic-ai/sdk';
import { MODEL_PRICES } from './agentResult.js';

// The breakdown is a planning call (no repo editing), so it runs as a plain Sonnet Messages
// call — the same shape as the Haiku classifier, just a more capable model for real planning.
// Sonnet 4.6 is the current Sonnet snapshot; pricing is sourced from the SAME per-model table
// the rest of the app bills sessions by, so the planning cost can never use a separate number.
const PLANNER_MODEL = 'claude-sonnet-4-6';
const MAX_STEPS = 8;

// USD cost of one direct Messages call, priced at Sonnet rates. Planning uses no prompt cache,
// so fresh input + output is the whole bill (cache fields handled defensively, valued at 0 if
// absent). Mirrors usageBreakdown() in agentResult.js but for a Messages (not session) usage.
function messageCostUsd(usage) {
  const p = MODEL_PRICES.sonnet;
  const input = Number(usage?.input_tokens) || 0;
  const output = Number(usage?.output_tokens) || 0;
  const cacheRead = Number(usage?.cache_read_input_tokens) || 0;
  const cacheWrite = Number(usage?.cache_creation_input_tokens) || 0;
  return (input * p.input + output * p.output + cacheRead * p.cacheRead + cacheWrite * p.cacheWrite5m) / 1e6;
}

/**
 * Break a feature request into an ordered list of fix-sized steps using one Sonnet call. Each
 * step is a self-contained change that can be built, previewed, and published on its own before
 * the next begins (later steps may build on earlier ones, which are merged to the repo's main
 * branch as each is deployed to testing). Returns the steps + the call's ACTUAL USD cost — the
 * planning charge is PLANNING_MULTIPLIER × this (see priceForPlanning). Titles/descriptions are
 * plain English (shown to the customer). Fails safe to a single step = the whole ask.
 *
 * @returns {Promise<{steps: {title:string, description:string}[], costUsd:number}>}
 */
export async function breakdownFeature(prompt, { images = [] } = {}) {
  const ask = String(prompt ?? '').trim();
  if (!ask) return { steps: [], costUsd: 0 };

  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const content = [
    ...images.map((im) => ({
      type: 'image',
      source: { type: 'base64', media_type: im.mediaType, data: im.data },
    })),
    {
      type: 'text',
      text:
        `A non-technical website owner wants this feature added to their site:\n"${ask}"\n\n` +
        `Break it into an ordered list of small, independent steps. Each step must be a single, ` +
        `self-contained change that can be built, previewed and published on its own before the ` +
        `next begins — later steps may rely on earlier ones already being live. Use the FEWEST ` +
        `steps that make sense (1–${MAX_STEPS}); a small feature can be a single step. Order them ` +
        `so each step works on its own once shipped.\n\n` +
        `Write every title and description in plain, friendly English a shop owner would use — ` +
        `NEVER any technical words (no code, files, components, API, database, deploy, etc.). ` +
        `Describe what a visitor or the owner will SEE or be able to DO.\n\n` +
        `Respond with JSON only — no prose, no code fences:\n` +
        `{"steps":[{"title":"<3–6 word plain title>","description":"<one or two plain sentences: what this step adds and where on the site>"}]}`,
    },
  ];

  const msg = await anthropic.messages.create({
    model: PLANNER_MODEL,
    max_tokens: 1500,
    system: 'You plan website features for non-technical owners as a short, ordered list of plain-English steps. Respond with JSON only — no prose, no code fences.',
    messages: [{ role: 'user', content }],
  });

  const costUsd = messageCostUsd(msg.usage);
  const text = msg.content.find((c) => c.type === 'text')?.text ?? '{}';
  let steps = [];
  try {
    const json = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
    steps = Array.isArray(json.steps) ? json.steps : [];
  } catch {
    steps = [];
  }
  steps = steps
    .map((s) => ({
      title: String(s?.title || '').slice(0, 80).trim(),
      description: String(s?.description || '').slice(0, 400).trim(),
    }))
    .filter((s) => s.title || s.description)
    .slice(0, MAX_STEPS);

  // Fail safe: the customer has paid for the breakdown, so always return something runnable.
  if (steps.length === 0) steps = [{ title: 'Build the feature', description: ask.slice(0, 400) }];

  return { steps, costUsd };
}
