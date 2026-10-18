import Anthropic from '@anthropic-ai/sdk';

// Shared Claude client for SHORT structured calls (classify / extract), the Claude twin of
// utils/gemini.js#generateJson. The managed-agent fix engine (utils/claudeAgent.js) is a different
// thing and does not go through here.
//
// Why Haiku 5.5 (2026-10-18): it is cheaper per token than gemini-2.5-flash ($0.10 / $0.50 per 1M
// in/out under 100K context), and the Anthropic org behind ANTHROPIC_API_KEY carries the Max plan's
// monthly API credits, so these calls draw on credit we already have before any cash.
//
// Auth: process.env.ANTHROPIC_API_KEY, injected only into functions that list the ANTHROPIC_API_KEY
// secret. A function without it reports claudeConfigured() === false and callers stay on Gemini.

export const CLAUDE_HAIKU = 'claude-haiku-5-5';

let _client = null;

export function claudeConfigured() {
  return !!process.env.ANTHROPIC_API_KEY;
}

function client() {
  if (!_client) _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return _client;
}

// Gemini responseSchema → JSON Schema: drop the Gemini-only `propertyOrdering`, recursively.
function toJsonSchema(s) {
  if (Array.isArray(s)) return s.map(toJsonSchema);
  if (!s || typeof s !== 'object') return s;
  const out = {};
  for (const [k, v] of Object.entries(s)) if (k !== 'propertyOrdering') out[k] = toJsonSchema(v);
  return out;
}

/**
 * One-shot structured generation, same contract as gemini.js#generateJson: returns the PARSED object,
 * or null on any failure so the caller owns the degrade path. JSON is enforced by forcing a single
 * tool call whose input_schema is `schema` (no prose to strip, no code fences).
 */
// No `temperature`: Haiku 5.5 rejects it (400 "temperature is deprecated for this model").
export async function generateJson({ model = CLAUDE_HAIKU, prompt, system, schema, maxOutputTokens = 512 }) {
  if (!claudeConfigured() || !prompt) return null;
  const tool = { name: 'answer', description: 'Return the answer.', input_schema: schema ? toJsonSchema(schema) : { type: 'object' } };
  // Same retry shape as gemini.js: transient 429 / 5xx / 529 overloaded retry twice, auth errors don't.
  const MAX_ATTEMPTS = 3;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const msg = await client().messages.create({
        model,
        max_tokens: maxOutputTokens,
        ...(system ? { system } : {}),
        tools: [tool],
        tool_choice: { type: 'tool', name: 'answer' },
        messages: [{ role: 'user', content: prompt }],
      });
      const use = msg.content.find((c) => c.type === 'tool_use');
      return use?.input && typeof use.input === 'object' ? use.input : null;
    } catch (e) {
      const status = Number(e?.status) || 0;
      const transient = status === 429 || status === 529 || status >= 500 || /fetch failed|ETIMEDOUT|ECONNRESET/i.test(String(e?.message));
      const willRetry = transient && attempt < MAX_ATTEMPTS - 1;
      console.error('claude:generateJson:err', status, String(e?.message || e).slice(0, 300), willRetry ? '(retrying)' : '');
      if (!willRetry) return null;
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  return null;
}
