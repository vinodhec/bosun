// Minimal, dependency-free formatter for chat bubbles. The assistant replies in light markdown —
// **bold** and numbered lines — but bubbles are plain text, so without this the asterisks show
// literally and the line breaks collapse into one paragraph. Renders **bold** as bold and preserves
// line breaks (blank lines become a small gap). No markdown library, no dangerouslySetInnerHTML.
function renderInline(line) {
  // Split on **bold** spans, keeping the delimiters so we can style just those.
  return line.split(/(\*\*[^*]+\*\*)/g).map((part, i) => {
    const m = part.match(/^\*\*([^*]+)\*\*$/);
    return m ? <strong key={i}>{m[1]}</strong> : <span key={i}>{part}</span>;
  });
}

export default function RichText({ text }) {
  const lines = String(text || '').split('\n');
  return (
    <>
      {lines.map((line, i) =>
        line.trim() === ''
          ? <span key={i} className="block h-2" aria-hidden="true" />
          : <span key={i} className="block">{renderInline(line)}</span>,
      )}
    </>
  );
}
