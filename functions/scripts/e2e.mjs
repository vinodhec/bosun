#!/usr/bin/env node
/*
 * FULL end-to-end proof of steps 2→5 against the live API:
 *   vault (GitHub MCP auth) + mounted repo  →  agent clones, fixes, opens a PR  →
 *   session idle  →  read result + actual cost.
 * Uses the same prompt + cost/result helpers as production. Cleans up the vault after.
 *
 *   cd functions && ANTHROPIC_API_KEY=... AGENT_ID=agent_... ENVIRONMENT_ID=env_... \
 *     GITHUB_TOKEN=... REPO=https://github.com/you/repo PROBLEM="..." node scripts/e2e.mjs
 */
import Anthropic from '@anthropic-ai/sdk';
import { buildFixPrompt, sessionCostUsd, extractResult } from '../utils/agentResult.js';

const BETA = 'managed-agents-2026-04-01';
const GH_MCP = 'https://api.githubcopilot.com/mcp/';
const DONE = ['idle', 'completed', 'ended', 'succeeded'];
const FAIL = ['failed', 'error', 'cancelled', 'canceled'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const c = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  defaultHeaders: { 'anthropic-beta': BETA },
});

// 1. Vault with the GitHub MCP credential (so the agent can open the PR).
const vault = await c.beta.vaults.create({ display_name: 'e2e', metadata: { purpose: 'e2e' } });
await c.beta.vaults.credentials.create(vault.id, {
  display_name: 'gh',
  auth: { type: 'static_bearer', mcp_server_url: GH_MCP, token: process.env.GITHUB_TOKEN },
});
console.log('vault:', vault.id);

// 2. Session: mount the repo (clone/push token) + reference the vault (MCP auth).
const session = await c.beta.sessions.create({
  agent: process.env.AGENT_ID,
  environment_id: process.env.ENVIRONMENT_ID,
  vault_ids: [vault.id],
  resources: [
    {
      type: 'github_repository',
      url: process.env.REPO,
      mount_path: '/workspace/repo',
      authorization_token: process.env.GITHUB_TOKEN,
    },
  ],
});
console.log('session:', session.id);

// 3. Send the fix request.
await c.beta.sessions.events.send(session.id, {
  events: [
    {
      type: 'user.message',
      content: [{ type: 'text', text: buildFixPrompt(process.env.PROBLEM || 'The menu disappears on mobile phone') }],
    },
  ],
});

// 4. Poll until idle/done (fixes take a few minutes).
let s;
for (let i = 0; i < 90; i++) {
  await sleep(5000);
  s = await c.beta.sessions.retrieve(session.id);
  console.log(`t+${(i + 1) * 5}s  status=${s?.status}  cost~$${sessionCostUsd(s).toFixed(4)}`);
  if ([...DONE, ...FAIL].includes(String(s?.status))) break;
}

// 5. Report errors, result, cost.
const evRes = await c.beta.sessions.events.list(session.id);
const events = evRes?.data ?? evRes?.body?.data ?? [];
const errors = events.filter((e) => e.type === 'session.error');
console.log('\n=== final status:', s?.status, '· actual cost: $' + sessionCostUsd(s).toFixed(4), '===');
if (errors.length) console.log('session.error:', JSON.stringify(errors, null, 2));
const result = await extractResult(c, session.id);
console.log('\n=== RESULT ===');
console.log(JSON.stringify(result, null, 2));

try { await c.beta.vaults.delete(vault.id); console.log('\n(vault cleaned up; session kept for inspection)'); } catch { /* ignore */ }
