import Anthropic from '@anthropic-ai/sdk';
import { buildFixPrompt, buildRevisePrompt } from './agentResult.js';

const BETA = 'managed-agents-2026-04-01';

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
export async function startFixSession({ prompt, images = [], repoUrl, githubToken, vaultId, agentId }) {
  const resolvedAgent = agentId || process.env.ANTHROPIC_MANAGED_AGENT_ID;
  if (!resolvedAgent) throw new Error('ANTHROPIC_MANAGED_AGENT_ID not configured');
  const environmentId = process.env.ANTHROPIC_MANAGED_ENVIRONMENT_ID;
  if (!environmentId) throw new Error('ANTHROPIC_MANAGED_ENVIRONMENT_ID not configured');

  const client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    defaultHeaders: { 'anthropic-beta': BETA },
  });

  const session = await client.beta.sessions.create({
    agent: resolvedAgent,
    environment_id: environmentId, // required: the Anthropic-managed cloud env
    vault_ids: vaultId ? [vaultId] : undefined, // GitHub MCP auth (so the agent can open the PR)
    resources: [
      {
        type: 'github_repository',
        url: repoUrl,
        mount_path: '/workspace/repo',
        authorization_token: githubToken, // GitHub App installation token (repo scope)
      },
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
        content: [{ type: 'text', text: buildFixPrompt(prompt, imageBlocks.length) }, ...imageBlocks],
      },
    ],
  });

  return { sessionId: session.id };
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
