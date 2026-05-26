// Client-side screenshot handling for the "paste a screenshot" flow.
// Screenshots are pasted (Ctrl+V) or dropped, downscaled in the browser, and sent to
// createTask as inline base64 — we never upload/persist them (better for privacy, no
// cleanup). Keep these limits in sync with the server guard in functions/handlers/createTask.js.

export const MAX_IMAGES = 2;
export const ACCEPTED_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // source-file guard, before downscale
const MAX_EDGE = 1568; // Anthropic downscales above this anyway — larger costs more for no gain

/**
 * Read a File into a downscaled base64 attachment: { id, mediaType, dataUrl, data }.
 * `dataUrl` is for the thumbnail preview; `data` is the bare base64 we send to the agent.
 * GIFs are passed through untouched (a canvas can't preserve animation).
 */
export function readImageAttachment(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('read_failed'));
    reader.onload = () => {
      const sourceUrl = String(reader.result || '');
      const finish = (mediaType, dataUrl) =>
        resolve({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`, mediaType, dataUrl, data: dataUrl.split(',')[1] || '' });

      if (file.type === 'image/gif') return finish('image/gif', sourceUrl);

      const img = new Image();
      img.onerror = () => reject(new Error('decode_failed'));
      img.onload = () => {
        const scale = Math.min(1, MAX_EDGE / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        const outType =
          file.type === 'image/jpeg' ? 'image/jpeg' : file.type === 'image/webp' ? 'image/webp' : 'image/png';
        const dataUrl = canvas.toDataURL(outType, outType === 'image/png' ? undefined : 0.9);
        finish(outType, dataUrl);
      };
      img.src = sourceUrl;
    };
    reader.readAsDataURL(file);
  });
}

/** Pull image Files out of a paste/drop event's clipboard or dataTransfer. */
export function imageFilesFrom(transfer) {
  const out = [];
  for (const item of transfer?.items || []) {
    if (item.kind === 'file' && String(item.type).startsWith('image/')) {
      const f = item.getAsFile();
      if (f) out.push(f);
    }
  }
  if (out.length === 0) for (const f of transfer?.files || []) if (String(f.type).startsWith('image/')) out.push(f);
  return out;
}
