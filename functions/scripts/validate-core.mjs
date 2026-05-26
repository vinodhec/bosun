#!/usr/bin/env node
/*
 * Independent end-to-end validation of the FIX ENGINE (steps 2–5) against the REAL
 * Managed Agents API. No Firebase, no UI. Proves the core loop:
 *   start a session on a repo → agent fixes + opens a PR → poll → read cost + result.
 *
 * It reuses the SAME prompt + cost/result helpers the production code uses
 * (functions/utils/agentResult.js), so validating here validates those too.
 *
 * Run from functions/ (so @anthropic-ai/sdk resolves):
 *
 *   # 1) Dry run — prints exactly what we'd send, no API key needed:
 *   cd functions && node ../scripts/validate-core.mjs --dry
 *
 *   # 2) Live run against a TEST repo (make a throwaway repo first):
 *   cd functions && \
 *     ANTHROPIC_API_KEY=sk-ant-... \
 *     AGENT_ID=agt_... \
 *     GITHUB_TOKEN=ghp_...            # fine-grained PAT, repo scope, on the test repo \
 *     REPO=https://github.com/you/test-site \
 *     PROBLEM="The menu disappears on mobile" \
 *     PRICE_INPUT_PER_MTOK=... PRICE_OUTPUT_PER_MTOK=... SESSION_HOUR_USD=0.08 \
 *     node ../scripts/validate-core.mjs
 *
 * Watch the CONFIRM-flagged spots in agentResult.js: if status/usage/cost come back
 * with different field names, fix them there (one place, used by the poller too).
 */
import { buildFixPrompt, sessionCostUsd, extractResult } from '../utils/agentResult.js';

const BETA = 'managed-agents-2026-04-01';
const DONE = new Set(['completed', 'ended', 'idle', 'succeeded']);
const FAILED = new Set(['failed', 'error', 'cancelled', 'canceled']);
const dry = process.argv.includes('--dry');

const cfg = {
  agentId: process.env.AGENT_ID || 'agt_DRY',
  envId: process.env.ENVIRONMENT_ID || 'env_DRY',
  repo: process.env.REPO || 'https://github.com/you/test-site',
  token: process.env.GITHUB_TOKEN || 'ghp_dry_token',
  problem: process.env.PROBLEM || 'The menu disappears on mobile phone',
};

const sessionBody = {
  agent: cfg.agentId,
  environment_id: cfg.envId,
  resources: [
    { type: 'github_repository', url: cfg.repo, mount_path: '/workspace/repo', authorization_token: cfg.token },
  ],
};
const problemEvent = {
  events: [{ type: 'user.message', content: [{ type: 'text', text: buildFixPrompt(cfg.problem) }] }],
};

if (dry) {
  const redacted = { ...sessionBody, resources: [{ ...sessionBody.resources[0], authorization_token: '***' }] };
  console.log('=== DRY RUN — no API calls ===\n');
  console.log('POST /v1/sessions  (beta: ' + BETA + ')');
  console.log(JSON.stringify(redacted, null, 2));
  console.log('\nPOST /v1/sessions/{id}/events');
  console.log(JSON.stringify(problemEvent, null, 2));
  console.log('\nThen poll /v1/sessions/{id} every 5s until status ∈', [...DONE], '→ bill, or ∈', [...FAILED], '→ no charge.');
  process.exit(0);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const { default: Anthropic } = await import('@anthropic-ai/sdk');
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY, defaultHeaders: { 'anthropic-beta': BETA } });

console.log('Creating session on', cfg.repo, '…');
const session = await client.beta.sessions.create(sessionBody);
console.log('session:', session.id);
await client.beta.sessions.events.send(session.id, problemEvent);
console.log('sent problem; polling…\n');

let s;
for (let i = 0; i < 120; i++) {
  await sleep(5000);
  s = await client.beta.sessions.retrieve(session.id);
  console.log(`t+${(i + 1) * 5}s  status=${s.status}  cost~$${sessionCostUsd(s).toFixed(4)}`);
  if (DONE.has(String(s.status)) || FAILED.has(String(s.status))) break;
}

console.log('\n=== FINAL ===');
console.log('status:', s?.status, '· actual cost: $' + sessionCostUsd(s).toFixed(4));
if (DONE.has(String(s?.status))) {
  const r = await extractResult(client, session.id);
  console.log('result:', JSON.stringify(r, null, 2));
}
