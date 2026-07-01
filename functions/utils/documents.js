import { HttpsError } from 'firebase-functions/v2/https';

// Reference documents (a CSV page plan, a spec, notes) the owner attaches alongside a fix so the
// agent has the exact details — text, values, or a per-page list — to follow. Sent inline as UTF-8
// text; we never store them, same as screenshots. Keep these limits in sync with the client-side
// guard in src/utils/documents.js.
export const MAX_DOCUMENTS = 3;
const MAX_DOC_CHARS = 200 * 1024; // ~200 KB of text — generous for a plan/CSV, sane on tokens
const MAX_NAME_LEN = 120;

// Validate + cap the owner's attached reference documents before forwarding them to the agent.
// Empty entries are skipped silently; oversized ones are rejected. Returns [{ name, text }].
export function sanitizeDocuments(raw) {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const out = [];
  for (const doc of raw.slice(0, MAX_DOCUMENTS)) {
    const text = typeof doc?.text === 'string' ? doc.text : '';
    if (!text.trim()) continue;
    if (text.length > MAX_DOC_CHARS) {
      throw new HttpsError('invalid-argument', 'Each attached document must be under ~200 KB of text.');
    }
    const name =
      String(doc?.name ?? 'document').replace(/[\r\n]+/g, ' ').trim().slice(0, MAX_NAME_LEN) || 'document';
    out.push({ name, text });
  }
  return out;
}
