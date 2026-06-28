import { useState } from 'react';

// "Share with my team" control — reused on a finished fix, a feature plan, and a design. The owner
// turns sharing on (mints a link a same-org teammate can open and build their own version from) and
// can stop sharing. `share`/`unshare` are async callables; `share` resolves to a shareToken.
//
// Plain language only — no technical words.
export default function ShareControl({ type, id, initialToken = null, share, unshare, blurb }) {
  const [token, setToken] = useState(initialToken);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const link = token ? `${window.location.origin}/shared/${type}/${id}?t=${token}` : '';

  const run = async (fn) => {
    setBusy(true); setErr('');
    try { return await fn(); }
    catch { setErr('Something went wrong. Please try again.'); }
    finally { setBusy(false); }
  };

  return (
    <div className="card-subtle mt-4 p-3.5">
      {!token ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs text-ink-soft">{blurb || 'Want a teammate to build their own version from this?'}</p>
          <button
            onClick={() => run(async () => { const res = await share(); if (res?.data?.shareToken) setToken(res.data.shareToken); })}
            disabled={busy}
            className="btn btn-outline btn-sm"
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
              value={link}
              onFocus={(e) => e.target.select()}
              className="input min-w-0 flex-1 py-1.5 text-xs text-ink-soft"
            />
            <button
              onClick={() => { navigator.clipboard?.writeText(link); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
              className="btn btn-primary btn-sm shrink-0"
            >
              {copied ? 'Copied ✓' : 'Copy link'}
            </button>
          </div>
          <button
            onClick={() => run(async () => { await unshare(); setToken(null); })}
            disabled={busy}
            className="mt-2 text-xs font-medium text-ink-soft underline hover:text-ink disabled:opacity-60"
          >
            Stop sharing
          </button>
        </div>
      )}
      {err && <p className="mt-1 text-xs text-bad">{err}</p>}
    </div>
  );
}
