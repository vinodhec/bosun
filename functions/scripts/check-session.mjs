#!/usr/bin/env node
// Inspect a live session: status, cost, recent events (errors / tools / messages).
//   cd functions && ANTHROPIC_API_KEY=... SESSION_ID=sesn_... node scripts/check-session.mjs
import Anthropic from '@anthropic-ai/sdk';
import { sessionCostUsd } from '../utils/agentResult.js';

const c = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  defaultHeaders: { 'anthropic-beta': 'managed-agents-2026-04-01' },
});
const id = process.env.SESSION_ID;
const s = await c.beta.sessions.retrieve(id);
console.log(`\n=== ${id} ===`);
console.log('status:', s.status, '| cost~$' + sessionCostUsd(s).toFixed(4), '| stats:', JSON.stringify(s.stats));

const ev = await c.beta.sessions.events.list(id);
const events = ev?.data ?? ev?.body?.data ?? [];
console.log('events:', events.length, '— last 14:');
for (const e of events.slice(-14)) {
  if (e.type === 'session.error') console.log('  ❌ ERROR:', JSON.stringify(e.error));
  else if (e.type === 'agent.message') console.log('  💬', (e.content || []).filter((b) => b.type === 'text').map((b) => b.text).join(' ').slice(0, 180));
  else if (e.type === 'agent.tool_use') console.log('  🔧 tool:', e.name);
  else console.log('  ·', e.type);
}
