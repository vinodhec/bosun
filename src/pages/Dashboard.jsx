import { useCallback, useEffect, useState } from 'react';
import { useAuth } from '../hooks/useAuth.js';
import { useOrg } from '../hooks/useOrg.js';
import { createTask, listMySessions, reviseSession } from '../firebase/functions.js';
import Navbar from '../components/Navbar.jsx';
import { formatINR } from '@shared/currency.js';
import { MAX_IMAGES, MAX_IMAGE_BYTES, ACCEPTED_TYPES, readImageAttachment, imageFilesFrom } from '../utils/images.js';

const STATUS = {
  queued: 'Starting…',
  running: 'Working on it…',
  complete: 'Your fix is ready! ✅',
  failed: 'Something went wrong 😔',
};
const isWorking = (s) => s === 'queued' || s === 'running';

function friendlyError(e) {
  const m = String(e?.message || '');
  if (m.includes('INSUFFICIENT_BALANCE')) return 'Not enough credits — the Bosun team will top you up.';
  if (m.includes('NO_REPO_CONNECTED')) return 'Your website isn’t connected yet.';
  if (m.includes('NO_ORG')) return 'Your account isn’t set up yet — the Bosun team will sort it.';
  if (m.includes('ALREADY_DEPLOYED')) return 'This fix is already live — start a new fix for further changes.';
  if (m.includes('NOT_READY')) return 'Please wait for the current change to finish.';
  return 'Something went wrong. You were not charged.';
}

export default function Dashboard() {
  const { user } = useAuth();
  const org = useOrg(user);
  const [problem, setProblem] = useState('');
  const [images, setImages] = useState([]); // pasted/dropped screenshots, max MAX_IMAGES
  const [imgErr, setImgErr] = useState('');
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [sessions, setSessions] = useState(null);

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

  // Initial load + light polling while anything is in progress.
  useEffect(() => {
    if (!user) return undefined;
    refresh();
    const id = setInterval(() => {
      setSessions((prev) => {
        if (prev && !prev.some((s) => isWorking(s.status))) return prev; // idle — skip
        refresh();
        return prev;
      });
    }, 4000);
    return () => clearInterval(id);
  }, [user, refresh]);

  // Add pasted/dropped screenshots, respecting the MAX_IMAGES cap and size/type limits.
  const addFiles = useCallback(async (files) => {
    if (!files?.length) return;
    setImgErr('');
    const slots = MAX_IMAGES - images.length;
    if (slots <= 0) { setImgErr(`You can attach up to ${MAX_IMAGES} screenshots.`); return; }
    const accepted = [];
    for (const f of files.slice(0, slots)) {
      if (!ACCEPTED_TYPES.includes(f.type)) { setImgErr('Only PNG, JPG, WEBP or GIF images.'); continue; }
      if (f.size > MAX_IMAGE_BYTES) { setImgErr('Each screenshot must be under 10 MB.'); continue; }
      try { accepted.push(await readImageAttachment(f)); }
      catch { setImgErr('Could not read that image.'); }
    }
    if (files.length > slots) setImgErr(`You can attach up to ${MAX_IMAGES} screenshots.`);
    if (accepted.length) setImages((prev) => [...prev, ...accepted].slice(0, MAX_IMAGES));
  }, [images.length]);

  const onPaste = useCallback((e) => {
    const files = imageFilesFrom(e.clipboardData);
    if (files.length) { e.preventDefault(); addFiles(files); }
  }, [addFiles]);

  const onDrop = useCallback((e) => {
    e.preventDefault(); setDragging(false);
    addFiles(imageFilesFrom(e.dataTransfer));
  }, [addFiles]);

  const removeImage = (id) => setImages((prev) => prev.filter((i) => i.id !== id));

  const onFix = async () => {
    if (!problem.trim()) return;
    setBusy(true); setErr('');
    try {
      await createTask({
        prompt: problem.trim(),
        images: images.map((i) => ({ mediaType: i.mediaType, data: i.data })),
      });
      setProblem(''); setImages([]); setImgErr('');
      await refresh();
    } catch (e) {
      setErr(friendlyError(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen">
      <Navbar balance={balance} />
      <main className="mx-auto max-w-2xl space-y-6 px-4 py-6">
        {org === null && (
          <div className="rounded-xl bg-amber-50 p-4 text-sm text-amber-800 ring-1 ring-amber-200">
            Your account isn’t set up yet — the Bosun team will connect your website and add credits.
          </div>
        )}

        <section className="rounded-2xl border border-line bg-white p-5 sm:p-6">
          <h1 className="text-xl font-bold text-ink">What’s broken on your website?</h1>
          {connected && (
            <p className="mt-1 text-sm text-ink-soft">
              Connected: <span className="font-medium text-ink">{org.github.repoFullName}</span>
            </p>
          )}
          <div
            onDrop={onDrop}
            onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            className={`mt-4 rounded-xl border ${dragging ? 'border-brand-500 ring-1 ring-brand-500' : 'border-line'}`}
          >
            <textarea
              value={problem}
              onChange={(e) => setProblem(e.target.value)}
              onPaste={onPaste}
              rows={3}
              placeholder="Example: My menu disappears on mobile phone"
              className="w-full resize-none rounded-t-xl bg-transparent px-4 py-3 outline-none"
            />
            {images.length > 0 && (
              <div className="flex flex-wrap gap-2 px-4 pb-3">
                {images.map((img) => (
                  <div key={img.id} className="relative">
                    <img src={img.dataUrl} alt="screenshot" className="h-16 w-16 rounded-lg border border-line object-cover" />
                    <button
                      type="button"
                      onClick={() => removeImage(img.id)}
                      aria-label="Remove screenshot"
                      className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-ink text-xs text-white shadow"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
          <p className="mt-1.5 text-xs text-ink-soft">
            📎 Paste a screenshot (Ctrl/⌘+V) or drag one in — up to {MAX_IMAGES}. It helps us see exactly what’s wrong.
          </p>
          {imgErr && <p className="mt-1 text-sm text-bad">{imgErr}</p>}
          {err && <p className="mt-2 text-sm text-bad">{err}</p>}
          <button
            onClick={onFix}
            disabled={busy || !problem.trim() || !connected}
            className="mt-3 inline-flex w-full items-center justify-center rounded-xl bg-brand-600 px-5 py-3 font-semibold text-white transition hover:bg-brand-700 disabled:opacity-60 sm:w-auto"
          >
            {busy ? 'Starting…' : 'Fix My Website →'}
          </button>
          <p className="mt-2 text-xs text-ink-soft">
            You’re only charged after the fix is done.
          </p>
        </section>

        {Array.isArray(sessions) && sessions.length > 0 && (
          <section className="space-y-3">
            <h2 className="px-1 text-sm font-semibold uppercase tracking-wide text-ink-soft">Your fixes</h2>
            {sessions.map((s) => (
              <SessionCard key={s.id} session={s} onRevised={refresh} />
            ))}
          </section>
        )}
      </main>
    </div>
  );
}

function SessionCard({ session: s, onRevised }) {
  const [open, setOpen] = useState(false);
  const [changes, setChanges] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const working = isWorking(s.status);
  const revising = s.status === 'running' && !!s.summary; // re-running with a prior result

  const sendChanges = async () => {
    if (!changes.trim()) return;
    setBusy(true); setErr('');
    try {
      await reviseSession({ taskId: s.id, changes: changes.trim() });
      setChanges(''); setOpen(false);
      await onRevised();
    } catch (e) {
      setErr(friendlyError(e));
    } finally {
      setBusy(false);
    }
  };

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
                      {r.kind === 'initial' ? 'Initial fix' : 'Change request'}
                    </span>
                    {r.charge != null && (
                      <span className="text-xs font-medium text-ink">{formatINR(r.charge)}</span>
                    )}
                  </div>
                  {r.prompt && <p className="mt-1 text-sm text-ink-soft">“{r.prompt}”</p>}
                  {r.summary && <p className="mt-1 text-sm text-ink">{r.summary}</p>}
                  {r.changes?.length > 0 && (
                    <ul className="mt-1 list-disc space-y-0.5 pl-5 text-sm text-ink-soft">
                      {r.changes.map((c, j) => <li key={j}>{c}</li>)}
                    </ul>
                  )}
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
          {s.charge != null && (
            <p className="mt-3 text-sm">
              Total charged: <span className="font-semibold">{formatINR(s.charge)}</span>
            </p>
          )}

          <div className="mt-3 flex flex-wrap items-center gap-2">
            {s.previewUrl ? (
              <a href={s.previewUrl} target="_blank" rel="noreferrer" className="rounded-xl border border-brand-600 px-4 py-2 font-semibold text-brand-600 transition hover:bg-brand-50">
                Test the preview →
              </a>
            ) : s.buildingPreview ? (
              <span className="text-sm text-ink-soft">Building a live preview…</span>
            ) : null}

            {s.canRevise && !open && (
              <button onClick={() => setOpen(true)} className="rounded-xl px-4 py-2 font-semibold text-brand-600 transition hover:bg-brand-50">
                Request changes
              </button>
            )}
            {s.deployed && <span className="text-sm font-medium text-good">Live ✓</span>}
          </div>

          {s.canRevise && open && (
            <div className="mt-3 rounded-xl bg-canvas p-3">
              <textarea
                value={changes}
                onChange={(e) => setChanges(e.target.value)}
                rows={3}
                placeholder="What else should change? Example: also make the buttons bigger on mobile"
                className="w-full resize-none rounded-lg border border-line px-3 py-2 text-sm outline-none focus:border-brand-500"
              />
              {err && <p className="mt-1 text-sm text-bad">{err}</p>}
              <div className="mt-2 flex gap-2">
                <button
                  onClick={sendChanges}
                  disabled={busy || !changes.trim()}
                  className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-700 disabled:opacity-60"
                >
                  {busy ? 'Sending…' : 'Send changes →'}
                </button>
                <button onClick={() => { setOpen(false); setErr(''); }} className="rounded-lg px-4 py-2 text-sm font-semibold text-ink-soft hover:bg-line/40">
                  Cancel
                </button>
              </div>
              <p className="mt-1 text-xs text-ink-soft">Charged only for the extra work — and only after it’s done.</p>
            </div>
          )}
        </>
      )}

      {s.status === 'failed' && (
        <p className="mt-1 text-ink-soft">No charge was applied. Please try again.</p>
      )}
    </div>
  );
}
