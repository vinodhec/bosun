// "Tip for next time" — shows the agent's ideal prompt for this fix, with a few key phrases
// underlined and a hover-tooltip explaining WHY each detail saved time. The header has an
// (i) icon explaining the principle: specific words = less guessing = cheaper fixes.
//
// `text` is the prompt. `keywords` is an optional [{ phrase, why }] — phrases must appear
// verbatim in `text`; the server filters out any that don't. `compact` drops the lead-in
// line and tightens padding so this fits inside an existing round card.

function buildSegments(text, keywords) {
  if (!text) return [];
  if (!keywords?.length) return [{ kind: 'plain', text }];
  const lower = text.toLowerCase();
  const ranges = [];
  for (const k of keywords) {
    const phrase = k?.phrase;
    const why = k?.why;
    if (!phrase || !why) continue;
    const idx = lower.indexOf(phrase.toLowerCase());
    if (idx < 0) continue;
    const end = idx + phrase.length;
    if (ranges.some((r) => idx < r.end && end > r.start)) continue;
    ranges.push({ start: idx, end, why });
  }
  ranges.sort((a, b) => a.start - b.start);
  const out = [];
  let cursor = 0;
  for (const r of ranges) {
    if (r.start > cursor) out.push({ kind: 'plain', text: text.slice(cursor, r.start) });
    out.push({ kind: 'hl', text: text.slice(r.start, r.end), why: r.why });
    cursor = r.end;
  }
  if (cursor < text.length) out.push({ kind: 'plain', text: text.slice(cursor) });
  return out;
}

const PRINCIPLE =
  'Specific words like a page name, a visible label, or a URL help us go straight to the right place — fewer guesses, faster fixes.';

export default function IdealPromptTip({ text, keywords, compact = false }) {
  if (!text) return null;
  const segments = buildSegments(text, keywords);
  const outerCls = compact
    ? 'mt-2 rounded-lg border border-brand-100 bg-brand-50 p-2.5'
    : 'mt-4 rounded-xl border border-brand-100 bg-brand-50 p-4';
  const bodyCls = compact
    ? 'mt-1 text-sm italic text-ink-soft'
    : 'mt-2 rounded-lg bg-white p-3 text-sm italic text-ink-soft';

  return (
    <div className={outerCls}>
      <div className="flex items-center gap-1.5">
        <p className="text-xs font-semibold uppercase tracking-wide text-brand-700">
          Tip for next time
        </p>
        <span
          title={PRINCIPLE}
          aria-label={PRINCIPLE}
          className="inline-flex h-4 w-4 cursor-help items-center justify-center rounded-full border border-brand-300 text-[10px] font-semibold text-brand-700"
        >
          i
        </span>
      </div>
      {!compact && (
        <p className="mt-1 text-sm text-ink">
          Next time, you could send us a prompt like this:
        </p>
      )}
      <p className={bodyCls}>
        “
        {segments.map((s, i) =>
          s.kind === 'plain' ? (
            <span key={i}>{s.text}</span>
          ) : (
            <span
              key={i}
              title={s.why}
              aria-label={`${s.text} — ${s.why}`}
              className="cursor-help font-medium not-italic text-ink underline decoration-dotted decoration-brand-500 underline-offset-2"
            >
              {s.text}
            </span>
          )
        )}
        ”
      </p>
    </div>
  );
}
