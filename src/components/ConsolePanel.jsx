import { useCallback, useEffect, useRef, useState } from 'react';
import { openConsoleSession } from '../firebase/functions.js';
import { useImageAttachments } from '../hooks/useImageAttachments.js';
import ScreenshotComposer from './ScreenshotComposer.jsx';
import { formatINR } from '@shared/currency.js';

/**
 * Chat & code — chat on the left, the customer's own website on the right. Full screen.
 *
 * One callable (`openConsoleSession`) opens the session on Bosun's console box; after that every
 * turn, the event feed and the preview go browser → box directly with the per-session token.
 * Nothing streams through Functions. The box bills a minute the moment the session opens and one
 * more for every minute it stays open, so the top bar shows the running clock.
 *
 * Events arrive by LONG-POLL (`poll?after=<seq>`), not SSE: the Cloudflare quick tunnel in front
 * of the box buffers an event-stream until it ends, so nothing ever showed while a turn ran. A
 * poll response ends per batch and streams through anything. A fresh attach replays the session's
 * event ring from seq 0, so a reload or a teammate joining sees the conversation so far.
 *
 * Screenshots ride along with a turn (paste / drop / attach, same composer as the Fix tab); the box
 * saves them beside the worktree and tells the agent to look at them first.
 */

const STORAGE_KEY = 'bosun:console-session';
const API = '/__console/api/';

let nextId = 1;

const ERRORS = {
  BUSY: 'Another session is live right now. One at a time — try again when it ends.',
  CONSOLE_OFFLINE: 'The console service is not reachable at the moment. Try again in a minute.',
  CONSOLE_REFUSED: 'The console service refused to open a session. Try again in a minute.',
  CONSOLE_NOT_CONFIGURED: 'Chat & code is not switched on for this workspace yet.',
  INSUFFICIENT_BALANCE: 'Not enough credit to start a session. Top up and try again.',
  NO_REPO_CONNECTED: 'Connect a repository first — the Bosun team does this for you.',
  WRONG_REPO: 'This workspace is not set up on the console yet. Ask the Bosun team.',
  NO_ORG: 'Your account isn’t linked to an organisation yet.',
};

function fmtElapsed(ms) {
  const m = Math.floor(ms / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${m}:${String(s).padStart(2, '0')}`;
}

export default function ConsolePanel({ orgId, connected, balance = null, onExit }) {
  const [session, setSession] = useState(null);
  const [lines, setLines] = useState([]);
  const [prompt, setPrompt] = useState('');
  const [creating, setCreating] = useState(false);
  const [turnRunning, setTurnRunning] = useState(false);
  const [previewReady, setPreviewReady] = useState(false);
  const [previewNonce, setPreviewNonce] = useState(0);
  const [turns, setTurns] = useState(0);
  const [shipTitle, setShipTitle] = useState('');
  const [shipping, setShipping] = useState(false);
  const [busyInfo, setBusyInfo] = useState(null);
  const [showDetails, setShowDetails] = useState(false);
  const [status, setStatus] = useState(null);
  const [now, setNow] = useState(Date.now());
  const { images, imgErr, dragging, setDragging, addFiles, removeImage, reset: resetImages } = useImageAttachments();

  const pollRef = useRef(null); // AbortController of the running poll loop
  const logRef = useRef(null);
  const streamIdRef = useRef(null);

  const add = useCallback((kind, text) => {
    const id = nextId++;
    setLines((prev) => [...prev, { id, kind, text }]);
    return id;
  }, []);

  const appendStream = useCallback((chunk) => {
    setLines((prev) => {
      const id = streamIdRef.current;
      if (id !== null) {
        const idx = prev.findIndex((l) => l.id === id);
        if (idx >= 0) {
          const copy = prev.slice();
          copy[idx] = { ...copy[idx], text: copy[idx].text + chunk };
          return copy;
        }
      }
      const fresh = nextId++;
      streamIdRef.current = fresh;
      return [...prev, { id: fresh, kind: 'agent', text: chunk }];
    });
  }, []);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [lines]);

  // Running clock while a session is live — billing is per minute, so show the minutes.
  useEffect(() => {
    if (!session) return undefined;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [session]);

  const call = useCallback(async (s, op, body, method = 'POST') => {
    const res = await fetch(`${s.consoleUrl}${API}${op}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${s.token}` },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let data = {};
    try { data = await res.json(); } catch { /* no body */ }
    return { status: res.status, data };
  }, []);

  const clearSession = useCallback(() => {
    pollRef.current?.abort();
    pollRef.current = null;
    try { sessionStorage.removeItem(STORAGE_KEY); } catch { /* storage blocked */ }
    setSession(null);
    setPreviewReady(false);
    setTurns(0);
    setTurnRunning(false);
    setStatus(null);
  }, []);

  const handleEvent = useCallback((m) => {
    switch (m.t) {
      case 'text':
        appendStream(String(m.v));
        break;
      case 'tool':
        setStatus((prev) => ({ label: String(m.label || 'Working'), steps: (prev?.steps || 0) + 1 }));
        add('tool', `${m.v}${m.f ? `  ${m.f}` : ''}`);
        break;
      case 'preview':
        setPreviewReady(true);
        setPreviewNonce((n) => n + 1);
        break;
      case 'checkpoint': {
        streamIdRef.current = null;
        setTurns(Number(m.n) || 0);
        setStatus(null);
        const changed = /(\d+) files? changed/.exec(String(m.stat || ''));
        add('checkpoint', changed ? `Saved — ${changed[1]} file${changed[1] === '1' ? '' : 's'} changed. Check the preview.` : 'Nothing changed on the page.');
        add('tool', `checkpoint ${m.n} @${m.sha} ${m.stat || ''}`);
        break;
      }
      case 'undo':
        streamIdRef.current = null;
        setTurns(Number(m.turns) || 0);
        add('checkpoint', 'Undone — the preview is back to how it was.');
        add('tool', `reset to ${m.to}`);
        setPreviewNonce((n) => n + 1);
        break;
      case 'shipped':
        add('checkpoint', 'Sent for review. It goes live once it passes validation and your team approves it.');
        add('tool', `PR ${m.url}`);
        setTurns(0);
        break;
      case 'idle':
        streamIdRef.current = null;
        setTurnRunning(false);
        setStatus(null);
        break;
      case 'result':
        if (m.err) add('error', `The turn ended with an error. ${m.v || ''}`);
        break;
      case 'ended':
        add('info', `Session ended (${m.v}).`);
        clearSession();
        break;
      case 'error':
      case 'stderr':
        add('error', String(m.v));
        break;
      default:
        break;
    }
  }, [add, appendStream, clearSession]);

  // The poll loop. One request in flight at a time; the box answers as soon as there is a
  // newer event, or after ~20 s with an empty batch. Replays from seq 0 on attach.
  const attach = useCallback((s) => {
    pollRef.current?.abort();
    const ac = new AbortController();
    pollRef.current = ac;
    let after = 0;
    let failures = 0;
    (async () => {
      while (!ac.signal.aborted) {
        try {
          const res = await fetch(`${s.consoleUrl}${API}poll?after=${after}&wait=20`, {
            headers: { authorization: `Bearer ${s.token}` },
            signal: ac.signal,
          });
          if (res.status === 404) { handleEvent({ t: 'ended', v: 'gone' }); return; }
          if (!res.ok) throw new Error(`poll ${res.status}`);
          const data = await res.json();
          if (failures >= 3) add('info', 'Reconnected.');
          failures = 0;
          for (const ev of data.events || []) {
            after = Math.max(after, Number(ev.seq) || 0);
            handleEvent(ev);
          }
          if (data.started) setPreviewReady(true);
          if (data.busy) setTurnRunning(true);
          if (typeof data.turns === 'number') setTurns(data.turns);
        } catch {
          if (ac.signal.aborted) return;
          failures += 1;
          if (failures === 3) add('info', 'Connection to the console dropped — retrying…');
          await new Promise((r) => setTimeout(r, Math.min(5000, 500 * failures)));
        }
      }
    })();
  }, [add, handleEvent]);

  // Survive a reload: the box still has the session; pick it back up.
  useEffect(() => {
    let raw = null;
    try { raw = sessionStorage.getItem(STORAGE_KEY); } catch { /* storage blocked */ }
    if (!raw) return;
    const s = JSON.parse(raw);
    call(s, 'session', undefined, 'GET')
      .then(({ status: st, data }) => {
        if (st !== 200) { sessionStorage.removeItem(STORAGE_KEY); return; }
        setSession(s);
        setTurns(Number(data.turns) || 0);
        setPreviewReady(Boolean(data.started));
        setTurnRunning(Boolean(data.busy));
        add('info', 'Resumed your session.');
        attach(s);
      })
      .catch(() => sessionStorage.removeItem(STORAGE_KEY));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => () => pollRef.current?.abort(), []);

  const newSession = async () => {
    setCreating(true);
    setBusyInfo(null);
    setLines([]);
    setPreviewReady(false);
    setTurns(0);
    add('info', 'Setting up your workspace…');
    try {
      const res = await openConsoleSession({ orgId });
      const s = res.data;
      setSession(s);
      try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch { /* storage blocked */ }
      if (s.rejoined) {
        setTurns(s.turns || 0);
        setPreviewReady(Boolean(s.started));
        add('info', s.teammate
          ? `Joined your team's live session (started by ${s.owner || 'a teammate'}, ${s.turns || 0} change${s.turns === 1 ? '' : 's'} so far). You share one preview and one branch — take turns.`
          : `Picked up your earlier session (${s.turns || 0} change${s.turns === 1 ? '' : 's'} so far). Carry on, or press End to start clean.`);
      } else {
        add('info', 'Ready in about a minute — the preview appears on the right. Then just describe the change you want.');
      }
      add('tool', `branch ${s.branch}`);
      attach(s);
    } catch (err) {
      const code = String(err?.message || '');
      if (code === 'BUSY' && err?.details) setBusyInfo(err.details);
      add('error', ERRORS[code] || `Could not open a session (${code || 'unknown error'}).`);
    } finally {
      setCreating(false);
    }
  };

  const canSend = !!session && !turnRunning && (prompt.trim().length > 0 || images.length > 0);

  const send = async (e) => {
    e?.preventDefault();
    if (!canSend) return;
    const text = prompt.trim();
    const shots = images.map((im) => ({ mediaType: im.mediaType, data: im.data }));
    setPrompt('');
    resetImages();
    setTurnRunning(true);
    add('user', `${text || 'See the attached screenshot.'}${shots.length ? ` 📎 ${shots.length}` : ''}`);
    const { status: st, data } = await call(session, 'turn', { prompt: text, images: shots });
    if (st !== 200) {
      setTurnRunning(false);
      add('error', String(data.error || `Turn refused (${st})`));
    }
  };

  const undo = async () => {
    if (!session || turnRunning) return;
    const { status: st, data } = await call(session, 'undo', { back: 1 });
    if (st !== 200) add('error', String(data.error || `Undo refused (${st})`));
  };

  const ship = async () => {
    if (!session || turnRunning || !turns) return;
    setShipping(true);
    try {
      const { status: st, data } = await call(session, 'ship', { title: shipTitle.trim() || undefined });
      if (st !== 200) add('error', String(data.error || `Ship refused (${st})`));
      else setShipTitle('');
    } finally {
      setShipping(false);
    }
  };

  const end = async () => {
    if (!session) return;
    await call(session, 'session', undefined, 'DELETE');
    clearSession();
    add('info', 'Session ended. The preview server is gone.');
  };

  const elapsed = session ? Math.max(0, now - (session.createdAt || now)) : 0;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-white">
      <div className="flex items-center gap-3 border-b border-line px-3 py-1.5 text-sm">
        <button type="button" onClick={onExit} className="btn btn-ghost btn-sm" disabled={turnRunning}>
          ← Back
        </button>
        <span className="font-semibold text-ink">Chat &amp; code</span>
        {session && <span className="badge badge-brand whitespace-nowrap">{fmtElapsed(elapsed)}</span>}
        <span className="ml-auto text-xs text-ink-soft">
          {balance == null ? '' : `Balance ${formatINR(balance)}`}
        </span>
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* Left: chat */}
        <div className="flex w-[42%] min-w-[320px] flex-col border-r border-line">
          <div className="flex flex-wrap items-center gap-1.5 border-b border-line px-3 py-2">
            {!session ? (
              <button type="button" onClick={newSession} disabled={creating || !connected} className="btn btn-primary btn-sm">
                {creating ? 'Starting…' : 'New session'}
              </button>
            ) : (
              <>
                <button type="button" onClick={undo} disabled={turnRunning || !turns} className="btn btn-outline btn-sm">
                  Undo turn
                </button>
                <input
                  value={shipTitle}
                  onChange={(e) => setShipTitle(e.target.value)}
                  placeholder="Title for review (optional)"
                  className="input min-w-0 flex-1 py-1 text-xs"
                />
                <button type="button" onClick={ship} disabled={turnRunning || !turns || shipping} className="btn btn-success btn-sm">
                  {shipping ? 'Shipping…' : `Ship${turns ? ` (${turns})` : ''}`}
                </button>
                <button type="button" onClick={end} disabled={turnRunning} className="btn btn-outline btn-sm text-bad">
                  End
                </button>
              </>
            )}
            <button type="button" onClick={() => setShowDetails((v) => !v)} className="ml-auto text-xs text-ink-muted hover:text-ink-soft">
              {showDetails ? 'Hide details' : 'Details'}
            </button>
          </div>

          <div ref={logRef} className="flex-1 space-y-1 overflow-auto px-3 py-2 text-sm">
            {!lines.length && (
              <p className="text-ink-soft">
                Start a session. It takes a copy of your live website, boots a preview, and every message becomes a change you can
                see on the right. Ship when it looks right — it goes for review, nothing goes live from here.
              </p>
            )}
            {busyInfo && (
              <p className="alert-warn text-xs">
                A session has been live since {new Date(busyInfo.since).toLocaleTimeString()} ({busyInfo.turns} turns). One at a
                time — try again when it ends.
              </p>
            )}
            {lines.filter((l) => showDetails || l.kind !== 'tool').map((l) => (
              <div
                key={l.id}
                className={
                  l.kind === 'user' ? 'mt-2 whitespace-pre-wrap font-medium text-brand-700'
                    : l.kind === 'tool' ? 'truncate font-mono text-[11px] text-ink-muted'
                      : l.kind === 'checkpoint' ? 'mt-1 border-t border-dashed border-line pt-1 text-xs text-emerald-700'
                        : l.kind === 'error' ? 'whitespace-pre-wrap text-xs text-bad'
                          : l.kind === 'info' ? 'text-xs text-ink-soft'
                            : 'whitespace-pre-wrap text-ink'
                }
              >
                {l.kind === 'user' ? '› ' : l.kind === 'tool' ? '· ' : ''}
                {l.text}
              </div>
            ))}
            {turnRunning && (
              <div className="flex items-center gap-2 text-xs text-ink-soft">
                <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-brand-500" />
                {status ? `${status.label}… (${status.steps} step${status.steps === 1 ? '' : 's'})` : 'Thinking…'}
              </div>
            )}
          </div>

          <form onSubmit={send} className="border-t border-line p-2">
            <ScreenshotComposer
              value={prompt}
              onChange={setPrompt}
              rows={2}
              disabled={!session || turnRunning}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
              }}
              placeholder={session ? 'Describe the change… paste or drop a screenshot to point at it (Enter to send)' : 'Start a session first'}
              images={images}
              imgErr={imgErr}
              dragging={dragging}
              setDragging={setDragging}
              addFiles={addFiles}
              removeImage={removeImage}
            />
            <div className="mt-1.5 flex justify-end">
              <button type="submit" disabled={!canSend} className="btn btn-primary btn-sm">
                Send
              </button>
            </div>
          </form>
        </div>

        {/* Right: live preview */}
        <div className="flex flex-1 flex-col">
          <div className="flex items-center gap-2 border-b border-line px-3 py-1.5 text-xs text-ink-soft">
            <span>Live preview</span>
            {session && previewReady ? (
              <>
                <button type="button" onClick={() => setPreviewNonce((n) => n + 1)} className="btn btn-outline btn-sm py-0.5">
                  Reload
                </button>
                <a href={session.previewUrl} target="_blank" rel="noreferrer" className="ml-auto text-brand-700 hover:underline">
                  Open in new tab
                </a>
              </>
            ) : session ? (
              <span className="ml-auto">starting the preview…</span>
            ) : null}
          </div>
          {session && previewReady ? (
            <iframe
              key={previewNonce}
              title="Live preview"
              src={session.previewUrl}
              sandbox="allow-same-origin allow-scripts allow-forms allow-popups"
              className="w-full flex-1 border-0"
            />
          ) : (
            <div className="flex flex-1 items-center justify-center text-sm text-ink-muted">
              {session ? 'The preview appears here once it is up (about a minute).' : 'No session.'}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
