import { useEffect, useState } from 'react';
import {
  adminListOrgs,
  adminCreateOrg,
  adminAddCredits,
  adminSetUserOrg,
  adminSetGithubRepo,
  adminRunFix,
  adminListTasks,
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

export default function Admin() {
  const [orgs, setOrgs] = useState([]);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [newOrg, setNewOrg] = useState('');
  const [credit, setCredit] = useState({ orgId: '', amount: '' });
  const [assign, setAssign] = useState({ email: '', orgId: '' });
  const [gh, setGh] = useState({ orgId: '', repoFullName: '', token: '' });
  const [test, setTest] = useState({ orgId: '', prompt: '' });
  const [taskId, setTaskId] = useState(null);
  const [task, setTask] = useState(null);
  const [sessOrg, setSessOrg] = useState('');
  const [sessions, setSessions] = useState([]);
  const [deployFor, setDeployFor] = useState(null);

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
      const { data } = await adminRunFix({ orgId: test.orgId, prompt: test.prompt.trim() });
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
          <button className={btn} disabled={busy || !test.orgId || !test.prompt.trim()} onClick={onRun}>Run fix</button>
          {taskId && (
            <div className="rounded-lg bg-white p-3 text-sm ring-1 ring-line">
              <p className="font-semibold text-ink">{STATUS[task?.status] || 'Working on it…'}</p>
              {(!task || task.status === 'queued' || task.status === 'running') && <p className="text-ink-soft">Please wait 3–5 minutes…</p>}
              {task?.status === 'complete' && (
                <>
                  {task.resultSummary && <p className="mt-1 text-ink-soft">{task.resultSummary}</p>}
                  <p className="mt-1">Cost: <span className="font-semibold">{formatINR(task.finalCharge)}</span></p>
                  {task.prUrl && <a href={task.prUrl} target="_blank" rel="noreferrer" className="mt-1 inline-block font-semibold text-brand-600">See the PR →</a>}
                  {task.previewUrl ? (
                    <a href={task.previewUrl} target="_blank" rel="noreferrer" className="mt-1 ml-3 inline-block font-semibold text-brand-600">Test the preview →</a>
                  ) : task.needsPreview ? (
                    <span className="ml-2 text-ink-soft">· preview building…</span>
                  ) : null}
                </>
              )}
              {task?.status === 'failed' && <p className="text-ink-soft">No charge applied.</p>}
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
                {t.finalCharge != null && (
                  <div className="mt-0.5 text-xs text-ink-soft">
                    {/* Single figure: the charged amount already includes our 2.5× margin. */}
                    cost <span className="font-semibold text-ink">{formatINR(t.finalCharge)}</span>
                  </div>
                )}
                {t.resultSummary && <p className="mt-1 text-ink-soft">{t.resultSummary}</p>}
                {t.error && <p className="mt-1 text-bad">error: {t.error}</p>}
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
