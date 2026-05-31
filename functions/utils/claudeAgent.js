import Anthropic, { toFile } from '@anthropic-ai/sdk';
import { buildFixPrompt, buildRevisePrompt } from './agentResult.js';

const BETA = 'managed-agents-2026-04-01';

/**
 * Convert the `orgSecrets/{orgId}.firebaseServiceAccounts` map into the array
 * startFixSession expects: { testing: { projectId, json }, production: {...} } →
 * [{ env, projectId, json }]. Returns [] when the org has no Firebase keys configured.
 */
export function firebaseSAsFromSecret(secretData) {
  const m = secretData?.firebaseServiceAccounts;
  if (!m || typeof m !== 'object') return [];
  return Object.entries(m)
    .filter(([, v]) => v && v.json)
    .map(([env, v]) => ({ env, projectId: v.projectId || null, json: v.json }));
}

/**
 * Start a Claude Managed Agent session to fix the user's repo.
 *
 * Runs in Anthropic's MANAGED CLOUD environment — no infrastructure of ours. The agent
 * (pre-created once, ANTHROPIC_MANAGED_AGENT_ID) declares the GitHub MCP server. We
 * start a session that mounts the repo as a resource (authed by a short-lived GitHub
 * App installation token) and send the problem. The agent edits files, pushes a branch,
 * and opens a PR via GitHub MCP.
 *
 * Returns { sessionId }. The `pollSessions` scheduled function finalizes + bills.
 */
export async function startFixSession({ prompt, images = [], repoUrl, githubToken, vaultId, agentId, firebaseSAs = [] }) {
  const resolvedAgent = agentId || process.env.ANTHROPIC_MANAGED_AGENT_ID;
  if (!resolvedAgent) throw new Error('ANTHROPIC_MANAGED_AGENT_ID not configured');
  const environmentId = process.env.ANTHROPIC_MANAGED_ENVIRONMENT_ID;
  if (!environmentId) throw new Error('ANTHROPIC_MANAGED_ENVIRONMENT_ID not configured');

  const client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    defaultHeaders: { 'anthropic-beta': BETA },
  });

  // Mount the org's READ-ONLY Firebase service-account keys as files so the agent can inspect the
  // live database when diagnosing — without the keys ever living in the customer's git repo. Each
  // is uploaded via the Files API and mounted at a stable path; buildFixPrompt tells the agent it
  // is strictly read-only. file_ids are returned so the poller can delete them when the run ends.
  const firebaseFileResources = [];
  const firebaseMounts = [];
  const firebaseFileIds = [];
  for (const sa of firebaseSAs || []) {
    if (!sa?.json || !sa?.env) continue;
    try {
      const up = await client.beta.files.upload({
        file: await toFile(Buffer.from(sa.json), `firebase-${sa.env}.json`, { type: 'application/json' }),
      });
      const mountPath = `/workspace/secrets/firebase-${sa.env}.json`;
      firebaseFileResources.push({ type: 'file', file_id: up.id, mount_path: mountPath });
      firebaseMounts.push({ env: sa.env, projectId: sa.projectId || '(unknown)', mountPath });
      firebaseFileIds.push(up.id);
    } catch (e) {
      console.warn('startFixSession:firebase_sa_upload', sa.env, e?.message || e);
    }
  }

  const session = await client.beta.sessions.create({
    agent: resolvedAgent,
    environment_id: environmentId, // required: the Anthropic-managed cloud env
    vault_ids: vaultId ? [vaultId] : undefined, // GitHub + Jam MCP auth (vault static_bearer creds)
    resources: [
      {
        type: 'github_repository',
        url: repoUrl,
        mount_path: '/workspace/repo',
        authorization_token: githubToken, // GitHub App installation token (repo scope)
      },
      ...firebaseFileResources, // read-only Firebase SA key files (if the org has any)
    ],
  });

  // The owner may attach screenshots; append them as image blocks after the text so the
  // agent sees exactly what the user sees. buildFixPrompt notes their presence.
  const imageBlocks = (images || []).map((img) => ({
    type: 'image',
    source: { type: 'base64', media_type: img.mediaType, data: img.data },
  }));

  await client.beta.sessions.events.send(session.id, {
    events: [
      {
        type: 'user.message',
        content: [{ type: 'text', text: buildFixPrompt(prompt, imageBlocks.length, firebaseMounts) }, ...imageBlocks],
      },
    ],
  });

  return { sessionId: session.id, firebaseFileIds };
}

/**
 * Resume an EXISTING session to apply more changes (a revision). The session keeps its
 * environment + GitHub auth, so the agent updates the SAME branch/PR. Usage accrues on
 * the same session, so the cost we read later is cumulative across rounds.
 */
export async function continueFixSession({ sessionId, changes, images = [] }) {
  if (!sessionId) throw new Error('missing sessionId');
  const client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    defaultHeaders: { 'anthropic-beta': BETA },
  });
  // The owner may attach fresh screenshots with their change request — append them as image
  // blocks after the text, same as the initial fix, so the agent sees what they're pointing at.
  const imageBlocks = (images || []).map((img) => ({
    type: 'image',
    source: { type: 'base64', media_type: img.mediaType, data: img.data },
  }));
  await client.beta.sessions.events.send(sessionId, {
    events: [
      {
        type: 'user.message',
        content: [{ type: 'text', text: buildRevisePrompt(changes, imageBlocks.length) }, ...imageBlocks],
      },
    ],
  });
  return { sessionId };
}
