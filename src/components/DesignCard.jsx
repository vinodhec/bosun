import { useState, lazy, Suspense } from 'react';
import { replyToClarify, approveDesign, refineMockup, shareDesign, unshareDesign } from '../firebase/functions.js';
import { formatINR } from '@shared/currency.js';
import ScreenshotComposer from './ScreenshotComposer.jsx';
import { useImageAttachments } from '../hooks/useImageAttachments.js';

// The markup tool pulls in the screenshot + drawing libraries (fabric, snapDOM) — load them only
// when the owner actually opens "Mark up the screen", so they don't weigh down the dashboard.
const MockAnnotator = lazy(() => import('./MockAnnotator.jsx'));

// The team-share link for a design, built from its capability token.
function shareLink(designId, token) {
  return `${window.location.origin}/shared/design/${designId}?t=${token}`;
}

// One "Design a screen" card — the design phase only (clarify chat + the live mock to approve).
// Once the owner approves, the design is handed off to a feature (the build runs there, step by
// step) and the card shows a link across to it.
//
// Plain language only — no technical words (no HTML/iframe/agent/repo/etc).
export default function DesignCard({ design: d, onChanged, onGoToFeature }) {
  const [answer, setAnswer] = useState('');
  const [changes, setChanges] = useState('');
  const [notes, setNotes] = useState('');
  const [showChanges, setShowChanges] = useState(false);
  const [showAnnotator, setShowAnnotator] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [shareToken, setShareToken] = useState(d.shared ? d.shareToken : null);
  const [copied, setCopied] = useState(false);
  // Optional "make it even better" enhancements the agent proposed; the owner opts into the ones they
  // want and they ride into the build (no separate change, no extra charge).
  const suggestions = Array.isArray(d.suggestions) ? d.suggestions : [];
  const [accepted, setAccepted] = useState(() => new Set());
  const toggleSuggestion = (i) => setAccepted((prev) => {
    const next = new Set(prev);
    next.has(i) ? next.delete(i) : next.add(i);
    return next;
  });
  // Marked-up screenshots the owner can attach to a change request, to show exactly what they mean.
  const changeImages = useImageAttachments();

  const turns = Array.isArray(d.turns) ? d.turns : [];
  const reviewing = d.status === 'mockup_review';
  const waiting = d.status === 'clarifying' && d.awaitingOwner;   // agent asked us something
  const working = d.status === 'clarifying' && !d.awaitingOwner;  // agent is thinking
  const handedOff = d.status === 'handed_off';                    // approved → now a feature
  const failed = d.status === 'failed';

  const run = async (fn, after) => {
    setBusy(true); setErr('');
    try { await fn(); after?.(); await onChanged(); }
    catch (e) { setErr(friendly(e)); }
    finally { setBusy(false); }
  };

  // The owner marked up the mock → attach the flattened picture to the change request and prefill the
  // change text with what they pointed at (they can still edit it).
  const onApplyMarkup = (file, summary) => {
    setShowChanges(true);
    changeImages.addFiles([file]);
    setChanges((prev) => (prev.trim() ? (summary ? `${prev}\n${summary}` : prev) : summary));
  };

  return (
    <div className="rounded-2xl border border-line bg-white p-5">
      <p className="text-sm text-ink-soft">“{d.prompt}”</p>
      <h3 className="mt-1 font-semibold text-ink">
        {failed ? 'We couldn’t finish this design 😔'
          : handedOff ? 'Design approved 🎉'
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

      {/* The mock — shown while reviewing AND after hand-off, so the design card stays a record of the
          design. Approve / ask-for-changes controls only appear while reviewing. */}
      {(reviewing || handedOff) && (
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

          {/* Share with a teammate. They open the link, see this design, and build their own version. */}
          <div className="mt-4 rounded-xl border border-line bg-canvas/60 p-3">
            {!shareToken ? (
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs text-ink-soft">Want a teammate to build their own version from this?</p>
                <button
                  onClick={() => run(async () => { const res = await shareDesign({ designId: d.id }); setShareToken(res?.data?.shareToken || null); })}
                  disabled={busy}
                  className="rounded-xl border border-brand-600 px-3 py-1.5 text-xs font-semibold text-brand-600 transition hover:bg-brand-50 disabled:opacity-60"
                >
                  Share with my team
                </button>
              </div>
            ) : (
              <div>
                <p className="text-xs font-medium text-ink">Anyone on your team can open this and build their own version.</p>
                <div className="mt-2 flex items-center gap-2">
                  <input
                    readOnly
                    value={shareLink(d.id, shareToken)}
                    onFocus={(e) => e.target.select()}
                    className="min-w-0 flex-1 rounded-lg border border-line bg-white px-2 py-1.5 text-xs text-ink-soft"
                  />
                  <button
                    onClick={() => { navigator.clipboard?.writeText(shareLink(d.id, shareToken)); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
                    className="shrink-0 rounded-lg bg-brand-600 px-3 py-1.5 text-xs font-semibold text-white transition hover:bg-brand-700"
                  >
                    {copied ? 'Copied ✓' : 'Copy link'}
                  </button>
                </div>
                <button
                  onClick={() => run(async () => { await unshareDesign({ designId: d.id }); setShareToken(null); })}
                  disabled={busy}
                  className="mt-2 text-xs font-medium text-ink-soft underline hover:text-ink disabled:opacity-60"
                >
                  Stop sharing
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Review controls — approve (→ hand off to a feature) or ask for a change. */}
      {reviewing && (
        <div className="mt-3">
          {/* Explained, opt-in enhancements — the “why” teaches the owner; chosen ones ride into the build. */}
          {suggestions.length > 0 && (
            <div className="mt-1">
              <p className="text-sm font-semibold text-ink">Make it even better? <span className="font-normal text-ink-soft">(optional)</span></p>
              <div className="mt-2 space-y-2">
                {suggestions.map((s, i) => {
                  const on = accepted.has(i);
                  return (
                    <div key={i} className={`rounded-xl border p-3 transition ${on ? 'border-brand-500 bg-brand-50/60' : 'border-line bg-canvas/40'}`}>
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-sm font-semibold text-ink">{s.title}</p>
                          {s.why && <p className="mt-0.5 text-sm text-ink-soft">{s.why}</p>}
                        </div>
                        <button
                          onClick={() => toggleSuggestion(i)}
                          disabled={busy}
                          className={`shrink-0 rounded-lg px-3 py-1.5 text-xs font-semibold transition disabled:opacity-60 ${on ? 'bg-brand-600 text-white' : 'border border-brand-600 text-brand-600 hover:bg-brand-50'}`}
                        >
                          {on ? 'Added ✓' : 'Add this'}
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
              {accepted.size > 0 && (
                <p className="mt-2 text-xs text-ink-soft">We’ll include {accepted.size === 1 ? 'this' : `these ${accepted.size}`} when we build — no extra step.</p>
              )}
            </div>
          )}

          <div className="mt-3">
            <label className="block text-xs font-medium text-ink-soft">Anything to add before we build? <span className="font-normal">(optional)</span></label>
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              placeholder="Example: make sure the phone number is clickable, and keep the same page title"
              className="mt-1 w-full rounded-xl border border-line px-3 py-2 text-sm focus:border-brand-500 focus:outline-none"
            />
          </div>

          <div className="mt-3 flex flex-wrap gap-2">
            <button
              onClick={() => run(async () => {
                // Fold the chosen "make it even better" extras into the build notes so they're built
                // alongside the screen — no separate change request, no extra charge.
                const extras = suggestions.filter((_, i) => accepted.has(i)).map((s) => `- ${s.change}`).join('\n');
                const finalNotes = [notes.trim(), extras && `Also include these improvements:\n${extras}`]
                  .filter(Boolean).join('\n\n').slice(0, 1500);
                const res = await approveDesign({ designId: d.id, notes: finalNotes });
                const fid = res?.data?.featureId;
                if (fid) onGoToFeature?.(fid); // hand off → the feature plan, prepopulated
              })}
              disabled={busy}
              className="rounded-xl bg-brand-600 px-4 py-2 font-semibold text-white transition hover:bg-brand-700 disabled:opacity-60"
            >
              {busy ? 'Setting up…' : 'Looks great — plan the build'}
            </button>
            <button
              onClick={() => setShowChanges((v) => !v)}
              disabled={busy}
              className="rounded-xl px-4 py-2 font-semibold text-brand-600 transition hover:bg-brand-50 disabled:opacity-60"
            >
              Request changes
            </button>
            <button
              onClick={() => setShowAnnotator(true)}
              disabled={busy}
              className="rounded-xl px-4 py-2 font-semibold text-brand-600 transition hover:bg-brand-50 disabled:opacity-60"
            >
              ✏️ Mark up the screen
            </button>
          </div>

          {showChanges && (
            <div className="mt-3">
              <ScreenshotComposer
                value={changes}
                onChange={setChanges}
                placeholder="What should change? Example: also make the buttons bigger on mobile"
                images={changeImages.images}
                imgErr={changeImages.imgErr}
                dragging={changeImages.dragging}
                setDragging={changeImages.setDragging}
                addFiles={changeImages.addFiles}
                removeImage={changeImages.removeImage}
              />
              <p className="mt-1 text-xs text-ink-soft">
                📎 Attach, paste or drag in a screenshot to show what’s still off.
              </p>
              <div className="mt-2 flex gap-2">
                <button
                  onClick={() => run(
                    () => refineMockup({
                      designId: d.id,
                      changes: changes.trim(),
                      images: changeImages.images.map((i) => ({ mediaType: i.mediaType, data: i.data })),
                    }),
                    () => { setChanges(''); setShowChanges(false); changeImages.reset(); },
                  )}
                  disabled={busy || (!changes.trim() && changeImages.images.length === 0)}
                  className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-700 disabled:opacity-60"
                >
                  {busy ? 'Sending…' : 'Send changes →'}
                </button>
                <button onClick={() => { setShowChanges(false); changeImages.reset(); }} disabled={busy} className="rounded-lg px-4 py-2 text-sm font-semibold text-ink-soft hover:bg-line/40 disabled:opacity-60">
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Approved — the build is now a feature, built step by step. Point the owner across to it. */}
      {handedOff && (
        <div className="mt-3">
          <p className="text-sm text-ink-soft">We’ve turned your screen into a step-by-step plan you can review and build.</p>
          <button
            onClick={() => onGoToFeature?.(d.featureId)}
            disabled={!d.featureId}
            className="mt-2 inline-flex items-center justify-center rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-700 disabled:opacity-60"
          >
            View your feature →
          </button>
        </div>
      )}

      {failed && (
        <p className="mt-2 text-sm text-ink-soft">Something went wrong while designing this. You were not charged — please try again.</p>
      )}

      {err && <p className="mt-2 text-sm text-bad">{err}</p>}

      {showAnnotator && (
        <Suspense fallback={null}>
          <MockAnnotator designId={d.id} onApply={onApplyMarkup} onClose={() => setShowAnnotator(false)} />
        </Suspense>
      )}

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
