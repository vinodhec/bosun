import { useEffect, useState } from 'react';
import {
  adminListOrgs,
  adminCreateOrg,
  adminAddCredits,
  adminSetUserOrg,
  adminSetOrgApproval,
  adminQuoteTask,
  adminStopTask,
  adminSetGithubRepo,
  adminRunFix,
  adminListTasks,
  confirmQuote,
  approveFix,
  declineQuote,
  deployTesting,
  deployProd,
} from '../firebase/functions.js';
import { onSnapshot, taskDocRef } from '../firebase/firestore.js';
import Navbar from '../components/Navbar.jsx';
import { formatINR } from '@shared/currency.js';

const field = 'w-full rounded-lg border border-line px-3 py-2 outline-none focus:border-brand-500';
const btn = 'rounded-lg bg-brand-600 px-4 py-2 font-semibold text-white transition hover:bg-brand-700 disabled:opacity-60';
const STATUS = { queued: 'Starting…', running: 'Working on it…', complete: 'Done ✅', failed: 'Failed' };
const TONE = { complete: 'bg-green-50 text-green-700', running: 'bg-blue-50 text-blue-700', queued: 'bg-slate-100 text-slate-600', failed: 'bg-rose-50 text-rose-700' };

// Admin-only: show sub-rupee COGS at 2dp so a small actual cost isn't rounded to ₹0
// (which would make every fix look like 100% margin). formatINR stays 0dp for prices.
const inrPrecise = (n) =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(Number(n) || 0);

// Per-fix P&L for the admin: what the customer PAID (finalCharge — ₹0 when never charged,
// i.e. a failed/stopped run) vs what the run actually COST us (actualCostInr = raw COGS in
// INR, no markup). Margin is shown as an absolute ₹ figure AND a %. A never-charged fix is a
// pure loss: paid ₹0 → margin = −COGS and −100%. Renders nothing until the run has finished.
function TaskPnL({ status, finalCharge, actualCostInr, className = '' }) {
  if (status !== 'complete' && status !== 'failed') return null;
  const paid = Number(finalCharge) || 0;
  const cogs = Number(actualCostInr) || 0;
  const margin = paid - cogs;
  // % is margin over revenue. With no revenue but real cost, the whole cost is a loss → −100%.
  const pct = paid > 0 ? Math.round((margin / paid) * 100) : cogs > 0 ? -100 : 0;
  const good = margin >= 0;
  return (
    <div className={`flex flex-wrap items-center gap-x-2 text-xs text-ink-soft ${className}`}>
      <span>paid <span className="font-semibold text-ink">{formatINR(paid)}</span></span>
      <span>·</span>
      <span>our cost <span className="font-semibold text-ink">{inrPrecise(cogs)}</span></span>
      <span>·</span>
      <span className={good ? 'text-green-700' : 'text-rose-600'}>
        margin <span className="font-semibold">{inrPrecise(margin)}</span> ({pct}%)
      </span>
    </div>
  );
}

export default function Admin() {
  const [orgs, setOrgs] = useState([]);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [newOrg, setNewOrg] = useState('');
  const [credit, setCredit] = useState({ orgId: '', amount: '' });
  const [assign, setAssign] = useState({ email: '', orgId: '' });
  const [gh, setGh] = useState({ orgId: '', repoFullName: '', token: '' });
  const [test, setTest] = useState({ orgId: '', prompt: '', asCustomer: true });
  const [taskId, setTaskId] = useState(null);
  const [task, setTask] = useState(null);
  const [sessOrg, setSessOrg] = useState('');
  const [sessions, setSessions] = useState([]);
  const [deployFor, setDeployFor] = useState(null);
  const [quoteFor, setQuoteFor] = useState(null);
  const [quoteAmt, setQuoteAmt] = useState('');
  const [quoteBudget, setQuoteBudget] = useState('');

  const loadSessions = async (id) => {
    setSessOrg(id);
    setSessions([]);
    if (!id) return;
    try { const { data } = await adminListTasks({ orgId: id }); setSessions(data.tasks || []); }
    catch { setErr('Failed to load sessions.'); }
  };

  const refresh = async () => {
    try { const { data } = await adminListOrgs(); setOrgs(data.orgs || []); }
    catch { setErr('Not authorised (your email must be in ADMIN_EMAILS), or failed to load.'); }
  };
  useEffect(() => { refresh(); }, []);
  useEffect(() => {
    if (!taskId) return undefined;
    return onSnapshot(taskDocRef(taskId), (s) => setTask(s.exists() ? { id: s.id, ...s.data() } : null));
  }, [taskId]);

  const run = async (fn, ok) => {
    setBusy(true); setErr(''); setMsg('');
    try { await fn(); setMsg(ok); await refresh(); }
    catch (e) { setErr(e?.message || 'Failed.'); }
    finally { setBusy(false); }
  };

  const deploy = async (fn, ok) => {
    setBusy(true); setErr(''); setMsg('');
    try { await fn(); setMsg(ok); await loadSessions(sessOrg); }
    catch (e) { setErr(e?.message || 'Deploy failed.'); }
    finally { setBusy(false); }
  };

  const onRun = async () => {
    setBusy(true); setErr(''); setTaskId(null); setTask(null);
    try {
      const { data } = await adminRunFix({ orgId: test.orgId, prompt: test.prompt.trim(), asCustomer: test.asCustomer });
      setTaskId(data.taskId);
    } catch (e) {
      const m = String(e?.message || '');
      setErr(m.includes('NO_REPO_CONNECTED') ? 'That org has no repo connected.'
        : m.includes('INSUFFICIENT_BALANCE') ? 'That org doesn’t have enough credits.'
        : 'Could not start the fix.');
    } finally { setBusy(false); }
  };

  const connectedOrgs = orgs.filter((o) => o.repo);

  return (
    <div className="min-h-screen">
      <Navbar balance={null} />
      <main className="mx-auto max-w-2xl space-y-5 px-4 py-6">
        <h1 className="text-xl font-bold text-ink">Admin — organisations &amp; credits</h1>
        {msg && <p className="rounded-xl bg-green-50 px-4 py-2 text-sm text-green-700">{msg}</p>}
        {err && <p className="rounded-xl bg-rose-50 px-4 py-2 text-sm text-bad">{err}</p>}

        <section className="rounded-2xl border border-line bg-white p-5">
          <h2 className="font-semibold text-ink">Organisations</h2>
          <ul className="mt-2 space-y-2 text-sm">
            {orgs.length === 0 ? (
              <li className="text-ink-soft">None yet.</li>
            ) : (
              orgs.map((o) => (
                <li key={o.id} className="rounded-lg border border-line p-3">
                  <div className="flex items-center justify-between">
                    <span className="font-medium text-ink">{o.name}</span>
                    <span className="font-semibold">{formatINR(o.balance)}</span>
                  </div>
                  <div className="mt-0.5 text-ink-soft">id: {o.id}</div>
                  <div className="text-ink-soft">
                    repo: {o.repo ? <span className="text-ink">{o.repo}</span> : <span className="text-warn">not connected</span>}
                  </div>
                  <div className="mt-1 flex items-center justify-between gap-2">
                    <span className="text-ink-soft">
                      charge: {o.requireApproval ? 'after “Looks good”' : 'auto on completion'}
                    </span>
                    <button
                      className="rounded-lg px-2.5 py-1 text-xs font-semibold text-brand-600 ring-1 ring-line transition hover:bg-brand-50 disabled:opacity-60"
                      disabled={busy}
                      onClick={() => run(() => adminSetOrgApproval({ orgId: o.id, requireApproval: !o.requireApproval }), 'Approval setting updated.')}
                    >
                      {o.requireApproval ? 'Switch to auto-charge' : 'Require “Looks good”'}
                    </button>
                  </div>
                </li>
              ))
            )}
          </ul>
        </section>

        <section className="space-y-2 rounded-2xl border border-line bg-white p-5">
          <h2 className="font-semibold text-ink">Create organisation</h2>
          <input className={field} value={newOrg} onChange={(e) => setNewOrg(e.target.value)} placeholder="Organisation name" />
          <button className={btn} disabled={busy || !newOrg.trim()} onClick={() => run(() => adminCreateOrg({ name: newOrg.trim() }).then(() => setNewOrg('')), 'Organisation created.')}>Create</button>
        </section>

        <section className="space-y-2 rounded-2xl border border-line bg-white p-5">
          <h2 className="font-semibold text-ink">Add credits</h2>
          <input className={field} value={credit.orgId} onChange={(e) => setCredit({ ...credit, orgId: e.target.value })} placeholder="orgId" />
          <input className={field} type="number" value={credit.amount} onChange={(e) => setCredit({ ...credit, amount: e.target.value })} placeholder="amount (₹)" />
          <button className={btn} disabled={busy || !credit.orgId || !credit.amount} onClick={() => run(() => adminAddCredits({ orgId: credit.orgId.trim(), amount: Number(credit.amount) }), 'Credits added.')}>Add credits</button>
        </section>

        <section className="space-y-2 rounded-2xl border border-line bg-white p-5">
          <h2 className="font-semibold text-ink">Assign user to organisation</h2>
          <input className={field} type="email" value={assign.email} onChange={(e) => setAssign({ ...assign, email: e.target.value })} placeholder="user email" />
          <select className={field} value={assign.orgId} onChange={(e) => setAssign({ ...assign, orgId: e.target.value })}>
            <option value="">Select organisation…</option>
            {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
          <button className={btn} disabled={busy || !assign.email || !assign.orgId} onClick={() => run(() => adminSetUserOrg({ email: assign.email.trim(), orgId: assign.orgId }), 'User assigned (they must sign out/in to see it).')}>Assign</button>
        </section>

        <section className="space-y-2 rounded-2xl border border-line bg-white p-5">
          <h2 className="font-semibold text-ink">Connect GitHub repo</h2>
          <p className="text-xs text-ink-soft">owner/repo + a token (Contents RW + Pull requests RW). Stored backend-only; sets up the org’s MCP vault.</p>
          <input className={field} value={gh.orgId} onChange={(e) => setGh({ ...gh, orgId: e.target.value })} placeholder="orgId" />
          <input className={field} value={gh.repoFullName} onChange={(e) => setGh({ ...gh, repoFullName: e.target.value })} placeholder="owner/repo" />
          <input className={field} value={gh.token} onChange={(e) => setGh({ ...gh, token: e.target.value })} placeholder="GitHub token (github_pat_… / ghp_…)" />
          <button className={btn} disabled={busy || !gh.orgId || !gh.repoFullName || !gh.token} onClick={() => run(() => adminSetGithubRepo({ orgId: gh.orgId.trim(), repoFullName: gh.repoFullName.trim(), token: gh.token.trim() }).then(() => setGh({ orgId: '', repoFullName: '', token: '' })), 'GitHub repo connected.')}>Connect repo</button>
        </section>

        <section className="space-y-2 rounded-2xl border border-brand-500 bg-brand-50/40 p-5">
          <h2 className="font-semibold text-ink">Test a fix</h2>
          <p className="text-xs text-ink-soft">Pick a connected org, describe the issue, then run — opens a real PR on its repo.</p>
          <select className={field} value={test.orgId} onChange={(e) => { setTest({ ...test, orgId: e.target.value }); setTaskId(null); setTask(null); }}>
            <option value="">Select organisation…</option>
            {connectedOrgs.map((o) => <option key={o.id} value={o.id}>{o.name} — {o.repo}</option>)}
          </select>
          <textarea className={field} rows={3} value={test.prompt} onChange={(e) => setTest({ ...test, prompt: e.target.value })} placeholder="Describe the issue, e.g. The menu disappears on mobile phone" />
          <label className="flex items-center gap-2 text-xs text-ink-soft">
            <input type="checkbox" checked={test.asCustomer} onChange={(e) => setTest({ ...test, asCustomer: e.target.checked })} />
            Run as customer (real classification, fixed-tier pricing, big-job quote flow)
          </label>
          <button className={btn} disabled={busy || !test.orgId || !test.prompt.trim()} onClick={onRun}>Run fix</button>
          {taskId && (
            <div className="rounded-lg bg-white p-3 text-sm ring-1 ring-line">
              <p className="font-semibold text-ink">{STATUS[task?.status] || 'Working on it…'}</p>
              {(!task || task.status === 'queued' || task.status === 'running') && <p className="text-ink-soft">Please wait 3–5 minutes…</p>}
              {task?.status === 'complete' && (
                <>
                  {task.resultSummary && <p className="mt-1 text-ink-soft">{task.resultSummary}</p>}
                  <TaskPnL status={task.status} finalCharge={task.finalCharge} actualCostInr={task.actualCostInr} className="mt-1" />
                  {task.prUrl && <a href={task.prUrl} target="_blank" rel="noreferrer" className="mt-1 inline-block font-semibold text-brand-600">See the PR →</a>}
                  {task.previewUrl ? (
                    <a href={task.previewUrl} target="_blank" rel="noreferrer" className="mt-1 ml-3 inline-block font-semibold text-brand-600">Test the preview →</a>
                  ) : task.needsPreview ? (
                    <span className="ml-2 text-ink-soft">· preview building…</span>
                  ) : null}
                </>
              )}
              {task?.status === 'failed' && (
                <>
                  <p className="text-ink-soft">No charge applied — we absorb the cost of a failed run.</p>
                  <TaskPnL status={task.status} finalCharge={task.finalCharge} actualCostInr={task.actualCostInr} className="mt-1" />
                </>
              )}
            </div>
          )}
        </section>

        <section className="space-y-3 rounded-2xl border border-line bg-white p-5">
          <h2 className="font-semibold text-ink">Sessions</h2>
          <select className={field} value={sessOrg} onChange={(e) => loadSessions(e.target.value)}>
            <option value="">Select organisation…</option>
            {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
          {sessOrg && sessions.length === 0 && <p className="text-sm text-ink-soft">No sessions yet.</p>}
          <ul className="space-y-2">
            {sessions.map((t) => (
              <li key={t.id} className="rounded-lg border border-line p-3 text-sm">
                <div className="flex items-start justify-between gap-3">
                  <span className="font-medium text-ink">{t.prompt}</span>
                  <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ${TONE[t.status] || 'bg-slate-100 text-slate-600'}`}>
                    {t.status}
                  </span>
                </div>
                <div className="mt-1 text-ink-soft">
                  {t.createdAt ? new Date(t.createdAt).toLocaleString('en-IN') : ''}
                  {t.model ? ` · ${t.model}` : ''}
                </div>
                <TaskPnL status={t.status} finalCharge={t.finalCharge} actualCostInr={t.actualCostInr} className="mt-0.5" />
                {t.resultSummary && <p className="mt-1 text-ink-soft">{t.resultSummary}</p>}
                {t.error && <p className="mt-1 text-bad">error: {t.error}</p>}

                {/* Big job awaiting a quote — set a price + budget cap, sent to the customer. */}
                {(t.status === 'needs_quote' || t.status === 'needs_requote') && (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <span className="text-xs font-medium text-amber-700">
                      {t.complexity === 'large' ? 'Big job' : 'Needs quote'} — set a price:
                    </span>
                    {quoteFor === t.id ? (
                      <>
                        <input type="number" className="w-24 rounded-lg border border-line px-2 py-1 text-xs" value={quoteAmt}
                          onChange={(e) => setQuoteAmt(e.target.value)} placeholder="₹ quote" />
                        <input type="number" className="w-24 rounded-lg border border-line px-2 py-1 text-xs" value={quoteBudget}
                          onChange={(e) => setQuoteBudget(e.target.value)} placeholder="$ cap (8)" />
                        <button className="rounded-lg bg-brand-600 px-3 py-1 text-xs font-semibold text-white disabled:opacity-60"
                          disabled={busy || !quoteAmt}
                          onClick={() => run(() => adminQuoteTask({ taskId: t.id, quoteInr: Number(quoteAmt), maxBudgetUsd: Number(quoteBudget) || 8 })
                            .then(() => { setQuoteFor(null); setQuoteAmt(''); setQuoteBudget(''); loadSessions(sessOrg); }), 'Quote sent to customer.')}>
                          Send quote
                        </button>
                        <button className="text-xs text-ink-soft underline disabled:opacity-60" disabled={busy} onClick={() => setQuoteFor(null)}>cancel</button>
                      </>
                    ) : (
                      <button className="rounded-lg bg-amber-600 px-3 py-1 text-xs font-semibold text-white disabled:opacity-60"
                        disabled={busy} onClick={() => { setQuoteFor(t.id); setQuoteAmt(''); setQuoteBudget(''); }}>
                        Quote
                      </button>
                    )}
                  </div>
                )}
                {t.status === 'quoted' && (t.adminRun ? (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <span className="text-xs text-ink-soft">Quoted {formatINR(t.quotedInr)}:</span>
                    <button className="rounded-lg bg-brand-600 px-3 py-1 text-xs font-semibold text-white disabled:opacity-60"
                      disabled={busy}
                      onClick={() => run(() => confirmQuote({ taskId: t.id }).then(() => loadSessions(sessOrg)), 'Confirmed — work started.')}>
                      Confirm {formatINR(t.quotedInr)} (as customer)
                    </button>
                    <button className="text-xs text-ink-soft underline disabled:opacity-60" disabled={busy}
                      onClick={() => run(() => declineQuote({ taskId: t.id }).then(() => loadSessions(sessOrg)), 'Quote declined.')}>
                      Decline
                    </button>
                  </div>
                ) : (
                  <p className="mt-1 text-xs text-ink-soft">Quoted {formatINR(t.quotedInr)} — waiting for the customer to confirm.</p>
                ))}

                {/* Run-as-customer test: approve (and charge) a finished fix awaiting review. */}
                {t.adminRun && t.status === 'complete' && t.pendingReview && (
                  <div className="mt-2">
                    <button className="rounded-lg bg-green-600 px-3 py-1 text-xs font-semibold text-white disabled:opacity-60"
                      disabled={busy}
                      onClick={() => run(() => approveFix({ taskId: t.id }).then(() => loadSessions(sessOrg)), 'Approved & charged.')}>
                      Looks good — pay {formatINR(t.currentRoundCharge || 0)} (as customer)
                    </button>
                  </div>
                )}

                {/* Stop a run mid-flight — marks it failed, never charged. */}
                {(t.status === 'queued' || t.status === 'running') && (
                  <div className="mt-2">
                    <button className="rounded-lg bg-rose-600 px-3 py-1 text-xs font-semibold text-white disabled:opacity-60"
                      disabled={busy}
                      onClick={() => { if (window.confirm('Stop this run? It will be marked failed and not charged.')) run(() => adminStopTask({ taskId: t.id }).then(() => loadSessions(sessOrg)), 'Run stopped.'); }}>
                      Stop run
                    </button>
                  </div>
                )}

                <div className="mt-1 flex gap-3">
                  {t.prUrl && <a href={t.prUrl} target="_blank" rel="noreferrer" className="font-semibold text-brand-600">PR →</a>}
                  {t.previewUrl && <a href={t.previewUrl} target="_blank" rel="noreferrer" className="font-semibold text-brand-600">Preview →</a>}
                </div>
                {t.status === 'complete' && t.prUrl && (
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    {deployFor === t.id ? (
                      <>
                        <span className="text-xs text-ink-soft">Deploy to:</span>
                        <button className="rounded-lg bg-teal-600 px-3 py-1 text-xs font-semibold text-white disabled:opacity-60"
                          disabled={busy}
                          onClick={() => { setDeployFor(null); deploy(() => deployTesting({ taskId: t.id }), 'Merged → deploying to testing.'); }}>
                          Testing
                        </button>
                        <button className="rounded-lg bg-rose-600 px-3 py-1 text-xs font-semibold text-white disabled:opacity-60"
                          disabled={busy}
                          onClick={() => { if (window.confirm('Promote release → PRODUCTION (vercel --prod + firebase)?')) { setDeployFor(null); deploy(() => deployProd({ taskId: t.id }), 'Promoting → production.'); } }}>
                          Production
                        </button>
                        <button className="text-xs text-ink-soft underline disabled:opacity-60" disabled={busy} onClick={() => setDeployFor(null)}>cancel</button>
                      </>
                    ) : (
                      <button className="rounded-lg bg-brand-600 px-3 py-1 text-xs font-semibold text-white disabled:opacity-60"
                        disabled={busy}
                        onClick={() => setDeployFor(t.id)}>
                        Deploy
                      </button>
                    )}
                    {t.deployedTesting && <span className="text-xs font-medium text-green-700">✓ on testing</span>}
                    {t.deployedProd && <span className="text-xs font-medium text-green-700">✓ live</span>}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </section>
      </main>
    </div>
  );
}
