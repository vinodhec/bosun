import { getStorage } from 'firebase-admin/storage';
import { randomUUID } from 'node:crypto';

// The "Design a screen" mock is a self-contained HTML page the design session writes (see
// designSession.js). It's small text, but it lives in Firebase Storage (not the Firestore doc) so
// the doc stays lean and the frontend can load it straight into a sandboxed <iframe src=...>. The
// browser is the renderer — no screenshots, no base64 (a rendered image can't be shipped out of the
// managed sandbox cheaply). Backend-only writes (Admin SDK); clients never write here
// (storage.rules deny it). Served via an unguessable download-token URL, which also bypasses rules.

// The default Firebase Storage bucket. In Cloud Functions GCLOUD_PROJECT is set automatically;
// MOCKSHOTS_BUCKET can override (e.g. the standalone validation script).
function bucketName() {
  return (
    process.env.MOCKSHOTS_BUCKET ||
    `${process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT}.firebasestorage.app`
  );
}

/**
 * Persist a design session's self-contained mock HTML to Firebase Storage and return a durable,
 * owner-loadable URL (a download token on an unguessable path; served as text/html so an <iframe>
 * can render it directly). Returns null on failure (best-effort — never throws). A new file per
 * call (timestamped) so a refine doesn't clobber the prior mock mid-read.
 */
export async function saveMockHtml(designId, html) {
  const body = String(html || '').trim();
  if (!body) return null;
  try {
    const bucket = getStorage().bucket(bucketName());
    const token = randomUUID();
    const path = `mockshots/${designId}/${Date.now()}.html`;
    await bucket.file(path).save(Buffer.from(body, 'utf8'), {
      resumable: false,
      contentType: 'text/html; charset=utf-8',
      metadata: { cacheControl: 'public,max-age=31536000', metadata: { firebaseStorageDownloadTokens: token } },
    });
    return `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(path)}?alt=media&token=${token}`;
  } catch (e) {
    console.warn('saveMockHtml', designId, e?.message || e);
    return null;
  }
}
