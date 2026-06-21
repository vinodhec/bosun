import crypto from 'node:crypto';

/**
 * Mint a short-lived GitHub App INSTALLATION access token for a given installation.
 * The managed-agent session uses it (as `authorization_token`) to clone the repo and
 * open the PR — so the non-technical user never handles a token themselves.
 *
 * Flow: build a short-lived App JWT (RS256, signed with the App private key) ->
 * POST /app/installations/{id}/access_tokens -> returns a token valid ~1 hour.
 *
 * Requires env: GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY (PEM).
 */
export async function mintInstallationToken(installationId) {
  const appId = process.env.GITHUB_APP_ID;
  const pem = process.env.GITHUB_APP_PRIVATE_KEY;
  if (!appId || !pem) throw new Error('GitHub App credentials not configured');
  if (!installationId) throw new Error('missing installationId');

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = { iat: now - 30, exp: now + 540, iss: appId }; // <=10 min lifetime
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const unsigned = `${b64(header)}.${b64(payload)}`;
  const signature = crypto.createSign('RSA-SHA256').update(unsigned).sign(pem, 'base64url');
  const jwt = `${unsigned}.${signature}`;

  const res = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    }
  );
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`installation token failed: ${res.status} ${text}`);
  }
  const json = await res.json();
  return json.token; // valid ~1 hour
}

async function ghGet(repoFullName, path, token) {
  const res = await fetch(`https://api.github.com/repos/${repoFullName}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });
  if (!res.ok) return null;
  return res.json().catch(() => null);
}

/**
 * Find the Vercel PREVIEW url for a PR (Vercel builds it async after the PR opens).
 * Reads the PR's GitHub deployments (`environment_url`) first, then falls back to the
 * Vercel-bot comment containing a *.vercel.app link. Returns the url, or null if it
 * isn't ready yet (caller retries on the next poll tick).
 */
export async function fetchPrPreviewUrl(repoFullName, prNumber, token) {
  const pr = await ghGet(repoFullName, `/pulls/${prNumber}`, token);
  const ref = pr?.head?.ref;
  if (ref) {
    const deps = await ghGet(repoFullName, `/deployments?ref=${encodeURIComponent(ref)}&per_page=10`, token);
    if (Array.isArray(deps)) {
      for (const d of deps) {
        const statuses = await ghGet(repoFullName, `/deployments/${d.id}/statuses?per_page=10`, token);
        const ok = Array.isArray(statuses)
          && statuses.find((s) => s.state === 'success' && (s.environment_url || s.target_url));
        if (ok) return ok.environment_url || ok.target_url;
      }
    }
  }
  const comments = await ghGet(repoFullName, `/issues/${prNumber}/comments?per_page=30`, token);
  if (Array.isArray(comments)) {
    for (const c of comments) {
      const m = (c.body || '').match(/https?:\/\/[^\s)\]]*vercel\.app[^\s)\]]*/i);
      if (m) return m[0];
    }
  }
  return null;
}

const GH_HEADERS = (token) => ({
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'Content-Type': 'application/json',
});

// Merge a PR into its base branch (squash). Pushing to the base triggers the
// deploy-testing GitHub Action in the customer's repo.
export async function mergePullRequest(repoFullName, prNumber, token) {
  const res = await fetch(`https://api.github.com/repos/${repoFullName}/pulls/${prNumber}/merge`, {
    method: 'PUT',
    headers: GH_HEADERS(token),
    body: JSON.stringify({ merge_method: 'squash' }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`merge failed: ${res.status} ${t}`);
  }
  return res.json();
}

// A sortable, date-based release tag (UTC), e.g. v2026.06.13-153045-a1b2. UTC keeps it
// monotonic; the short random suffix means two deploys in the same second never collide.
function releaseTagName() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const date = `${d.getUTCFullYear()}.${p(d.getUTCMonth() + 1)}.${p(d.getUTCDate())}`;
  const time = `${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}`;
  return `v${date}-${time}-${crypto.randomBytes(2).toString('hex')}`;
}

// The PR's head branch name (e.g. `claude/123-fix`). Needed to deploy a PR branch as a
// Firebase preview without merging it. Null if the PR can't be read.
export async function getPrHeadRef(repoFullName, prNumber, token) {
  const pr = await ghGet(repoFullName, `/pulls/${prNumber}`, token);
  return pr?.head?.ref || null;
}

// Trigger a `workflow_dispatch` GitHub Action in the customer's repo. Used for the Firebase
// hosting path: the repo's own workflow does the Angular build + `firebase deploy`, Bosun just
// kicks it off. `gitRef` is the branch the workflow FILE is read from (must be the default
// branch, where the file lives); `inputs.ref` tells that workflow which branch/sha to build
// (the PR branch for a preview, the base branch for a revert). Returns true on success (204).
export async function dispatchWorkflow(repoFullName, workflowFile, gitRef, inputs, token) {
  const res = await fetch(
    `https://api.github.com/repos/${repoFullName}/actions/workflows/${encodeURIComponent(workflowFile)}/dispatches`,
    {
      method: 'POST',
      headers: GH_HEADERS(token),
      body: JSON.stringify({ ref: gitRef, inputs: inputs || {} }),
    }
  );
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`workflow dispatch failed: ${res.status} ${t}`);
  }
  return true; // 204 No Content
}

// The most recent run of a given workflow (optionally filtered to one head branch). Used by the
// poller to tell when a dispatched Firebase preview/revert deploy has finished. Returns
// { status, conclusion, headBranch, createdAt(ms), url } or null.
export async function latestWorkflowRun(repoFullName, workflowFile, token, { branch } = {}) {
  const q = `?per_page=10${branch ? `&branch=${encodeURIComponent(branch)}` : ''}`;
  const data = await ghGet(repoFullName, `/actions/workflows/${encodeURIComponent(workflowFile)}/runs${q}`, token);
  const run = Array.isArray(data?.workflow_runs) ? data.workflow_runs[0] : null;
  if (!run) return null;
  return {
    status: run.status, // queued | in_progress | completed
    conclusion: run.conclusion, // success | failure | cancelled | null
    headBranch: run.head_branch || null,
    createdAt: run.created_at ? Date.parse(run.created_at) : 0,
    url: run.html_url || null,
  };
}

// Create a lightweight git tag at `fromBranch`'s current head. Pushing the tag triggers the
// customer's deploy-prod GitHub Action (which runs on `tags: ['v*']`). Bosun only moves the
// ref — the repo's own Action does the actual production deploy. Returns the tag name + sha.
export async function createReleaseTag(repoFullName, fromBranch, token) {
  const headers = GH_HEADERS(token);
  const r1 = await fetch(`https://api.github.com/repos/${repoFullName}/git/ref/heads/${fromBranch}`, { headers });
  if (!r1.ok) throw new Error(`source branch ${fromBranch} not found: ${r1.status}`);
  const sha = (await r1.json()).object.sha;

  const tag = releaseTagName();
  const create = await fetch(`https://api.github.com/repos/${repoFullName}/git/refs`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ ref: `refs/tags/${tag}`, sha }),
  });
  if (!create.ok) {
    const t = await create.text().catch(() => '');
    throw new Error(`tag failed: ${create.status} ${t}`);
  }
  return { sha, tag };
}
