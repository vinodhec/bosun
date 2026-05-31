import Anthropic from '@anthropic-ai/sdk';

const BETA = 'managed-agents-2026-04-01';
const GH_MCP_URL = 'https://api.githubcopilot.com/mcp/';
const JAM_MCP_URL = 'https://mcp.jam.dev/mcp';

function client() {
  return new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    defaultHeaders: { 'anthropic-beta': BETA },
  });
}

/**
 * Ensure the org has a Managed-Agents vault holding a current GitHub MCP credential
 * (static_bearer). Creates the vault if needed; creates the credential, or rotates it
 * if one already exists for the GitHub MCP URL. Returns the vaultId.
 * Validated against the live API (probe-vault) — this is what lets the agent open PRs.
 */
export async function ensureOrgGithubVault({ orgId, vaultId, token }) {
  const c = client();
  let vid = vaultId;
  if (!vid) {
    const v = await c.beta.vaults.create({ display_name: `org:${orgId}`, metadata: { orgId } });
    vid = v.id;
  }
  try {
    await c.beta.vaults.credentials.create(vid, {
      display_name: 'github',
      auth: { type: 'static_bearer', mcp_server_url: GH_MCP_URL, token },
    });
  } catch (e) {
    // 409 = a credential already exists for this MCP URL → rotate its token.
    if (e?.status === 409) {
      const list = await c.beta.vaults.credentials.list(vid);
      const items = list?.data ?? list?.body?.data ?? [];
      const existing = items.find((x) => x.mcp_server_url === GH_MCP_URL) ?? items[0];
      if (existing) {
        await c.beta.vaults.credentials.update(existing.id, {
          vault_id: vid,
          auth: { type: 'static_bearer', token },
        });
      }
    } else {
      throw e;
    }
  }
  return vid;
}

/**
 * Add (or rotate) a Jam MCP credential in an existing org vault so the agent can read a
 * customer-shared jam.dev recording headlessly. Jam's MCP is OAuth-only interactively, but it
 * issues Personal Access Tokens (`jam_pat_…`) that work as a static bearer — the SAME shape the
 * GitHub credential uses. One Bosun-team PAT is shared across orgs (it's our token, not theirs),
 * so this just seeds the same value into each org's vault alongside the GitHub credential.
 * No-op when no token is configured, so the feature degrades to "no recording" cleanly.
 */
export async function ensureOrgJamCredential({ vaultId, token }) {
  if (!vaultId || !token) return;
  const c = client();
  try {
    await c.beta.vaults.credentials.create(vaultId, {
      display_name: 'jam',
      auth: { type: 'static_bearer', mcp_server_url: JAM_MCP_URL, token },
    });
  } catch (e) {
    // 409 = a credential already exists for the Jam MCP URL → rotate its token.
    if (e?.status === 409) {
      const list = await c.beta.vaults.credentials.list(vaultId);
      const items = list?.data ?? list?.body?.data ?? [];
      const existing = items.find((x) => x.mcp_server_url === JAM_MCP_URL);
      if (existing) {
        await c.beta.vaults.credentials.update(existing.id, {
          vault_id: vaultId,
          auth: { type: 'static_bearer', token },
        });
      }
    } else {
      throw e;
    }
  }
}
