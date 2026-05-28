import { useCallback, useState } from 'react';
import { MAX_IMAGES, MAX_IMAGE_BYTES, ACCEPTED_TYPES, readImageAttachment } from '../utils/images.js';

// Shared screenshot-attachment state for the "paste / drop / attach a screenshot" composer.
// Used by both the initial fix box and the "Request changes" box so they behave identically.
export function useImageAttachments() {
  const [images, setImages] = useState([]); // pasted/dropped/attached screenshots, max MAX_IMAGES
  const [imgErr, setImgErr] = useState('');
  const [dragging, setDragging] = useState(false);

  const addFiles = useCallback(async (fileList) => {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    setImgErr('');
    const slots = MAX_IMAGES - images.length;
    if (slots <= 0) { setImgErr(`You can attach up to ${MAX_IMAGES} screenshots.`); return; }
    const accepted = [];
    for (const f of files.slice(0, slots)) {
      if (!ACCEPTED_TYPES.includes(f.type)) { setImgErr('Only PNG, JPG, WEBP or GIF images.'); continue; }
      if (f.size > MAX_IMAGE_BYTES) { setImgErr('Each screenshot must be under 10 MB.'); continue; }
      try { accepted.push(await readImageAttachment(f)); }
      catch { setImgErr('Could not read that image.'); }
    }
    if (files.length > slots) setImgErr(`You can attach up to ${MAX_IMAGES} screenshots.`);
    if (accepted.length) setImages((prev) => [...prev, ...accepted].slice(0, MAX_IMAGES));
  }, [images.length]);

  const removeImage = useCallback((id) => setImages((prev) => prev.filter((i) => i.id !== id)), []);
  const reset = useCallback(() => { setImages([]); setImgErr(''); setDragging(false); }, []);

  return { images, imgErr, dragging, setDragging, addFiles, removeImage, reset };
}
