import crypto from 'node:crypto';
import { getStorage } from 'firebase-admin/storage';
import {
  getPullRequest,
  updatePullRequestBody,
  getRepoFileRaw,
  getRepoFileSha,
  deleteRepoFile,
} from './github.js';

// Keep in sync with SCREENSHOT_STAGE_DIR in utils/agentResult.js — the branch-relative folder
// the agent stages before/after PNGs in. We collect them from there, re-host on our side, embed
// them in the PR, then DELETE the folder off the branch so it never merges into the owner's main.
const SCREENSHOT_STAGE_DIR = '.bosun-preview';

const CONTENT_TYPE = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp',
};
const contentTypeFor = (path) => CONTENT_TYPE[String(path).split('.').pop().toLowerCase()] || 'image/png';

// Pull the PR number out of a github PR url (…/pull/123). Returns null if it doesn't look like one.
export function prNumberFromUrl(prUrl) {
  const m = String(prUrl || '').match(/\/pull\/(\d+)/);
  return m ? Number(m[1]) : null;
}

// Upload one image buffer to OUR Firebase Storage and return a stable, public download URL.
// We mint a Firebase download token instead of flipping ACLs — a tokened URL is served by the
// download API regardless of bucket-level access or security rules, so it renders for anyone
// viewing the public PR (the reviewer, the owner) without exposing the rest of the bucket.
async function uploadToStorage(orgId, taskId, name, buffer, contentType) {
  const bucket = getStorage().bucket();
  const objectPath = `prShots/${orgId}/${taskId}/${name}`;
  const token = crypto.randomUUID();
  await bucket.file(objectPath).save(buffer, {
    resumable: false,
    contentType,
    metadata: { cacheControl: 'public, max-age=31536000', metadata: { firebaseStorageDownloadTokens: token } },
  });
  return `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(objectPath)}?alt=media&token=${token}`;
}

// Render the markdown "Before & After" section we splice into the PR body. Side-by-side via an
// HTML table when we have both shots (GitHub renders it); a single image otherwise.
const MARKER = '<!-- bosun:screenshots -->';
function renderSection(shots) {
  const rows = shots.map((s) => {
    const title = s.label || s.page || 'Screenshot';
    if (s.beforeUrl && s.afterUrl) {
      return (
        `**${title}**\n\n` +
        `<table><tr><td align="center"><b>Before</b><br><img src="${s.beforeUrl}" width="380"></td>` +
        `<td align="center"><b>After</b><br><img src="${s.afterUrl}" width="380"></td></tr></table>`
      );
    }
    const url = s.afterUrl || s.beforeUrl;
    return `**${title}**\n\n<img src="${url}" width="600">`;
  });
  return `${MARKER}\n\n## 📸 Before & After\n\n${rows.join('\n\n')}\n`;
}

// Strip any section we appended on a previous round so revisions replace rather than stack.
function stripPriorSection(body) {
  const i = body.indexOf(MARKER);
  return i === -1 ? body : body.slice(0, i).trimEnd();
}

/**
 * Collect the screenshots the agent staged on the PR branch, re-host them on our Firebase
 * Storage, embed a Before/After section in the PR description, then delete the staged folder
 * off the branch (so it never reaches the owner's main on merge).
 *
 * Entirely best-effort: returns the hosted screenshots (for the caller to persist on the task)
 * or [] if anything is missing/fails. NEVER throws — the caller's billing path must not depend
 * on this. `specs` are the validated entries from agentResult.parseScreenshotSpecs.
 */
export async function attachScreenshotsToPr({ repoFullName, prUrl, specs, orgId, taskId, token }) {
  if (!repoFullName || !prUrl || !token || !Array.isArray(specs) || specs.length === 0) return [];
  const prNumber = prNumberFromUrl(prUrl);
  if (!prNumber) return [];

  try {
    const pr = await getPullRequest(repoFullName, prNumber, token);
    if (!pr || !pr.branch) return [];
    const branch = pr.branch;

    // Download each staged image off the branch and re-host it. Track every staged path we
    // touch so we can delete them all afterwards (even ones we couldn't host).
    const hosted = [];
    const stagedPaths = new Set();
    let idx = 0;
    for (const s of specs) {
      const out = { label: s.label, page: s.page, beforeUrl: null, afterUrl: null };
      for (const which of ['before', 'after']) {
        const path = which === 'before' ? s.beforePath : s.afterPath;
        if (!path) continue;
        stagedPaths.add(path);
        const buf = await getRepoFileRaw(repoFullName, path, branch, token);
        if (!buf) continue;
        const name = `${String(idx).padStart(2, '0')}-${which}.${(path.split('.').pop() || 'png').toLowerCase()}`;
        try {
          out[`${which}Url`] = await uploadToStorage(orgId, taskId, name, buf, contentTypeFor(path));
        } catch (e) {
          console.warn('attachScreenshotsToPr:upload', path, e?.message || e);
        }
      }
      if (out.beforeUrl || out.afterUrl) hosted.push(out);
      idx += 1;
    }

    // Embed in the PR description (replacing any section from a prior round).
    if (hosted.length) {
      const base = stripPriorSection(pr.body || '');
      const body = `${base}${base ? '\n\n' : ''}${renderSection(hosted)}`;
      await updatePullRequestBody(repoFullName, prNumber, body, token);
    }

    // Strip the staged folder off the branch so it never merges into the owner's main. One
    // delete commit per file (specs are capped at 8 upstream, so this stays small).
    for (const path of stagedPaths) {
      try {
        const sha = await getRepoFileSha(repoFullName, path, branch, token);
        if (sha) await deleteRepoFile(repoFullName, path, sha, branch, token, `chore: remove preview screenshot ${path}`);
      } catch (e) {
        console.warn('attachScreenshotsToPr:cleanup', path, e?.message || e);
      }
    }

    return hosted;
  } catch (e) {
    console.warn('attachScreenshotsToPr', e?.message || e);
    return [];
  }
}

export { SCREENSHOT_STAGE_DIR };
