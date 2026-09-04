import { useRef } from 'react';
import { MAX_IMAGES, ACCEPTED_TYPES, imageFilesFrom } from '../utils/images.js';
import { MAX_DOCUMENTS, ACCEPTED_DOC_ACCEPT } from '../utils/documents.js';

export default function ScreenshotComposer({
  value, onChange, rows = 3, placeholder, autoFocus = false, onKeyDown, disabled = false,
  images, imgErr, dragging, setDragging, addFiles, removeImage,
  // Optional document attachments — the "attach a plan / spreadsheet" button only renders when
  // an `addDocs` handler is passed, so screenshot-only composers are unaffected.
  documents = [], docErr = '', addDocs, removeDoc,
}) {
  const fileRef = useRef(null);
  const docRef = useRef(null);

  const onPaste = (e) => {
    const files = imageFilesFrom(e.clipboardData);
    if (files.length) { e.preventDefault(); addFiles(files); }
  };
  const onDrop = (e) => { e.preventDefault(); setDragging(false); addFiles(imageFilesFrom(e.dataTransfer)); };
  const onPick = (e) => { addFiles(e.target.files); e.target.value = ''; };
  const onPickDoc = (e) => { addDocs?.(e.target.files); e.target.value = ''; };
  const full = images.length >= MAX_IMAGES;
  const docsFull = documents.length >= MAX_DOCUMENTS;

  return (
    <div
      onDrop={onDrop}
      onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
      onDragLeave={() => setDragging(false)}
      className={`composer ${dragging ? 'composer-dragging' : ''}`}
    >
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onPaste={onPaste}
        onKeyDown={onKeyDown}
        rows={rows}
        autoFocus={autoFocus}
        disabled={disabled}
        placeholder={placeholder}
        className="w-full resize-none bg-transparent px-4 py-3.5 text-sm leading-relaxed text-ink outline-none placeholder:text-ink-muted"
      />
      {images.length > 0 && (
        <div className="flex flex-wrap gap-2.5 border-t border-line/60 px-4 py-3">
          {images.map((img) => (
            <div key={img.id} className="relative">
              <img src={img.dataUrl} alt="screenshot" className="h-16 w-16 rounded-lg border border-line object-cover shadow-sm" />
              <button
                type="button"
                onClick={() => removeImage(img.id)}
                aria-label="Remove screenshot"
                className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-ink text-xs text-white shadow-md transition hover:scale-110"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}
      {addDocs && documents.length > 0 && (
        <div className="flex flex-wrap gap-2 border-t border-line/60 px-4 py-3">
          {documents.map((doc) => (
            <span
              key={doc.id}
              className="inline-flex items-center gap-1.5 rounded-lg border border-line bg-canvas px-2.5 py-1.5 text-xs font-medium text-ink"
            >
              📄 {doc.name}
              <button
                type="button"
                onClick={() => removeDoc(doc.id)}
                aria-label="Remove document"
                className="text-ink-soft transition hover:text-ink"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="flex items-center gap-1 border-t border-line/60 px-3 py-2">
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          disabled={full}
          title={full ? `Up to ${MAX_IMAGES} screenshots` : 'Attach a screenshot'}
          className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-ink-soft transition hover:bg-canvas hover:text-ink disabled:opacity-50"
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
        {addDocs && (
          <>
            <button
              type="button"
              onClick={() => docRef.current?.click()}
              disabled={docsFull}
              title={docsFull ? `Up to ${MAX_DOCUMENTS} documents` : 'Attach a plan or spreadsheet'}
              className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-medium text-ink-soft transition hover:bg-canvas hover:text-ink disabled:opacity-50"
            >
              📄 Attach document
            </button>
            <input
              ref={docRef}
              type="file"
              accept={ACCEPTED_DOC_ACCEPT}
              multiple
              className="hidden"
              onChange={onPickDoc}
            />
          </>
        )}
      </div>
      {imgErr && <p className="px-4 pb-3 text-sm text-bad">{imgErr}</p>}
      {docErr && <p className="px-4 pb-3 text-sm text-bad">{docErr}</p>}
    </div>
  );
}
