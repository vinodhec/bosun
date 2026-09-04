import { useState } from 'react';
import { replyToComparison, refineComparison } from '../firebase/functions.js';
import { useImageAttachments } from '../hooks/useImageAttachments.js';
import ScreenshotComposer from './ScreenshotComposer.jsx';
import RichText from './RichText.jsx';
import { formatINR } from '@shared/currency.js';
import { NEGATIVE_BALANCE_MESSAGE } from '@shared/billing.js';

// One "Size up the competition" card — the clarify chat, then a two-sided scorecard (where rivals beat
// us / where we beat them) and scoped actions. Each action routes into Fix / Design / Plan a feature
// via onRoute(scope, text). Plain language only — no technical words.

// How a finding's internal scope shows + reads to the owner, and the tool it routes into.
const SCOPE = {
  fix:     { label: 'Quick fix',  cta: 'Fix this →',     blurb: 'We’ll do this as a quick fix.' },
  design:  { label: 'New look',   cta: 'Design this →',  blurb: 'We’ll design how this looks first.' },
  feature: { label: 'Bigger add', cta: 'Plan this →',    blurb: 'We’ll plan this as a feature, built in steps.' },
};

export default function ComparisonCard({ comparison: c, onChanged, onRoute }) {
  const [answer, setAnswer] = useState('');
  const [changes, setChanges] = useState('');
  const [showChanges, setShowChanges] = useState(false);
  const [actOn, setActOn] = useState(null); // index of the finding being acted on
  const [actText, setActText] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [copied, setCopied] = useState(false);
  const { images, imgErr, dragging, setDragging, addFiles, removeImage, reset: resetImages } = useImageAttachments();

  const turns = Array.isArray(c.turns) ? c.turns : [];
  const shots = Array.isArray(c.screenshotUrls) ? c.screenshotUrls : []; // optional owner uploads
  const report = c.report || null;
  const ready = c.status === 'report_ready';
  const waiting = c.status === 'analysing' && c.awaitingOwner;   // agent asked us something
  const working = c.status === 'analysing' && !c.awaitingOwner;  // agent is thinking
  const failed = c.status === 'failed';

  const run = async (fn, after) => {
    setBusy(true); setErr('');
    try { await fn(); after?.(); await onChanged(); }
    catch (e) { setErr(friendly(e)); }
    finally { setBusy(false); }
  };

  const startAct = (i, finding) => { setActOn(i); setActText(finding.suggestedInput || finding.detail || ''); setErr(''); };
  const sendAct = (scope) => run(async () => { await onRoute(scope, actText.trim()); setActOn(null); setActText(''); });

  return (
    <div className="card p-5">
      <p className="text-sm text-ink-soft">“{c.prompt}”</p>
      <h3 className="mt-1 font-semibold text-ink">
        {failed ? 'We couldn’t finish this comparison 😔'
          : ready ? 'Here’s how you compare 📊'
          : waiting ? 'A couple of quick questions'
          : 'Sizing up the competition…'}
      </h3>
      {working && <p className="mt-1 text-sm text-ink-soft">We’re looking at your site and the competitors. This takes a few minutes — you can leave this open.</p>}

      {/* The back-and-forth so far. */}
      {turns.length > 0 && (
        <div className="mt-3 space-y-2">
          {turns.map((t, i) => (
            <div key={i} className={t.role === 'owner' ? 'flex justify-end' : 'flex justify-start'}>
              <div className={t.role === 'owner' ? 'bubble-owner' : 'bubble-agent'}>
                <RichText text={t.text} />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Optional: screenshots the owner shared (their page and/or a competitor's). */}
      {shots.length > 0 && (
        <div className="mt-3">
          <p className="text-xs font-medium uppercase tracking-wide text-ink-soft">Screenshots you shared</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {shots.map((url, i) => (
              <a key={i} href={url} target="_blank" rel="noreferrer" title="Open full size">
                <img src={url} alt={`shared ${i + 1}`} className="h-24 w-32 rounded-lg border border-line object-cover transition hover:opacity-90" />
              </a>
            ))}
          </div>
        </div>
      )}

      {/* The agent asked something — let the owner answer (often: send competitor screenshots). */}
      {waiting && (
        <div className="mt-3">
          <ScreenshotComposer
            value={answer}
            onChange={setAnswer}
            rows={2}
            placeholder="Type your answer — and attach a screenshot if they asked for one"
            images={images}
            imgErr={imgErr}
            dragging={dragging}
            setDragging={setDragging}
            addFiles={addFiles}
            removeImage={removeImage}
          />
          <button
            onClick={() => run(
              () => replyToComparison({ comparisonId: c.id, answer: answer.trim(), images: images.map((i) => ({ mediaType: i.mediaType, data: i.data })) }),
              () => { setAnswer(''); resetImages(); },
            )}
            disabled={busy || !answer.trim()}
            className="btn btn-primary btn-sm mt-2"
          >
            {busy ? 'Sending…' : 'Send answer'}
          </button>
        </div>
      )}

      {/* The scorecard. */}
      {ready && report && (
        <div className="mt-3 space-y-4">
          {report.summary && <p className="text-sm text-ink">{report.summary}</p>}

          {/* Shareable report — a durable web page (like a design's live mock), to send to anyone. */}
          {c.reportUrl && (
            <div className="flex flex-wrap items-center gap-2">
              <a href={c.reportUrl} target="_blank" rel="noreferrer" className="btn btn-primary btn-sm">
                Open full report ↗
              </a>
              <button
                onClick={() => { navigator.clipboard?.writeText(c.reportUrl).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }); }}
                className="btn btn-outline btn-sm"
              >
                {copied ? 'Link copied ✓' : 'Copy share link'}
              </button>
            </div>
          )}

          <div className="grid gap-3 sm:grid-cols-2">
            {/* Where we're behind. */}
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-amber-700">Where they’re ahead</p>
              {report.theirEdge?.length > 0 ? (
                <ul className="mt-2 space-y-1.5 text-sm text-ink">
                  {report.theirEdge.map((e, i) => (
                    <li key={i}>• {e.point}{e.evidence && <span className="text-ink-soft"> — {e.evidence}</span>}</li>
                  ))}
                </ul>
              ) : <p className="mt-2 text-sm text-ink-soft">Nothing major — you’re holding your own.</p>}
            </div>
            {/* Where we win. */}
            <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-emerald-700">Where you’re ahead</p>
              {report.ourEdge?.length > 0 ? (
                <ul className="mt-2 space-y-1.5 text-sm text-ink">
                  {report.ourEdge.map((e, i) => <li key={i}>• {e.point}</li>)}
                </ul>
              ) : <p className="mt-2 text-sm text-ink-soft">Let’s build a standout strength worth shouting about.</p>}
            </div>
          </div>

          {/* Actions — each routes into the right tool. */}
          {report.findings?.length > 0 && (
            <div>
              <p className="text-xs font-semibold uppercase tracking-wide text-ink-soft">What we’d do about it</p>
              <ul className="mt-2 space-y-2">
                {report.findings.map((f, i) => {
                  const sc = SCOPE[f.scope] || SCOPE.fix;
                  return (
                    <li key={i} className="rounded-xl border border-line p-3">
                      <div className="flex items-start justify-between gap-2">
                        <p className="text-sm font-medium text-ink">{f.title}</p>
                        <span className="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide bg-line/60 text-ink-soft">{sc.label}</span>
                      </div>
                      {f.detail && <p className="mt-1 text-sm text-ink-soft">{f.detail}</p>}
                      {f.evidence && <p className="mt-1 text-xs text-ink-soft">Seen on a competitor: {f.evidence}</p>}

                      {actOn === i ? (
                        <div className="mt-2">
                          <textarea
                            value={actText}
                            onChange={(e) => setActText(e.target.value)}
                            rows={2}
                            placeholder="Add anything you want us to know"
                            className="w-full rounded-xl border border-line px-3 py-2 text-sm focus:border-brand-500 focus:outline-none"
                          />
                          <p className="mt-1 text-xs text-ink-soft">{sc.blurb} You’ll review and pay for it there, the usual way.</p>
                          <div className="mt-2 flex gap-2">
                            <button onClick={() => sendAct(f.scope)} disabled={busy || !actText.trim()} className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-700 disabled:opacity-60">
                              {busy ? 'Setting up…' : sc.cta}
                            </button>
                            <button onClick={() => { setActOn(null); setActText(''); }} disabled={busy} className="rounded-lg px-4 py-2 text-sm font-semibold text-ink-soft hover:bg-line/40">Cancel</button>
                          </div>
                        </div>
                      ) : (
                        <button onClick={() => startAct(i, f)} className="mt-2 rounded-lg border border-brand-600 px-3 py-1.5 text-sm font-semibold text-brand-600 transition hover:bg-brand-50">
                          {sc.cta}
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          {/* Look again. */}
          <div className="border-t border-line pt-3">
            {!showChanges ? (
              <button onClick={() => setShowChanges(true)} className="text-sm font-semibold text-brand-600 hover:underline">
                Look again / focus on something
              </button>
            ) : (
              <div>
                <textarea
                  value={changes}
                  onChange={(e) => setChanges(e.target.value)}
                  rows={2}
                  placeholder="Example: also compare our prices, and check the booking step on mobile"
                  className="w-full rounded-xl border border-line px-3 py-2 text-sm focus:border-brand-500 focus:outline-none"
                />
                <p className="mt-1 text-xs text-ink-soft">There’s a small charge to look again, less than the first time.</p>
                <div className="mt-2 flex gap-2">
                  <button
                    onClick={() => run(() => refineComparison({ comparisonId: c.id, changes: changes.trim() }), () => { setChanges(''); setShowChanges(false); })}
                    disabled={busy || !changes.trim()}
                    className="rounded-lg bg-ink px-4 py-2 text-sm font-semibold text-white transition hover:opacity-90 disabled:opacity-60"
                  >
                    {busy ? 'Looking…' : 'Look again →'}
                  </button>
                  <button onClick={() => { setShowChanges(false); setChanges(''); }} disabled={busy} className="rounded-lg px-4 py-2 text-sm font-semibold text-ink-soft hover:bg-line/40">Cancel</button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {failed && (
        <p className="mt-2 text-sm text-ink-soft">Something went wrong while comparing. You were not charged — please try again.</p>
      )}

      {err && <p className="mt-2 text-sm text-bad">{err}</p>}

      {c.totalPaidInr > 0 && (
        <p className="mt-3 text-xs text-ink-soft">Paid so far: <span className="font-medium text-ink">{formatINR(c.totalPaidInr)}</span></p>
      )}
    </div>
  );
}

function friendly(e) {
  const m = String(e?.message || '');
  if (m.includes('LOW_BALANCE')) return NEGATIVE_BALANCE_MESSAGE;
  if (m.includes('NOT_AWAITING')) return 'This comparison has moved on — refresh to see the latest.';
  if (m.includes('NOT_REVIEWABLE')) return 'This comparison isn’t ready yet.';
  if (m.includes('TOO_MANY_REPLIES')) return 'Let’s go with what we have — act on a finding, or look again later.';
  if (m.includes('NO_REPO_CONNECTED')) return 'Your website isn’t connected yet.';
  return 'Something went wrong. You were not charged.';
}
