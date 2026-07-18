/**
 * GitHub issue creation for the nightly dev-task filer — the one write bosun makes to a customer
 * repo outside the managed-agent pipeline. Mirrors the REST discipline of utils/github.js
 * (`createReleaseTag` is the create-a-resource reference): raw REST, same headers, token from the
 * org's stored `orgSecrets/{orgId}.githubToken` (the repo-scoped token the operator supplied at
 * connect time — must carry issues:write).
 *
 * Only ever called for proposals a SUPERADMIN approved on the platform; the filer also caps files
 * per night and dedups by fingerprint, so this can never flood a repo.
 */

const GH_HEADERS = (token) => ({
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'Content-Type': 'application/json',
});

/**
 * Create one issue. Returns { ok, number, url } or { ok:false, error }. Never throws — a GitHub
 * hiccup must not break the nightly run (the proposal stays approved and retries next night).
 */
export async function createIssue(repoFullName, { title, body, labels = [] }, token) {
  if (!repoFullName || !title || !token) return { ok: false, error: 'missing repo/title/token' };
  try {
    const resp = await fetch(`https://api.github.com/repos/${repoFullName}/issues`, {
      method: 'POST',
      headers: GH_HEADERS(token),
      body: JSON.stringify({ title, body, labels }),
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      console.error('githubIssues:create:http', repoFullName, resp.status, text.slice(0, 200));
      return { ok: false, error: `http-${resp.status}` };
    }
    const issue = await resp.json();
    return { ok: true, number: issue.number, url: issue.html_url };
  } catch (e) {
    console.error('githubIssues:create:err', repoFullName, e?.message || e);
    return { ok: false, error: e?.message || String(e) };
  }
}
