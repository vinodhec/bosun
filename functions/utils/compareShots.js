import { getStorage } from 'firebase-admin/storage';
import { randomUUID } from 'node:crypto';

// "Size up the competition" lets the owner attach screenshots — their own page and/or a competitor's.
// The agent already SEES them (via the Files API, for its vision comparison); this persists the SAME
// images to Firebase Storage so the report can show them back to the owner ("ours vs theirs"). The
// owner is the source — Bosun never renders or scrapes anything (see [[bosun-stays-generic]]).
// Backend-only writes (Admin SDK); served via an unguessable download-token URL (bypasses storage.rules).

function bucketName() {
  return (
    process.env.MOCKSHOTS_BUCKET ||
    `${process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT}.firebasestorage.app`
  );
}

/**
 * Persist the owner's comparison screenshots ([{ mediaType, data(base64) }]) to Firebase Storage and
 * return durable, owner-loadable URLs (one per image). Best-effort: a failed image is skipped, never
 * throws (a display nicety must never block the comparison). Returns [] when there are none.
 */
export async function saveCompareShots(comparisonId, images = []) {
  if (!Array.isArray(images) || images.length === 0) return [];
  const urls = [];
  let bucket;
  try { bucket = getStorage().bucket(bucketName()); } catch (e) { console.warn('saveCompareShots:bucket', e?.message || e); return []; }
  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    if (!img?.data || !img?.mediaType) continue;
    try {
      const ext = (img.mediaType.split('/')[1] || 'png').replace('jpeg', 'jpg');
      const token = randomUUID();
      const path = `compareshots/${comparisonId}/${Date.now()}-${i}.${ext}`;
      await bucket.file(path).save(Buffer.from(img.data, 'base64'), {
        resumable: false,
        contentType: img.mediaType,
        metadata: { cacheControl: 'public,max-age=31536000', metadata: { firebaseStorageDownloadTokens: token } },
      });
      urls.push(`https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(path)}?alt=media&token=${token}`);
    } catch (e) {
      console.warn('saveCompareShots', comparisonId, e?.message || e);
    }
  }
  return urls;
}

/**
 * Persist a comparison's rendered report HTML to Firebase Storage and return a durable, shareable URL
 * (served as text/html so it opens directly in a browser) — the same pattern as saveMockHtml. A new
 * timestamped file per call, so a "look again" refine never clobbers a report mid-read. Returns null
 * on failure (best-effort — a display nicety must never block the comparison).
 */
export async function saveReportHtml(comparisonId, html) {
  const body = String(html || '').trim();
  if (!body) return null;
  try {
    const bucket = getStorage().bucket(bucketName());
    const token = randomUUID();
    const path = `comparereports/${comparisonId}/${Date.now()}.html`;
    await bucket.file(path).save(Buffer.from(body, 'utf8'), {
      resumable: false,
      contentType: 'text/html; charset=utf-8',
      metadata: { cacheControl: 'public,max-age=31536000', metadata: { firebaseStorageDownloadTokens: token } },
    });
    return `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(path)}?alt=media&token=${token}`;
  } catch (e) {
    console.warn('saveReportHtml', comparisonId, e?.message || e);
    return null;
  }
}
