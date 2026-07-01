import { useCallback, useState } from 'react';
import { MAX_DOCUMENTS, MAX_DOC_BYTES, hasAcceptedDocExt, readDocumentAttachment } from '../utils/documents.js';

// Shared document-attachment state for the "attach a plan / spreadsheet" composer — mirrors
// useImageAttachments so the fix box and the "Request changes" box behave identically.
export function useDocumentAttachments() {
  const [documents, setDocuments] = useState([]); // attached text documents, max MAX_DOCUMENTS
  const [docErr, setDocErr] = useState('');

  const addDocs = useCallback(async (fileList) => {
    const files = Array.from(fileList || []);
    if (!files.length) return;
    setDocErr('');
    const slots = MAX_DOCUMENTS - documents.length;
    if (slots <= 0) { setDocErr(`You can attach up to ${MAX_DOCUMENTS} documents.`); return; }
    const accepted = [];
    for (const f of files.slice(0, slots)) {
      if (!hasAcceptedDocExt(f.name)) { setDocErr('Attach a spreadsheet or text document (.csv, .txt, .md, .json).'); continue; }
      if (f.size > MAX_DOC_BYTES) { setDocErr('Each document must be under 200 KB.'); continue; }
      try { accepted.push(await readDocumentAttachment(f)); }
      catch { setDocErr('Could not read that document.'); }
    }
    if (files.length > slots) setDocErr(`You can attach up to ${MAX_DOCUMENTS} documents.`);
    if (accepted.length) setDocuments((prev) => [...prev, ...accepted].slice(0, MAX_DOCUMENTS));
  }, [documents.length]);

  const removeDoc = useCallback((id) => setDocuments((prev) => prev.filter((d) => d.id !== id)), []);
  const reset = useCallback(() => { setDocuments([]); setDocErr(''); }, []);

  return { documents, docErr, addDocs, removeDoc, reset };
}
