#!/usr/bin/env node
/*
 * Prototype the Vault → Jam MCP auth path: prove the managed agent can READ a customer-shared
 * jam.dev recording using a Jam Personal Access Token stored as a static_bearer credential
 * (the same shape probe-vault.mjs uses for GitHub). Spins up a THROWAWAY haiku agent with the
 * Jam MCP declared (so we don't touch the production agents), seeds the PAT into a temp vault,
 * asks the agent to read the recording, and prints what it found. Cleans up agent + vault after.
 *
 * Success = no mcp_authentication_failed_error + the agent reports the recording's title /
 * console output (i.e. it actually reached the Jam).
 *
 *   cd functions && ANTHROPIC_API_KEY=... ENVIRONMENT_ID=env_... JAM_PAT=jam_pat_... \
 *     JAM_URL=https://jam.dev/c/<id> node scripts/probe-jam.mjs
 */
import Anthropic from '@anthropic-ai/sdk';

const BETA = 'managed-agents-2026-04-01';
const JAM_MCP_URL = 'https://mcp.jam.dev/mcp';
const DONE = ['idle', 'completed', 'ended', 'succeeded', 'failed', 'error'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const envId = process.env.ENVIRONMENT_ID || process.env.ANTHROPIC_MANAGED_ENVIRONMENT_ID;
const jamPat = process.env.JAM_PAT;
const jamUrl = process.env.JAM_URL;
if (!envId || !jamPat || !jamUrl) {
  console.error('Need ENVIRONMENT_ID, JAM_PAT and JAM_URL.');
  process.exit(1);
}

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  defaultHeaders: { 'anthropic-beta': BETA },
});

const model = process.env.MODEL || 'claude-haiku-4-5';
const agent = await client.beta.agents.create({
  name: 'probe-jam (throwaway)',
  model,
  system: 'You read jam.dev bug recordings via the jam MCP tools and report what they contain.',
  mcp_servers: [{ type: 'url', name: 'jam', url: JAM_MCP_URL }],
  tools: [
    { type: 'agent_toolset_20260401' },
    { type: 'mcp_toolset', mcp_server_name: 'jam', default_config: { enabled: true, permission_policy: { type: 'always_allow' } } },
  ],
});
console.log('agent:', agent.id, `(${model})`);

const vault = await client.beta.vaults.create({ display_name: 'probe-jam-vault', metadata: { purpose: 'prototype' } });
console.log('vault:', vault.id);

const cred = await client.beta.vaults.credentials.create(vault.id, {
  display_name: 'jam',
  auth: { type: 'static_bearer', mcp_server_url: JAM_MCP_URL, token: jamPat },
});
console.log('credential:', cred.id);

const session = await client.beta.sessions.create({
  agent: agent.id,
  environment_id: envId,
  vault_ids: [vault.id],
});
console.log('session:', session.id, '\n');

await client.beta.sessions.events.send(session.id, {
  events: [
    {
      type: 'user.message',
      content: [
        {
          type: 'text',
          text:
            `Using the jam tools, read this recording: ${jamUrl}\n` +
            `Call getDetails (jamId = that URL) for its title, then getConsoleLogs and getUserEvents. ` +
            `Report: (1) the recording's title, (2) any console errors, (3) the steps the user took. ` +
            `If you CANNOT access it, say exactly why (quote the error).`,
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
console.log(errors.length ? JSON.stringify(errors, null, 2) : '(none — Jam MCP authenticated ✅)');
console.log('\n=== jam tools the agent called ===');
console.log(toolUses.length ? toolUses.join(', ') : '(none)');
console.log('\n=== agent said ===');
console.log(msgs.join('\n') || '(no text)');

try { await client.beta.sessions.delete(session.id); } catch { /* ignore */ }
try { await client.beta.vaults.delete(vault.id); } catch { /* ignore */ }
try { await client.beta.agents.delete(agent.id); } catch { /* ignore */ }
console.log('\n(cleaned up session + vault + agent)');
