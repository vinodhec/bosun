/**
 * Operator-only: buyer background checks — the agent-or-buyer verdicts Bosun gives the customer's
 * buyer bank (handlers/buyerChecks.js). Three things in one panel:
 *   Today    — the day's numbers (the same figures the Telegram digest sends), queue depth, days to clear.
 *   Records  — every buyer with its verdict / score / status; click one for its full timeline + evidence.
 *   Setup    — enable, batch size, the platform's two URLs, the Telegram chat; run a batch or the digest now.
 *
 * Admin panel: exempt from the customer-facing UI language rules.
 */
import { useEffect, useState } from 'react';
import { adminBuyerChecks, adminSetBuyerCheck, adminRunBuyerChecksNow, adminBuyerCheckReportNow } from '../firebase/functions.js';

const btn = 'rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-semibold text-white transition hover:bg-brand-700 disabled:opacity-60';
const btnGhost = 'rounded-lg border border-line px-3 py-1.5 text-sm font-medium text-ink transition hover:bg-canvas disabled:opacity-60';
const input = 'w-full rounded-lg border border-line px-2 py-1 text-sm';

const when = (ms) => (ms ? new Date(ms).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '—');
const VERDICT = {
  buyer: { label: 'Buyer', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  possible_agent: { label: 'Possible agent', cls: 'bg-amber-50 text-amber-700 border-amber-200' },
  agent: { label: 'Agent', cls: 'bg-red-50 text-red-700 border-red-200' },
  unclear: { label: 'Unclear', cls: 'bg-slate-50 text-slate-600 border-slate-200' },
};
const SIGNAL = { agent: 'text-red-600', buyer: 'text-emerald-600', neutral: 'text-slate-500' };

function Chip({ verdict }) {
  const v = VERDICT[verdict] || { label: verdict || '—', cls: 'bg-slate-50 text-slate-500 border-slate-200' };
  return <span className={`inline-block rounded-md border px-2 py-0.5 text-xs font-semibold ${v.cls}`}>{v.label}</span>;
}

function Stat({ label, value, sub }) {
  return (
    <div className="rounded-lg border border-line bg-canvas px-3 py-2">
      <div className="text-xs text-muted">{label}</div>
      <div className="text-lg font-semibold text-ink tabular-nums">{value}</div>
      {sub && <div className="text-xs text-muted">{sub}</div>}
    </div>
  );
}

function Timeline({ events }) {
  if (!events?.length) return <p className="text-sm text-muted">No events yet.</p>;
  return (
    <ol className="space-y-2">
      {events.map((e) => (
        <li key={e.id} className="rounded-lg border border-line p-2 text-sm">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="font-medium text-ink">{e.text}</span>
            <span className="text-xs text-muted">{when(e.atMs)}{e.chargeInr ? ` · ₹${e.chargeInr}` : e.type === 'verdict' ? ' · free' : ''}{e.byName ? ` · ${e.byName}` : ''}</span>
          </div>
          {e.type === 'verdict' && e.reasons?.length > 0 && (
            <ul className="mt-1 list-disc pl-5 text-xs text-muted">{e.reasons.map((r, i) => <li key={i}>{r}</li>)}</ul>
          )}
          {e.evidence?.length > 0 && (
            <details className="mt-1">
              <summary className="cursor-pointer text-xs text-brand-700">{e.evidence.length} evidence line{e.evidence.length === 1 ? '' : 's'}</summary>
              <ul className="mt-1 space-y-1 text-xs">
                {e.evidence.map((ev, i) => (
                  <li key={i} className="flex gap-2">
                    <span className={`w-16 shrink-0 font-mono ${SIGNAL[ev.signal] || ''}`}>{ev.source}{ev.kind && ev.kind !== 'fact' ? `/${ev.kind}` : ''}</span>
                    <span className="text-ink">
                      {ev.quote}
                      {ev.url && <> <a className="text-brand-700 underline" href={ev.url} target="_blank" rel="noreferrer">link</a></>}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </li>
      ))}
    </ol>
  );
}

export default function BuyerChecks({ orgs }) {
  const [orgId, setOrgId] = useState('');
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [note, setNote] = useState('');
  const [filter, setFilter] = useState({ status: '', verdict: '' });
  const [open, setOpen] = useState(null); // { record, timeline }
  const [cfg, setCfg] = useState({});
  const [token, setToken] = useState('');

  const load = async (id = orgId, f = filter) => {
    if (!id) return;
    setBusy(true); setErr('');
    try {
      const { data: d } = await adminBuyerChecks({ orgId: id, status: f.status || undefined, verdict: f.verdict || undefined, limit: 200 });
      setData(d);
      setCfg({ enabled: !!d.config?.enabled, maxPerBatch: d.config?.maxPerBatch ?? 5, verdictUrl: d.config?.verdictUrl || '', snapshotUrl: d.config?.snapshotUrl || '', profileActorId: d.config?.profileActorId || '', telegramEnabled: !!d.config?.telegram?.enabled, chatId: d.config?.telegram?.chatId || '' });
    } catch (e) {
      setErr(e?.message || 'Failed to load.');
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => { if (orgId) load(orgId); }, [orgId]); // eslint-disable-line react-hooks/exhaustive-deps

  const openRecord = async (buyerKey) => {
    try {
      const { data: d } = await adminBuyerChecks({ orgId, buyerKey });
      setOpen(d);
    } catch (e) { setErr(e?.message || 'Failed to load the buyer.'); }
  };

  const save = async () => {
    setBusy(true); setErr(''); setNote('');
    try {
      await adminSetBuyerCheck({ orgId, patch: { enabled: cfg.enabled, maxPerBatch: Number(cfg.maxPerBatch) || 5, verdictUrl: cfg.verdictUrl, snapshotUrl: cfg.snapshotUrl, profileActorId: cfg.profileActorId, telegram: { enabled: cfg.telegramEnabled, chatId: cfg.chatId } }, telegramBotToken: token || undefined });
      setToken('');
      setNote('Saved.');
      await load();
    } catch (e) { setErr(e?.message || 'Save failed.'); } finally { setBusy(false); }
  };
  const runNow = async () => {
    setBusy(true); setErr(''); setNote('');
    try {
      const { data: d } = await adminRunBuyerChecksNow({ orgId });
      const s = d.summary || {};
      setNote(`Batch ${s.status}${s.reason ? ` (${s.reason})` : ''}: ${s.checked ?? 0} checked of ${s.picked ?? 0} picked, ${s.queued ?? 0} queued, ₹${s.chargedInr ?? 0} charged.`);
      await load();
    } catch (e) { setErr(e?.message || 'Run failed.'); } finally { setBusy(false); }
  };
  const digestNow = async () => {
    setBusy(true); setErr(''); setNote('');
    try {
      const { data: d } = await adminBuyerCheckReportNow({ orgId });
      setNote(d.status === 'sent' ? 'Digest sent to Telegram.' : `Digest skipped: ${d.reason}.`);
    } catch (e) { setErr(e?.message || 'Digest failed.'); } finally { setBusy(false); }
  };

  const t = data?.today;

  return (
    <section className="space-y-3 rounded-2xl border border-line bg-white p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold text-ink">Buyer background checks</h2>
        <div className="flex items-center gap-2">
          <select className="rounded-lg border border-line px-2 py-1 text-sm" value={orgId} onChange={(e) => setOrgId(e.target.value)}>
            <option value="">Pick an organisation…</option>
            {orgs.map((o) => <option key={o.id} value={o.id}>{o.name || o.id}</option>)}
          </select>
          <button type="button" className={btnGhost} onClick={() => load()} disabled={busy || !orgId}>Refresh</button>
        </div>
      </div>
      {err && <p className="text-sm text-red-600">{err}</p>}
      {note && <p className="text-sm text-emerald-700">{note}</p>}

      {t && (
        <div className="grid grid-cols-2 gap-2 md:grid-cols-4 lg:grid-cols-6">
          <Stat label="Checked today" value={t.checked} sub={t.deep ? `${t.deep} deep` : ''} />
          <Stat label="Buyer / possible / agent" value={`${t.buyer} / ${t.possible_agent} / ${t.agent}`} sub={`unclear ${t.unclear}`} />
          <Stat label="Staff calls" value={`${t.staffBuyer} / ${t.staffAgent}`} sub={`buyer / agent · no answer ${t.staffNoAnswer}`} />
          <Stat label="Overrides" value={t.overrides} sub={`reviews ✓${t.reviewsConfirmed} ✗${t.reviewsChallenged}`} />
          <Stat label="Revenue / COGS" value={`₹${Math.round(t.revenueInr)}`} sub={`COGS ≈ ₹${Math.round(t.cogsInr)} · converted ${t.converted}`} />
          <Stat label="Queue" value={t.queued} sub={t.daysToClear != null ? `~${t.daysToClear} days at ${t.perDay}/day · watch ${t.watch}` : ''} />
        </div>
      )}

      {data && (
        <details className="rounded-lg border border-line p-3">
          <summary className="cursor-pointer text-sm font-medium text-ink">Setup &amp; run</summary>
          <div className="mt-2 grid gap-2 md:grid-cols-2">
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={cfg.enabled} onChange={(e) => setCfg({ ...cfg, enabled: e.target.checked })} /> Checks enabled (batches at 10:00 and 22:00 IST)</label>
            <label className="text-sm">Per batch <input className={input} type="number" min="1" value={cfg.maxPerBatch} onChange={(e) => setCfg({ ...cfg, maxPerBatch: e.target.value })} /></label>
            <label className="text-sm">Verdict URL (platform ingest) <input className={input} value={cfg.verdictUrl} onChange={(e) => setCfg({ ...cfg, verdictUrl: e.target.value })} placeholder="https://www.maadiveedu.com/api/ingest/buyer-verdict" /></label>
            <label className="text-sm">Snapshot URL (platform behaviour) <input className={input} value={cfg.snapshotUrl} onChange={(e) => setCfg({ ...cfg, snapshotUrl: e.target.value })} placeholder="https://www.maadiveedu.com/api/sourcing/buyer-snapshot" /></label>
            <label className="text-sm">Facebook profile actor (blank = default) <input className={input} value={cfg.profileActorId} onChange={(e) => setCfg({ ...cfg, profileActorId: e.target.value })} placeholder="cleansyntax~facebook-profile-posts-scraper" /></label>
            <div className="grid grid-cols-2 gap-2">
              <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={cfg.telegramEnabled} onChange={(e) => setCfg({ ...cfg, telegramEnabled: e.target.checked })} /> Telegram digest 22:30</label>
              <label className="text-sm">Chat id <input className={input} value={cfg.chatId} onChange={(e) => setCfg({ ...cfg, chatId: e.target.value })} /></label>
            </div>
            <label className="text-sm md:col-span-2">Telegram bot token (stored in the vault; leave blank to keep) <input className={input} value={token} onChange={(e) => setToken(e.target.value)} placeholder="123456:ABC…" /></label>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <button type="button" className={btn} onClick={save} disabled={busy}>Save</button>
            <button type="button" className={btnGhost} onClick={runNow} disabled={busy || !cfg.enabled}>Run a batch now</button>
            <button type="button" className={btnGhost} onClick={digestNow} disabled={busy}>Send today's digest now</button>
          </div>
          {data.runs?.length > 0 && (
            <ul className="mt-3 space-y-1 text-xs text-muted">
              {data.runs.slice(0, 8).map((r) => (
                <li key={r.id}>{when(r.startedAtMs)} · {r.trigger} · {r.status}{r.reason ? ` (${r.reason})` : ''} · picked {r.picked} / queued {r.queued ?? '—'} · checked {r.checked} · ₹{r.chargedInr} · COGS ${Number(r.cogsUsd || 0).toFixed(3)}{r.errors?.length ? ` · ${r.errors.length} error(s)` : ''}</li>
              ))}
            </ul>
          )}
        </details>
      )}

      {data && (
        <div className="space-y-2">
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <select className="rounded-lg border border-line px-2 py-1" value={filter.status} onChange={(e) => { const f = { ...filter, status: e.target.value }; setFilter(f); load(orgId, f); }}>
              <option value="">Any status</option>
              {['due', 'watch', 'done', 'review_pending'].map((s) => <option key={s} value={s}>{s}</option>)}
            </select>
            <select className="rounded-lg border border-line px-2 py-1" value={filter.verdict} onChange={(e) => { const f = { ...filter, verdict: e.target.value }; setFilter(f); load(orgId, f); }}>
              <option value="">Any verdict</option>
              {Object.entries(VERDICT).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
            </select>
            <span className="text-muted">{data.records.length} record{data.records.length === 1 ? '' : 's'}</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-xs uppercase tracking-wide text-muted">
                <tr><th className="py-1 pr-2">Buyer</th><th className="py-1 pr-2">Source</th><th className="py-1 pr-2">Verdict</th><th className="py-1 pr-2">Score</th><th className="py-1 pr-2">Status</th><th className="py-1 pr-2">Checks</th><th className="py-1 pr-2">Last</th></tr>
              </thead>
              <tbody>
                {data.records.map((r) => (
                  <tr key={r.buyerKey} className="cursor-pointer border-t border-line hover:bg-canvas" onClick={() => openRecord(r.buyerKey)}>
                    <td className="py-1 pr-2">
                      <div className="font-medium text-ink">{r.name || r.buyerKey}</div>
                      <div className="text-xs text-muted">{r.phone ? `…${r.phone.slice(-4)}` : 'no phone'}{r.city ? ` · ${r.city}` : ''}{r.badge ? ' · ✅ verified' : ''}{r.override ? ' · overridden' : ''}</div>
                    </td>
                    <td className="py-1 pr-2 text-xs">{r.source}</td>
                    <td className="py-1 pr-2"><Chip verdict={r.verdict} /></td>
                    <td className="py-1 pr-2 tabular-nums">{r.agentScore != null ? `${Math.round(r.agentScore * 100)}%` : '—'}</td>
                    <td className="py-1 pr-2 text-xs">{r.status}{r.dueReason ? ` (${r.dueReason})` : ''}</td>
                    <td className="py-1 pr-2 tabular-nums">{r.checkCount}</td>
                    <td className="py-1 pr-2 text-xs text-muted">{when(r.checkedAtMs || r.updatedAtMs)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {open && (
        <div className="rounded-xl border border-brand-500 bg-brand-50/30 p-3">
          <div className="flex items-start justify-between gap-2">
            <div>
              <div className="font-semibold text-ink">{open.record.name || open.record.buyerKey} <Chip verdict={open.record.verdict} /></div>
              <div className="text-xs text-muted">{open.record.buyerKey} · {open.record.source} · {open.record.status} · {open.record.checkCount} check{open.record.checkCount === 1 ? '' : 's'}{open.record.summary ? ` · ${open.record.summary}` : ''}</div>
            </div>
            <button type="button" className={btnGhost} onClick={() => setOpen(null)}>Close</button>
          </div>
          <div className="mt-2"><Timeline events={open.timeline} /></div>
        </div>
      )}
    </section>
  );
}
