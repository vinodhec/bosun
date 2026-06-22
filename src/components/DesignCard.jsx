import { useState } from 'react';
import { replyToClarify, approveDesign, refineMockup } from '../firebase/functions.js';
import { formatINR } from '@shared/currency.js';

// One "Design a screen" card — the design phase only (clarify chat + the live mock to approve).
// Once the owner approves and it's building, the Dashboard renders the normal fix card on the
// build session instead, so deploy / go-live reuse the existing flow.
//
// Plain language only — no technical words (no HTML/iframe/agent/repo/etc).
export default function DesignCard({ design: d, onChanged }) {
  const [answer, setAnswer] = useState('');
  const [changes, setChanges] = useState('');
  const [showChanges, setShowChanges] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const turns = Array.isArray(d.turns) ? d.turns : [];
  const reviewing = d.status === 'mockup_review';
  const waiting = d.status === 'clarifying' && d.awaitingOwner;   // agent asked us something
  const working = d.status === 'clarifying' && !d.awaitingOwner;  // agent is thinking
  const failed = d.status === 'failed';

  const run = async (fn, after) => {
    setBusy(true); setErr('');
    try { await fn(); after?.(); await onChanged(); }
    catch (e) { setErr(friendly(e)); }
    finally { setBusy(false); }
  };

  return (
    <div className="rounded-2xl border border-line bg-white p-5">
      <p className="text-sm text-ink-soft">“{d.prompt}”</p>
      <h3 className="mt-1 font-semibold text-ink">
        {failed ? 'We couldn’t finish this design 😔'
          : reviewing ? 'Here’s how your screen will look ✨'
          : waiting ? 'A couple of quick questions'
          : 'Designing your screen…'}
      </h3>
      {working && <p className="mt-1 text-sm text-ink-soft">Please wait a moment — you can leave this open.</p>}

      {/* The back-and-forth so far. */}
      {turns.length > 0 && (
        <div className="mt-3 space-y-2">
          {turns.map((t, i) => (
            <div key={i} className={t.role === 'owner' ? 'flex justify-end' : 'flex justify-start'}>
              <div className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm ${t.role === 'owner' ? 'bg-brand-600 text-white' : 'bg-canvas text-ink ring-1 ring-line'}`}>
                {t.text}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* The agent asked something — let the owner answer to continue. */}
      {waiting && (
        <div className="mt-3">
          <textarea
            value={answer}
            onChange={(e) => setAnswer(e.target.value)}
            rows={2}
            placeholder="Type your answer…"
            className="w-full rounded-xl border border-line px-3 py-2 text-sm focus:border-brand-500 focus:outline-none"
          />
          <button
            onClick={() => run(() => replyToClarify({ designId: d.id, answer: answer.trim() }), () => setAnswer(''))}
            disabled={busy || !answer.trim()}
            className="mt-2 inline-flex items-center justify-center rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-700 disabled:opacity-60"
          >
            {busy ? 'Sending…' : 'Send answer'}
          </button>
        </div>
      )}

      {/* The mock is ready — preview it live and approve or ask for changes. */}
      {reviewing && (
        <div className="mt-3">
          {d.brief && <p className="text-sm text-ink-soft">{d.brief}</p>}
          {d.mockUrl && (
            <iframe
              src={d.mockUrl}
              sandbox=""
              title="Your screen"
              className="mt-3 h-[480px] w-full rounded-xl border border-line bg-white"
            />
          )}
          {d.mockUrl && (
            <a href={d.mockUrl} target="_blank" rel="noreferrer" className="mt-1 inline-block text-xs font-medium text-brand-600 hover:underline">
              Open full screen ↗
            </a>
          )}

          <div className="mt-3 flex flex-wrap gap-2">
            <button
              onClick={() => run(() => approveDesign({ designId: d.id }))}
              disabled={busy}
              className="rounded-xl bg-brand-600 px-4 py-2 font-semibold text-white transition hover:bg-brand-700 disabled:opacity-60"
            >
              {busy ? 'Starting…' : 'Looks great — build it'}
            </button>
            <button
              onClick={() => setShowChanges((v) => !v)}
              disabled={busy}
              className="rounded-xl px-4 py-2 font-semibold text-ink-soft transition hover:bg-line/40 disabled:opacity-60"
            >
              Ask for changes
            </button>
          </div>

          {showChanges && (
            <div className="mt-3">
              <textarea
                value={changes}
                onChange={(e) => setChanges(e.target.value)}
                rows={2}
                placeholder="Example: make the heading bigger and use a lighter background"
                className="w-full rounded-xl border border-line px-3 py-2 text-sm focus:border-brand-500 focus:outline-none"
              />
              <button
                onClick={() => run(() => refineMockup({ designId: d.id, changes: changes.trim() }), () => { setChanges(''); setShowChanges(false); })}
                disabled={busy || !changes.trim()}
                className="mt-2 inline-flex items-center justify-center rounded-xl bg-ink px-4 py-2 text-sm font-semibold text-white transition hover:opacity-90 disabled:opacity-60"
              >
                {busy ? 'Updating…' : 'Update the design'}
              </button>
            </div>
          )}
        </div>
      )}

      {failed && (
        <p className="mt-2 text-sm text-ink-soft">Something went wrong while designing this. You were not charged — please try again.</p>
      )}

      {err && <p className="mt-2 text-sm text-bad">{err}</p>}

      {d.totalPaidInr > 0 && (
        <p className="mt-3 text-xs text-ink-soft">Paid so far: <span className="font-medium text-ink">{formatINR(d.totalPaidInr)}</span></p>
      )}
    </div>
  );
}

function friendly(e) {
  const m = String(e?.message || '');
  if (m.includes('NOT_AWAITING')) return 'This design has moved on — refresh to see the latest.';
  if (m.includes('NOT_REVIEWABLE')) return 'This design isn’t ready to review yet.';
  if (m.includes('TOO_MANY_REPLIES')) return 'Let’s build from what we have — approve it or ask for changes after.';
  return 'Something went wrong. You were not charged.';
}
