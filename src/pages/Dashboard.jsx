import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../hooks/useAuth.js';
import { useOrg } from '../hooks/useOrg.js';
import { createTask, listMySessions, reviseSession, approveFix, confirmQuote, declineQuote, customerDeployTesting, customerDeployProd, customerPreviewTesting, customerRevertTesting, planFeature, approveFeaturePlan, reviseFeaturePlan, addFeatureChange, listMyFeatures, retryFeatureStep } from '../firebase/functions.js';
import Navbar from '../components/Navbar.jsx';
import ScreenshotComposer from '../components/ScreenshotComposer.jsx';
import IdealPromptTip from '../components/IdealPromptTip.jsx';
import Leaderboard from '../components/Leaderboard.jsx';
import { useImageAttachments } from '../hooks/useImageAttachments.js';
import { useOrgStats } from '../hooks/useOrgStats.js';
import { formatINR } from '@shared/currency.js';
import { clarityStars } from '@shared/gamification.js';
import { MAX_IMAGES } from '../utils/images.js';

const STATUS = {
  queued: 'Starting…',
  running: 'Working on it…',
  complete: 'Your fix is ready! ✅',
  failed: 'Something went wrong 😔',
  needs_quote: 'Preparing your quote…',
  quoted: 'Here’s your quote',
  cancelled: 'Cancelled',
};
const isWorking = (s) => s === 'queued' || s === 'running';
// States that change on their own (operator quoting, agent running) — keep polling for them.
const isLive = (s) => isWorking(s) || s === 'needs_quote' || s === 'quoted';

function friendlyError(e) {
  const m = String(e?.message || '');
  if (m.includes('NO_REPO_CONNECTED')) return 'Your website isn’t connected yet.';
  if (m.includes('NO_ORG')) return 'Your account isn’t set up yet — the Bosun team will sort it.';
  if (m.includes('ALREADY_DEPLOYED')) return 'This fix is already live — start a new fix for further changes.';
  if (m.includes('NOT_READY')) return 'Please wait for the current change to finish.';
  if (m.includes('NOT_PENDING')) return 'This fix has already been confirmed.';
  if (m.includes('TOO_MANY_FREE_REVISIONS')) return 'You’ve used all the free re-fixes for this. Approve what you have, or ask for it as a new change.';
  return 'Something went wrong. You were not charged.';
}

export default function Dashboard() {
  const { user } = useAuth();
  const org = useOrg(user);
  const { members, meId } = useOrgStats(user);
  const [mode, setMode] = useState('fix'); // 'fix' = one-off fix · 'feature' = plan a feature as steps
  const [problem, setProblem] = useState('');
  const { images, imgErr, dragging, setDragging, addFiles, removeImage, reset: resetImages } = useImageAttachments();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [sessions, setSessions] = useState(null);
  const [features, setFeatures] = useState(null);

  const balance = org === undefined ? null : org?.balance ?? null;
  const connected = !!org?.github?.repoFullName;

  const refresh = useCallback(async () => {
    try {
      const { data } = await listMySessions();
      setSessions(data?.sessions ?? []);
    } catch {
      setSessions((prev) => prev ?? []);
    }
  }, []);
  const refreshFeatures = useCallback(async () => {
    try {
      const { data } = await listMyFeatures();
      setFeatures(data?.features ?? []);
    } catch {
      setFeatures((prev) => prev ?? []);
    }
  }, []);
  const refreshAll = useCallback(async () => {
    await Promise.all([refresh(), refreshFeatures()]);
  }, [refresh, refreshFeatures]);

  // Initial load + light polling while anything is in progress — a live fix, or a feature whose
  // steps are still running / advancing. Latest state is read via functional setState so the
  // interval never closes over stale values.
  useEffect(() => {
    if (!user) return undefined;
    refreshAll();
    const id = setInterval(() => {
      let live = false;
      setSessions((prev) => { if (prev?.some((s) => isLive(s.status))) live = true; return prev; });
      setFeatures((prev) => { if (prev?.some((f) => f.status === 'running' || f.status === 'planning')) live = true; return prev; });
      if (live) refreshAll();
    }, 4000);
    return () => clearInterval(id);
  }, [user, refreshAll]);

  const onFix = async () => {
    if (!problem.trim()) return;
    setBusy(true); setErr('');
    try {
      await createTask({
        prompt: problem.trim(),
        images: images.map((i) => ({ mediaType: i.mediaType, data: i.data })),
      });
      setProblem(''); resetImages();
      await refreshAll();
    } catch (e) {
      setErr(friendlyError(e));
    } finally {
      setBusy(false);
    }
  };

  const onPlan = async () => {
    if (!problem.trim()) return;
    setBusy(true); setErr('');
    try {
      await planFeature({
        prompt: problem.trim(),
        images: images.map((i) => ({ mediaType: i.mediaType, data: i.data })),
      });
      setProblem(''); resetImages();
      await refreshAll();
    } catch (e) {
      setErr(friendlyError(e));
    } finally {
      setBusy(false);
    }
  };

  const tabCls = (active) =>
    `rounded-lg px-3 py-1.5 text-sm font-semibold transition ${active ? 'bg-white text-ink shadow-sm ring-1 ring-line' : 'text-ink-soft hover:text-ink'}`;

  return (
    <div className="min-h-screen">
      <Navbar balance={balance} />
      {/* Two columns on large screens: a sticky left rail holds the team board (always in
          view to drive activation); the main column keeps the existing fix flow unchanged.
          On small screens the board collapses to a compact strip above the fix box. */}
      <main className="mx-auto w-full max-w-6xl px-4 py-6 lg:grid lg:grid-cols-[18rem_minmax(0,42rem)] lg:gap-6 lg:justify-center">
        <aside className="hidden lg:block">
          <div className="lg:sticky lg:top-20">
            <Leaderboard members={members} meId={meId} />
          </div>
        </aside>

        <div className="space-y-6">
        <div className="lg:hidden">
          <Leaderboard members={members} meId={meId} compact />
        </div>

        {org === null && (
          <div className="rounded-xl bg-amber-50 p-4 text-sm text-amber-800 ring-1 ring-amber-200">
            Your account isn’t set up yet — the Bosun team will connect your website and add credits.
          </div>
        )}

        <section className="rounded-2xl border border-line bg-white p-5 sm:p-6">
          {/* Pick a quick one-off fix, or plan a whole feature that we build as steps. */}
          <div className="mb-4 inline-flex rounded-xl bg-canvas p-1 ring-1 ring-line">
            <button type="button" onClick={() => { setMode('fix'); setErr(''); }} className={tabCls(mode === 'fix')}>
              Fix something
            </button>
            <button type="button" onClick={() => { setMode('feature'); setErr(''); }} className={tabCls(mode === 'feature')}>
              Plan a feature
            </button>
          </div>

          <h1 className="text-xl font-bold text-ink">
            {mode === 'feature' ? 'What would you like to add to your website?' : 'What’s broken on your website?'}
          </h1>
          {connected && (
            <p className="mt-1 text-sm text-ink-soft">
              Connected: <span className="font-medium text-ink">{org.github.repoFullName}</span>
            </p>
          )}
          <div className="mt-4">
            <ScreenshotComposer
              value={problem}
              onChange={setProblem}
              placeholder={mode === 'feature'
                ? 'Example: Let customers book an appointment and get an email confirmation'
                : 'Example: My menu disappears on mobile phone'}
              images={images}
              imgErr={imgErr}
              dragging={dragging}
              setDragging={setDragging}
              addFiles={addFiles}
              removeImage={removeImage}
            />
          </div>
          <p className="mt-1.5 text-xs text-ink-soft">
            📎 Attach, paste (Ctrl/⌘+V) or drag in a screenshot — up to {MAX_IMAGES}. It helps us see exactly what you mean.
          </p>
          {err && <p className="mt-2 text-sm text-bad">{err}</p>}
          <button
            onClick={mode === 'feature' ? onPlan : onFix}
            disabled={busy || !problem.trim() || !connected}
            className="mt-3 inline-flex w-full items-center justify-center rounded-xl bg-brand-600 px-5 py-3 font-semibold text-white transition hover:bg-brand-700 disabled:opacity-60 sm:w-auto"
          >
            {busy ? (mode === 'feature' ? 'Planning…' : 'Starting…') : (mode === 'feature' ? 'Plan My Feature →' : 'Fix My Website →')}
          </button>
          <p className="mt-2 text-xs text-ink-soft">
            {mode === 'feature'
              ? 'We’ll look at your website and your design, then show you a plan to approve before anything is built. There’s a small charge to plan it; then you pay for each step as it’s done.'
              : 'You’re only charged after the fix is done.'}
          </p>
        </section>

        {Array.isArray(features) && features.length > 0 && (
          <section className="space-y-3">
            <h2 className="px-1 text-sm font-semibold uppercase tracking-wide text-ink-soft">Your features</h2>
            {features.map((f) => (
              <FeatureCard key={f.id} feature={f} onChanged={refreshAll} />
            ))}
          </section>
        )}

        {Array.isArray(sessions) && sessions.length > 0 && (
          <section className="space-y-3">
            <h2 className="px-1 text-sm font-semibold uppercase tracking-wide text-ink-soft">Your fixes</h2>
            {sessions.map((s) => (
              <SessionCard key={s.id} session={s} onRevised={refreshAll} />
            ))}
          </section>
        )}
        </div>
      </main>
    </div>
  );
}

// Friendly label + cost tag for one iteration in the thread.
function roundLabel(r) {
  if (r.kind === 'initial') return 'Initial fix';
  if (r.kind === 'new_scope') return 'New request';
  return 'Re-fix';
}
function roundCost(r) {
  if (r.free) return 'Free';
  if (!r.addedInr) return '';
  return r.kind === 'initial' ? formatINR(r.addedInr) : `+${formatINR(r.addedInr)}`;
}

function SessionCard({ session: s, onRevised, hideGoLive = false }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('unresolved'); // 'unresolved' (free) | 'new_scope' (paid)
  const [changes, setChanges] = useState('');
  const { images, imgErr, dragging, setDragging, addFiles, removeImage, reset: resetImages } = useImageAttachments();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [deployOpen, setDeployOpen] = useState(false); // expanded Testing|Production picker
  const working = isWorking(s.status);
  const revising = s.status === 'running' && !!s.summary; // re-running with a prior result
  const noFreeLeft = (s.freeRevisionsLeft ?? 0) <= 0;

  // Self-deploy availability. Publishing to testing is open to every org member; going live
  // (production) is allowed only for people the operator has granted it to (canDeployProd).
  const canDeployTesting = s.canDeployTesting && !s.deployedTesting;
  const canGoLive = !!s.canDeployProd && !hideGoLive;
  const showDeploy = canDeployTesting || canGoLive;

  const approve = async () => {
    setBusy(true); setErr('');
    try {
      await approveFix({ taskId: s.id });
      await onRevised();
    } catch (e) {
      setErr(friendlyError(e));
    } finally {
      setBusy(false);
    }
  };

  const sendChanges = async () => {
    if (!changes.trim()) return;
    setBusy(true); setErr('');
    try {
      await reviseSession({
        taskId: s.id,
        changes: changes.trim(),
        reason,
        images: images.map((i) => ({ mediaType: i.mediaType, data: i.data })),
      });
      setChanges(''); setOpen(false); setReason('unresolved'); resetImages();
      await onRevised();
    } catch (e) {
      setErr(friendlyError(e));
    } finally {
      setBusy(false);
    }
  };

  const act = async (fn) => {
    setBusy(true); setErr('');
    try { await fn({ taskId: s.id }); await onRevised(); }
    catch (e) { setErr(friendlyError(e)); }
    finally { setBusy(false); }
  };
  const quoteAmount = s.quoteInr || s.priceInr || 0;

  return (
    <div className="rounded-2xl border border-line bg-white p-5">
      {/* The original problem heads the card — except once complete, where the thread's
          first entry already shows it (avoids repeating it twice). */}
      {s.problem && !(s.status === 'complete' && s.rounds?.length > 0) && (
        <p className="text-sm text-ink-soft">“{s.problem}”</p>
      )}
      <h3 className="mt-1 font-semibold text-ink">
        {revising ? 'Applying your changes…' : STATUS[s.status] || 'Working on it…'}
      </h3>

      {/* Echo the change request being applied, so the user can see it was received. */}
      {revising && s.revisePrompt && (
        <p className="mt-1 text-sm text-ink-soft">“{s.revisePrompt}”</p>
      )}

      {working && (
        <p className="mt-1 text-sm text-ink-soft">Please wait a few minutes. You can leave this open.</p>
      )}

      {/* Big job: waiting for the operator to set a price. */}
      {s.status === 'needs_quote' && (
        <p className="mt-1 text-sm text-ink-soft">
          This is a bigger job, so we’re preparing a price for you. We’ll update this shortly — you can leave it open.
        </p>
      )}

      {/* Big job: quote ready — confirm before any work starts (or reduce scope). */}
      {s.status === 'quoted' && (
        <div className="mt-2">
          <p className="text-sm text-ink-soft">
            This is a bigger job. It’ll cost <span className="font-semibold text-ink">{formatINR(quoteAmount)}</span> — and you’re only charged if we fix it.
          </p>
          {err && <p className="mt-1 text-sm text-bad">{err}</p>}
          <div className="mt-3 flex flex-wrap gap-2">
            <button onClick={() => act(confirmQuote)} disabled={busy} className="rounded-xl bg-brand-600 px-4 py-2 font-semibold text-white transition hover:bg-brand-700 disabled:opacity-60">
              {busy ? 'Starting…' : `Yes, fix it for ${formatINR(quoteAmount)}`}
            </button>
            <button onClick={() => act(declineQuote)} disabled={busy} className="rounded-xl px-4 py-2 font-semibold text-ink-soft transition hover:bg-line/40 disabled:opacity-60">
              Not now
            </button>
          </div>
          <p className="mt-2 text-xs text-ink-soft">Want it cheaper? Tap “Not now” and start again with a smaller request.</p>
        </div>
      )}

      {s.status === 'cancelled' && (
        <p className="mt-1 text-sm text-ink-soft">This quote was cancelled. No charge was applied.</p>
      )}

      {s.status === 'complete' && (
        <>
          {/* Iteration thread: the initial fix + every change request, each with its own
              prompt, summary, and cost. Older fixes (made before threads existed) have no
              `rounds`, so we fall back to the latest summary/changes. */}
          {s.rounds?.length > 0 ? (
            <ol className="mt-2 space-y-2">
              {s.rounds.map((r, i) => (
                <li key={i} className="rounded-xl border border-line bg-canvas p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-semibold uppercase tracking-wide text-ink-soft">
                      {roundLabel(r)}
                    </span>
                    {roundCost(r) && (
                      <span className="text-xs font-medium text-ink">{roundCost(r)}</span>
                    )}
                  </div>
                  {r.prompt && (
                    <div className="mt-1 flex items-start justify-between gap-2">
                      <p className="text-sm text-ink-soft">“{r.prompt}”</p>
                      {clarityStars(r.briefScore) > 0 && (
                        <span
                          title="How clear your description was — clearer descriptions mean faster, first-try fixes."
                          className="mt-0.5 shrink-0 whitespace-nowrap rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700 ring-1 ring-amber-200"
                        >
                          Clarity {clarityStars(r.briefScore)}/5 ⭐
                        </span>
                      )}
                    </div>
                  )}
                  {r.summary && <p className="mt-1 text-sm text-ink">{r.summary}</p>}
                  {r.changes?.length > 0 && (
                    <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-ink-soft">
                      {r.changes.map((c, j) => <li key={j}>{c}</li>)}
                    </ul>
                  )}
                  <IdealPromptTip text={r.idealDescription} keywords={r.idealKeywords} compact />

                </li>
              ))}
            </ol>
          ) : (
            <>
              {s.summary && <p className="mt-1 text-ink-soft">{s.summary}</p>}
              {s.changes?.length > 0 && (
                <ul className="mt-2 list-disc space-y-0.5 pl-5 text-sm text-ink-soft">
                  {s.changes.map((c, i) => <li key={i}>{c}</li>)}
                </ul>
              )}
            </>
          )}

          {/* Money summary: what tapping "Looks good" will charge, or what's been charged. */}
          {s.pendingReview ? (
            s.owedInr > 0 ? (
              <p className="mt-3 text-sm text-ink-soft">
                You’ll pay <span className="font-semibold text-ink">{formatINR(s.owedInr)}</span> when you tap “Looks good”.
                {s.paidInr > 0 && <> ({formatINR(s.paidInr)} already paid)</>}
              </p>
            ) : (
              <p className="mt-3 text-sm text-ink-soft">No charge for this — it’s a free re-fix.</p>
            )
          ) : (
            s.paidInr > 0 && (
              <p className="mt-3 text-sm">
                Total charged: <span className="font-semibold">{formatINR(s.paidInr)}</span>
              </p>
            )
          )}

          <div className="mt-3 flex flex-wrap items-center gap-2">
            {s.deployHost === 'firebase' ? (
              // No automatic preview here — the owner asks for one, which puts this change on
              // the test site so they can see it; "Undo preview" puts the test site back.
              <>
                {s.buildingPreview ? (
                  <span className="text-sm text-ink-soft">Putting it on your test site… (about a minute)</span>
                ) : s.previewActive && s.previewUrl ? (
                  <>
                    <a href={s.previewUrl} target="_blank" rel="noreferrer" className="rounded-xl border border-brand-600 px-4 py-2 font-semibold text-brand-600 transition hover:bg-brand-50">
                      Open your test site →
                    </a>
                    {s.canRevert && (
                      <button onClick={() => act(customerRevertTesting)} disabled={busy} className="rounded-xl px-4 py-2 font-semibold text-ink-soft transition hover:bg-canvas disabled:opacity-60">
                        {busy ? 'Undoing…' : 'Undo preview'}
                      </button>
                    )}
                  </>
                ) : s.canPreview ? (
                  <button onClick={() => act(customerPreviewTesting)} disabled={busy} className="rounded-xl border border-brand-600 px-4 py-2 font-semibold text-brand-600 transition hover:bg-brand-50 disabled:opacity-60">
                    {busy ? 'Preparing…' : 'See it on your test site'}
                  </button>
                ) : null}
                {s.previewError && <span className="text-sm text-bad">That didn’t finish — please try again.</span>}
              </>
            ) : s.previewUrl ? (
              <a href={s.previewUrl} target="_blank" rel="noreferrer" className="rounded-xl border border-brand-600 px-4 py-2 font-semibold text-brand-600 transition hover:bg-brand-50">
                Test the preview →
              </a>
            ) : s.buildingPreview ? (
              <span className="text-sm text-ink-soft">Building a live preview…</span>
            ) : null}

            {/* "Looks good" appears only when the org requires approval before charging. */}
            {s.canApprove && !open && (
              <button onClick={approve} disabled={busy} className="rounded-xl bg-good px-4 py-2 font-semibold text-white transition hover:opacity-90 disabled:opacity-60">
                {busy ? 'Confirming…' : (s.owedInr > 0 ? `Looks good — pay ${formatINR(s.owedInr)}` : 'Looks good ✓')}
              </button>
            )}

            {s.canRevise && !open && (
              <button onClick={() => setOpen(true)} className="rounded-xl px-4 py-2 font-semibold text-brand-600 transition hover:bg-brand-50">
                Request changes
              </button>
            )}

            {/* Self-deploy. Publishing to testing is open to everyone in the organisation;
                going live (production) shows only for people the operator has allowed. */}
            {showDeploy && !open && (
              deployOpen ? (
                <>
                  <span className="text-sm text-ink-soft">Deploy to:</span>
                  {canDeployTesting && (
                    <button
                      onClick={() => act(customerDeployTesting)}
                      disabled={busy}
                      className="rounded-xl bg-teal-600 px-4 py-2 font-semibold text-white transition hover:opacity-90 disabled:opacity-60"
                    >
                      {busy ? 'Deploying…' : 'Testing'}
                    </button>
                  )}
                  {canGoLive && (
                    <button
                      onClick={() => { if (window.confirm('Make this change live on your website now?')) act(customerDeployProd); }}
                      disabled={busy}
                      className="rounded-xl bg-good px-4 py-2 font-semibold text-white transition hover:opacity-90 disabled:opacity-60"
                    >
                      {busy ? 'Publishing…' : 'Go live'}
                    </button>
                  )}
                  <button onClick={() => setDeployOpen(false)} disabled={busy} className="px-2 py-2 text-sm font-medium text-ink-soft underline disabled:opacity-60">
                    cancel
                  </button>
                </>
              ) : (
                <button onClick={() => setDeployOpen(true)} className="rounded-xl bg-brand-600 px-4 py-2 font-semibold text-white transition hover:bg-brand-700">
                  Deploy
                </button>
              )
            )}

            {s.deployedTesting && !s.deployedProd && <span className="text-sm font-medium text-ink-soft">✓ on testing</span>}
            {s.deployedProd && <span className="text-sm font-medium text-good">Live ✓</span>}
          </div>

          {open && (
            <div className="mt-3 rounded-xl bg-canvas p-3">
              {/* Why is it not right? — maps to free re-fix vs new, chargeable scope. */}
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => setReason('unresolved')}
                  disabled={noFreeLeft}
                  className={`rounded-lg px-3 py-1.5 text-sm font-medium ring-1 transition disabled:opacity-50 ${reason === 'unresolved' ? 'bg-brand-600 text-white ring-brand-600' : 'bg-white text-ink ring-line'}`}
                >
                  It’s not working / not what I meant
                </button>
                <button
                  type="button"
                  onClick={() => setReason('new_scope')}
                  className={`rounded-lg px-3 py-1.5 text-sm font-medium ring-1 transition ${reason === 'new_scope' ? 'bg-brand-600 text-white ring-brand-600' : 'bg-white text-ink ring-line'}`}
                >
                  I want something new
                </button>
              </div>
              <p className="mt-2 text-xs text-ink-soft">
                {reason === 'unresolved'
                  ? (noFreeLeft
                      ? 'No free re-fixes left — please approve what you have, or choose “something new”.'
                      : `Free re-fix — ${s.freeRevisionsLeft} left.`)
                  : 'A new change is priced based on the work needed — you’ll see the amount and approve before paying.'}
              </p>
              <div className="mt-2">
                <ScreenshotComposer
                  value={changes}
                  onChange={setChanges}
                  placeholder="What should change? Example: also make the buttons bigger on mobile"
                  images={images}
                  imgErr={imgErr}
                  dragging={dragging}
                  setDragging={setDragging}
                  addFiles={addFiles}
                  removeImage={removeImage}
                />
              </div>
              <p className="mt-1 text-xs text-ink-soft">
                📎 Attach, paste or drag in a screenshot to show what’s still off.
              </p>
              {err && <p className="mt-1 text-sm text-bad">{err}</p>}
              <div className="mt-2 flex gap-2">
                <button
                  onClick={sendChanges}
                  disabled={busy || !changes.trim() || (reason === 'unresolved' && noFreeLeft)}
                  className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-700 disabled:opacity-60"
                >
                  {busy ? 'Sending…' : 'Send changes →'}
                </button>
                <button onClick={() => { setOpen(false); setErr(''); setReason('unresolved'); resetImages(); }} className="rounded-lg px-4 py-2 text-sm font-semibold text-ink-soft hover:bg-line/40">
                  Cancel
                </button>
              </div>
            </div>
          )}
          {err && !open && <p className="mt-2 text-sm text-bad">{err}</p>}
        </>
      )}

      {s.status === 'failed' && (
        <p className="mt-1 text-ink-soft">No charge was applied. Please try again.</p>
      )}
    </div>
  );
}

// A planned feature. New lifecycle: planning (we explore your site + design) → plan_review (you
// approve / request changes / start over) → running (build step by step, normal fix card on the
// active step) → complete (one go-live). Nothing builds or is charged a build until you approve.
function FeatureCard({ feature: f, onChanged }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [panel, setPanel] = useState(null); // 'refine' | 'replace' | 'addChange' | null
  const [text, setText] = useState('');
  const { images, imgErr, dragging, setDragging, addFiles, removeImage, reset: resetImages } = useImageAttachments();
  const active = f.steps.find((st) => st.status === 'running' || st.status === 'failed');
  const reviewing = f.status === 'plan_review';

  const stepIcon = (st) =>
    st.status === 'done' ? '✅' : st.status === 'running' ? '⏳' : st.status === 'failed' ? '⚠️'
      : st.status === 'proposed' ? '•' : '◻️';

  const run = async (fn) => {
    setBusy(true); setErr('');
    try { await fn(); await onChanged(); }
    catch (e) { setErr(friendlyError(e)); }
    finally { setBusy(false); }
  };
  const retry = () => run(() => retryFeatureStep({ featureId: f.id }));
  const approvePlan = () => run(() => approveFeaturePlan({ featureId: f.id }));
  const submitRevise = () => run(async () => {
    const mode = panel; // 'refine' | 'replace'
    await reviseFeaturePlan({ featureId: f.id, mode, ...(mode === 'refine' ? { changes: text.trim() } : { prompt: text.trim() }) });
    setPanel(null); setText('');
  });
  const submitAddChange = () => run(async () => {
    await addFeatureChange({ featureId: f.id, changes: text.trim(), images: images.map((i) => ({ mediaType: i.mediaType, data: i.data })) });
    setPanel(null); setText(''); resetImages();
  });
  const goLive = async () => {
    if (!window.confirm('Make this whole feature live on your website now?')) return;
    run(() => customerDeployProd({ taskId: f.goLiveTaskId }));
  };

  const heading = {
    planning: 'Planning your feature…',
    plan_review: 'Here’s the plan — your call',
    plan_failed: 'We couldn’t plan this one',
    complete: 'All steps done 🎉',
  }[f.status] || `Building your feature — step ${Math.min(f.currentStep + 1, f.stepCount)} of ${f.stepCount}`;

  return (
    <div className="rounded-2xl border border-line bg-white p-5">
      <p className="text-sm text-ink-soft">“{f.prompt}”</p>
      <h3 className="mt-1 font-semibold text-ink">{heading}</h3>

      {f.status === 'planning' && (
        <p className="mt-2 text-sm text-ink-soft">We’re looking at your site and your design to work out the smallest steps. This takes a few minutes — you can leave this open.</p>
      )}
      {f.status === 'plan_failed' && (
        <p className="mt-2 text-sm text-ink-soft">Something went wrong while planning — you weren’t charged. Please describe the feature again above.</p>
      )}

      {/* The plan, step by step. Proposed steps show a Fixed / Live-data tag. */}
      {f.steps.length > 0 && (
        <ol className="mt-3 space-y-1.5">
          {f.steps.map((st, i) => (
            <li key={i} className="flex items-start gap-2 text-sm">
              <span className="mt-0.5 w-5 shrink-0 text-center">{stepIcon(st)}</span>
              <span className={st.status === 'done' ? 'text-ink-soft' : 'text-ink'}>
                <span className="font-medium">{st.title || `Step ${i + 1}`}</span>
                {(reviewing || f.status === 'planning') && (
                  <span className={`ml-1.5 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${st.kind === 'dynamic' ? 'bg-amber-100 text-amber-700' : 'bg-line/60 text-ink-soft'}`}>
                    {st.kind === 'dynamic' ? 'Live data' : 'Fixed'}
                  </span>
                )}
                {st.description && <span className="text-ink-soft"> — {st.description}</span>}
                {st.status === 'done' && st.paidInr > 0 && (
                  <span className="ml-1 whitespace-nowrap text-xs text-ink-soft">· {formatINR(st.paidInr)}</span>
                )}
              </span>
            </li>
          ))}
        </ol>
      )}

      {/* Running total — planning + each finished step. Not an estimate: this is what's paid. */}
      {f.totalPaidInr > 0 && (
        <p className="mt-3 text-sm">
          Paid so far: <span className="font-semibold">{formatINR(f.totalPaidInr)}</span>
          {f.planningChargeInr > 0 && (
            <span className="text-ink-soft"> (incl. {formatINR(f.planningChargeInr)} to plan it)</span>
          )}
        </p>
      )}

      {/* Plan review: approve to build, or refine / start over (each re-plan is a fresh look). */}
      {reviewing && (
        <div className="mt-4 border-t border-line pt-4">
          {!panel && (
            <>
              <p className="text-sm text-ink">Happy with these steps? We’ll build them one at a time — you approve and pay for each as it’s done.</p>
              {err && <p className="mt-1 text-sm text-bad">{err}</p>}
              <div className="mt-2 flex flex-wrap gap-2">
                <button onClick={approvePlan} disabled={busy} className="rounded-xl bg-brand-600 px-4 py-2 font-semibold text-white transition hover:bg-brand-700 disabled:opacity-60">
                  {busy ? 'Starting…' : 'Looks good — start building →'}
                </button>
                <button onClick={() => { setPanel('refine'); setText(''); setErr(''); }} disabled={busy} className="rounded-xl border border-brand-600 px-4 py-2 font-semibold text-brand-600 transition hover:bg-brand-50 disabled:opacity-60">
                  Request changes
                </button>
                <button onClick={() => { setPanel('replace'); setText(''); setErr(''); }} disabled={busy} className="rounded-xl px-4 py-2 font-semibold text-ink-soft transition hover:bg-line/40 disabled:opacity-60">
                  Start over
                </button>
              </div>
            </>
          )}
          {panel && (
            <div className="rounded-xl bg-canvas p-3">
              <p className="text-sm font-medium text-ink">
                {panel === 'refine' ? 'What should change about the plan?' : 'Describe the feature again, your way'}
              </p>
              <textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                rows={3}
                placeholder={panel === 'refine' ? 'Example: combine the last two steps, and the footer should keep the existing links' : 'Describe what you want added to your website'}
                className="mt-2 w-full rounded-lg border border-line px-3 py-2 text-sm outline-none focus:border-brand-500"
              />
              <p className="mt-1 text-xs text-ink-soft">We’ll take another look and show you an updated plan. There’s a small charge to re-plan, the same as the first plan.</p>
              {err && <p className="mt-1 text-sm text-bad">{err}</p>}
              <div className="mt-2 flex gap-2">
                <button onClick={submitRevise} disabled={busy || !text.trim()} className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-700 disabled:opacity-60">
                  {busy ? 'Re-planning…' : (panel === 'refine' ? 'Update the plan →' : 'Plan again →')}
                </button>
                <button onClick={() => { setPanel(null); setText(''); setErr(''); }} disabled={busy} className="rounded-lg px-4 py-2 text-sm font-semibold text-ink-soft hover:bg-line/40">
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* The active step uses the normal fix card. Go-live is hidden here — held to the end. */}
      {active && (
        <div className="mt-4 border-t border-line pt-4">
          <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-soft">
            Current step: {active.title}
          </p>
          {active.status === 'failed' ? (
            <div>
              <p className="text-sm text-ink-soft">This step didn’t work — no charge for it. You can try it again.</p>
              {err && <p className="mt-1 text-sm text-bad">{err}</p>}
              <button onClick={retry} disabled={busy} className="mt-2 rounded-xl bg-brand-600 px-4 py-2 font-semibold text-white transition hover:bg-brand-700 disabled:opacity-60">
                {busy ? 'Starting…' : 'Try this step again'}
              </button>
            </div>
          ) : (
            active.session && <SessionCard session={active.session} onRevised={onChanged} hideGoLive />
          )}
        </div>
      )}

      {/* The next step is being prepared — or a rare dispatch hiccup left it not started.
          Either way a gentle nudge resumes it (retryFeatureStep starts the current step). */}
      {f.status === 'running' && !active && (
        <div className="mt-4 border-t border-line pt-4">
          <p className="text-sm text-ink-soft">Getting the next step ready…</p>
          {err && <p className="mt-1 text-sm text-bad">{err}</p>}
          <button onClick={retry} disabled={busy} className="mt-2 rounded-xl border border-brand-600 px-4 py-2 font-semibold text-brand-600 transition hover:bg-brand-50 disabled:opacity-60">
            {busy ? 'Starting…' : 'Continue building →'}
          </button>
        </div>
      )}

      {/* Whole feature done → one button publishes everything (only for owners allowed to go live). */}
      {f.status === 'complete' && (
        <div className="mt-4 border-t border-line pt-4">
          <p className="text-sm text-ink">
            Every step is on your testing site.{f.canGoLive ? ' Ready to make the whole feature live?' : ''}
          </p>
          {err && <p className="mt-1 text-sm text-bad">{err}</p>}
          <div className="mt-2 flex flex-wrap gap-2">
            {f.canGoLive && (
              <button onClick={goLive} disabled={busy} className="rounded-xl bg-good px-4 py-2 font-semibold text-white transition hover:opacity-90 disabled:opacity-60">
                {busy ? 'Publishing…' : 'Go live →'}
              </button>
            )}
            {panel !== 'addChange' && (
              <button onClick={() => { setPanel('addChange'); setText(''); setErr(''); }} disabled={busy} className="rounded-xl border border-brand-600 px-4 py-2 font-semibold text-brand-600 transition hover:bg-brand-50 disabled:opacity-60">
                Add another change
              </button>
            )}
          </div>

          {panel === 'addChange' && (
            <div className="mt-3 rounded-xl bg-canvas p-3">
              <p className="text-sm font-medium text-ink">What else would you like to change about this feature?</p>
              <div className="mt-2">
                <ScreenshotComposer
                  value={text}
                  onChange={setText}
                  placeholder="Example: also let visitors see the results without voting, and make the vote button green"
                  images={images}
                  imgErr={imgErr}
                  dragging={dragging}
                  setDragging={setDragging}
                  addFiles={addFiles}
                  removeImage={removeImage}
                />
              </div>
              <p className="mt-1 text-xs text-ink-soft">📎 Attach, paste or drag in a screenshot to show what you mean. We’ll build this as another step on this feature — you review and pay for it just like the others, and it’s added to this feature’s total.</p>
              <div className="mt-2 flex gap-2">
                <button onClick={submitAddChange} disabled={busy || !text.trim()} className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-700 disabled:opacity-60">
                  {busy ? 'Starting…' : 'Make this change →'}
                </button>
                <button onClick={() => { setPanel(null); setText(''); setErr(''); resetImages(); }} disabled={busy} className="rounded-lg px-4 py-2 text-sm font-semibold text-ink-soft hover:bg-line/40">
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
