#!/usr/bin/env node
/*
 * Cheapest possible probe of the Managed Agents session API: create a session with
 * NO repo and a trivial prompt, poll it, and dump the full session object + events
 * shape. Reveals the real `status` values and `usage`/cost/runtime field names so we
 * can lock the CONFIRM spots in agentResult.js. Costs a few tokens + seconds.
 *
 *   cd functions && ANTHROPIC_API_KEY=... AGENT_ID=agt_... node scripts/probe-session.mjs
 */
import Anthropic from '@anthropic-ai/sdk';

const BETA = 'managed-agents-2026-04-01';
const DONE = ['completed', 'ended', 'idle', 'succeeded', 'failed', 'error', 'cancelled', 'canceled'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  defaultHeaders: { 'anthropic-beta': BETA },
});

const session = await client.beta.sessions.create({
  agent: process.env.AGENT_ID,
  environment_id: process.env.ENVIRONMENT_ID,
});
console.log('session created:', session.id);

await client.beta.sessions.events.send(session.id, {
  events: [{ type: 'user.message', content: [{ type: 'text', text: 'Reply with just the word OK.' }] }],
});

let s;
for (let i = 0; i < 24; i++) {
  await sleep(5000);
  s = await client.beta.sessions.retrieve(session.id);
  console.log(`t+${(i + 1) * 5}s  status=${s?.status}`);
  if (DONE.includes(String(s?.status))) break;
}

console.log('\n=== FULL SESSION OBJECT ===');
console.log(JSON.stringify(s, null, 2));

try {
  const ev = await client.beta.sessions.events.list(session.id);
  console.log('\n=== EVENTS (truncated) ===');
  console.log(JSON.stringify(ev, null, 2).slice(0, 2500));
} catch (e) {
  console.log('\nevents.list error:', e?.message || e);
}

// Clean up the probe session.
try { await client.beta.sessions.delete(session.id); console.log('\n(session deleted)'); } catch { /* ignore */ }
