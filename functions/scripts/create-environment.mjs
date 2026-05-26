#!/usr/bin/env node
// One-time setup: create the Anthropic-managed CLOUD environment that sessions run in.
//   cd functions && ANTHROPIC_API_KEY=sk-ant-... node scripts/create-environment.mjs
// Copy the printed id into functions/.env as ANTHROPIC_MANAGED_ENVIRONMENT_ID.
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  defaultHeaders: { 'anthropic-beta': 'managed-agents-2026-04-01' },
});

const env = await client.beta.environments.create({
  name: 'bosun-cloud',
  config: { type: 'cloud', networking: { type: 'unrestricted' } },
});

console.log('\n✅ Created environment.\nAdd this to functions/.env:\n');
console.log('ANTHROPIC_MANAGED_ENVIRONMENT_ID=' + env.id + '\n');
