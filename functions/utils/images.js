import { HttpsError } from 'firebase-functions/v2/https';

// Screenshots are sent inline as base64 (we never store them — better for privacy and
// no cleanup). Keep these limits in sync with the client-side guard in src/utils/images.js.
export const MAX_IMAGES = 2;
const ALLOWED_MEDIA = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const MAX_IMAGE_B64 = 5 * 1024 * 1024; // ~3.7 MB decoded per image — well within callable limits

// Validate + cap the owner's pasted/attached screenshots before forwarding them to the agent.
export function sanitizeImages(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const out = [];
  for (const img of raw.slice(0, MAX_IMAGES)) {
    const mediaType = String(img?.mediaType ?? img?.media_type ?? '').toLowerCase();
    const data = typeof img?.data === 'string' ? img.data : '';
    if (!ALLOWED_MEDIA.has(mediaType)) {
      throw new HttpsError('invalid-argument', 'Only PNG, JPG, WEBP or GIF screenshots are allowed.');
    }
    if (!data || data.length > MAX_IMAGE_B64) {
      throw new HttpsError('invalid-argument', 'Each screenshot must be under ~3.5 MB.');
    }
    out.push({ mediaType, data });
  }
  return out;
}
