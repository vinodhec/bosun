import { useRef } from 'react';
import { MAX_IMAGES, ACCEPTED_TYPES, imageFilesFrom } from '../utils/images.js';

// Textarea + screenshot attachments: paste (Ctrl/⌘+V), drag-drop, or the 📎 attach button.
// Driven by an external useImageAttachments() so the parent can read/reset the images it sends.
export default function ScreenshotComposer({
  value, onChange, rows = 3, placeholder, autoFocus = false,
  images, imgErr, dragging, setDragging, addFiles, removeImage,
}) {
  const fileRef = useRef(null);

  const onPaste = (e) => {
    const files = imageFilesFrom(e.clipboardData);
    if (files.length) { e.preventDefault(); addFiles(files); }
  };
  const onDrop = (e) => { e.preventDefault(); setDragging(false); addFiles(imageFilesFrom(e.dataTransfer)); };
  const onPick = (e) => { addFiles(e.target.files); e.target.value = ''; };
  const full = images.length >= MAX_IMAGES;

  return (
    <div
      onDrop={onDrop}
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      className={`rounded-xl border ${dragging ? 'border-brand-500 ring-1 ring-brand-500' : 'border-line'}`}
    >
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onPaste={onPaste}
        rows={rows}
        autoFocus={autoFocus}
        placeholder={placeholder}
        className="w-full resize-none rounded-t-xl bg-transparent px-4 py-3 text-sm outline-none"
      />
      {images.length > 0 && (
        <div className="flex flex-wrap gap-2 px-4 pb-2">
          {images.map((img) => (
            <div key={img.id} className="relative">
              <img src={img.dataUrl} alt="screenshot" className="h-16 w-16 rounded-lg border border-line object-cover" />
              <button
                type="button"
                onClick={() => removeImage(img.id)}
                aria-label="Remove screenshot"
                className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-ink text-xs text-white shadow"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="px-3 pb-2">
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={full}
          title={full ? `Up to ${MAX_IMAGES} screenshots` : 'Attach a screenshot'}
          className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium text-ink-soft transition hover:bg-line/50 disabled:opacity-50"
        >
          📎 Attach screenshot
        </button>
        <input
          ref={fileRef}
          type="file"
          accept={ACCEPTED_TYPES.join(',')}
          multiple
          className="hidden"
          onChange={onPick}
        />
      </div>
      {imgErr && <p className="px-4 pb-2 text-sm text-bad">{imgErr}</p>}
    </div>
  );
}
