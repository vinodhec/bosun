#!/usr/bin/env node
/*
 * Feasibility probe for the SECURE Firebase path: inject the service-account key as a MOUNTED
 * FILE (Files API upload + file resource) instead of committing it to the repo. Proves the
 * agent can auth to Firestore from a file we hand it at session-create time — no repo, no
 * committed key. This is the mechanism startFixSession will use in production.
 *
 *   cd functions && ANTHROPIC_API_KEY=... ENVIRONMENT_ID=env_... \
 *     SA_FILE=/abs/path/to/service-account.json PROJECT_ID=maadiveedu-6b8ce \
 *     node scripts/probe-firebase-inject.mjs
 */
import Anthropic, { toFile } from '@anthropic-ai/sdk';
import { readFileSync } from 'node:fs';

const BETA = 'managed-agents-2026-04-01';
const DONE = ['idle', 'completed', 'ended', 'succeeded', 'failed', 'error'];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const envId = process.env.ENVIRONMENT_ID || process.env.ANTHROPIC_MANAGED_ENVIRONMENT_ID;
const saFile = process.env.SA_FILE;
const projectId = process.env.PROJECT_ID || 'maadiveedu-6b8ce';
if (!envId || !saFile) {
  console.error('Need ENVIRONMENT_ID and SA_FILE.');
  process.exit(1);
}

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  defaultHeaders: { 'anthropic-beta': BETA },
});

// 1) Upload the SA key via the Files API → file_id we can mount.
const saBuf = readFileSync(saFile);
const uploaded = await client.beta.files.upload({
  file: await toFile(saBuf, 'firebase-testing.json', { type: 'application/json' }),
});
console.log('uploaded file:', uploaded.id);

const model = process.env.MODEL || 'claude-sonnet-4-6';
const agent = await client.beta.agents.create({
  name: 'probe-firebase-inject (throwaway)',
  model,
  system: 'You test whether you can reach a Firebase project from your shell. Be terse and factual.',
  tools: [{ type: 'agent_toolset_20260401' }],
});
console.log('agent:', agent.id, `(${model})`);

const MOUNT = '/workspace/secrets/firebase-testing.json';
const session = await client.beta.sessions.create({
  agent: agent.id,
  environment_id: envId,
  resources: [{ type: 'file', file_id: uploaded.id, mount_path: MOUNT }],
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
            `A Firebase service-account key is mounted at ${MOUNT}.\n` +
            `Goal: confirm you can READ Firestore for project ${projectId} using it.\n` +
            `1. export GOOGLE_APPLICATION_CREDENTIALS=${MOUNT}\n` +
            `2. Try: npx --yes firebase-tools firestore:databases:list --project ${projectId}\n` +
            `   If that doesn't list data, write a tiny node script using "firebase-admin" ` +
            `(npm i firebase-admin in a temp dir) that initializes with the cert at ${MOUNT} ` +
            `and lists up to 3 Firestore collection ids via listCollections().\n` +
            `3. Report EXACTLY: did it connect? what came back? If it failed, paste the exact error ` +
            `(especially network: ENOTFOUND/ETIMEDOUT/EAI_AGAIN). Do NOT write/modify any data.`,
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
const msgs = events
  .filter((e) => e.type === 'agent.message')
  .flatMap((e) => (e.content || []).filter((b) => b.type === 'text').map((b) => b.text));

console.log('\n=== session.error events ===');
console.log(errors.length ? JSON.stringify(errors, null, 2) : '(none)');
console.log('\n=== agent said ===');
console.log(msgs.join('\n') || '(no text)');

try { await client.beta.sessions.delete(session.id); } catch { /* ignore */ }
try { await client.beta.agents.delete(agent.id); } catch { /* ignore */ }
try { await client.beta.files.delete(uploaded.id); } catch { /* ignore */ }
console.log('\n(cleaned up session + agent + uploaded file)');
