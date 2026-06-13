import Anthropic, { toFile } from '@anthropic-ai/sdk';
import { buildFixPrompt, buildRevisePrompt } from './agentResult.js';

const BETA = 'managed-agents-2026-04-01';

/**
 * Operator deep link to a managed-agent session in the Claude developer platform, so the admin
 * can jump from a fix straight to its session trace (events, tool calls, cost) for debugging.
 *
 * Anthropic doesn't publish the console's single-session path, so it's CONFIGURABLE via
 * CLAUDE_PLATFORM_SESSION_URL — either a template containing `{sessionId}`, or a base URL the
 * id is appended to. Defaults to platform.claude.com. Operator-facing only (admin reads); the
 * raw sessionId is also surfaced so it's copy-pasteable even if the path ever changes.
 */
export function platformSessionUrl(sessionId) {
  if (!sessionId) return null;
  const tmpl = process.env.CLAUDE_PLATFORM_SESSION_URL
    || 'https://platform.claude.com/managed-agents/sessions/{sessionId}';
  const id = encodeURIComponent(sessionId);
  return tmpl.includes('{sessionId}') ? tmpl.replace('{sessionId}', id) : `${tmpl.replace(/\/$/, '')}/${id}`;
}

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
 * Upload owner screenshots to the Anthropic Files API ONCE so they can be re-attached, by
 * file_id, to every later session of a feature (the planning session + each build step) without
 * re-sending multi-MB base64 or storing it in Firestore (which caps at 1MB/doc). Returns the
 * file_ids (best-effort: a failed upload is skipped, never throws). `images` is [{mediaType,data}].
 */
export async function uploadImagesToFiles(images = []) {
  if (!Array.isArray(images) || images.length === 0) return [];
  const client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    defaultHeaders: { 'anthropic-beta': BETA },
  });
  const ids = [];
  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    if (!img?.data || !img?.mediaType) continue;
    try {
      const ext = (img.mediaType.split('/')[1] || 'png').replace('jpeg', 'jpg');
      const up = await client.beta.files.upload({
        file: await toFile(Buffer.from(img.data, 'base64'), `shot-${i}.${ext}`, { type: img.mediaType }),
      });
      ids.push(up.id);
    } catch (e) {
      console.warn('uploadImagesToFiles', e?.message || e);
    }
  }
  return ids;
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
export async function startFixSession({ prompt, images = [], imageFileIds = [], repoUrl, githubToken, vaultId, agentId, firebaseSAs = [], figmaDesign = null, instruction = null }) {
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
      const fileName = `firebase-${sa.env}.json`;
      const up = await client.beta.files.upload({
        file: await toFile(Buffer.from(sa.json), fileName, { type: 'application/json' }),
      });
      // File resources are mounted UNDER /mnt/session/uploads/ — a leading-slash mount_path gets
      // re-rooted there (e.g. "/workspace/x" → "/mnt/session/uploads/workspace/x"). So mount with a
      // bare filename and tell the agent the REAL absolute path, so the two never disagree.
      const mountPath = `/mnt/session/uploads/${fileName}`;
      firebaseFileResources.push({ type: 'file', file_id: up.id, mount_path: fileName });
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

  // Screenshots persisted on an earlier session (Files API) re-attached by file_id — used to carry
  // the owner's original screenshot forward into a feature's build steps without resending base64.
  const fileImageBlocks = (imageFileIds || []).map((fid) => ({
    type: 'image',
    source: { type: 'file', file_id: fid },
  }));

  // If the owner linked a Figma design, append its rendered PNG as the LAST image — buildFixPrompt's
  // figmaNote tells the agent the last image IS the design and points it at the exact spec.
  const figmaImageBlock = figmaDesign?.image
    ? [{ type: 'image', source: { type: 'base64', media_type: figmaDesign.image.mediaType, data: figmaDesign.image.data } }]
    : [];

  // `instruction`, when given (e.g. the planning pass), is the COMPLETE prompt and replaces the
  // fix instruction — the caller has already folded in any design/screenshot framing it needs.
  const text = instruction || buildFixPrompt(prompt, imageBlocks.length + fileImageBlocks.length, firebaseMounts, figmaDesign);

  await client.beta.sessions.events.send(session.id, {
    events: [
      {
        type: 'user.message',
        content: [
          { type: 'text', text },
          ...imageBlocks,
          ...fileImageBlocks,
          ...figmaImageBlock,
        ],
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
export async function continueFixSession({ sessionId, changes, images = [], figmaDesign = null }) {
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
  // A design link in the revision is enriched the same way as the initial fix (rendered PNG last).
  const figmaImageBlock = figmaDesign?.image
    ? [{ type: 'image', source: { type: 'base64', media_type: figmaDesign.image.mediaType, data: figmaDesign.image.data } }]
    : [];
  await client.beta.sessions.events.send(sessionId, {
    events: [
      {
        type: 'user.message',
        content: [
          { type: 'text', text: buildRevisePrompt(changes, imageBlocks.length, figmaDesign) },
          ...imageBlocks,
          ...figmaImageBlock,
        ],
      },
    ],
  });
  return { sessionId };
}
