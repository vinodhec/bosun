#!/usr/bin/env node
// Actual cost per run (from real token usage × the PER-MODEL price table, by the model each
// session ran) vs our calculator.
//   cd functions && ANTHROPIC_API_KEY=... SESSION_IDS=sesn_a,sesn_b node scripts/cost-report.mjs
import Anthropic from '@anthropic-ai/sdk';
import { usageBreakdown } from '../utils/agentResult.js';
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
    const bd = usageBreakdown(s);
    const usd = bd.totalUsd;
    total += usd;
    const charge = chargeForRound(usd, 'initial', { rate });
    console.log(`\n${id.slice(0, 26)}  [${s.status}]`);
    console.log(`  tokens  in=${bd.input}  out=${bd.output}  cacheRead=${bd.cacheRead}  cacheWr5m=${bd.cacheWrite5m}  cacheWr1h=${bd.cacheWrite1h}`);
    console.log(`  cacheHit ${(bd.cacheHitRatio * 100).toFixed(1)}%  runtime ${bd.runtimeSec.toFixed(1)}s`);
    console.log(`  ACTUAL $${usd.toFixed(4)}  →  our charge (×2, min ₹75): ₹${charge}`);
  } catch (e) {
    console.log(`\n${id.slice(0, 26)}: ${e?.message || e}`);
  }
}
console.log(`\n=== TOTAL actual (these ${ids.length} fix sessions): $${total.toFixed(4)} ===`);
console.log('(The console total also includes Haiku estimate calls + probe/e2e sessions.)');
