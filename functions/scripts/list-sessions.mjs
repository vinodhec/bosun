#!/usr/bin/env node
// List ALL managed-agent sessions and their actual cost (usage × Opus 4.7 prices).
//   cd functions && ANTHROPIC_API_KEY=... PRICE_*=... node scripts/list-sessions.mjs
import Anthropic from '@anthropic-ai/sdk';
import { sessionCostUsd } from '../utils/agentResult.js';

const c = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  defaultHeaders: { 'anthropic-beta': 'managed-agents-2026-04-01' },
});

let total = 0;
let n = 0;
const res = await c.beta.sessions.list({ limit: 100 });
const items = res?.data ?? res?.body?.data ?? (Array.isArray(res) ? res : []);
console.log('sessions returned by the API:', items.length, '\n');
for (const it of items) {
  let s = it;
  try { if (!s.usage) s = await c.beta.sessions.retrieve(it.id); } catch { /* ignore */ }
  const usd = sessionCostUsd(s);
  total += usd;
  n += 1;
  const u = s.usage || {};
  console.log(`${it.id.slice(0, 26)} [${s.status}]  out=${u.output_tokens || 0} cacheRead=${u.cache_read_input_tokens || 0}  →  $${usd.toFixed(4)}`);
}
console.log(`\n=== ${n} live sessions, total $${total.toFixed(4)} ===`);
console.log('(Deleted probe/e2e sessions are gone from this list but still counted toward the Anthropic bill.)');
