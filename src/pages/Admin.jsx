import { useEffect, useState } from 'react';
import {
  adminListOrgs,
  adminCreateOrg,
  adminAddCredits,
  adminDeductCredits,
  adminListTransactions,
  adminSetUserOrg,
  adminRemoveUserOrg,
  adminSetOrgApproval,
  adminListUsers,
  adminSetUserDeploy,
  adminSetUserInvoices,
  adminListInvoices,
  adminInvoiceHtml,
  adminGstReport,
  adminQuoteTask,
  adminStopTask,
  adminSetGithubRepo,
  adminRunFix,
  adminListTasks,
  adminListFeatures,
  adminListDesigns,
  adminListChats,
  adminMetrics,
  confirmQuote,
  approveFix,
  declineQuote,
  deployTesting,
  deployProd,
  adminConnectFigma,
  adminDisconnectFigma,
} from '../firebase/functions.js';
import { onSnapshot, taskDocRef } from '../firebase/firestore.js';
import Navbar from '../components/Navbar.jsx';
import ScreenshotComposer from '../components/ScreenshotComposer.jsx';
import { useImageAttachments } from '../hooks/useImageAttachments.js';
import { formatINR } from '@shared/currency.js';

const field = 'w-full rounded-lg border border-line px-3 py-2 outline-none focus:border-brand-500';
const btn = 'rounded-lg bg-brand-600 px-4 py-2 font-semibold text-white transition hover:bg-brand-700 disabled:opacity-60';
const STATUS = { queued: 'Starting…', running: 'Working on it…', complete: 'Done ✅', failed: 'Failed' };
const TONE = { complete: 'bg-green-50 text-green-700', running: 'bg-blue-50 text-blue-700', queued: 'bg-slate-100 text-slate-600', failed: 'bg-rose-50 text-rose-700' };

// Admin-only: show sub-rupee COGS at 2dp so a small actual cost isn't rounded to ₹0
// (which would make every fix look like 100% margin). formatINR stays 0dp for prices.
const inrPrecise = (n) =>
  new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2 }).format(Number(n) || 0);

// What we actually pay Anthropic is denominated in USD, so show it natively.
const fmtUSD = (n) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(Number(n) || 0);

// One headline number on the business overview. tone colours profit-like figures.
function MetricCard({ label, value, sub, tone }) {
  const valueCls = tone === 'good' ? 'text-green-700' : tone === 'bad' ? 'text-rose-600' : 'text-ink';
  return (
    <div className="rounded-xl border border-line bg-canvas/40 p-3">
      <div className="text-xs font-medium text-ink-soft">{label}</div>
      <div className={`mt-0.5 text-lg font-bold leading-tight ${valueCls}`}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-ink-soft">{sub}</div>}
    </div>
  );
}

// A small revenue/profit-by-period table (run-rate averages or trailing windows). Profit
// cells are coloured by sign; revenue is neutral.
function TrendTable({ title, cols, revenue, profit }) {
  return (
    <div className="rounded-xl border border-line bg-canvas/40 p-3">
      <div className="text-xs font-medium text-ink-soft">{title}</div>
      <table className="mt-2 w-full text-xs">
        <thead>
          <tr className="text-ink-soft">
            <th className="text-left font-medium" />
            {cols.map((c) => <th key={c} className="pl-3 text-right font-medium">{c}</th>)}
          </tr>
        </thead>
        <tbody>
          <tr>
            <td className="py-1 text-left text-ink-soft">Revenue</td>
            {revenue.map((v, i) => <td key={i} className="py-1 pl-3 text-right font-semibold text-ink">{formatINR(v)}</td>)}
          </tr>
          <tr>
            <td className="py-1 text-left text-ink-soft">Profit</td>
            {profit.map((v, i) => (
              <td key={i} className={`py-1 pl-3 text-right font-semibold ${v >= 0 ? 'text-green-700' : 'text-rose-600'}`}>{formatINR(v)}</td>
            ))}
          </tr>
        </tbody>
      </table>
    </div>
  );
}

// Today (IST calendar day) snapshot — what happened since midnight India time. Distinct
// from the rolling 24h trailing window. Loss-of-failures is the COGS we ate on runs that
// were never charged; free retries are the 'unresolved' re-runs we absorbed.
function TodayCard({ today }) {
  if (!today) return null;
  const pnlTone = today.profitInr >= 0 ? 'good' : 'bad';
  const dateLabel = new Date(today.startMs).toLocaleDateString('en-IN', {
    timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short',
  });
  return (
    <div className="mt-3 rounded-xl border border-brand-500/40 bg-brand-50/30 p-3">
      <div className="flex items-center justify-between">
        <div className="text-xs font-semibold uppercase tracking-wide text-brand-700">Today · {dateLabel}</div>
        <div className="text-[10px] text-ink-soft">since 00:00 IST</div>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-3 lg:grid-cols-3">
        <MetricCard label="Revenue today" value={formatINR(today.revenueInr)} tone="good" />
        <MetricCard label="Cost today" value={inrPrecise(today.costInr)} sub="raw COGS" />
        <MetricCard label="P&L today" value={inrPrecise(today.profitInr)}
          sub={today.profitInr >= 0 ? 'profit' : 'loss'} tone={pnlTone} />
        <MetricCard label="Failed today" value={today.failedRuns}
          sub={`${inrPrecise(today.failedCostInr)} lost to failures`}
          tone={today.failedRuns > 0 ? 'bad' : undefined} />
        <MetricCard label="Free retries given" value={today.freeRetriesGiven}
          sub="unresolved re-runs we ate" />
      </div>
    </div>
  );
}

// Business overview: revenue, what we pay Anthropic, profit/margin, and delivery counts
// (fixes / PRs / deploys), plus a per-org breakdown. Data from the adminMetrics callable.
function Overview({ data, busy, onRefresh }) {
  const t = data?.totals;
  return (
    <section className="rounded-2xl border border-line bg-white p-5">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-ink">Business overview</h2>
        <button className="rounded-lg px-2.5 py-1 text-xs font-semibold text-brand-600 ring-1 ring-line transition hover:bg-brand-50 disabled:opacity-60"
          disabled={busy} onClick={onRefresh}>Refresh</button>
      </div>
      {!data ? (
        <p className="mt-3 text-sm text-ink-soft">Loading numbers…</p>
      ) : (
        <>
          <TodayCard today={data.today} />
          <div className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <MetricCard label="Revenue" value={formatINR(t.revenueInr)} sub="earned on fixes" tone="good" />
            <MetricCard label="Paid to Anthropic" value={fmtUSD(t.anthropicUsd)} sub={`${inrPrecise(t.costInr)} cost`} />
            <MetricCard label="Profit" value={formatINR(t.profitInr)} sub={`${t.marginPct}% margin`} tone={t.profitInr >= 0 ? 'good' : 'bad'} />
            <MetricCard label="Cash collected" value={formatINR(t.creditsAddedInr)} sub={`${formatINR(t.balanceInr)} unspent`} />
            <MetricCard label="Organisations" value={t.orgs} sub={`${t.tasksTotal} jobs total`} />
            <MetricCard label="Fixes delivered" value={t.fixesDone}
              sub={`${t.failedRuns} failed${t.inProgress ? ` · ${t.inProgress} running` : ''}`} />
            <MetricCard label="PRs opened" value={t.prsDelivered} />
            <MetricCard label="Deploys" value={`${t.deploysProd} live`} sub={`${t.deploysTesting} to testing`} />
          </div>

          <div className="mt-4 grid gap-3 lg:grid-cols-2">
            <TrendTable
              title={`Run rate — average over ${Math.round(data.averages.spanDays)} day${Math.round(data.averages.spanDays) === 1 ? '' : 's'}`}
              cols={['Daily', 'Weekly', 'Monthly']}
              revenue={[data.averages.revenue.daily, data.averages.revenue.weekly, data.averages.revenue.monthly]}
              profit={[data.averages.profit.daily, data.averages.profit.weekly, data.averages.profit.monthly]}
            />
            <TrendTable
              title="Recent — booked in the last…"
              cols={['24 hours', '7 days', '30 days']}
              revenue={[data.trailing.d1.revenueInr, data.trailing.d7.revenueInr, data.trailing.d30.revenueInr]}
              profit={[data.trailing.d1.profitInr, data.trailing.d7.profitInr, data.trailing.d30.profitInr]}
            />
          </div>

          {data.byOrg.length > 0 && (
            <div className="mt-4 overflow-x-auto">
              <table className="w-full min-w-[640px] text-left text-xs">
                <thead>
                  <tr className="border-b border-line text-ink-soft">
                    <th className="py-1.5 pr-3 font-medium">Organisation</th>
                    <th className="py-1.5 pr-3 text-right font-medium">Revenue</th>
                    <th className="py-1.5 pr-3 text-right font-medium">Cost</th>
                    <th className="py-1.5 pr-3 text-right font-medium">Profit</th>
                    <th className="py-1.5 pr-3 text-right font-medium">Fixes</th>
                    <th className="py-1.5 pr-3 text-right font-medium">PRs</th>
                    <th className="py-1.5 pr-3 text-right font-medium">Deploys</th>
                    <th className="py-1.5 text-right font-medium">Balance</th>
                  </tr>
                </thead>
                <tbody>
                  {data.byOrg.map((o) => (
                    <tr key={o.orgId} className="border-b border-line/60">
                      <td className="py-1.5 pr-3 font-medium text-ink">{o.name}</td>
                      <td className="py-1.5 pr-3 text-right text-ink">{formatINR(o.revenueInr)}</td>
                      <td className="py-1.5 pr-3 text-right text-ink-soft">{inrPrecise(o.costInr)}</td>
                      <td className={`py-1.5 pr-3 text-right font-semibold ${o.profitInr >= 0 ? 'text-green-700' : 'text-rose-600'}`}>{inrPrecise(o.profitInr)}</td>
                      <td className="py-1.5 pr-3 text-right text-ink">{o.fixesDone}{o.failedRuns ? <span className="text-rose-500"> /{o.failedRuns}✗</span> : ''}</td>
                      <td className="py-1.5 pr-3 text-right text-ink">{o.prsDelivered}</td>
                      <td className="py-1.5 pr-3 text-right text-ink-soft">{o.deploysProd}↑ · {o.deploysTesting}t</td>
                      <td className="py-1.5 text-right text-ink">{formatINR(o.balanceInr)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </section>
  );
}

// Sourcing overview: the sourced-listing relay lane — revenue (₹ charged), leads relayed, and an
// ESTIMATED Apify COGS (this lane isn't metered per run, so profit is an estimate), sliced today /
// trailing / per-org. Mirrors the Business overview. Data from adminMetrics().sourcing.
function SourcingOverview({ data: s }) {
  if (!s) return null;
  const today = s.today || { revenueInr: 0, leads: 0, profitInr: 0 };
  return (
    <section className="rounded-2xl border border-line bg-white p-5">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-ink">Sourcing — leads relayed</h2>
        <span className="text-[10px] text-ink-soft">near-zero COGS · profit est. at ₹{s.estInrPerLead}/lead Apify</span>
      </div>

      <div className="mt-3 rounded-xl border border-brand-500/40 bg-brand-50/30 p-3">
        <div className="text-xs font-semibold uppercase tracking-wide text-brand-700">Today · since 00:00 IST</div>
        <div className="mt-2 grid grid-cols-3 gap-3">
          <MetricCard label="Revenue today" value={formatINR(today.revenueInr)} tone="good" />
          <MetricCard label="Leads today" value={today.leads} />
          <MetricCard label="Profit today" value={inrPrecise(today.profitInr)} sub="est."
            tone={today.profitInr >= 0 ? 'good' : 'bad'} />
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <MetricCard label="Revenue" value={formatINR(s.revenueInr)} sub="charged for leads" tone="good" />
        <MetricCard label="Leads relayed" value={s.leads} sub={`${s.batches} runs`} />
        <MetricCard label="Est. Apify cost" value={inrPrecise(s.estCostInr)} sub={`est. ₹${s.estInrPerLead}/lead`} />
        <MetricCard label="Profit" value={formatINR(s.profitInr)} sub={`${s.marginPct}% margin · est.`}
          tone={s.profitInr >= 0 ? 'good' : 'bad'} />
        <MetricCard label="Avg per lead" value={inrPrecise(s.avgInrPerLead)} sub="revenue / lead" />
      </div>

      <div className="mt-4">
        <TrendTable
          title="Recent — relayed in the last…"
          cols={['24 hours', '7 days', '30 days']}
          revenue={[s.trailing.d1.revenueInr, s.trailing.d7.revenueInr, s.trailing.d30.revenueInr]}
          profit={[s.trailing.d1.profitInr, s.trailing.d7.profitInr, s.trailing.d30.profitInr]}
        />
      </div>

      {s.byOrg.length > 0 && (
        <div className="mt-4 overflow-x-auto">
          <table className="w-full min-w-[480px] text-left text-xs">
            <thead>
              <tr className="border-b border-line text-ink-soft">
                <th className="py-1.5 pr-3 font-medium">Organisation</th>
                <th className="py-1.5 pr-3 text-right font-medium">Leads</th>
                <th className="py-1.5 pr-3 text-right font-medium">Revenue</th>
                <th className="py-1.5 pr-3 text-right font-medium">Est. cost</th>
                <th className="py-1.5 text-right font-medium">Profit</th>
              </tr>
            </thead>
            <tbody>
              {s.byOrg.map((o) => {
                const est = (Number(o.leads) || 0) * s.estInrPerLead;
                const profit = o.revenueInr - est;
                return (
                  <tr key={o.orgId} className="border-b border-line/60">
                    <td className="py-1.5 pr-3 font-medium text-ink">{o.name}</td>
                    <td className="py-1.5 pr-3 text-right text-ink">{o.leads}</td>
                    <td className="py-1.5 pr-3 text-right text-ink">{formatINR(o.revenueInr)}</td>
                    <td className="py-1.5 pr-3 text-right text-ink-soft">{inrPrecise(est)}</td>
                    <td className={`py-1.5 text-right font-semibold ${profit >= 0 ? 'text-green-700' : 'text-rose-600'}`}>{inrPrecise(profit)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

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

// Admin-only progress meter for in-flight runs. The poller stamps liveCostUsd /
// liveActiveSeconds on the task every ~minute; we render elapsed time, USD spent,
// and how close each is to its cap. Customer UI never sees this.
function RunProgress({ task }) {
  if (task.status !== 'running' && task.status !== 'queued') return null;
  const elapsedSec = Math.max(0, Math.round(Number(task.liveActiveSeconds) || 0));
  const cost = Number(task.liveCostUsd) || 0;
  const maxSec = Number(task.maxSeconds) || 0;
  const maxUsd = Number(task.maxBudgetUsd) || 0;
  const fmtTime = (s) => {
    const m = Math.floor(s / 60);
    const r = s % 60;
    return m > 0 ? `${m}m ${r}s` : `${r}s`;
  };
  const updated = task.liveUpdatedAt ? new Date(task.liveUpdatedAt) : null;
  const noData = !task.liveUpdatedAt;
  const timePct = maxSec > 0 ? Math.min(100, Math.round((elapsedSec / maxSec) * 100)) : 0;
  const costPct = maxUsd > 0 ? Math.min(100, Math.round((cost / maxUsd) * 100)) : 0;
  const hot = (p) => (p >= 90 ? 'bg-rose-500' : p >= 60 ? 'bg-amber-500' : 'bg-brand-500');
  return (
    <div className="mt-2 rounded-lg border border-line bg-canvas/50 p-2 text-xs">
      <div className="flex items-center justify-between text-ink-soft">
        <span className="font-semibold text-ink">Run progress</span>
        <span>{noData ? 'waiting for first poll…' : updated ? `updated ${updated.toLocaleTimeString('en-IN')}` : ''}</span>
      </div>
      <div className="mt-1.5 space-y-1.5">
        <div>
          <div className="flex justify-between text-ink-soft">
            <span>Time</span>
            <span className="font-medium text-ink">
              {fmtTime(elapsedSec)}{maxSec > 0 ? ` / ${fmtTime(maxSec)}` : ''}
            </span>
          </div>
          {maxSec > 0 && (
            <div className="mt-0.5 h-1.5 w-full overflow-hidden rounded-full bg-line">
              <div className={`h-full ${hot(timePct)}`} style={{ width: `${timePct}%` }} />
            </div>
          )}
        </div>
        <div>
          <div className="flex justify-between text-ink-soft">
            <span>Anthropic spend</span>
            <span className="font-medium text-ink">
              ${cost.toFixed(2)}{maxUsd > 0 ? ` / $${maxUsd.toFixed(2)}` : ''}
            </span>
          </div>
          {maxUsd > 0 && (
            <div className="mt-0.5 h-1.5 w-full overflow-hidden rounded-full bg-line">
              <div className={`h-full ${hot(costPct)}`} style={{ width: `${costPct}%` }} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Per-org ledger: the line-by-line credit/debit statement for one organisation, newest first,
// with a running balance — the detail behind the aggregate Overview numbers. Credits are
// top-ups; debits are fix charges and manual adjustments. Operator-only.
function Ledger({ orgs }) {
  const [orgId, setOrgId] = useState('');
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const load = async (id) => {
    setOrgId(id); setData(null); setErr('');
    if (!id) return;
    setBusy(true);
    try { const { data: d } = await adminListTransactions({ orgId: id }); setData(d); }
    catch { setErr('Failed to load the ledger.'); }
    finally { setBusy(false); }
  };

  // Plain-English label for one ledger row from its type/kind.
  const label = (t) => {
    if (t.type === 'credit') return t.description || 'Credits added';
    if (t.kind === 'admin_adjustment') return t.description || 'Manual adjustment';
    if (t.taskId) return t.kind === 'new_scope' ? 'Fix charge (new request)' : 'Fix charge';
    return t.description || t.kind || 'Debit';
  };

  return (
    <section className="space-y-3 rounded-2xl border border-line bg-white p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-semibold text-ink">Ledger</h2>
        {data && (
          <span className="text-sm text-ink-soft">
            Balance: <span className="font-semibold text-ink">{formatINR(data.balance)}</span>
          </span>
        )}
      </div>
      <select className={field} value={orgId} onChange={(e) => load(e.target.value)}>
        <option value="">Select organisation…</option>
        {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
      </select>
      {err && <p className="text-sm text-bad">{err}</p>}
      {busy && <p className="text-sm text-ink-soft">Loading…</p>}
      {orgId && !busy && data && data.transactions.length === 0 && (
        <p className="text-sm text-ink-soft">No credits or debits yet.</p>
      )}
      {data && data.transactions.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[560px] text-left text-xs">
            <thead>
              <tr className="border-b border-line text-ink-soft">
                <th className="py-1.5 pr-3 font-medium">Date</th>
                <th className="py-1.5 pr-3 font-medium">Detail</th>
                <th className="py-1.5 pr-3 font-medium">Who</th>
                <th className="py-1.5 pr-3 text-right font-medium">Amount</th>
                <th className="py-1.5 text-right font-medium">Balance</th>
              </tr>
            </thead>
            <tbody>
              {data.transactions.map((t) => (
                <tr key={t.id} className="border-b border-line/60">
                  <td className="py-1.5 pr-3 text-ink-soft">{t.createdAt ? new Date(t.createdAt).toLocaleString('en-IN') : '—'}</td>
                  <td className="py-1.5 pr-3 text-ink">{label(t)}</td>
                  <td className="py-1.5 pr-3 text-ink-soft">{t.by || t.userEmail || '—'}</td>
                  <td className={`py-1.5 pr-3 text-right font-semibold ${t.type === 'credit' ? 'text-green-700' : 'text-rose-600'}`}>
                    {t.type === 'credit' ? '+' : '−'}{formatINR(t.amount)}
                  </td>
                  <td className="py-1.5 text-right text-ink">{formatINR(t.balanceAfter)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

// Per-user "go live" access. Publishing a fix to testing is open to everyone in an org; making
// it live (production) is granted per person here. Pick an org, then switch each teammate on/off.
function DeployAccess({ orgs }) {
  const [orgId, setOrgId] = useState('');
  const [users, setUsers] = useState([]);
  const [invoices, setInvoices] = useState([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');

  const load = async (id) => {
    setOrgId(id); setUsers([]); setInvoices([]); setErr(''); setMsg('');
    if (!id) return;
    setBusy(true);
    try {
      const { data } = await adminListUsers({ orgId: id });
      setUsers(data.users || []);
      const inv = await adminListInvoices({ orgId: id });
      setInvoices(inv.data?.invoices || []);
    }
    catch { setErr('Failed to load people.'); }
    finally { setBusy(false); }
  };

  const toggle = async (u) => {
    setBusy(true); setErr(''); setMsg('');
    const next = !u.canDeployProd;
    try {
      await adminSetUserDeploy({ uid: u.uid, canDeployProd: next });
      setUsers((list) => list.map((x) => (x.uid === u.uid ? { ...x, canDeployProd: next } : x)));
      setMsg(`${u.email || 'User'} ${next ? 'can now go live.' : 'is testing-only now.'}`);
    } catch { setErr('Could not update that person.'); }
    finally { setBusy(false); }
  };

  const toggleInvoices = async (u) => {
    setBusy(true); setErr(''); setMsg('');
    const next = !u.canViewInvoices;
    try {
      await adminSetUserInvoices({ uid: u.uid, canViewInvoices: next });
      setUsers((list) => list.map((x) => (x.uid === u.uid ? { ...x, canViewInvoices: next } : x)));
      setMsg(`${u.email || 'User'} ${next ? 'can now see invoices.' : 'can no longer see invoices.'}`);
    } catch { setErr('Could not update that person.'); }
    finally { setBusy(false); }
  };

  // Open one invoice as a printable page (save/print as PDF).
  const openInvoice = async (id) => {
    try {
      const { data } = await adminInvoiceHtml({ invoiceId: id });
      const w = window.open('', '_blank');
      if (!w) return;
      w.document.write(data.html); w.document.close(); w.focus();
      setTimeout(() => w.print(), 400);
    } catch { setErr('Could not open that invoice.'); }
  };

  // Org-name lookup for the membership chips.
  const orgName = (id) => orgs.find((o) => o.id === id)?.name || id;

  // Add the user to another org / remove them from one, then reload the list (a removed user may
  // drop out of THIS org's view).
  const addOrg = async (u, addId) => {
    if (!addId) return;
    setBusy(true); setErr(''); setMsg('');
    try {
      await adminSetUserOrg({ email: u.email, orgId: addId });
      setUsers((list) => list.map((x) => (x.uid === u.uid ? { ...x, orgIds: [...new Set([...(x.orgIds || []), addId])] } : x)));
      setMsg(`${u.email || 'User'} added to ${orgName(addId)}.`);
    } catch { setErr('Could not add that membership (has the user signed in?).'); }
    finally { setBusy(false); }
  };
  const removeOrg = async (u, rmId) => {
    setBusy(true); setErr(''); setMsg('');
    try {
      await adminRemoveUserOrg({ email: u.email, orgId: rmId });
      if (rmId === orgId) { await load(orgId); }
      else { setUsers((list) => list.map((x) => (x.uid === u.uid ? { ...x, orgIds: (x.orgIds || []).filter((id) => id !== rmId) } : x))); }
      setMsg(`${u.email || 'User'} removed from ${orgName(rmId)}.`);
    } catch { setErr('Could not remove that membership.'); }
    finally { setBusy(false); }
  };

  return (
    <section className="space-y-3 rounded-2xl border border-line bg-white p-5">
      <h2 className="font-semibold text-ink">People &amp; workspaces</h2>
      <p className="text-xs text-ink-soft">Everyone in an organisation can publish to testing; only people switched on here can go live (production). A person can belong to several organisations — add/remove memberships below (they switch between them with the workspace dropdown).</p>
      <select className={field} value={orgId} onChange={(e) => load(e.target.value)}>
        <option value="">Select organisation…</option>
        {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
      </select>
      {err && <p className="text-sm text-bad">{err}</p>}
      {msg && <p className="text-sm text-green-700">{msg}</p>}
      {orgId && !busy && users.length === 0 && <p className="text-sm text-ink-soft">Nobody is assigned to this organisation yet.</p>}
      {users.length > 0 && (
        <ul className="space-y-2">
          {users.map((u) => (
            <li key={u.uid} className="space-y-2 rounded-lg border border-line p-3 text-sm">
              <div className="flex items-center justify-between gap-3">
                <span className="truncate text-ink">{u.email || u.uid}</span>
                <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                  <span className={`text-xs ${u.canDeployProd ? 'text-green-700' : 'text-ink-soft'}`}>
                    {u.canDeployProd ? 'can go live' : 'testing only'}
                  </span>
                  <button
                    className="rounded-lg px-2.5 py-1 text-xs font-semibold text-brand-600 ring-1 ring-line transition hover:bg-brand-50 disabled:opacity-60"
                    disabled={busy}
                    onClick={() => toggle(u)}
                  >
                    {u.canDeployProd ? 'Revoke go-live' : 'Allow go-live'}
                  </button>
                  <span className={`text-xs ${u.canViewInvoices ? 'text-green-700' : 'text-ink-soft'}`}>
                    {u.canViewInvoices ? 'sees invoices' : 'no invoices'}
                  </span>
                  <button
                    className="rounded-lg px-2.5 py-1 text-xs font-semibold text-brand-600 ring-1 ring-line transition hover:bg-brand-50 disabled:opacity-60"
                    disabled={busy}
                    onClick={() => toggleInvoices(u)}
                  >
                    {u.canViewInvoices ? 'Hide invoices' : 'Allow invoices'}
                  </button>
                </div>
              </div>
              {/* Membership chips + add-to-another-org. */}
              <div className="flex flex-wrap items-center gap-1.5">
                {(u.orgIds || []).map((id) => (
                  <span key={id} className="inline-flex items-center gap-1 rounded-full bg-canvas px-2 py-0.5 text-xs text-ink ring-1 ring-line">
                    {orgName(id)}
                    <button
                      className="text-ink-soft hover:text-bad disabled:opacity-60"
                      disabled={busy || (u.orgIds || []).length <= 1}
                      title={(u.orgIds || []).length <= 1 ? 'A user must belong to at least one organisation' : 'Remove from this organisation'}
                      onClick={() => removeOrg(u, id)}
                    >✕</button>
                  </span>
                ))}
                <select
                  className="rounded-lg border border-line bg-white px-2 py-0.5 text-xs text-ink-soft disabled:opacity-60"
                  value=""
                  disabled={busy}
                  onChange={(e) => { addOrg(u, e.target.value); e.target.value = ''; }}
                >
                  <option value="">+ add to organisation…</option>
                  {orgs.filter((o) => !(u.orgIds || []).includes(o.id)).map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
                </select>
              </div>
            </li>
          ))}
        </ul>
      )}

      {orgId && (
        <div className="mt-5 border-t border-line pt-4">
          <h3 className="mb-2 text-sm font-semibold text-ink">Invoices</h3>
          {invoices.length === 0 ? (
            <p className="text-xs text-ink-soft">No invoices for this organisation yet — one is created each time you add credits.</p>
          ) : (
            <ul className="space-y-1.5">
              {invoices.map((iv) => (
                <li key={iv.id} className="flex items-center justify-between gap-3 rounded-lg border border-line px-3 py-2 text-sm">
                  <div className="min-w-0">
                    <p className="truncate font-medium text-ink">{iv.number}</p>
                    <p className="text-xs text-ink-soft">
                      {iv.issuedAtMs ? new Date(iv.issuedAtMs).toLocaleDateString('en-IN') : ''} · {formatINR(iv.totalInr)} · {iv.buyerName || '—'}
                    </p>
                  </div>
                  <button
                    className="shrink-0 rounded-lg px-2.5 py-1 text-xs font-semibold text-brand-600 ring-1 ring-line transition hover:bg-brand-50"
                    onClick={() => openInvoice(iv.id)}
                  >
                    Download
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

// GST Reports (software line only). Generates a GSTR-1 (outward supplies) for the SW/ invoices in a
// date range — the CA merges it with the trading business for the single-GSTIN return. Purchases
// (Anthropic credits, an RCM import of services) are handled separately by the CA.
function GstReports() {
  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const now = new Date();
  const [from, setFrom] = useState(iso(new Date(now.getFullYear(), now.getMonth(), 1)));
  const [to, setTo] = useState(iso(now));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [info, setInfo] = useState('');

  const generate = async () => {
    setBusy(true); setErr(''); setInfo('');
    try {
      const { data } = await adminGstReport({ from, to });
      const w = window.open('', '_blank');
      if (w) { w.document.write(data.html); w.document.close(); w.focus(); }
      const taxable = Number(data.totals?.taxable || 0).toLocaleString('en-IN');
      setInfo(`${data.count} invoice(s) · taxable ₹${taxable}`);
    } catch {
      setErr('Could not generate the report.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="space-y-3 rounded-2xl border border-line bg-white p-5">
      <h2 className="font-semibold text-ink">GST Reports (software line)</h2>
      <p className="text-xs text-ink-soft">GSTR-1 (outward sales) for the SW/ invoices in a date range — hand to the CA to merge with the trading business. Purchases (Anthropic, reverse-charge) are handled separately.</p>
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-sm text-ink">From
          <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="mt-1 block rounded-lg border border-line px-3 py-2 text-sm outline-none focus:border-brand-500" />
        </label>
        <label className="text-sm text-ink">To
          <input type="date" value={to} onChange={(e) => setTo(e.target.value)} className="mt-1 block rounded-lg border border-line px-3 py-2 text-sm outline-none focus:border-brand-500" />
        </label>
        <button className={btn} disabled={busy} onClick={generate}>{busy ? 'Generating…' : 'Generate GSTR-1'}</button>
      </div>
      {info && <p className="text-sm text-green-700">{info}</p>}
      {err && <p className="text-sm text-red-600">{err}</p>}
    </section>
  );
}

// Operator-only: connect an org's Figma account so a customer who pastes a design link gets it
// built pixel-perfect. We save the Figma access token backend-only (orgSecrets/{orgId}.figma) and
// validate it on save; the token is never returned to the browser. No board/target to pick — the
// customer supplies the design link per request, so a valid token is the whole setup.
function FigmaConnect({ orgs }) {
  const [orgId, setOrgId] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  const selectedOrg = orgs.find((o) => o.id === orgId);

  const save = async () => {
    setBusy(true); setErr(''); setMsg('');
    try {
      const { data } = await adminConnectFigma({ orgId: orgId.trim(), token: token.trim() });
      setMsg(`Connected to Figma as ${data.handle || data.email || 'the account'}.`);
      setToken('');
    } catch (e) { setErr(e?.message || 'Could not connect.'); }
    finally { setBusy(false); }
  };

  const disconnect = async () => {
    setBusy(true); setErr(''); setMsg('');
    try {
      await adminDisconnectFigma({ orgId: orgId.trim() });
      setMsg('Disconnected.');
    } catch (e) { setErr(e?.message || 'Could not disconnect.'); }
    finally { setBusy(false); }
  };

  return (
    <section className="space-y-2 rounded-2xl border border-line bg-white p-5">
      <h2 className="font-semibold text-ink">Connect Figma (design-to-code)</h2>
      <p className="text-xs text-ink-soft">
        Paste a Figma access token (stored backend-only). Once connected, when a customer includes a
        Figma link in what they want, we build it pixel-perfect from the design.
      </p>
      <select className={field} value={orgId} onChange={(e) => { setOrgId(e.target.value); setMsg(''); setErr(''); }}>
        <option value="">Select organisation…</option>
        {orgs.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}{o.figma?.connected ? ` — ✓ ${o.figma.handle || 'connected'}` : ''}
          </option>
        ))}
      </select>

      {orgId && (
        <>
          {selectedOrg?.figma?.connected && (
            <p className="text-xs text-ink-soft">
              Currently linked to <span className="font-medium text-ink">{selectedOrg.figma.handle || selectedOrg.figma.email || 'an account'}</span>.
            </p>
          )}
          <input className={field} value={token} onChange={(e) => setToken(e.target.value)} placeholder="Figma access token (figd_…)" />
          <div className="flex flex-wrap gap-2">
            <button className={btn} disabled={busy || !token.trim()} onClick={save}>
              {selectedOrg?.figma?.connected ? 'Update token' : 'Connect'}
            </button>
            {selectedOrg?.figma?.connected && (
              <button className="rounded-lg px-4 py-2 font-semibold text-bad ring-1 ring-line transition hover:bg-rose-50 disabled:opacity-60" disabled={busy} onClick={disconnect}>
                Disconnect
              </button>
            )}
          </div>
        </>
      )}

      {msg && <p className="rounded-lg bg-green-50 px-3 py-2 text-xs text-green-700">{msg}</p>}
      {err && <p className="rounded-lg bg-rose-50 px-3 py-2 text-xs text-bad">{err}</p>}
    </section>
  );
}

// Plain-English lifecycle labels for a "Plan a feature" feature + its steps, plus the badge tones.
const FEAT_STATUS = {
  planning: 'Planning…',
  plan_review: 'Awaiting plan approval',
  plan_failed: 'Plan failed',
  running: 'Building',
  complete: 'Complete ✅',
};
const FEAT_TONE = {
  planning: 'bg-blue-50 text-blue-700',
  plan_review: 'bg-amber-50 text-amber-700',
  plan_failed: 'bg-rose-50 text-rose-700',
  running: 'bg-blue-50 text-blue-700',
  complete: 'bg-green-50 text-green-700',
};
const STEP_STATUS = {
  proposed: 'Proposed', pending: 'Queued', running: 'Building', built: 'Built (not deployed)',
  failed: 'Failed', done: 'Done',
};
const STEP_TONE = {
  proposed: 'bg-slate-100 text-slate-600', pending: 'bg-slate-100 text-slate-600',
  running: 'bg-blue-50 text-blue-700', built: 'bg-indigo-50 text-indigo-700',
  failed: 'bg-rose-50 text-rose-700', done: 'bg-green-50 text-green-700',
};

// One paid / cost / margin line (everything already in INR). Mirrors TaskPnL but for the
// already-converted feature figures (planning COGS is converted server-side).
function MarginLine({ paidInr, costInr, label = null, className = '' }) {
  const paid = Number(paidInr) || 0;
  const cogs = Number(costInr) || 0;
  const margin = paid - cogs;
  const pct = paid > 0 ? Math.round((margin / paid) * 100) : cogs > 0 ? -100 : 0;
  return (
    <div className={`flex flex-wrap items-center gap-x-2 text-xs text-ink-soft ${className}`}>
      {label && <span className="font-medium text-ink">{label}</span>}
      <span>paid <span className="font-semibold text-ink">{formatINR(paid)}</span></span>
      <span>·</span>
      <span>our cost <span className="font-semibold text-ink">{inrPrecise(cogs)}</span></span>
      <span>·</span>
      <span className={margin >= 0 ? 'text-green-700' : 'text-rose-600'}>
        margin <span className="font-semibold">{inrPrecise(margin)}</span> ({pct}%)
      </span>
    </div>
  );
}

// "Plan a feature" — its OWN group in the admin, separate from the raw fix Sessions list. Pick an
// org (or all), and each feature shows its lifecycle, the planning (breakdown) charge + COGS, every
// step's status + paid/cost/margin, and the running total for the whole feature. Operator-only:
// the planning + step session traces deep-link to the Claude platform.
function Features({ orgs }) {
  const [orgId, setOrgId] = useState(''); // '' = not yet selected
  const [features, setFeatures] = useState([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const orgName = Object.fromEntries(orgs.map((o) => [o.id, o.name]));

  const load = async (id) => {
    if (!id) return;
    setBusy(true); setErr('');
    try {
      const { data } = await adminListFeatures(id === '*' ? {} : { orgId: id });
      setFeatures(data.features || []);
    } catch { setErr('Failed to load features.'); }
    finally { setBusy(false); }
  };

  // Refresh while anything is mid-flight so the breakdown tracks the poller's per-minute snapshots.
  useEffect(() => {
    const inFlight = features.some((f) => ['planning', 'running'].includes(f.status));
    if (!inFlight) return undefined;
    const t = setInterval(() => load(orgId), 30000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [features, orgId]);

  const pick = (id) => { setOrgId(id); load(id); };

  return (
    <section className="space-y-3 rounded-2xl border border-line bg-white p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-semibold text-ink">Plan a feature</h2>
        <button className="rounded-lg px-2.5 py-1 text-xs font-semibold text-brand-600 ring-1 ring-line transition hover:bg-brand-50 disabled:opacity-60"
          disabled={busy} onClick={() => load(orgId)}>Refresh</button>
      </div>
      <p className="text-xs text-ink-soft">
        Bigger asks broken into fix-sized steps. The breakdown (planning) is charged 2× its own cost
        up front; each step is then billed like a normal fix. Totals below are planning + every step.
      </p>
      <select className={field} value={orgId} onChange={(e) => pick(e.target.value)}>
        <option value="">Select organisation…</option>
        <option value="*">All organisations</option>
        {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
      </select>
      {err && <p className="text-sm text-bad">{err}</p>}
      {busy && features.length === 0 && <p className="text-sm text-ink-soft">Loading…</p>}
      {!busy && orgId && features.length === 0 && <p className="text-sm text-ink-soft">No features yet.</p>}

      <ul className="space-y-3">
        {features.map((f) => (
          <li key={f.id} className="rounded-xl border border-line p-3">
            <div className="flex items-start justify-between gap-3">
              <span className="font-medium text-ink">{f.prompt}</span>
              <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ${FEAT_TONE[f.status] || 'bg-slate-100 text-slate-600'}`}>
                {FEAT_STATUS[f.status] || f.status}
              </span>
            </div>
            <div className="mt-1 text-xs text-ink-soft">
              {orgId === '*' && f.orgId ? `${orgName[f.orgId] || f.orgId} · ` : ''}
              {f.createdAt ? new Date(f.createdAt).toLocaleString('en-IN') : ''}
              {f.userEmail ? ` · ${f.userEmail}` : ''}
              {f.stepCount ? ` · ${f.stepCount} step${f.stepCount === 1 ? '' : 's'}` : ''}
              {f.status === 'running' ? ` · on step ${Math.min(f.currentStep + 1, f.stepCount)} of ${f.stepCount}` : ''}
            </div>
            {f.error && <p className="mt-1 text-xs text-bad">error: {f.error}</p>}

            {/* Feature total — the headline P&L for the whole feature (planning + all steps). */}
            <div className="mt-2 rounded-lg bg-canvas/50 p-2">
              <MarginLine label="Total" paidInr={f.totalPaidInr} costInr={f.totalCostInr} />
              <div className="mt-1 text-[11px] text-ink-soft">
                Planning: paid <span className="font-semibold text-ink">{formatINR(f.planningChargeInr)}</span>
                {' · '}cost <span className="font-semibold text-ink">{inrPrecise(f.planningCostInr)}</span>
                {' '}({fmtUSD(f.planningCostUsd)})
                {f.planningSessionUrl && (
                  <a href={f.planningSessionUrl} target="_blank" rel="noreferrer" className="ml-2 font-semibold text-brand-600">plan session →</a>
                )}
              </div>
            </div>

            {/* Step-by-step breakdown. Before the plan is approved these are just proposals. */}
            {f.steps.length > 0 && (
              <ol className="mt-2 space-y-2">
                {f.steps.map((s, i) => (
                  <li key={i} className="rounded-lg border border-line/70 p-2 text-xs">
                    <div className="flex items-start justify-between gap-2">
                      <span className="font-medium text-ink">
                        {i + 1}. {s.title}
                        <span className="ml-1 rounded bg-slate-100 px-1 py-0.5 text-[10px] font-normal text-slate-600">{s.kind}</span>
                        {s.added && <span className="ml-1 rounded bg-violet-50 px-1 py-0.5 text-[10px] font-normal text-violet-700">added</span>}
                      </span>
                      <span className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold ${STEP_TONE[s.status] || 'bg-slate-100 text-slate-600'}`}>
                        {STEP_STATUS[s.status] || s.status}
                      </span>
                    </div>
                    {s.description && <p className="mt-0.5 text-ink-soft">{s.description}</p>}
                    {s.taskId && (s.status === 'running' || s.status === 'built' || s.status === 'done' || s.status === 'failed') && (
                      <MarginLine paidInr={s.paidInr} costInr={s.costInr} className="mt-1" />
                    )}
                    {s.summary && <p className="mt-0.5 text-ink-soft">{s.summary}</p>}
                    {s.error && <p className="mt-0.5 text-bad">error: {s.error}</p>}
                    {(s.prUrl || s.previewUrl || s.platformUrl) && (
                      <div className="mt-1 flex gap-3">
                        {s.prUrl && <a href={s.prUrl} target="_blank" rel="noreferrer" className="font-semibold text-brand-600">PR →</a>}
                        {s.previewUrl && <a href={s.previewUrl} target="_blank" rel="noreferrer" className="font-semibold text-brand-600">Preview →</a>}
                        {s.platformUrl && <a href={s.platformUrl} target="_blank" rel="noreferrer" className="font-semibold text-brand-600">Session →</a>}
                        {s.deployedTesting && <span className="font-medium text-green-700">✓ testing</span>}
                        {s.deployedProd && <span className="font-medium text-green-700">✓ live</span>}
                      </div>
                    )}
                  </li>
                ))}
              </ol>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

// Plain-English lifecycle labels for a "Design a screen" design + the badge tones.
// After mock approval a design is handed off to a feature, so its later lifecycle mirrors the
// feature's (plan_review → running → complete).
const DESIGN_STATUS = {
  clarifying: 'Clarifying…',
  mockup_review: 'Awaiting mock approval',
  plan_review: 'Awaiting plan approval',
  running: 'Building',
  complete: 'Complete ✅',
  failed: 'Failed',
};
const DESIGN_TONE = {
  clarifying: 'bg-blue-50 text-blue-700',
  mockup_review: 'bg-amber-50 text-amber-700',
  plan_review: 'bg-amber-50 text-amber-700',
  running: 'bg-blue-50 text-blue-700',
  complete: 'bg-green-50 text-green-700',
  failed: 'bg-rose-50 text-rose-700',
};

// "Design a screen" — its OWN group in the admin, separate from the raw fix Sessions list (mirrors
// Plan a feature). Pick an org (or all). Each design shows its lifecycle, the design-phase charge +
// COGS (priceForDesign, charged when a mock is ready), and — once approved — the build's
// paid/cost/margin, plus a running total. Operator-only: the clarify + build session traces + mock.
function Designs({ orgs }) {
  const [orgId, setOrgId] = useState(''); // '' = not yet selected
  const [designs, setDesigns] = useState([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const orgName = Object.fromEntries(orgs.map((o) => [o.id, o.name]));

  const load = async (id) => {
    if (!id) return;
    setBusy(true); setErr('');
    try {
      const { data } = await adminListDesigns(id === '*' ? {} : { orgId: id });
      setDesigns(data.designs || []);
    } catch (e) {
      console.error('adminListDesigns failed:', e);
      setErr(`Failed to load designs.${e?.message ? ` (${e.message})` : ''}`);
    }
    finally { setBusy(false); }
  };

  // Refresh while anything is mid-flight so the breakdown tracks the poller's per-minute snapshots.
  useEffect(() => {
    const inFlight = designs.some((d) => ['clarifying', 'running'].includes(d.status));
    if (!inFlight) return undefined;
    const t = setInterval(() => load(orgId), 30000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [designs, orgId]);

  const pick = (id) => { setOrgId(id); load(id); };

  return (
    <section className="space-y-3 rounded-2xl border border-line bg-white p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-semibold text-ink">Design a screen</h2>
        <button className="rounded-lg px-2.5 py-1 text-xs font-semibold text-brand-600 ring-1 ring-line transition hover:bg-brand-50 disabled:opacity-60"
          disabled={busy} onClick={() => load(orgId)}>Refresh</button>
      </div>
      <p className="text-xs text-ink-soft">
        A new screen previewed as a live mock the owner approves before any build. The design phase is
        charged when the mock is ready; the build after approval is billed like a normal fix. Totals
        below are the design phase + the build.
      </p>
      <select className={field} value={orgId} onChange={(e) => pick(e.target.value)}>
        <option value="">Select organisation…</option>
        <option value="*">All organisations</option>
        {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
      </select>
      {err && <p className="text-sm text-bad">{err}</p>}
      {busy && designs.length === 0 && <p className="text-sm text-ink-soft">Loading…</p>}
      {!busy && orgId && designs.length === 0 && <p className="text-sm text-ink-soft">No designs yet.</p>}

      <ul className="space-y-3">
        {designs.map((d) => (
          <li key={d.id} className="rounded-xl border border-line p-3">
            <div className="flex items-start justify-between gap-3">
              <span className="font-medium text-ink">{d.prompt}</span>
              <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ${DESIGN_TONE[d.status] || 'bg-slate-100 text-slate-600'}`}>
                {DESIGN_STATUS[d.status] || d.status}
              </span>
            </div>
            <div className="mt-1 text-xs text-ink-soft">
              {orgId === '*' && d.orgId ? `${orgName[d.orgId] || d.orgId} · ` : ''}
              {d.createdAt ? new Date(d.createdAt).toLocaleString('en-IN') : ''}
              {d.userEmail ? ` · ${d.userEmail}` : ''}
            </div>
            {d.error && <p className="mt-1 text-xs text-bad">error: {d.error}</p>}

            {/* Design total — the headline P&L for the whole design (design phase + build). */}
            <div className="mt-2 rounded-lg bg-canvas/50 p-2">
              <MarginLine label="Total" paidInr={d.totalPaidInr} costInr={d.totalCostInr} />
              <div className="mt-1 text-[11px] text-ink-soft">
                Design phase: paid <span className="font-semibold text-ink">{formatINR(d.designChargeInr)}</span>
                {' · '}cost <span className="font-semibold text-ink">{inrPrecise(d.designCostInr)}</span>
                {' '}({fmtUSD(d.designCostUsd)})
                {d.designSessionUrl && (
                  <a href={d.designSessionUrl} target="_blank" rel="noreferrer" className="ml-2 font-semibold text-brand-600">design session →</a>
                )}
                {d.mockUrl && (
                  <a href={d.mockUrl} target="_blank" rel="noreferrer" className="ml-2 font-semibold text-brand-600">mock →</a>
                )}
              </div>
            </div>

            {/* The build only exists once the owner approved the mock — a normal bracketed fix. */}
            {d.buildStatus && (
              <div className="mt-2 rounded-lg border border-line/70 p-2 text-xs">
                <div className="flex items-start justify-between gap-2">
                  <span className="font-medium text-ink">Build</span>
                  <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-600">{d.buildStatus}</span>
                </div>
                <MarginLine paidInr={d.buildPaidInr} costInr={d.buildCostInr} className="mt-1" />
                {(d.buildPrUrl || d.buildPreviewUrl || d.buildSessionUrl) && (
                  <div className="mt-1 flex gap-3">
                    {d.buildPrUrl && <a href={d.buildPrUrl} target="_blank" rel="noreferrer" className="font-semibold text-brand-600">PR →</a>}
                    {d.buildPreviewUrl && <a href={d.buildPreviewUrl} target="_blank" rel="noreferrer" className="font-semibold text-brand-600">Preview →</a>}
                    {d.buildSessionUrl && <a href={d.buildSessionUrl} target="_blank" rel="noreferrer" className="font-semibold text-brand-600">Session →</a>}
                    {d.deployedTesting && <span className="font-medium text-green-700">✓ testing</span>}
                    {d.deployedProd && <span className="font-medium text-green-700">✓ live</span>}
                  </div>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

// Plain-English lifecycle labels for a "Chat & build" session + the badge tones.
const CHAT_STATUS = {
  clarifying: 'Clarifying…',
  ready_to_build: 'Ready to build',
  previewing: 'Previewing mock',
  building: 'Building',
  complete: 'Complete ✅',
  failed: 'Failed',
};
const CHAT_TONE = {
  clarifying: 'bg-blue-50 text-blue-700',
  ready_to_build: 'bg-amber-50 text-amber-700',
  previewing: 'bg-amber-50 text-amber-700',
  building: 'bg-blue-50 text-blue-700',
  complete: 'bg-green-50 text-green-700',
  failed: 'bg-rose-50 text-rose-700',
};

// "Chat & build" — its OWN group in the admin, separate from the raw fix Sessions list (mirrors
// Plan a feature / Design a screen). Pick an org (or all). Each chat is one warm session that
// clarifies then builds, billed ONCE when the build completes. Shows the lifecycle, the single
// charge + COGS/margin, and — operator-only — the session trace + PR + mock + preview links.
function Chats({ orgs }) {
  const [orgId, setOrgId] = useState(''); // '' = not yet selected
  const [chats, setChats] = useState([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const orgName = Object.fromEntries(orgs.map((o) => [o.id, o.name]));

  const load = async (id) => {
    if (!id) return;
    setBusy(true); setErr('');
    try {
      const { data } = await adminListChats(id === '*' ? {} : { orgId: id });
      setChats(data.chats || []);
    } catch (e) {
      console.error('adminListChats failed:', e);
      setErr(`Failed to load chats.${e?.message ? ` (${e.message})` : ''}`);
    }
    finally { setBusy(false); }
  };

  // Refresh while anything is mid-flight so the breakdown tracks the poller's per-minute snapshots.
  useEffect(() => {
    const inFlight = chats.some((c) => ['clarifying', 'building', 'previewing'].includes(c.status));
    if (!inFlight) return undefined;
    const t = setInterval(() => load(orgId), 30000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chats, orgId]);

  const pick = (id) => { setOrgId(id); load(id); };

  return (
    <section className="space-y-3 rounded-2xl border border-line bg-white p-5">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-semibold text-ink">Chat &amp; build</h2>
        <button className="rounded-lg px-2.5 py-1 text-xs font-semibold text-brand-600 ring-1 ring-line transition hover:bg-brand-50 disabled:opacity-60"
          disabled={busy} onClick={() => load(orgId)}>Refresh</button>
      </div>
      <p className="text-xs text-ink-soft">
        One warm session that chats to clarify, then builds. The whole session is billed once (3× its
        own cost, capped) when the build completes — nothing before then.
      </p>
      <select className={field} value={orgId} onChange={(e) => pick(e.target.value)}>
        <option value="">Select organisation…</option>
        <option value="*">All organisations</option>
        {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
      </select>
      {err && <p className="text-sm text-bad">{err}</p>}
      {busy && chats.length === 0 && <p className="text-sm text-ink-soft">Loading…</p>}
      {!busy && orgId && chats.length === 0 && <p className="text-sm text-ink-soft">No chats yet.</p>}

      <ul className="space-y-3">
        {chats.map((c) => (
          <li key={c.id} className="rounded-xl border border-line p-3">
            <div className="flex items-start justify-between gap-3">
              <span className="font-medium text-ink">{c.prompt}</span>
              <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ${CHAT_TONE[c.status] || 'bg-slate-100 text-slate-600'}`}>
                {CHAT_STATUS[c.status] || c.status}
              </span>
            </div>
            <div className="mt-1 text-xs text-ink-soft">
              {orgId === '*' && c.orgId ? `${orgName[c.orgId] || c.orgId} · ` : ''}
              {c.createdAt ? new Date(c.createdAt).toLocaleString('en-IN') : ''}
              {c.userEmail ? ` · ${c.userEmail}` : ''}
              {c.turnCount ? ` · ${c.turnCount} message${c.turnCount === 1 ? '' : 's'}` : ''}
            </div>
            {c.summary && <p className="mt-1 text-xs text-ink-soft">{c.summary}</p>}
            {c.error && <p className="mt-1 text-xs text-bad">error: {c.error}</p>}

            {/* The single charge + its COGS/margin (billed once, at build completion). */}
            <div className="mt-2 rounded-lg bg-canvas/50 p-2">
              <MarginLine label="Total" paidInr={c.paidInr} costInr={c.costInr} />
              <div className="mt-1 text-[11px] text-ink-soft">
                cost <span className="font-semibold text-ink">{inrPrecise(c.costInr)}</span>
                {' '}({fmtUSD(c.costUsd)})
              </div>
            </div>

            {(c.prUrl || c.previewUrl || c.mockUrl || c.sessionUrl) && (
              <div className="mt-2 flex gap-3 text-xs">
                {c.prUrl && <a href={c.prUrl} target="_blank" rel="noreferrer" className="font-semibold text-brand-600">PR →</a>}
                {c.previewUrl && <a href={c.previewUrl} target="_blank" rel="noreferrer" className="font-semibold text-brand-600">Preview →</a>}
                {c.mockUrl && <a href={c.mockUrl} target="_blank" rel="noreferrer" className="font-semibold text-brand-600">Mock →</a>}
                {c.sessionUrl && <a href={c.sessionUrl} target="_blank" rel="noreferrer" className="font-semibold text-brand-600">Session →</a>}
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

export default function Admin() {
  const [orgs, setOrgs] = useState([]);
  const [metrics, setMetrics] = useState(null);
  const [metricsBusy, setMetricsBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [newOrg, setNewOrg] = useState('');
  const [credit, setCredit] = useState({ orgId: '', amount: '' });
  const [deduct, setDeduct] = useState({ orgId: '', amount: '', description: '' });
  const [assign, setAssign] = useState({ email: '', orgId: '' });
  const [gh, setGh] = useState({ orgId: '', repoFullName: '', token: '', baseBranch: 'main', deployHost: 'vercel', testingProject: '', prodProject: '', testingUrl: '' });
  const [test, setTest] = useState({ orgId: '', prompt: '', asCustomer: true, model: 'auto' });
  const [taskId, setTaskId] = useState(null);
  const [task, setTask] = useState(null);
  const [sessOrg, setSessOrg] = useState('');
  const [sessions, setSessions] = useState([]);
  const [deployFor, setDeployFor] = useState(null);
  const [quoteFor, setQuoteFor] = useState(null);
  const [quoteAmt, setQuoteAmt] = useState('');
  const [quoteBudget, setQuoteBudget] = useState('');
  const { images: testImages, imgErr: testImgErr, dragging: testDragging, setDragging: setTestDragging,
    addFiles: addTestFiles, removeImage: removeTestImage, reset: resetTestImages } = useImageAttachments();

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
  const loadMetrics = async () => {
    setMetricsBusy(true);
    try { const { data } = await adminMetrics(); setMetrics(data); }
    catch { /* keep the last snapshot; the orgs error already surfaces auth issues */ }
    finally { setMetricsBusy(false); }
  };
  useEffect(() => { refresh(); loadMetrics(); }, []);
  useEffect(() => {
    if (!taskId) return undefined;
    return onSnapshot(taskDocRef(taskId), (s) => setTask(s.exists() ? { id: s.id, ...s.data() } : null));
  }, [taskId]);

  // Auto-refresh the sessions list every 30s while any row is in-flight, so the
  // RunProgress meter picks up the poller's per-minute snapshots without the admin
  // having to re-select the org.
  useEffect(() => {
    if (!sessOrg) return undefined;
    const inFlight = sessions.some((t) => t.status === 'running' || t.status === 'queued');
    if (!inFlight) return undefined;
    const id = setInterval(async () => {
      try {
        const { data } = await adminListTasks({ orgId: sessOrg });
        setSessions(data.tasks || []);
      } catch { /* silent — manual refresh still works */ }
    }, 30000);
    return () => clearInterval(id);
  }, [sessOrg, sessions]);

  const run = async (fn, ok) => {
    setBusy(true); setErr(''); setMsg('');
    try { await fn(); setMsg(ok); await refresh(); loadMetrics(); }
    catch (e) { setErr(e?.message || 'Failed.'); }
    finally { setBusy(false); }
  };

  const deploy = async (fn, ok) => {
    setBusy(true); setErr(''); setMsg('');
    try { await fn(); setMsg(ok); await loadSessions(sessOrg); loadMetrics(); }
    catch (e) { setErr(e?.message || 'Deploy failed.'); }
    finally { setBusy(false); }
  };

  const onRun = async () => {
    setBusy(true); setErr(''); setTaskId(null); setTask(null);
    try {
      const { data } = await adminRunFix({
        orgId: test.orgId,
        prompt: test.prompt.trim(),
        asCustomer: test.asCustomer,
        // Operator model override — omitted ('auto') means the normal cost-aware routing.
        model: test.model !== 'auto' ? test.model : undefined,
        images: testImages.map((i) => ({ mediaType: i.mediaType, data: i.data })),
      });
      setTaskId(data.taskId);
      resetTestImages();
    } catch (e) {
      const m = String(e?.message || '');
      setErr(m.includes('NO_REPO_CONNECTED') ? 'That org has no repo connected.'
        : 'Could not start the fix.');
    } finally { setBusy(false); }
  };

  const connectedOrgs = orgs.filter((o) => o.repo);

  // Sessions = standalone fixes only. Design clarify/planning sessions and the design build, plus
  // feature steps, get their own groups above (Design a screen / Plan a feature), so drop them here.
  const fixSessions = sessions.filter(
    (t) => t.kind !== 'design' && t.kind !== 'planning' && !t.designId && !t.featureId,
  );

  return (
    <div className="page-bg min-h-screen">
      <Navbar balance={null} />
      <main className="mx-auto max-w-3xl space-y-5 px-4 py-6">
        <h1 className="text-xl font-bold text-ink">Admin — organisations &amp; credits</h1>
        {msg && <p className="rounded-xl bg-green-50 px-4 py-2 text-sm text-green-700">{msg}</p>}
        {err && <p className="rounded-xl bg-rose-50 px-4 py-2 text-sm text-bad">{err}</p>}

        <Overview data={metrics} busy={metricsBusy} onRefresh={loadMetrics} />

        <SourcingOverview data={metrics?.sourcing} />

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
          <select className={field} value={credit.orgId} onChange={(e) => setCredit({ ...credit, orgId: e.target.value })}>
            <option value="">Select organisation…</option>
            {orgs.map((o) => <option key={o.id} value={o.id}>{o.name} — {formatINR(o.balance)}</option>)}
          </select>
          <input className={field} type="number" value={credit.amount} onChange={(e) => setCredit({ ...credit, amount: e.target.value })} placeholder="amount (₹)" />
          <button className={btn} disabled={busy || !credit.orgId || !credit.amount} onClick={() => run(() => adminAddCredits({ orgId: credit.orgId.trim(), amount: Number(credit.amount) }), 'Credits added.')}>Add credits</button>
        </section>

        <section className="space-y-2 rounded-2xl border border-line bg-white p-5">
          <h2 className="font-semibold text-ink">Deduct credits</h2>
          <p className="text-xs text-ink-soft">Balance is allowed to go negative. Use this for refunds-in-reverse, fee corrections, or adjustments.</p>
          <select className={field} value={deduct.orgId} onChange={(e) => setDeduct({ ...deduct, orgId: e.target.value })}>
            <option value="">Select organisation…</option>
            {orgs.map((o) => <option key={o.id} value={o.id}>{o.name} — {formatINR(o.balance)}</option>)}
          </select>
          <input className={field} type="number" value={deduct.amount} onChange={(e) => setDeduct({ ...deduct, amount: e.target.value })} placeholder="amount (₹)" />
          <input className={field} value={deduct.description} onChange={(e) => setDeduct({ ...deduct, description: e.target.value })} placeholder="reason (recorded in ledger)" />
          <button
            className={btn}
            disabled={busy || !deduct.orgId || !deduct.amount || !deduct.description.trim()}
            onClick={() => run(
              () => adminDeductCredits({
                orgId: deduct.orgId.trim(),
                amount: Number(deduct.amount),
                description: deduct.description.trim(),
              }).then(() => setDeduct({ orgId: '', amount: '', description: '' })),
              'Credits deducted.'
            )}
          >
            Deduct credits
          </button>
        </section>

        <Ledger orgs={orgs} />

        <section className="space-y-2 rounded-2xl border border-line bg-white p-5">
          <h2 className="font-semibold text-ink">Assign user to organisation</h2>
          <input className={field} type="email" value={assign.email} onChange={(e) => setAssign({ ...assign, email: e.target.value })} placeholder="user email" />
          <select className={field} value={assign.orgId} onChange={(e) => setAssign({ ...assign, orgId: e.target.value })}>
            <option value="">Select organisation…</option>
            {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
          <button className={btn} disabled={busy || !assign.email || !assign.orgId} onClick={() => run(() => adminSetUserOrg({ email: assign.email.trim(), orgId: assign.orgId }), 'User assigned (they must sign out/in to see it).')}>Assign</button>
        </section>

        <DeployAccess orgs={orgs} />

        <GstReports />

        <section className="space-y-2 rounded-2xl border border-line bg-white p-5">
          <h2 className="font-semibold text-ink">Connect GitHub repo</h2>
          <p className="text-xs text-ink-soft">owner/repo + a token (Contents RW + Pull requests RW; add Workflows RW for a Firebase host). Stored backend-only; sets up the org’s MCP vault.</p>
          <select className={field} value={gh.orgId} onChange={(e) => setGh({ ...gh, orgId: e.target.value })}>
            <option value="">Select organisation…</option>
            {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}{o.repo ? ` — ${o.repo}` : ''}</option>)}
          </select>
          <input className={field} value={gh.repoFullName} onChange={(e) => setGh({ ...gh, repoFullName: e.target.value })} placeholder="owner/repo" />
          <input className={field} value={gh.token} onChange={(e) => setGh({ ...gh, token: e.target.value })} placeholder="GitHub token (github_pat_… / ghp_…)" />
          <div className="flex gap-2">
            <input className={field} value={gh.baseBranch} onChange={(e) => setGh({ ...gh, baseBranch: e.target.value })} placeholder="base branch (default main)" />
            <select className={field} value={gh.deployHost} onChange={(e) => setGh({ ...gh, deployHost: e.target.value })}>
              <option value="vercel">Vercel host (auto preview)</option>
              <option value="firebase">Firebase host (preview/revert)</option>
            </select>
          </div>
          {gh.deployHost === 'firebase' && (
            <div className="space-y-2 rounded-xl bg-canvas p-3">
              <p className="text-xs text-ink-soft">Firebase Hosting: project ids the repo’s workflow deploys to, and the testing site URL shown to the owner. Seed <code>bosun-deploy-testing.yml</code> + <code>bosun-deploy-prod.yml</code> and a <code>FIREBASE_SERVICE_ACCOUNT</code> secret into the repo.</p>
              <div className="flex gap-2">
                <input className={field} value={gh.testingProject} onChange={(e) => setGh({ ...gh, testingProject: e.target.value })} placeholder="testing project id" />
                <input className={field} value={gh.prodProject} onChange={(e) => setGh({ ...gh, prodProject: e.target.value })} placeholder="production project id" />
              </div>
              <input className={field} value={gh.testingUrl} onChange={(e) => setGh({ ...gh, testingUrl: e.target.value })} placeholder="testing site URL (https://…web.app)" />
            </div>
          )}
          <button
            className={btn}
            disabled={busy || !gh.orgId || !gh.repoFullName || !gh.token || (gh.deployHost === 'firebase' && (!gh.testingProject.trim() || !gh.prodProject.trim()))}
            onClick={() => run(() => adminSetGithubRepo({
              orgId: gh.orgId.trim(),
              repoFullName: gh.repoFullName.trim(),
              token: gh.token.trim(),
              baseBranch: (gh.baseBranch.trim() || 'main'),
              deployHost: gh.deployHost,
              ...(gh.deployHost === 'firebase' ? { firebase: { testingProject: gh.testingProject.trim(), prodProject: gh.prodProject.trim(), testingUrl: gh.testingUrl.trim() } } : {}),
            }).then(() => setGh({ orgId: '', repoFullName: '', token: '', baseBranch: 'main', deployHost: 'vercel', testingProject: '', prodProject: '', testingUrl: '' })), 'GitHub repo connected.')}
          >Connect repo</button>
        </section>


        <FigmaConnect orgs={orgs} />

        <section className="space-y-2 rounded-2xl border border-brand-500 bg-brand-50/40 p-5">
          <h2 className="font-semibold text-ink">Test a fix</h2>
          <p className="text-xs text-ink-soft">Pick a connected org, describe the issue, then run — opens a real PR on its repo.</p>
          <select className={field} value={test.orgId} onChange={(e) => { setTest({ ...test, orgId: e.target.value }); setTaskId(null); setTask(null); }}>
            <option value="">Select organisation…</option>
            {connectedOrgs.map((o) => <option key={o.id} value={o.id}>{o.name} — {o.repo}</option>)}
          </select>
          <ScreenshotComposer
            value={test.prompt}
            onChange={(v) => setTest({ ...test, prompt: v })}
            placeholder="Describe the issue, e.g. The menu disappears on mobile phone"
            images={testImages}
            imgErr={testImgErr}
            dragging={testDragging}
            setDragging={setTestDragging}
            addFiles={addTestFiles}
            removeImage={removeTestImage}
          />
          <label className="flex items-center gap-2 text-xs text-ink-soft">
            <input type="checkbox" checked={test.asCustomer} onChange={(e) => setTest({ ...test, asCustomer: e.target.checked })} />
            Run as customer (real classification, fixed-tier pricing, big-job quote flow)
          </label>
          <label className="flex items-center gap-2 text-xs text-ink-soft">
            <span>Model</span>
            <select
              className="rounded-lg border border-line px-2 py-1 text-xs"
              value={test.model}
              onChange={(e) => setTest({ ...test, model: e.target.value })}
            >
              <option value="auto">Auto (default routing)</option>
              <option value="sonnet">Sonnet (force)</option>
              <option value="opus">Opus (force)</option>
            </select>
            <span className="text-ink-soft/70">override the model for this run</span>
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

        <Features orgs={orgs} />

        <Designs orgs={orgs} />

        <Chats orgs={orgs} />

        <section className="space-y-3 rounded-2xl border border-line bg-white p-5">
          <div className="flex items-center justify-between gap-3">
            <h2 className="font-semibold text-ink">Sessions</h2>
            <button className="rounded-lg px-2.5 py-1 text-xs font-semibold text-brand-600 ring-1 ring-line transition hover:bg-brand-50 disabled:opacity-60"
              disabled={!sessOrg} onClick={() => loadSessions(sessOrg)}>Refresh</button>
          </div>
          <select className={field} value={sessOrg} onChange={(e) => loadSessions(e.target.value)}>
            <option value="">Select organisation…</option>
            {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
          </select>
          <p className="text-xs text-ink-soft">Standalone fixes. Designs and feature steps live in their own groups above.</p>
          {sessOrg && fixSessions.length === 0 && <p className="text-sm text-ink-soft">No sessions yet.</p>}
          <ul className="space-y-2">
            {fixSessions.map((t) => (
              <li key={t.id} className="rounded-lg border border-line p-3 text-sm">
                <div className="flex items-start justify-between gap-3">
                  <span className="font-medium text-ink">{t.prompt}</span>
                  <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold ${TONE[t.status] || 'bg-slate-100 text-slate-600'}`}>
                    {t.status}
                  </span>
                </div>
                <div className="mt-1 text-ink-soft">
                  {t.createdAt ? new Date(t.createdAt).toLocaleString('en-IN') : ''}
                  {t.model ? ` · ${t.model}${t.modelOverride ? ' (forced)' : ''}` : ''}
                  {t.userEmail ? ` · ${t.userEmail}` : ''}
                </div>
                {t.sessionId && <div className="mt-0.5 font-mono text-[10px] text-ink-soft/80">{t.sessionId}</div>}
                <TaskPnL status={t.status} finalCharge={t.finalCharge} actualCostInr={t.actualCostInr} className="mt-0.5" />
                <RunProgress task={t} />
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
                  {t.platformUrl && <a href={t.platformUrl} target="_blank" rel="noreferrer" className="font-semibold text-brand-600">Session →</a>}
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
                          onClick={() => { if (window.confirm('Tag a release → PRODUCTION? The repo’s Actions deploy it (vercel --prod + firebase).')) { setDeployFor(null); deploy(() => deployProd({ taskId: t.id }), 'Tagged a release → production deploy started.'); } }}>
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
