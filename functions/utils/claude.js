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
// The judgement tier (utils/buyerCheck.js): Sonnet reads every buyer check, Opus re-judges the torn
// ones. Both run with adaptive thinking on; `effort` is the only depth control they accept.
export const CLAUDE_SONNET = 'claude-sonnet-5-5';
export const CLAUDE_OPUS = 'claude-opus-5-5';

/** $ per 1M tokens, for COGS bookkeeping on the lanes that run here (not for pricing — see billing). */
export const CLAUDE_USD_PER_M = {
  [CLAUDE_HAIKU]: { input: 0.1, output: 0.5 },
  [CLAUDE_SONNET]: { input: 2, output: 10 },
  [CLAUDE_OPUS]: { input: 4, output: 20 },
};

/** Dollar cost of one response's `usage` on `model` (cache reads priced as plain input — close enough for forensics). */
export function usageCostUsd(model, usage) {
  const r = CLAUDE_USD_PER_M[model] || CLAUDE_USD_PER_M[CLAUDE_SONNET];
  const inp = (Number(usage?.input_tokens) || 0) + (Number(usage?.cache_read_input_tokens) || 0) + (Number(usage?.cache_creation_input_tokens) || 0);
  const out = Number(usage?.output_tokens) || 0;
  return (inp * r.input + out * r.output) / 1e6;
}

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

/**
 * Structured generation for the Sonnet / Opus 5.5 tier — the forced-tool trick above returns a 400 on
 * those models (`tool_choice: tool` is not supported there), so JSON is enforced through
 * `output_config.format` (structured outputs) instead. Thinking is adaptive by default on both;
 * `effort` sets how hard they think. Returns `{ data, usage, model }` — the caller needs `usage` for
 * COGS — or null on any failure / refusal, so the caller owns the degrade path.
 */
export async function generateStructured({ model = CLAUDE_SONNET, prompt, system, schema, effort = 'medium', maxOutputTokens = 4096 }) {
  if (!claudeConfigured() || !prompt) return null;
  const MAX_ATTEMPTS = 3;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const msg = await client().messages.create({
        model,
        max_tokens: maxOutputTokens,
        ...(system ? { system } : {}),
        output_config: { effort, format: { type: 'json_schema', schema: schema ? toJsonSchema(schema) : { type: 'object' } } },
        messages: [{ role: 'user', content: prompt }],
      });
      if (msg.stop_reason === 'refusal') {
        console.error('claude:generateStructured:refusal', model, msg.stop_details?.category || null);
        return null;
      }
      const text = msg.content.filter((c) => c.type === 'text').map((c) => c.text).join('').trim();
      if (!text) return null;
      let data;
      try { data = JSON.parse(text); } catch { data = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1)); }
      return data && typeof data === 'object' ? { data, usage: msg.usage, model: msg.model || model } : null;
    } catch (e) {
      const status = Number(e?.status) || 0;
      const transient = status === 429 || status === 529 || status >= 500 || /fetch failed|ETIMEDOUT|ECONNRESET/i.test(String(e?.message));
      const willRetry = transient && attempt < MAX_ATTEMPTS - 1;
      console.error('claude:generateStructured:err', model, status, String(e?.message || e).slice(0, 300), willRetry ? '(retrying)' : '');
      if (!willRetry) return null;
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  return null;
}
