#!/usr/bin/env node
// One-time setup: create the "Website Fixer" Managed Agent (model + GitHub MCP +
// agent toolset). Run from functions/ so the @anthropic-ai/sdk resolves:
//
//   cd functions && ANTHROPIC_API_KEY=sk-ant-... node scripts/create-agent.mjs
//
// Copy the printed id into functions/.env as ANTHROPIC_MANAGED_AGENT_ID.
//
// COGS note (2026-07-16): the agent's toolset schemas are re-read from cache on EVERY model
// turn, so every exposed tool taxes every fix. The original agent carried GitHub's full MCP
// server (44 tools, ~29k tokens) + Jam (~3k) — ~26% of a typical fix's COGS — while sessions
// use git CLI for everything except opening the PR (see BUILD_EFFICIENCY). So:
//   - github points at the PR-scoped endpoint (/x/pull_requests, 10 tools ~8k tokens) and only
//     create_pull_request / update_pull_request are enabled (default_config disables the rest —
//     merging stays server-side in customerDeployTesting, never the agent's job).
//   - Jam MCP is gone entirely; jam.dev links now ride the prompts as context only.
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  defaultHeaders: { 'anthropic-beta': 'managed-agents-2026-04-01' },
});

const model = process.env.MODEL || 'claude-opus-4-8';
const agent = await client.beta.agents.create({
  name: `Website Fixer (${model})`,
  model,
  system:
    'You fix websites for non-technical small-business owners. Make the smallest safe ' +
    'change that resolves the reported problem, commit to a new branch, push it, and ' +
    'open a pull request. Keep any user-facing text plain and friendly, with no ' +
    'technical jargon.',
  mcp_servers: [
    { type: 'url', name: 'github', url: 'https://api.githubcopilot.com/mcp/x/pull_requests' },
  ],
  tools: [
    { type: 'agent_toolset_20260401' },
    // always_allow so MCP tool calls run headlessly (default is always_ask, which
    // stalls waiting for human approval — fatal for an unattended fix).
    {
      type: 'mcp_toolset',
      mcp_server_name: 'github',
      default_config: { enabled: false },
      configs: [
        { name: 'create_pull_request', enabled: true, permission_policy: { type: 'always_allow' } },
        { name: 'update_pull_request', enabled: true, permission_policy: { type: 'always_allow' } },
      ],
    },
  ],
});

console.log('\n✅ Created agent.\nAdd this to functions/.env:\n');
console.log('ANTHROPIC_MANAGED_AGENT_ID=' + agent.id + '\n');
