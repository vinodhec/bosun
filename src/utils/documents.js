// Client-side handling for the "attach a document" flow — a page plan / spreadsheet (CSV), a
// spec, or notes the owner wants us to follow exactly. Read as plain text in the browser and sent
// inline to createTask/reviseSession; never uploaded or persisted (same as screenshots). Keep the
// limits in sync with the server guard in functions/utils/documents.js.

export const MAX_DOCUMENTS = 3;
export const MAX_DOC_BYTES = 200 * 1024; // ~200 KB source guard
// Text-based references we can read as plain text. (PDFs / Word docs aren't plain text — not yet.)
export const ACCEPTED_DOC_EXT = ['.csv', '.tsv', '.txt', '.md', '.json'];
export const ACCEPTED_DOC_ACCEPT =
  '.csv,.tsv,.txt,.md,.json,text/csv,text/tab-separated-values,text/plain,text/markdown,application/json';

/** True when a filename ends in one of the accepted text extensions (browsers set spotty MIME types). */
export function hasAcceptedDocExt(name = '') {
  const lower = String(name).toLowerCase();
  return ACCEPTED_DOC_EXT.some((ext) => lower.endsWith(ext));
}

/** Read a text File into { id, name, text, size }. Oversized/non-text files are filtered upstream. */
export function readDocumentAttachment(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('read_failed'));
    reader.onload = () =>
      resolve({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        name: file.name || 'document',
        text: String(reader.result || ''),
        size: file.size,
      });
    reader.readAsText(file);
  });
}
