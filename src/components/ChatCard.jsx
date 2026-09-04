import { useState, lazy, Suspense } from 'react';
import { replyToChat, approveChatBuild, getChatMockHtml } from '../firebase/functions.js';
import { formatINR } from '@shared/currency.js';
import ScreenshotComposer from './ScreenshotComposer.jsx';
import RichText from './RichText.jsx';
import { useImageAttachments } from '../hooks/useImageAttachments.js';
import { NEGATIVE_BALANCE_MESSAGE } from '@shared/billing.js';

// The markup tool pulls in the drawing libraries (fabric, snapDOM) — load it only when the owner
// opens "Mark up the screen", so it doesn't weigh down the dashboard.
const MockAnnotator = lazy(() => import('./MockAnnotator.jsx'));

// One "Chat & build" card — the whole thing in a single thread: the back-and-forth where we work out
// what's needed (we may ask for a screenshot, a page link, a recording or a design), an optional
// preview, then — once you say go — we make the change and you get a link to see it.
//
// Plain language only — no technical words (no repo/PR/agent/code/etc).
export default function ChatCard({ chat: c, onChanged }) {
  const [answer, setAnswer] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [showAnnotator, setShowAnnotator] = useState(false);
  const [mockHtml, setMockHtml] = useState('');
  const replyImages = useImageAttachments();

  // Open the mark-up tool: fetch the preview's raw HTML (owner-gated) so the annotator can re-render
  // it same-origin and let the owner draw on it. On apply, the flattened picture rides into a tweak.
  const openMarkup = async () => {
    setErr('');
    try {
      if (!mockHtml) {
        const res = await getChatMockHtml({ chatId: c.id });
        setMockHtml(String(res?.data?.mockHtml || ''));
      }
      setShowAnnotator(true);
    } catch { setErr('We couldn’t open the preview to mark up. Please try again.'); }
  };
  const onApplyMarkup = (file, summary) => {
    replyImages.addFiles([file]);
    setAnswer((prev) => (prev.trim() ? (summary ? `${prev}\n${summary}` : prev) : summary));
  };

  const turns = Array.isArray(c.turns) ? c.turns : [];
  const waiting = ['clarifying', 'ready_to_build', 'previewing'].includes(c.status) && c.awaitingOwner;
  const working = c.status === 'clarifying' && !c.awaitingOwner;
  const canApprove = ['ready_to_build', 'previewing'].includes(c.status) && c.awaitingOwner;
  const building = c.status === 'building';
  const complete = c.status === 'complete';
  const failed = c.status === 'failed';

  const run = async (fn, after) => {
    setBusy(true); setErr('');
    try { await fn(); after?.(); await onChanged(); }
    catch (e) { setErr(friendly(e)); }
    finally { setBusy(false); }
  };

  return (
    <div className="card p-5">
      <p className="text-sm text-ink-soft">“{c.prompt}”</p>
      <h3 className="mt-1 font-semibold text-ink">
        {failed ? 'We couldn’t finish this 😔'
          : complete ? 'All done 🎉'
          : building ? 'Making the change…'
          : canApprove ? 'Ready when you are ✨'
          : waiting ? 'A couple of quick questions'
          : 'Working on it…'}
      </h3>
      {(working || building) && <p className="mt-1 text-sm text-ink-soft">Please wait a moment — you can leave this open.</p>}

      {/* The whole conversation so far, one thread start to finish. */}
      {turns.length > 0 && (
        <div className="mt-3 space-y-2">
          {turns.map((t, i) => (
            <div key={i} className={t.role === 'owner' ? 'flex justify-end' : 'flex justify-start'}>
              <div className={t.role === 'owner' ? 'bubble-owner' : 'bubble-agent'}><RichText text={t.text} /></div>
            </div>
          ))}
        </div>
      )}

      {/* The optional visual preview, before anything is built. */}
      {canApprove && c.mockUrl && (
        <div className="mt-3">
          {/* The preview link, surfaced right in the thread as a chat element. */}
          <div className="flex justify-start">
            <div className="bubble-agent flex items-center gap-2">
              <span>✨ Here’s a preview of your screen:</span>
              <a href={c.mockUrl} target="_blank" rel="noreferrer" className="font-semibold text-brand-600 hover:underline">
                Open preview ↗
              </a>
            </div>
          </div>
          <iframe
            src={c.mockUrl}
            sandbox=""
            title="Preview"
            className="mt-3 h-[420px] w-full rounded-xl border border-line bg-white shadow-sm"
          />
          <div className="mt-2 flex flex-wrap items-center gap-3">
            <a href={c.mockUrl} target="_blank" rel="noreferrer" className="text-xs font-medium text-brand-600 hover:underline">
              Open full screen ↗
            </a>
            <button onClick={openMarkup} disabled={busy} className="btn btn-outline btn-sm">
              ✏️ Mark up the preview
            </button>
          </div>
        </div>
      )}

      {/* We asked something — reply to keep going. Attach a screenshot to show exactly what you mean. */}
      {waiting && !canApprove && (
        <div className="mt-3">
          <ScreenshotComposer
            value={answer}
            onChange={setAnswer}
            placeholder="Type your answer… you can attach a screenshot too"
            images={replyImages.images}
            imgErr={replyImages.imgErr}
            dragging={replyImages.dragging}
            setDragging={replyImages.setDragging}
            addFiles={replyImages.addFiles}
            removeImage={replyImages.removeImage}
          />
          <button
            onClick={() => run(
              () => replyToChat({
                chatId: c.id,
                answer: answer.trim(),
                images: replyImages.images.map((i) => ({ mediaType: i.mediaType, data: i.data })),
              }),
              () => { setAnswer(''); replyImages.reset(); },
            )}
            disabled={busy || (!answer.trim() && replyImages.images.length === 0)}
            className="btn btn-primary btn-sm mt-2"
          >
            {busy ? 'Sending…' : 'Send'}
          </button>
        </div>
      )}

      {/* Ready — approve to build, or reply to ask for a tweak first. */}
      {canApprove && (
        <div className="mt-3">
          <label className="block text-xs font-medium text-ink-soft">Anything to add before we make the change? <span className="font-normal">(optional)</span></label>
          <textarea
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            rows={2}
            placeholder="Example: keep the same page title, and make the phone number clickable"
            className="mt-1 w-full rounded-xl border border-line px-3 py-2 text-sm focus:border-brand-500 focus:outline-none"
          />
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              onClick={() => run(() => approveChatBuild({ chatId: c.id, notes: notes.trim() }), () => setNotes(''))}
              disabled={busy}
              className="btn btn-primary"
            >
              {busy ? 'Starting…' : 'Go ahead — make the change'}
            </button>
          </div>
          <div className="mt-3">
            <ScreenshotComposer
              value={answer}
              onChange={setAnswer}
              placeholder="Or ask for a tweak first…"
              images={replyImages.images}
              imgErr={replyImages.imgErr}
              dragging={replyImages.dragging}
              setDragging={replyImages.setDragging}
              addFiles={replyImages.addFiles}
              removeImage={replyImages.removeImage}
            />
            <button
              onClick={() => run(
                () => replyToChat({
                  chatId: c.id,
                  answer: answer.trim(),
                  images: replyImages.images.map((i) => ({ mediaType: i.mediaType, data: i.data })),
                }),
                () => { setAnswer(''); replyImages.reset(); },
              )}
              disabled={busy || (!answer.trim() && replyImages.images.length === 0)}
              className="btn btn-outline btn-sm mt-2"
            >
              {busy ? 'Sending…' : 'Ask for a tweak'}
            </button>
          </div>
        </div>
      )}

      {/* Done — the change is ready to preview. */}
      {complete && (
        <div className="mt-3">
          {c.previewUrl ? (
            <a href={c.previewUrl} target="_blank" rel="noreferrer" className="btn btn-primary btn-sm">
              See your change ↗
            </a>
          ) : (
            <p className="text-sm text-ink-soft">Your change is being prepared for preview — check back in a moment.</p>
          )}
        </div>
      )}

      {failed && (
        <p className="mt-2 text-sm text-ink-soft">Something went wrong. You were not charged — please try again.</p>
      )}

      {err && <p className="mt-2 text-sm text-bad">{err}</p>}

      {showAnnotator && mockHtml && (
        <Suspense fallback={null}>
          <MockAnnotator mockHtml={mockHtml} onApply={onApplyMarkup} onClose={() => setShowAnnotator(false)} />
        </Suspense>
      )}

      {c.totalPaidInr > 0 && (
        <p className="mt-3 text-xs text-ink-soft">Paid: <span className="font-medium text-ink">{formatINR(c.totalPaidInr)}</span></p>
      )}
    </div>
  );
}

function friendly(e) {
  const m = String(e?.message || '');
  if (m.includes('LOW_BALANCE')) return NEGATIVE_BALANCE_MESSAGE;
  if (m.includes('NOT_AWAITING')) return 'This chat has moved on — refresh to see the latest.';
  if (m.includes('NOT_READY')) return 'This isn’t ready to build yet.';
  if (m.includes('BUDGET_SOFT')) return 'We’ve got enough to build this — go ahead and approve it, then start a new chat for anything else.';
  if (m.includes('TOO_MANY_REPLIES')) return 'Let’s build from what we have — approve it to continue.';
  return 'Something went wrong. You were not charged.';
}
