#!/usr/bin/env node
/*
 * Prototype the Vault → GitHub MCP auth path (the piece the first probe said was missing).
 * Creates a vault, stores a GitHub token as a static_bearer credential bound to the GitHub
 * MCP URL, starts a session referencing the vault, and asks the agent to use a GitHub tool
 * READ-ONLY. Success = no mcp_authentication_failed_error + the agent reports the GitHub login.
 * No repo mounted (so no clone cost). Cleans up the session + vault afterward.
 *
 *   cd functions && ANTHROPIC_API_KEY=... AGENT_ID=agent_... ENVIRONMENT_ID=env_... \
 *     GITHUB_TOKEN=... node scripts/probe-vault.mjs
 */
import Anthropic from '@anthropic-ai/sdk';

const BETA = 'managed-agents-2026-04-01';
const GH_MCP_URL = 'https://api.githubcopilot.com/mcp/';
const DONE = ['idle', 'completed', 'ended', 'succeeded', 'failed', 'error'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  defaultHeaders: { 'anthropic-beta': BETA },
});

const vault = await client.beta.vaults.create({ display_name: 'probe-vault', metadata: { purpose: 'prototype' } });
console.log('vault:', vault.id);

const cred = await client.beta.vaults.credentials.create(vault.id, {
  display_name: 'GitHub MCP token',
  auth: { type: 'static_bearer', mcp_server_url: GH_MCP_URL, token: process.env.GITHUB_TOKEN },
});
console.log('credential:', cred.id);

const session = await client.beta.sessions.create({
  agent: process.env.AGENT_ID,
  environment_id: process.env.ENVIRONMENT_ID,
  vault_ids: [vault.id],
});
console.log('session:', session.id);

await client.beta.sessions.events.send(session.id, {
  events: [
    {
      type: 'user.message',
      content: [
        {
          type: 'text',
          text: 'Using the GitHub tools, tell me the login of the authenticated GitHub user. Read-only — do not create or change anything.',
        },
      ],
    },
  ],
});

let s;
for (let i = 0; i < 36; i++) {
  await sleep(5000);
  s = await client.beta.sessions.retrieve(session.id);
  console.log(`t+${(i + 1) * 5}s status=${s?.status}`);
  if (DONE.includes(String(s?.status))) break;
}

const res = await client.beta.sessions.events.list(session.id);
const events = res?.data ?? res?.body?.data ?? [];
const errors = events.filter((e) => e.type === 'session.error');
const toolUses = events.filter((e) => e.type === 'agent.tool_use').map((e) => e.name);
const msgs = events
  .filter((e) => e.type === 'agent.message')
  .flatMap((e) => (e.content || []).filter((b) => b.type === 'text').map((b) => b.text));

console.log('\n=== session.error events ===');
console.log(errors.length ? JSON.stringify(errors, null, 2) : '(none — GitHub MCP authenticated ✅)');
console.log('\n=== GitHub tools the agent called ===');
console.log(toolUses.length ? toolUses.join(', ') : '(none)');
console.log('\n=== agent said ===');
console.log(msgs.join('\n') || '(no text)');

try { await client.beta.sessions.delete(session.id); } catch { /* ignore */ }
try { await client.beta.vaults.delete(vault.id); } catch { /* ignore */ }
console.log('\n(cleaned up session + vault)');
