import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../hooks/useAuth.js';
import { useOrgs } from '../hooks/useOrgs.js';
import { createTask, listMySessions, reviseSession, approveFix, confirmQuote, declineQuote, customerDeployTesting, customerDeployProd, customerPreviewTesting, customerRevertTesting, planFeature, approveFeaturePlan, reviseFeaturePlan, editFeaturePlan, addFeatureChange, listMyFeatures, retryFeatureStep, planDesign, listMyDesigns, startComparison, listMyComparisons, setActiveOrg, shareSession, unshareSession, shareFeature, unshareFeature } from '../firebase/functions.js';
import { useLocation } from 'react-router-dom';
import Navbar from '../components/Navbar.jsx';
import ShareControl from '../components/ShareControl.jsx';
import ScreenshotComposer from '../components/ScreenshotComposer.jsx';
import IdealPromptTip from '../components/IdealPromptTip.jsx';
import DesignCard from '../components/DesignCard.jsx';
import ComparisonCard from '../components/ComparisonCard.jsx';
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

// A live m:ss count-up for an in-progress test-site deploy. Anchored to the server-side start
// (previewStartedAt) so it survives refreshes; ticks locally every second.
function DeployTimer({ since }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const secs = Math.max(0, Math.floor((now - (since || now)) / 1000));
  return <span className="tabular-nums font-medium">{Math.floor(secs / 60)}:{String(secs % 60).padStart(2, '0')}</span>;
}
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
  // A user can belong to several orgs; the dropdown picks the active one and everything below —
  // wallet, fixes, features, board — is scoped to it.
  const { orgs, activeOrgId, loading: orgsLoading } = useOrgs(user);
  const [selectedOrgId, setSelectedOrgId] = useState(null);
  useEffect(() => { if (activeOrgId && !selectedOrgId) setSelectedOrgId(activeOrgId); }, [activeOrgId, selectedOrgId]);
  const orgId = selectedOrgId || activeOrgId || null;
  const org = orgsLoading ? undefined : (orgs.find((o) => o.id === orgId) || null);
  const { members, meId } = useOrgStats(user, orgId);
  const [mode, setMode] = useState('fix'); // 'fix' = one-off fix · 'feature' = plan a feature as steps
  const [problem, setProblem] = useState('');
  // Arriving from a shared fix ("use as a starting point") seeds the fix box with that brief.
  const location = useLocation();
  useEffect(() => {
    const pf = location.state?.prefillFix;
    if (pf) { setMode('fix'); setProblem(pf); window.history.replaceState({}, ''); }
  }, [location.state]);
  const { images, imgErr, dragging, setDragging, addFiles, removeImage, reset: resetImages } = useImageAttachments();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [sessions, setSessions] = useState(null);
  const [features, setFeatures] = useState(null);
  const [designs, setDesigns] = useState(null);
  const [comparisons, setComparisons] = useState(null);
  // Cross-tab navigation: an approved design hands off to a feature (and links back). `focus` switches
  // the tab and remembers which card to scroll to + briefly highlight.
  const [focus, setFocus] = useState(null); // { mode, id }
  const goTo = useCallback((m, id) => { setMode(m); setErr(''); setFocus({ mode: m, id }); }, []);
  const focusRef = useCallback((el) => { if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' }); }, []);

  const balance = org === undefined ? null : org?.balance ?? null;
  const connected = !!org?.github?.repoFullName;

  // Lists are scoped to an org; callers may pass an explicit id (used when switching, so the
  // fetch doesn't race the state update).
  const refresh = useCallback(async (oid = orgId) => {
    if (!oid) { setSessions([]); return; }
    try {
      const { data } = await listMySessions({ orgId: oid });
      setSessions(data?.sessions ?? []);
    } catch {
      setSessions((prev) => prev ?? []);
    }
  }, [orgId]);
  const refreshFeatures = useCallback(async (oid = orgId) => {
    if (!oid) { setFeatures([]); return; }
    try {
      const { data } = await listMyFeatures({ orgId: oid });
      setFeatures(data?.features ?? []);
    } catch {
      setFeatures((prev) => prev ?? []);
    }
  }, [orgId]);
  const refreshDesigns = useCallback(async (oid = orgId) => {
    if (!oid) { setDesigns([]); return; }
    try {
      const { data } = await listMyDesigns({ orgId: oid });
      setDesigns(data?.designs ?? []);
    } catch {
      setDesigns((prev) => prev ?? []);
    }
  }, [orgId]);
  const refreshComparisons = useCallback(async (oid = orgId) => {
    if (!oid) { setComparisons([]); return; }
    try {
      const { data } = await listMyComparisons({ orgId: oid });
      setComparisons(data?.comparisons ?? []);
    } catch {
      setComparisons((prev) => prev ?? []);
    }
  }, [orgId]);
  const refreshAll = useCallback(async (oid = orgId) => {
    await Promise.all([refresh(oid), refreshFeatures(oid), refreshDesigns(oid), refreshComparisons(oid)]);
  }, [refresh, refreshFeatures, refreshDesigns, refreshComparisons, orgId]);

  // Switch the active org: optimistic local select, clear the lists, persist the choice, reload.
  const switchOrg = useCallback(async (id) => {
    if (!id || id === orgId) return;
    setSelectedOrgId(id);
    setSessions(null); setFeatures(null); setDesigns(null); setComparisons(null);
    try { await setActiveOrg({ orgId: id }); } catch { /* selection still applies locally */ }
    refreshAll(id);
  }, [orgId, refreshAll]);

  // Initial load + light polling while anything is in progress — a live fix, or a feature whose
  // steps are still running / advancing. Latest state is read via functional setState so the
  // interval never closes over stale values.
  useEffect(() => {
    if (!user || !orgId) return undefined;
    refreshAll();
    const id = setInterval(() => {
      let live = false;
      setSessions((prev) => { if (prev?.some((s) => isLive(s.status) || s.buildingPreview)) live = true; return prev; });
      setFeatures((prev) => { if (prev?.some((f) => f.status === 'running' || f.status === 'planning')) live = true; return prev; });
      // A design is live only while the agent is designing (not while it's waiting on the owner). Once
      // approved it's handed off to a feature, which the feature poll above keeps fresh.
      setDesigns((prev) => { if (prev?.some((d) => d.status === 'clarifying' && !d.awaitingOwner)) live = true; return prev; });
      // A comparison is live only while the agent is analysing (not while waiting on the owner).
      setComparisons((prev) => { if (prev?.some((c) => c.status === 'analysing' && !c.awaitingOwner)) live = true; return prev; });
      if (live) refreshAll();
    }, 4000);
    return () => clearInterval(id);
  }, [user, orgId, refreshAll]);

  const onFix = async () => {
    if (!problem.trim()) return;
    setBusy(true); setErr('');
    try {
      await createTask({
        orgId,
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
        orgId,
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

  const onDesign = async () => {
    if (!problem.trim()) return;
    setBusy(true); setErr('');
    try {
      await planDesign({
        orgId,
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
  const onCompare = async () => {
    if (!problem.trim()) return;
    setBusy(true); setErr('');
    try {
      await startComparison({
        orgId,
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
  const onSubmit = mode === 'feature' ? onPlan : mode === 'design' ? onDesign : mode === 'compare' ? onCompare : onFix;

  // Act on a comparison finding → route it into the matching tool, prefilled, then jump to that tab.
  const routeFinding = useCallback(async (scope, text) => {
    if (!text?.trim()) return;
    const payload = { orgId, prompt: text.trim() };
    if (scope === 'design') {
      const res = await planDesign(payload); goTo('design', res?.data?.designId);
    } else if (scope === 'feature') {
      const res = await planFeature(payload); goTo('feature', res?.data?.featureId);
    } else {
      const res = await createTask(payload); goTo('fix', res?.data?.taskId);
    }
    await refreshAll();
  }, [orgId, goTo, refreshAll]);

  const tabCls = (active) =>
    `tab-item ${active ? 'tab-item-active' : ''}`;

  return (
    <div className="page-bg min-h-screen">
      <Navbar balance={balance} />
      {/* Two columns on large screens: a sticky left rail holds the team board (always in
          view to drive activation); the main column keeps the existing fix flow unchanged.
          On small screens the board collapses to a compact strip above the fix box. */}
      <main className="container-app mx-auto grid gap-6 px-4 py-8 lg:grid-cols-[18rem_minmax(0,42rem)] lg:justify-center">
        <aside className="hidden lg:block">
          <div className="lg:sticky lg:top-[5rem]">
            <Leaderboard members={members} meId={meId} />
          </div>
        </aside>

        <div className="space-y-6">
          <div className="lg:hidden">
            <Leaderboard members={members} meId={meId} compact />
          </div>

          <section className="section-panel-strong p-5 sm:p-6">
            <div className="section-header">
              <div>
                <p className="text-sm font-semibold uppercase tracking-[0.16em] text-brand-700">Workspace</p>
                <h1 className="mt-3 text-3xl font-semibold text-ink">Get your website fixed, designed, or improved faster.</h1>
                <p className="section-subtitle">Describe the issue in plain language, attach a screenshot, and we’ll turn it into a working change.</p>
              </div>
              <div className="flex flex-col gap-2 sm:items-end">
                <span className="badge badge-brand">Balance {balance == null ? '…' : formatINR(balance)}</span>
                {orgs.length > 1 && (
                  <select
                    value={orgId || ''}
                    onChange={(e) => switchOrg(e.target.value)}
                    disabled={busy}
                    className="select mt-1 min-w-[12rem]"
                  >
                    {orgs.map((o) => <option key={o.id} value={o.id}>{o.name || 'Untitled'}</option>)}
                  </select>
                )}
              </div>
            </div>
          </section>

          {org === null && (
            <div className="alert-warn">
              Your account isn’t set up yet — the Bosun team will connect your website and add credits.
            </div>
          )}

          <section className="card p-5 sm:p-6">
            <div className="mb-5 tab-group">
              <button type="button" onClick={() => { setMode('fix'); setErr(''); }} className={tabCls(mode === 'fix')}>
                Fix something
              </button>
              <button type="button" onClick={() => { setMode('feature'); setErr(''); }} className={tabCls(mode === 'feature')}>
                Plan a feature
              </button>
              <button type="button" onClick={() => { setMode('design'); setErr(''); }} className={tabCls(mode === 'design')}>
                Design a screen
              </button>
              <button type="button" onClick={() => { setMode('compare'); setErr(''); }} className={tabCls(mode === 'compare')}>
                Size up rivals
              </button>
            </div>

            <h1 className="text-xl font-bold tracking-tight text-ink">
              {mode === 'feature' ? 'What would you like to add to your website?'
                : mode === 'design' ? 'What screen would you like us to design?'
                  : mode === 'compare' ? 'Who would you like to compare against?'
                    : 'What’s broken on your website?'}
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
                  : mode === 'design'
                    ? 'Example: A Contact Us page with a short intro and a simple enquiry form'
                    : mode === 'compare'
                      ? 'Example: Compare us to our main competitors — paste their website links'
                      : 'Example: My menu disappears on mobile phone'}
                images={images}
                imgErr={imgErr}
                dragging={dragging}
                setDragging={setDragging}
                addFiles={addFiles}
                removeImage={removeImage}
              />
            </div>
            <p className="mt-1.5 text-sm text-ink-soft">
              📎 Attach, paste (Ctrl/⌘+V) or drag in a screenshot — up to {MAX_IMAGES}. It helps us see exactly what you mean.
            </p>
            {err && <p className="mt-3 text-sm text-bad">{err}</p>}
            <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <button
                onClick={onSubmit}
                disabled={busy || !problem.trim() || !connected}
                className="btn btn-primary w-full sm:w-auto"
              >
                {busy
                  ? (mode === 'feature' ? 'Planning…' : mode === 'design' ? 'Designing…' : mode === 'compare' ? 'Comparing…' : 'Starting…')
                  : (mode === 'feature' ? 'Plan My Feature →' : mode === 'design' ? 'Design My Screen →' : mode === 'compare' ? 'Size Up Rivals →' : 'Fix My Website →')}
              </button>
              {connected ? null : (
                <span className="text-sm text-ink-soft">Connect a repository to start.</span>
              )}
            </div>
            <p className="mt-3 text-sm text-ink-soft">
              {mode === 'feature'
                ? 'We’ll look at your website and your design, then show you a plan to approve before anything is built. There’s a small charge to plan it; then you pay for each step as it’s done.'
                : mode === 'design'
                  ? 'We’ll ask a couple of quick questions, then show you how your screen will look — on your real site — before anything is built. There’s a small charge to design it; the build is priced separately when you approve.'
                  : mode === 'compare'
                    ? 'We’ll look at your site and the competitors and show you where you’re ahead and behind — with things you can act on in one tap. There’s a small charge for the comparison; anything you choose to do is priced separately.'
                    : 'You’re only charged after the fix is done.'}
            </p>
          </section>

          {/* Each tab shows only its own list, so what's below stays relevant to what you're doing:
            Design a screen → your designs · Plan a feature → your features · Fix something → fixes. */}
          {mode === 'design' && Array.isArray(designs) && designs.length > 0 && (
            <section className="space-y-3">
              <h2 className="section-label">Your designs</h2>
              {designs.map((d) => (
                // The design card hosts the clarify chat + mock review. Once approved it's handed off to a
                // feature (the build lives there), and the card shows a link across to it.
                <div key={d.id} ref={focus?.mode === 'design' && focus.id === d.id ? focusRef : null}>
                  <DesignCard design={d} onChanged={refreshAll} onGoToFeature={(fid) => goTo('feature', fid)} />
                </div>
              ))}
            </section>
          )}

          {mode === 'compare' && Array.isArray(comparisons) && comparisons.length > 0 && (
            <section className="space-y-3">
              <h2 className="section-label">Your comparisons</h2>
              {comparisons.map((c) => (
                <div key={c.id} ref={focus?.mode === 'compare' && focus.id === c.id ? focusRef : null}>
                  <ComparisonCard comparison={c} onChanged={refreshAll} onRoute={routeFinding} />
                </div>
              ))}
            </section>
          )}

          {mode === 'feature' && Array.isArray(features) && features.length > 0 && (
            <section className="space-y-3">
              <h2 className="section-label">Your features</h2>
              {features.map((f) => (
                <div key={f.id} ref={focus?.mode === 'feature' && focus.id === f.id ? focusRef : null}>
                  <FeatureCard feature={f} onChanged={refreshAll} onGoToDesign={(did) => goTo('design', did)} />
                </div>
              ))}
            </section>
          )}

          {mode === 'fix' && Array.isArray(sessions) && sessions.length > 0 && (
            <section className="space-y-3">
              <h2 className="section-label">Your fixes</h2>
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
    <div className="card p-5">
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
            <button onClick={() => act(confirmQuote)} disabled={busy} className="btn btn-primary">
              {busy ? 'Starting…' : `Yes, fix it for ${formatINR(quoteAmount)}`}
            </button>
            <button onClick={() => act(declineQuote)} disabled={busy} className="btn btn-ghost">
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
                <li key={i} className="card-inset p-3">
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

          {/* Per-run test-site costs are metered separately from the fix charge. */}
          {s.ciChargeInr > 0 && (
            <p className="mt-1 text-xs text-ink-soft">
              + {formatINR(s.ciChargeInr)} for {s.ciRunCount} test-site {s.ciRunCount === 1 ? 'update' : 'updates'}
            </p>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-2">
            {s.deployHost === 'firebase' ? (
              // The fix is deployed to the test site AUTOMATICALLY when it's ready. The owner just
              // opens it; "Undo preview" puts the test site back; "Merge to testing" (below) keeps it.
              <>
                {s.buildingPreview ? (
                  <span className="inline-flex items-center gap-2 text-sm text-ink-soft">
                    <span className="h-3.5 w-3.5 spinner" />
                    Putting it on your test site… <DeployTimer since={s.previewStartedAt} /> <span className="text-ink-soft/70">(usually 1–2 min)</span>
                  </span>
                ) : s.previewActive && s.previewUrl ? (
                  <>
                    <a href={s.previewUrl} target="_blank" rel="noreferrer" className="btn btn-outline">
                      Open your test site →
                    </a>
                    {s.canRevert && (
                      <button onClick={() => act(customerRevertTesting)} disabled={busy} className="btn btn-ghost">
                        {busy ? 'Undoing…' : 'Undo preview'}
                      </button>
                    )}
                  </>
                ) : s.canPreview ? (
                  // Fallback (auto-deploy failed / not yet active): let them trigger it manually.
                  <button onClick={() => act(customerPreviewTesting)} disabled={busy} className="btn btn-outline disabled:opacity-60">
                    {busy ? 'Deploying…' : 'Show it on your test site'}
                  </button>
                ) : null}
                {s.previewError && !s.buildingPreview && (
                  <button onClick={() => act(customerPreviewTesting)} disabled={busy} className="text-sm font-medium text-bad underline disabled:opacity-60">
                    Test-site deploy failed — try again
                  </button>
                )}
              </>
            ) : s.previewUrl ? (
              <a href={s.previewUrl} target="_blank" rel="noreferrer" className="btn btn-outline">
                Test the preview →
              </a>
            ) : s.buildingPreview ? (
              <span className="text-sm text-ink-soft">Building a live preview…</span>
            ) : null}

            {/* "Looks good" appears only when the org requires approval before charging. */}
            {s.canApprove && !open && (
              <button onClick={approve} disabled={busy} className="btn btn-success">
                {busy ? 'Confirming…' : (s.owedInr > 0 ? `Looks good — pay ${formatINR(s.owedInr)}` : 'Looks good ✓')}
              </button>
            )}

            {s.canRevise && !open && (
              <button onClick={() => setOpen(true)} className="btn btn-outline">
                Request changes
              </button>
            )}

            {/* Self-deploy. Publishing to testing is open to everyone in the organisation;
                going live (production) shows only for people the operator has allowed. */}
            {showDeploy && !open && (
              s.deployHost === 'firebase' ? (
                // Firebase: the fix is already on the test site automatically; "Merge to testing"
                // makes it part of the project (so it sticks and can go live). No picker needed.
                <>
                  {canDeployTesting && (
                    <button
                      onClick={() => act(customerDeployTesting)}
                      disabled={busy}
                      className="btn btn-teal"
                    >
                      {busy ? 'Merging…' : 'Merge to testing'}
                    </button>
                  )}
                  {canGoLive && (
                    <button
                      onClick={() => { if (window.confirm('Make this change live on your website now?')) act(customerDeployProd); }}
                      disabled={busy}
                      className="btn btn-success"
                    >
                      {busy ? 'Publishing…' : 'Go live'}
                    </button>
                  )}
                </>
              ) : deployOpen ? (
                <>
                  <span className="text-sm text-ink-soft">Deploy to:</span>
                  {canDeployTesting && (
                    <button
                      onClick={() => act(customerDeployTesting)}
                      disabled={busy}
                      className="btn btn-teal"
                    >
                      {busy ? 'Deploying…' : 'Testing'}
                    </button>
                  )}
                  {canGoLive && (
                    <button
                      onClick={() => { if (window.confirm('Make this change live on your website now?')) act(customerDeployProd); }}
                      disabled={busy}
                      className="btn btn-success"
                    >
                      {busy ? 'Publishing…' : 'Go live'}
                    </button>
                  )}
                  <button onClick={() => setDeployOpen(false)} disabled={busy} className="px-2 py-2 text-sm font-medium text-ink-soft underline disabled:opacity-60">
                    cancel
                  </button>
                </>
              ) : (
                <button onClick={() => setDeployOpen(true)} className="btn btn-primary">
                  Deploy
                </button>
              )
            )}

            {s.deployedTesting && !s.deployedProd && !s.buildingPreview && <span className="text-sm font-medium text-ink-soft">✓ on testing</span>}
            {s.deployedProd && <span className="text-sm font-medium text-good">Live ✓</span>}
          </div>

          {open && (
            <div className="card-inset mt-3 p-3.5">
              {/* Why is it not right? — maps to free re-fix vs new, chargeable scope. */}
              <div className="flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => setReason('unresolved')}
                  disabled={noFreeLeft}
                  className={`btn btn-sm ring-1 transition ${reason === 'unresolved' ? 'btn-primary ring-brand-600' : 'bg-white text-ink ring-line hover:bg-canvas'}`}
                >
                  It’s not working / not what I meant
                </button>
                <button
                  type="button"
                  onClick={() => setReason('new_scope')}
                  className={`btn btn-sm ring-1 transition ${reason === 'new_scope' ? 'btn-primary ring-brand-600' : 'bg-white text-ink ring-line hover:bg-canvas'}`}
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
                  className="btn btn-primary btn-sm"
                >
                  {busy ? 'Sending…' : 'Send changes →'}
                </button>
                <button onClick={() => { setOpen(false); setErr(''); setReason('unresolved'); resetImages(); }} className="btn btn-ghost btn-sm">
                  Cancel
                </button>
              </div>
            </div>
          )}
          {err && !open && <p className="mt-2 text-sm text-bad">{err}</p>}

          {/* Share this finished fix with a teammate, who uses it as a starting point for their own. */}
          {!open && (
            <ShareControl
              type="fix"
              id={s.id}
              initialToken={s.shared ? s.shareToken : null}
              share={() => shareSession({ taskId: s.id })}
              unshare={() => unshareSession({ taskId: s.id })}
              blurb="Want a teammate to start their own fix from this?"
            />
          )}
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
function FeatureCard({ feature: f, onChanged, onGoToDesign }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [panel, setPanel] = useState(null); // 'refine' | 'replace' | 'addChange' | null
  const [text, setText] = useState('');
  const [editSteps, setEditSteps] = useState(null); // null = not editing the prepopulated steps
  const { images, imgErr, dragging, setDragging, addFiles, removeImage, reset: resetImages } = useImageAttachments();
  const active = f.steps.find((st) => st.status === 'running' || st.status === 'ready' || st.status === 'failed');
  const reviewing = f.status === 'plan_review';

  const stepIcon = (st) =>
    st.status === 'done' ? '✅' : st.status === 'ready' ? '🟢' : st.status === 'running' ? '⏳' : st.status === 'failed' ? '⚠️'
      : st.status === 'proposed' ? '•' : '◻️';

  const run = async (fn) => {
    setBusy(true); setErr('');
    try { await fn(); await onChanged(); }
    catch (e) { setErr(friendlyError(e)); }
    finally { setBusy(false); }
  };
  const retry = () => run(() => retryFeatureStep({ featureId: f.id }));
  const approvePlan = () => run(() => approveFeaturePlan({ featureId: f.id }));
  // Free, no-charge edit of the prepopulated steps (design-origin features). No re-plan session.
  const startEdit = () => { setEditSteps(f.steps.map((s) => ({ title: s.title || '', description: s.description || '', kind: s.kind === 'dynamic' ? 'dynamic' : 'static' }))); setErr(''); };
  const setStep = (i, patch) => setEditSteps((arr) => arr.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  const addStep = () => setEditSteps((arr) => [...arr, { title: '', description: '', kind: 'static' }]);
  const removeStep = (i) => setEditSteps((arr) => arr.filter((_, j) => j !== i));
  const saveEdit = () => run(async () => {
    await editFeaturePlan({ featureId: f.id, steps: editSteps.filter((s) => s.title.trim() || s.description.trim()) });
    setEditSteps(null);
  });
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
  }[f.status] || (active?.status === 'ready'
    ? `Step ${Math.min(f.currentStep + 1, f.stepCount)} of ${f.stepCount} is ready — take a look`
    : `Building your feature — step ${Math.min(f.currentStep + 1, f.stepCount)} of ${f.stepCount}`);

  return (
    <div className="card p-5">
      {f.fromDesign && f.designId && (
        <button
          onClick={() => onGoToDesign?.(f.designId)}
          className="mb-1 inline-flex items-center text-xs font-medium text-brand-600 hover:underline"
        >
          ← From your design{f.designPrompt ? `: “${f.designPrompt.slice(0, 60)}${f.designPrompt.length > 60 ? '…' : ''}”` : ''}
        </button>
      )}
      <p className="text-sm text-ink-soft">“{f.prompt}”</p>
      <h3 className="mt-1 font-semibold text-ink">{heading}</h3>

      {f.status === 'planning' && (
        <p className="mt-2 text-sm text-ink-soft">We’re looking at your site and your design to work out the smallest steps. This takes a few minutes — you can leave this open.</p>
      )}
      {f.status === 'plan_failed' && (
        <p className="mt-2 text-sm text-ink-soft">Something went wrong while planning — you weren’t charged. Please describe the feature again above.</p>
      )}

      {/* The plan, step by step. Proposed steps show a Fixed / Live-data tag. */}
      {f.steps.length > 0 && editSteps === null && (
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

      {/* Editing the prepopulated steps (design-origin) — free, no re-plan. */}
      {editSteps !== null && (
        <div className="mt-3 space-y-3">
          {editSteps.map((s, i) => (
            <div key={i} className="card-inset p-3">
              <div className="flex items-center gap-2">
                <input
                  value={s.title}
                  onChange={(e) => setStep(i, { title: e.target.value })}
                  placeholder="Step title"
                  className="input flex-1 py-2 text-sm font-medium"
                />
                <select
                  value={s.kind}
                  onChange={(e) => setStep(i, { kind: e.target.value })}
                  className="select py-2 text-xs text-ink-soft"
                >
                  <option value="static">Fixed</option>
                  <option value="dynamic">Live data</option>
                </select>
                <button onClick={() => removeStep(i)} className="rounded-lg px-2 py-1 text-sm text-ink-soft hover:bg-line/40" title="Remove step">✕</button>
              </div>
              <textarea
                value={s.description}
                onChange={(e) => setStep(i, { description: e.target.value })}
                rows={2}
                placeholder="What this step adds and where on the site"
                className="input mt-2 w-full py-2 text-sm"
              />
            </div>
          ))}
          {err && <p className="text-sm text-bad">{err}</p>}
          <div className="flex flex-wrap gap-2">
            <button onClick={addStep} disabled={busy} className="rounded-lg border border-line px-3 py-2 text-sm font-semibold text-ink-soft hover:bg-line/40 disabled:opacity-60">+ Add a step</button>
            <button onClick={saveEdit} disabled={busy || editSteps.every((s) => !s.title.trim() && !s.description.trim())} className="btn btn-primary btn-sm">
              {busy ? 'Saving…' : 'Save the plan'}
            </button>
            <button onClick={() => { setEditSteps(null); setErr(''); }} disabled={busy} className="rounded-lg px-4 py-2 text-sm font-semibold text-ink-soft hover:bg-line/40">Cancel</button>
          </div>
        </div>
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

      {/* Plan review: approve to build, edit the steps yourself (free, design-origin), or refine /
          start over (each re-plan is a fresh AI look). Hidden while the inline editor is open. */}
      {reviewing && editSteps === null && (
        <div className="mt-4 border-t border-line pt-4">
          {!panel && (
            <>
              <p className="text-sm text-ink">Happy with these steps? We’ll build them one at a time — you approve and pay for each as it’s done.{f.fromDesign ? ' You can tweak them here first — that’s free.' : ''}</p>
              {err && <p className="mt-1 text-sm text-bad">{err}</p>}
              <div className="mt-2 flex flex-wrap gap-2">
                <button onClick={approvePlan} disabled={busy} className="btn btn-primary">
                  {busy ? 'Starting…' : 'Looks good — start building →'}
                </button>
                {f.fromDesign && (
                  <button onClick={startEdit} disabled={busy} className="btn btn-outline">
                    Edit the steps
                  </button>
                )}
                <button onClick={() => { setPanel('refine'); setText(''); setErr(''); }} disabled={busy} className="btn btn-outline">
                  Request changes
                </button>
                <button onClick={() => { setPanel('replace'); setText(''); setErr(''); }} disabled={busy} className="btn btn-ghost">
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
                className="input mt-2 w-full py-2 text-sm"
              />
              <p className="mt-1 text-xs text-ink-soft">We’ll take another look and show you an updated plan. There’s a small charge to re-plan, the same as the first plan.</p>
              {err && <p className="mt-1 text-sm text-bad">{err}</p>}
              <div className="mt-2 flex gap-2">
                <button onClick={submitRevise} disabled={busy || !text.trim()} className="btn btn-primary btn-sm">
                  {busy ? 'Re-planning…' : (panel === 'refine' ? 'Update the plan →' : 'Plan again →')}
                </button>
                <button onClick={() => { setPanel(null); setText(''); setErr(''); }} disabled={busy} className="btn btn-ghost btn-sm">
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
              <button onClick={retry} disabled={busy} className="btn btn-primary mt-2">
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
          <button onClick={retry} disabled={busy} className="btn btn-outline mt-2">
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
              <button onClick={goLive} disabled={busy} className="btn btn-success">
                {busy ? 'Publishing…' : 'Go live →'}
              </button>
            )}
            {panel !== 'addChange' && (
              <button onClick={() => { setPanel('addChange'); setText(''); setErr(''); }} disabled={busy} className="btn btn-outline">
                Add another change
              </button>
            )}
          </div>

          {panel === 'addChange' && (
            <div className="card-inset mt-3 p-3.5">
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
                <button onClick={submitAddChange} disabled={busy || !text.trim()} className="btn btn-primary btn-sm">
                  {busy ? 'Starting…' : 'Make this change →'}
                </button>
                <button onClick={() => { setPanel(null); setText(''); setErr(''); resetImages(); }} disabled={busy} className="btn btn-ghost btn-sm">
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Share the plan with a teammate, who forks it into their own feature to build. */}
      {['plan_review', 'running', 'complete'].includes(f.status) && (
        <ShareControl
          type="feature"
          id={f.id}
          initialToken={f.shared ? f.shareToken : null}
          share={() => shareFeature({ featureId: f.id })}
          unshare={() => unshareFeature({ featureId: f.id })}
          blurb="Want a teammate to build their own version of this plan?"
        />
      )}
    </div>
  );
}
