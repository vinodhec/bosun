#!/usr/bin/env node
/*
 * Feasibility probe for "approach A": can the managed agent reach a customer's Firebase from its
 * own shell, authenticating with a service-account key that lives IN the connected repo?
 *
 * Mounts the repo at /workspace/repo, then asks the agent to find the committed service-account
 * JSON, point GOOGLE_APPLICATION_CREDENTIALS at it, and read Firestore (CLI or firebase-admin).
 * The make-or-break unknown is whether the agent sandbox has outbound network to *.googleapis.com.
 *
 *   cd functions && ANTHROPIC_API_KEY=... ENVIRONMENT_ID=env_... \
 *     REPO=https://github.com/owner/repo GITHUB_TOKEN=gho_... \
 *     PROJECT_ID=maadiveedu-6b8ce node scripts/probe-firebase.mjs
 */
import Anthropic from '@anthropic-ai/sdk';

const BETA = 'managed-agents-2026-04-01';
const DONE = ['idle', 'completed', 'ended', 'succeeded', 'failed', 'error'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const envId = process.env.ENVIRONMENT_ID || process.env.ANTHROPIC_MANAGED_ENVIRONMENT_ID;
const repo = process.env.REPO;
const token = process.env.GITHUB_TOKEN;
const projectId = process.env.PROJECT_ID || 'maadiveedu-6b8ce';
if (!envId || !repo || !token) {
  console.error('Need ENVIRONMENT_ID, REPO and GITHUB_TOKEN.');
  process.exit(1);
}

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  defaultHeaders: { 'anthropic-beta': BETA },
});

const model = process.env.MODEL || 'claude-sonnet-4-6';
const agent = await client.beta.agents.create({
  name: 'probe-firebase (throwaway)',
  model,
  system: 'You are testing whether you can reach a Firebase project from your shell. Be terse and factual.',
  tools: [{ type: 'agent_toolset_20260401' }],
});
console.log('agent:', agent.id, `(${model})`);

const session = await client.beta.sessions.create({
  agent: agent.id,
  environment_id: envId,
  resources: [{ type: 'github_repository', url: repo, mount_path: '/workspace/repo', authorization_token: token }],
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
            `Goal: confirm whether you can reach Firestore for project ${projectId} from your shell.\n\n` +
            `1. In /workspace/repo, find the Firebase service-account JSON (look under scripts/, ` +
            `filename contains "firebase-adminsdk"). Print its path.\n` +
            `2. Set GOOGLE_APPLICATION_CREDENTIALS to that path.\n` +
            `3. Try to READ from Firestore (read-only) using whichever works:\n` +
            `   (a) npx --yes firebase-tools firestore:databases:list --project ${projectId}\n` +
            `   (b) or a tiny node script using the "firebase-admin" package: initialize with the ` +
            `cert, then list up to 3 collection ids via listCollections().\n` +
            `4. Report EXACTLY: did it connect? what did it return (collection/db names)? ` +
            `If it failed, paste the exact error — especially any network error (ENOTFOUND, ETIMEDOUT, ` +
            `EAI_AGAIN, getaddrinfo, "could not reach"). Do NOT write or modify any data.`,
        },
      ],
    },
  ],
});

let s;
for (let i = 0; i < 60; i++) {
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
console.log(errors.length ? JSON.stringify(errors, null, 2) : '(none)');
console.log('\n=== tools the agent called ===');
console.log(toolUses.length ? toolUses.join(', ') : '(none)');
console.log('\n=== agent said ===');
console.log(msgs.join('\n') || '(no text)');

try { await client.beta.sessions.delete(session.id); } catch { /* ignore */ }
try { await client.beta.agents.delete(agent.id); } catch { /* ignore */ }
console.log('\n(cleaned up session + agent)');
