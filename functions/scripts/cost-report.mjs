#!/usr/bin/env node
// Actual cost per run (from real token usage × Opus 4.7 prices) vs our calculator.
//   cd functions && ANTHROPIC_API_KEY=... SESSION_IDS=sesn_a,sesn_b PRICE_*=... node scripts/cost-report.mjs
import Anthropic from '@anthropic-ai/sdk';
import { sessionCostUsd } from '../utils/agentResult.js';
import { chargeForRound } from '../utils/billing.js';

const c = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  defaultHeaders: { 'anthropic-beta': 'managed-agents-2026-04-01' },
});
const rate = Number(process.env.USD_TO_INR) || 83;
const ids = (process.env.SESSION_IDS || '').split(',').map((s) => s.trim()).filter(Boolean);

let total = 0;
for (const id of ids) {
  try {
    const s = await c.beta.sessions.retrieve(id);
    const u = s.usage || {};
    const cc = u.cache_creation || {};
    const usd = sessionCostUsd(s);
    total += usd;
    const charge = chargeForRound(usd, 'initial', { rate });
    console.log(`\n${id.slice(0, 26)}  [${s.status}]`);
    console.log(`  tokens  in=${u.input_tokens || 0}  out=${u.output_tokens || 0}  cacheRead=${u.cache_read_input_tokens || 0}  cacheWr5m=${cc.ephemeral_5m_input_tokens || 0}  cacheWr1h=${cc.ephemeral_1h_input_tokens || 0}`);
    console.log(`  runtime ${(s.stats?.active_seconds || 0).toFixed(1)}s`);
    console.log(`  ACTUAL $${usd.toFixed(4)}  →  our charge (×2, min ₹75): ₹${charge}`);
  } catch (e) {
    console.log(`\n${id.slice(0, 26)}: ${e?.message || e}`);
  }
}
console.log(`\n=== TOTAL actual (these ${ids.length} fix sessions): $${total.toFixed(4)} ===`);
console.log('(The console total also includes Haiku estimate calls + probe/e2e sessions.)');
