#!/usr/bin/env node
// One-time setup: create the "Website Fixer" Managed Agent (model + GitHub MCP +
// agent toolset). Run from functions/ so the @anthropic-ai/sdk resolves:
//
//   cd functions && ANTHROPIC_API_KEY=sk-ant-... node scripts/create-agent.mjs
//
// Copy the printed id into functions/.env as ANTHROPIC_MANAGED_AGENT_ID.
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  defaultHeaders: { 'anthropic-beta': 'managed-agents-2026-04-01' },
});

const model = process.env.MODEL || 'claude-opus-4-7';
const agent = await client.beta.agents.create({
  name: `Website Fixer (${model})`,
  model,
  system:
    'You fix websites for non-technical small-business owners. Make the smallest safe ' +
    'change that resolves the reported problem, commit to a new branch, push it, and ' +
    'open a pull request. Keep any user-facing text plain and friendly, with no ' +
    'technical jargon.',
  mcp_servers: [
    { type: 'url', name: 'github', url: 'https://api.githubcopilot.com/mcp/' },
    // Jam lets the agent read a customer-shared jam.dev recording (console errors, failed
    // requests, repro steps). Authed by a Jam PAT stored as a static_bearer vault credential
    // (see utils/vault.js); the session's vault_ids carry it in.
    { type: 'url', name: 'jam', url: 'https://mcp.jam.dev/mcp' },
  ],
  tools: [
    { type: 'agent_toolset_20260401' },
    // always_allow so MCP tool calls run headlessly (default is always_ask, which
    // stalls waiting for human approval — fatal for an unattended fix).
    {
      type: 'mcp_toolset',
      mcp_server_name: 'github',
      default_config: { enabled: true, permission_policy: { type: 'always_allow' } },
    },
    {
      type: 'mcp_toolset',
      mcp_server_name: 'jam',
      default_config: { enabled: true, permission_policy: { type: 'always_allow' } },
    },
  ],
});

console.log('\n✅ Created agent.\nAdd this to functions/.env:\n');
console.log('ANTHROPIC_MANAGED_AGENT_ID=' + agent.id + '\n');
