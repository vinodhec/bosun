/**
 * Operator-only: the property-sourcing relay's audit trail.
 *
 * Answers the two questions the funnel counters exist for — "what did we source?" and "why did so
 * few leads land?" — at three depths:
 *   Runs   — every cron/manual run, its targets, and the whole funnel from SERP fetch to webhook.
 *   Leads  — for one run, the URL-level drill-down: which query found it, which gate killed it.
 *   Ledger — the historical relayed/dropped store, which predates the run recorder.
 *
 * This is the Admin panel, exempt from the customer-facing UI language rules — the operator needs
 * the real vocabulary (query, classify, enrich, webhook), not plain phrasing.
 */
import { useEffect, useState } from 'react';
import { adminSourcingRuns, adminSourcingRunDetail, adminSourcingLeadLedger, adminSourceTopTarget, adminRunSourcingNow, adminPlanNow, adminSourcingRelayLead } from '../firebase/functions.js';
import { formatINR } from '@shared/currency.js';

const btn = 'rounded-lg bg-brand-600 px-3 py-1.5 text-sm font-semibold text-white transition hover:bg-brand-700 disabled:opacity-60';
const btnGhost = 'rounded-lg border border-line px-3 py-1.5 text-sm font-medium text-ink transition hover:bg-canvas disabled:opacity-60';

const when = (ms) => (ms ? new Date(ms).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }) : '—');
const day = (ms) => (ms ? new Date(ms).toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: 'numeric', month: 'short', year: '2-digit' }) : '—');
const dur = (ms) => (ms == null ? '—' : ms < 1000 ? `${ms}ms` : ms < 60000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`);

/**
 * The funnel, in pipeline order. `kind` drives the colour and is the difference between reading a
 * run right and reading it backwards:
 *   drop  — a lead we LOST. Red, because it's the only band worth chasing.
 *   defer — deliberately left for the next run. Amber: not a loss, it relays later.
 *   known — a listing we already have (dedup). Neutral: on a mature locality this is SUPPOSED to
 *           dominate, and painting it red would make working dedup look like mass lead loss.
 *   stage — a plain checkpoint count.
 */
const FUNNEL_STEPS = [
  { key: 'fetched', label: 'Fetched from Google', kind: 'stage', hint: 'Raw SERP results across every query for this run.' },
  { key: 'posts', label: 'Individual posts', kind: 'stage', hint: 'Survived the URL filter — real listings, not group/page landing pages.' },
  { key: 'dupInRun', label: 'Duplicate in run', kind: 'known', hint: 'Two queries returned the same listing. Not a loss — just query overlap.' },
  { key: 'seenBefore', label: 'Already have it', kind: 'known', hint: 'Dedup-forever hit — relayed or binned on an earlier run. Expected to dominate on a mature locality; this is dedup working, not lost leads.' },
  { key: 'newProspects', label: 'New prospects', kind: 'stage', hint: 'Genuinely new listings entering the vetting gates.' },
  { key: 'serpStaleSkipped', label: 'Skipped: SERP date', kind: 'drop', hint: 'Google reported it as clearly older than the window — skipped before paying to scrape. Retryable.' },
  { key: 'noSignalDropped', label: 'Dropped: no signal', kind: 'drop', hint: 'Our cheap property-signal filter found nothing property-like in the snippet. Retryable.' },
  { key: 'offTargetDropped', label: 'Dropped: off-target', kind: 'drop', hint: 'Gemini confidently rejected it — wrong locality or not a listing. Permanent (never re-scraped). With sourcing.offTargetLeads on, confident wrong-locality LISTINGS relay tagged instead of landing here.' },
  { key: 'buyerDropped', label: 'Dropped: buyer post', kind: 'drop', hint: 'A genuine "wanted / looking for" post, but the org hasn’t opted into buyer leads (sourcing.buyerLeads). Retryable — flipping the flag catches posts still live.' },
  { key: 'degradedDropped', label: 'Dropped: classifier down', kind: 'drop', hint: 'Classifier errored AND no India signal. A spike here is an incident, not a dry locality. Retryable.' },
  { key: 'localityPending', label: 'Locality unknown → full text', kind: 'stage', hint: 'A genuine listing whose SERP text named NO place (truncated title / adjacent-post snippet). Not judged yet — enriched and re-classified on the full post text.' },
  { key: 'poolDeferred', label: 'Deferred: enrich pool', kind: 'defer', hint: 'Vetted but over this run’s enrich pool. Not marked seen — the next run picks it up.' },
  { key: 'enriched', label: 'Enriched (paid scrape)', kind: 'stage', hint: 'Facebook post scrapes actually paid for. This is the Apify bill.' },
  { key: 'enrichMissed', label: 'Enrich returned nothing', kind: 'drop', hint: 'Paid the scrape and got nothing back. The lead survives on its SERP snippet — this is pure Apify waste.' },
  { key: 'fullTextConfirmed', label: 'Confirmed by full post', kind: 'stage', hint: 'The full FB text settled a locality-unknown lead — it proceeds like any verified lead.' },
  { key: 'fullTextDropped', label: 'Dropped: full post off-target', kind: 'drop', hint: 'The full post text confidently placed it elsewhere (or showed it isn’t a listing). Permanent.' },
  { key: 'localityUnresolved', label: 'Dropped: still unknown', kind: 'drop', hint: 'Enrichment returned no text, so the locality never got judged. Retryable — never buried.' },
  { key: 'recencyDropped', label: 'Dropped: too old', kind: 'drop', hint: 'Real FB post date older than the org window. Permanent.' },
  { key: 'intentStaleDropped', label: 'Dropped: stale for intent', kind: 'drop', hint: 'Rent leads age out faster than sale leads. Permanent.' },
  { key: 'staleReadmitted', label: 'Re-admitted (stale fallback)', kind: 'stage', hint: 'Target had zero fresh leads, so its best stale ones were relayed anyway, badged stale.' },
  { key: 'capDeferred', label: 'Deferred: maxPerRun', kind: 'defer', hint: 'Fresh and vetted, but over the per-run cap. Not marked seen — relays next run.' },
  { key: 'relayAttempted', label: 'Relay attempted', kind: 'stage', hint: 'POSTed to the customer webhook.' },
  { key: 'relayFailed', label: 'Relay failed', kind: 'drop', hint: 'Webhook did not return 2xx. We paid everything and earned nothing — but it retries next run.' },
  { key: 'relayed', label: 'Relayed & billed', kind: 'win', hint: 'Delivered, marked seen, and charged to the org wallet.' },
  { key: 'buyerRelayed', label: '… of which buyer leads', kind: 'win', hint: 'Relayed with leadType "buyer" — a demand post ("wanted / looking for"), usually phone-less; the value is the post link + request text.' },
  { key: 'offTargetRelayed', label: '… of which off-target', kind: 'win', hint: 'Relayed with leadType "off-target" — a real listing outside the searched locality; its actual place rides in extracted.locality.' },
];

const KIND_CLS = {
  stage: 'text-ink',
  known: 'text-ink-soft',
  drop: 'text-rose-600',
  defer: 'text-amber-600',
  win: 'text-green-700',
};

const KIND_BAR = {
  stage: 'bg-brand-400',
  known: 'bg-slate-300',
  drop: 'bg-rose-400',
  defer: 'bg-amber-400',
  win: 'bg-green-500',
};

/** The funnel as a labelled bar chart — each stage scaled against the widest count in the run. */
function Funnel({ funnel }) {
  if (!funnel) return <p className="text-xs text-ink-soft">No funnel recorded.</p>;
  const rows = FUNNEL_STEPS.filter((s) => (funnel[s.key] || 0) > 0);
  if (!rows.length) return <p className="text-xs text-ink-soft">This run fetched nothing.</p>;
  const max = Math.max(...rows.map((s) => funnel[s.key] || 0), 1);
  return (
    <div className="space-y-1">
      {rows.map((s) => {
        const n = funnel[s.key] || 0;
        return (
          <div key={s.key} className="flex items-center gap-2" title={s.hint}>
            <div className="w-44 shrink-0 truncate text-[11px] text-ink-soft">{s.label}</div>
            <div className="h-3 flex-1 overflow-hidden rounded bg-canvas">
              <div
                className={`h-full rounded ${KIND_BAR[s.kind]}`}
                style={{ width: `${Math.max(2, (n / max) * 100)}%` }}
              />
            </div>
            <div className={`w-12 shrink-0 text-right text-[11px] font-semibold tabular-nums ${KIND_CLS[s.kind]}`}>{n}</div>
          </div>
        );
      })}
    </div>
  );
}

/** One target's leg — the queries Gemini built for it and what they yielded. */
function TargetLeg({ t }) {
  const [open, setOpen] = useState(false);
  const f = t.funnel || {};
  return (
    <div className="rounded-lg border border-line/70">
      <button type="button" onClick={() => setOpen((v) => !v)} className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left">
        <div className="min-w-0">
          <div className="truncate text-sm font-medium text-ink">
            {t.locality ? `${t.locality}${t.city ? `, ${t.city}` : ''}` : 'Static queries'}
            {t.shape && <span className="ml-2 text-[11px] font-normal text-ink-soft">{t.shape}</span>}
          </div>
          <div className="mt-0.5 text-[11px] text-ink-soft">
            {t.regionalLanguage && <span className="mr-2">{t.regionalLanguage}{t.regionalName ? ` · ${t.regionalName}` : ''}</span>}
            {(t.queries || []).length} quer{(t.queries || []).length === 1 ? 'y' : 'ies'} · {f.fetched || 0} fetched · {f.enriched || 0} scraped
            {t.ms ? ` · ${dur(t.ms)}` : ''}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className={`text-sm font-bold ${t.relayed > 0 ? 'text-green-700' : 'text-ink-soft'}`}>{t.relayed || 0}</span>
          <span className="text-[11px] text-ink-soft">{t.amountInr ? formatINR(t.amountInr) : '—'}</span>
          <span className="text-ink-soft">{open ? '▾' : '▸'}</span>
        </div>
      </button>
      {open && (
        <div className="space-y-3 border-t border-line/70 px-3 py-3">
          {t.note && <p className="rounded bg-amber-50 px-2 py-1 text-[11px] text-amber-800">{t.note}</p>}
          {(t.queries || []).length > 0 && (
            <div>
              <div className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-ink-soft">Queries run</div>
              <ul className="space-y-0.5">
                {t.queries.map((q, i) => (
                  <li key={i} className="rounded bg-canvas px-2 py-1 font-mono text-[11px] text-ink">{q}</li>
                ))}
              </ul>
            </div>
          )}
          <Funnel funnel={f} />
        </div>
      )}
    </div>
  );
}

const STAGE_BADGE = {
  relayed: 'bg-green-50 text-green-700',
  dropped: 'bg-rose-50 text-rose-600',
  deferred: 'bg-amber-50 text-amber-700',
};

/**
 * The URL-level table for one run. Dropped rows carry a "Relay & bill" override — the operator has
 * eyeballed the actual post, so their consent trumps the gate. It runs the REAL money path
 * (enrich → webhook → wallet debit), hence the confirm.
 */
function LeadTable({ leads, runId, onRelayed }) {
  const [filter, setFilter] = useState('all');
  const [relayingId, setRelayingId] = useState('');
  const [relayErr, setRelayErr] = useState('');
  const shown = filter === 'all' ? leads : leads.filter((l) => l.stage === filter);
  const counts = leads.reduce((m, l) => ({ ...m, [l.stage]: (m[l.stage] || 0) + 1 }), {});

  const relay = async (l) => {
    if (!window.confirm('Relay this lead to the org anyway? It scrapes the full post, delivers it through the normal webhook, and bills the org the standard per-lead price (~₹2.6).')) return;
    setRelayingId(l.id);
    setRelayErr('');
    try {
      await adminSourcingRelayLead({ runId, leadId: l.id });
      await onRelayed();
    } catch (e) {
      setRelayErr(e?.message || 'Relay failed. Nothing was billed.');
    } finally {
      setRelayingId('');
    }
  };
  return (
    <div>
      <div className="mb-2 flex flex-wrap gap-1.5">
        {['all', 'relayed', 'dropped', 'deferred'].map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            className={`rounded-full px-2.5 py-1 text-[11px] font-medium capitalize ${filter === f ? 'bg-brand-600 text-white' : 'border border-line text-ink-soft hover:bg-canvas'}`}
          >
            {f} ({f === 'all' ? leads.length : counts[f] || 0})
          </button>
        ))}
      </div>
      {relayErr && <p className="mb-2 rounded bg-rose-50 px-2 py-1 text-[11px] text-rose-700">{relayErr}</p>}
      {!shown.length ? (
        <p className="text-xs text-ink-soft">Nothing in this band.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-left text-[11px]">
            <thead>
              <tr className="border-b border-line text-ink-soft">
                <th className="py-1.5 pr-2 font-medium">Listing</th>
                <th className="py-1.5 pr-2 font-medium">Target</th>
                <th className="py-1.5 pr-2 font-medium">Posted</th>
                <th className="py-1.5 pr-2 font-medium">Outcome</th>
                <th className="py-1.5 font-medium">Why</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((l) => (
                <tr key={l.id} className="border-b border-line/50 align-top">
                  <td className="max-w-[280px] py-1.5 pr-2">
                    <a href={l.url} target="_blank" rel="noreferrer" className="block truncate font-medium text-brand-700 hover:underline" title={l.url}>
                      {l.title || l.url}
                    </a>
                    <div className="truncate text-ink-soft" title={l.snippet}>{l.snippet}</div>
                    <div className="mt-0.5 flex flex-wrap gap-1 text-[10px] text-ink-soft">
                      {l.listingType && <span className="rounded bg-canvas px-1">{l.listingType}</span>}
                      {l.propertyType && <span className="rounded bg-canvas px-1">{l.propertyType}</span>}
                      {l.priceText && <span className="rounded bg-canvas px-1">{l.priceText}</span>}
                      {l.hasPhone && <span className="rounded bg-canvas px-1">📞</span>}
                      {l.imageCount > 0 && <span className="rounded bg-canvas px-1">🖼 {l.imageCount}</span>}
                      {l.leadType === 'buyer' && <span className="rounded bg-sky-50 px-1 text-sky-700">buyer</span>}
                      {l.leadType === 'off-target' && <span className="rounded bg-violet-50 px-1 text-violet-700">off-target</span>}
                      {l.classifyStatus === 'unverified' && <span className="rounded bg-amber-50 px-1 text-amber-700">unverified</span>}
                      {l.freshness === 'stale-fallback' && <span className="rounded bg-amber-50 px-1 text-amber-700">stale fallback</span>}
                    </div>
                  </td>
                  <td className="py-1.5 pr-2 text-ink-soft">
                    <div>{l.locality || '—'}</div>
                    {l.query && <div className="mt-0.5 max-w-[160px] truncate font-mono text-[10px]" title={l.query}>{l.query}</div>}
                  </td>
                  <td className="py-1.5 pr-2 text-ink-soft">{l.postedAt ? day(l.postedAt) : '—'}</td>
                  <td className="py-1.5 pr-2">
                    <span className={`rounded px-1.5 py-0.5 font-medium ${STAGE_BADGE[l.stage] || ''}`}>{l.stage}</span>
                    {l.manual && <span className="ml-1 rounded bg-sky-50 px-1 py-0.5 text-[10px] text-sky-700" title="Relayed by the operator's override, not the pipeline">manual</span>}
                    {l.stage === 'dropped' && (
                      <button
                        type="button"
                        onClick={() => relay(l)}
                        disabled={!!relayingId}
                        className="mt-1 block rounded border border-line px-1.5 py-0.5 text-[10px] font-medium text-ink-soft hover:bg-canvas disabled:opacity-50"
                        title="Operator override: scrape the full post, relay it through the normal webhook, and bill the org the standard per-lead price."
                      >
                        {relayingId === l.id ? 'Relaying…' : 'Relay & bill'}
                      </button>
                    )}
                  </td>
                  <td className="py-1.5 text-ink-soft">
                    {l.dropStage ? <span className="font-medium text-ink">{l.dropStage}</span> : '—'}
                    {l.dropReason && <div className="mt-0.5">{l.dropReason}</div>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** One run row — collapsed to its headline, expanding into targets and (on demand) its leads.
 *  `autoOpen` starts it expanded with its lead table loading — used by the ?run=<id> deep link the
 *  platform's target console points at ("did this target really get sourced?"). */
function RunRow({ run, showOrg, autoOpen = false }) {
  const [open, setOpen] = useState(autoOpen);
  const [detail, setDetail] = useState(null);
  const [leadErr, setLeadErr] = useState('');
  const [busy, setBusy] = useState(false);

  // Keep the failure OUT of `detail` — parking it there made the empty-table branch render alongside
  // the error and hid the retry button behind `!detail`.
  // `reloadLeads` always refetches (a manual relay changed rows server-side); `loadLeads` is the
  // cheap first-open path that skips the round-trip when the table is already loaded.
  const reloadLeads = async () => {
    setBusy(true);
    setLeadErr('');
    try { const { data } = await adminSourcingRunDetail({ runId: run.id }); setDetail(data); }
    catch { setLeadErr('Failed to load listings.'); }
    finally { setBusy(false); }
  };
  const loadLeads = () => { if (!detail) reloadLeads(); };
  useEffect(() => { if (autoOpen && run.leadRows > 0) reloadLeads(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const f = run.funnel || {};
  const statusCls = run.status === 'error' || run.status === 'timeout' ? 'bg-rose-50 text-rose-600'
    : run.status === 'partial' ? 'bg-amber-50 text-amber-700'
    : run.status === 'running' ? 'bg-blue-50 text-blue-700' : 'bg-slate-100 text-slate-600';

  return (
    <div className="rounded-xl border border-line">
      <button type="button" onClick={() => setOpen((v) => !v)} className="flex w-full items-center justify-between gap-3 px-3 py-2.5 text-left">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-ink">{when(run.startedAtMs)}</span>
            <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${statusCls}`}>{run.status}</span>
            <span className="rounded bg-canvas px-1.5 py-0.5 text-[10px] text-ink-soft">{run.trigger}</span>
            {showOrg && <span className="truncate text-[11px] text-ink-soft">{run.orgName}</span>}
          </div>
          <div className="mt-0.5 text-[11px] text-ink-soft">
            {run.targetCount} target{run.targetCount === 1 ? '' : 's'} · {f.fetched || 0} fetched · {f.newProspects || 0} new · {f.enriched || 0} scraped · {dur(run.ms)}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-3 text-right">
          <div>
            <div className={`text-sm font-bold ${run.relayed > 0 ? 'text-green-700' : 'text-ink-soft'}`}>{run.relayed}</div>
            <div className="text-[10px] text-ink-soft">relayed</div>
          </div>
          <div>
            <div className="text-sm font-bold text-ink">{run.amountInr ? formatINR(run.amountInr) : '—'}</div>
            <div className="text-[10px] text-ink-soft">billed</div>
          </div>
          <span className="text-ink-soft">{open ? '▾' : '▸'}</span>
        </div>
      </button>

      {open && (
        <div className="space-y-3 border-t border-line px-3 py-3">
          {run.error && <p className="rounded bg-rose-50 px-2 py-1 text-[11px] text-rose-700">{run.error}</p>}
          {(run.notes || []).map((n, i) => (
            <p key={i} className="rounded bg-amber-50 px-2 py-1 text-[11px] text-amber-800">{n}</p>
          ))}

          {run.matrix && (
            <div className="rounded-lg bg-canvas/60 p-2 text-[11px] text-ink-soft">
              <span className="font-semibold text-ink">Demand matrix</span>{' '}
              — {run.matrix.targetsReturned} returned, {run.matrix.targetsChosen} sourced (topN {run.matrix.topN}, limit {run.matrix.limit})
              {run.matrix.dryRun && <span className="ml-1 rounded bg-amber-50 px-1 text-amber-700">dry run — cadence not advanced</span>}
              {run.matrix.targetsSkippedAsJunk > 0 && (
                <div className="mt-1 text-rose-600">
                  {run.matrix.targetsSkippedAsJunk} skipped as junk
                  {(run.matrix.junkExamples || []).length > 0 && `: ${run.matrix.junkExamples.join(', ')}`}
                </div>
              )}
              {run.matrix.policy && (
                <div className="mt-1">
                  Freshness policy — sale {run.matrix.policy.saleMonths}mo · rent {run.matrix.policy.rentMonths}mo · fallback {run.matrix.policy.fallbackMaxLeads}
                </div>
              )}
            </div>
          )}

          <div>
            <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-soft">Run funnel</div>
            <Funnel funnel={f} />
          </div>

          {(run.targets || []).length > 0 && (
            <div>
              <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-ink-soft">Targets</div>
              <div className="space-y-1.5">
                {run.targets.map((t, i) => <TargetLeg key={i} t={t} />)}
              </div>
            </div>
          )}

          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-ink-soft">
                Listings examined ({run.leadRows})
                {run.leadsTruncated && <span className="ml-1 font-normal normal-case text-amber-700">· capped at 2000, some rows not recorded</span>}
              </div>
              {!detail && run.leadRows > 0 && (
                <button type="button" className={btnGhost} onClick={loadLeads} disabled={busy}>
                  {busy ? 'Loading…' : leadErr ? 'Retry' : 'Show URLs'}
                </button>
              )}
            </div>
            {run.leadRows === 0 && <p className="text-xs text-ink-soft">No listing rows recorded for this run.</p>}
            {leadErr && <p className="text-xs text-bad">{leadErr}</p>}
            {detail?.leads && <LeadTable leads={detail.leads} runId={run.id} onRelayed={reloadLeads} />}
          </div>
        </div>
      )}
    </div>
  );
}

/** The historical ledger — everything terminal we know about, from before the run recorder existed. */
function LeadLedger({ orgs }) {
  const [orgId, setOrgId] = useState('');
  const [mode, setMode] = useState('relayed');
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);

  const load = async (id, m) => {
    if (!id) { setData(null); return; }
    setBusy(true);
    try { const { data: d } = await adminSourcingLeadLedger({ orgId: id, mode: m, limit: 200 }); setData(d); }
    catch { setData(null); }
    finally { setBusy(false); }
  };

  return (
    <div className="space-y-3">
      <p className="rounded-lg bg-canvas/60 px-2.5 py-2 text-[11px] text-ink-soft">
        The dedup-forever store — every listing that reached a final state. This is the only lead
        history from before the run recorder, so it has no target or query attribution, and it never
        saw the leads that were skipped before the paid scrape.
      </p>
      <div className="flex flex-wrap gap-2">
        <select
          className="rounded-lg border border-line px-3 py-1.5 text-sm"
          value={orgId}
          onChange={(e) => { setOrgId(e.target.value); load(e.target.value, mode); }}
        >
          <option value="">Select an organisation…</option>
          {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
        </select>
        {['relayed', 'dropped'].map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => { setMode(m); load(orgId, m); }}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium capitalize ${mode === m ? 'bg-brand-600 text-white' : 'border border-line text-ink-soft hover:bg-canvas'}`}
          >
            {m === 'dropped' ? 'Scraped then binned' : 'Relayed'}
          </button>
        ))}
      </div>

      {busy && <p className="text-xs text-ink-soft">Loading…</p>}
      {data && !busy && (
        <>
          {mode === 'dropped' && Object.keys(data.byReason || {}).length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {Object.entries(data.byReason).sort((a, b) => b[1] - a[1]).map(([r, n]) => (
                <span key={r} className="rounded-full bg-rose-50 px-2 py-0.5 text-[11px] text-rose-700">{r} · {n}</span>
              ))}
            </div>
          )}
          {!data.leads.length ? (
            <p className="text-xs text-ink-soft">Nothing recorded for this organisation.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-left text-[11px]">
                <thead>
                  <tr className="border-b border-line text-ink-soft">
                    <th className="py-1.5 pr-2 font-medium">Listing</th>
                    <th className="py-1.5 pr-2 font-medium">Posted</th>
                    <th className="py-1.5 pr-2 font-medium">{mode === 'dropped' ? 'Binned' : 'Relayed'}</th>
                    {mode === 'dropped' && <th className="py-1.5 font-medium">Why</th>}
                  </tr>
                </thead>
                <tbody>
                  {data.leads.map((l) => (
                    <tr key={l.key} className="border-b border-line/50">
                      <td className="max-w-[320px] py-1.5 pr-2">
                        <a href={l.url} target="_blank" rel="noreferrer" className="block truncate text-brand-700 hover:underline" title={l.url}>
                          {l.title || l.url}
                        </a>
                      </td>
                      <td className="py-1.5 pr-2 text-ink-soft">{l.postedAt ? day(l.postedAt) : '—'}</td>
                      <td className="py-1.5 pr-2 text-ink-soft">{when(l.atMs)}</td>
                      {mode === 'dropped' && <td className="py-1.5 text-rose-600">{l.dropReason || '—'}</td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="text-[10px] text-ink-soft">Showing the {data.leads.length} most recent.</p>
        </>
      )}
    </div>
  );
}

export default function SourcingRuns({ orgs }) {
  const [tab, setTab] = useState('runs');
  const [orgId, setOrgId] = useState('');
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [running, setRunning] = useState('');
  // Outcome of a manual "Plan today now". A skip or a wallet block is a SUCCESS response, not an
  // error, so it needs its own line — the operator must see which of the three things happened.
  const [planResult, setPlanResult] = useState(null);
  // Deep link from the platform's target console: /admin?run=<sourcingRunId> pins that run at the
  // top, already expanded — the "did this target really get sourced?" audit jump.
  const [pinnedRun, setPinnedRun] = useState(null);
  const [pinnedErr, setPinnedErr] = useState('');
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('run');
    if (!id) return;
    adminSourcingRunDetail({ runId: id })
      .then(({ data: d }) => setPinnedRun({ ...d.run, orgName: d.run.orgId }))
      .catch(() => setPinnedErr(`Linked run ${id} not found (runs are kept 90 days).`));
  }, []);

  const load = async (id = orgId) => {
    setBusy(true);
    setErr('');
    try {
      const { data: d } = await adminSourcingRuns({ orgId: id || undefined, limit: 40 });
      setData(d);
    } catch {
      setErr('Failed to load runs.');
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => { load(''); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Manual triggers. Both cost real money (Apify + the per-lead wallet debit), so they are labelled
  // with what they actually do rather than a generic "run".
  const fire = async (kind) => {
    if (!orgId) { setErr('Pick an organisation first.'); return; }
    setRunning(kind);
    setErr('');
    setPlanResult(null);
    try {
      if (kind === 'top') await adminSourceTopTarget({ orgId, topN: 1 });
      else if (kind === 'plan') {
        const { data: d } = await adminPlanNow({ orgId });
        setPlanResult(d);
        return; // planning writes no sourcing run — nothing on this panel to reload
      } else await adminRunSourcingNow({ orgId });
      await load(orgId);
    } catch (e) {
      setErr(e?.message || 'Run failed.');
    } finally {
      setRunning('');
    }
  };

  const r = data?.rollup;

  return (
    <section className="space-y-3 rounded-2xl border border-line bg-white p-5">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-ink">Sourcing — runs &amp; funnel</h2>
        <button type="button" className={btnGhost} onClick={() => load()} disabled={busy}>
          {busy ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      <div className="flex gap-1.5">
        {[['runs', 'Runs'], ['ledger', 'Lead history']].map(([k, label]) => (
          <button
            key={k}
            type="button"
            onClick={() => setTab(k)}
            className={`rounded-lg px-3 py-1.5 text-sm font-medium ${tab === k ? 'bg-brand-600 text-white' : 'border border-line text-ink-soft hover:bg-canvas'}`}
          >
            {label}
          </button>
        ))}
      </div>

      {err && <p className="rounded-lg bg-rose-50 px-3 py-2 text-sm text-bad">{err}</p>}

      {pinnedErr && tab === 'runs' && <p className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">{pinnedErr}</p>}
      {pinnedRun && tab === 'runs' && (
        <div className="rounded-xl border-2 border-brand-300 p-1">
          <div className="px-2 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-wide text-brand-700">Linked run</div>
          <RunRow run={pinnedRun} showOrg autoOpen />
        </div>
      )}
      {tab === 'ledger' ? (
        <LeadLedger orgs={orgs} />
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <select
              className="rounded-lg border border-line px-3 py-1.5 text-sm"
              value={orgId}
              onChange={(e) => { setOrgId(e.target.value); load(e.target.value); }}
            >
              <option value="">All organisations</option>
              {orgs.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}
            </select>
            <button type="button" className={btn} onClick={() => fire('top')} disabled={!!running || !orgId}>
              {running === 'top' ? 'Sourcing…' : 'Source top target now'}
            </button>
            <button type="button" className={btnGhost} onClick={() => fire('now')} disabled={!!running || !orgId}>
              {running === 'now' ? 'Running…' : 'Run static queries now'}
            </button>
            <span className="text-[10px] text-ink-soft">Both spend real Apify credit and bill the org per lead.</span>
          </div>

          {/* Plan today's work queue by hand. Its own row, away from the sourcing triggers: this
              one costs no Apify credit but bills the flat plan-day price, and its main use is
              recovering a day the wallet gate withheld — top up, then click. */}
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" className={btnGhost} onClick={() => fire('plan')} disabled={!!running || !orgId}>
              {running === 'plan' ? 'Planning…' : "Plan today's tasks now"}
            </button>
            <span className="text-[10px] text-ink-soft">
              Re-runs tonight&rsquo;s planner for today. Bills the plan-day price unless the day is already
              planned or the balance is still negative.
            </span>
          </div>

          {planResult && (
            <p
              className={`rounded-lg px-3 py-2 text-xs ${
                planResult.status === 'blocked'
                  ? 'bg-amber-50 text-amber-800'
                  : planResult.status === 'ok'
                    ? 'bg-green-50 text-green-800'
                    : 'bg-canvas text-ink-soft'
              }`}
            >
              {planResult.status === 'ok'
                ? `Planned ${planResult.dateKey}: ${planResult.taskCount} tasks across ${planResult.adminCount} admin${planResult.adminCount === 1 ? '' : 's'}.`
                : planResult.status === 'blocked'
                  ? `Withheld — balance is ${formatINR(planResult.balance || 0)}. Top the org up, then click again.`
                  : `Nothing to do: ${planResult.reason || 'skipped'}.`}
            </p>
          )}

          {r && (
            <div className="rounded-xl border border-line bg-canvas/40 p-3">
              <div className="text-xs font-medium text-ink-soft">
                Across the last {r.runs} run{r.runs === 1 ? '' : 's'} shown{orgId ? ' for this organisation' : ''}
              </div>
              <div className="mt-2 grid grid-cols-2 gap-3 sm:grid-cols-5">
                <div>
                  <div className="text-lg font-bold text-ink">{r.targets}</div>
                  <div className="text-[11px] text-ink-soft">targets sourced</div>
                </div>
                <div>
                  <div className="text-lg font-bold text-ink">{r.funnel?.fetched || 0}</div>
                  <div className="text-[11px] text-ink-soft">listings fetched</div>
                </div>
                <div>
                  <div className="text-lg font-bold text-ink">{r.funnel?.enriched || 0}</div>
                  <div className="text-[11px] text-ink-soft">paid scrapes</div>
                </div>
                <div>
                  <div className="text-lg font-bold text-green-700">{r.relayed}</div>
                  <div className="text-[11px] text-ink-soft">relayed · {r.yieldPct.toFixed(1)}% of fetched</div>
                </div>
                <div>
                  <div className="text-lg font-bold text-ink">{formatINR(r.amountInr)}</div>
                  <div className="text-[11px] text-ink-soft">billed</div>
                </div>
              </div>
              <div className="mt-3">
                <Funnel funnel={r.funnel} />
              </div>
            </div>
          )}

          {!busy && data && !data.runs.length && (
            <p className="rounded-lg bg-canvas/60 px-3 py-2 text-xs text-ink-soft">
              No runs recorded yet. The funnel is captured from the next run onward — earlier runs only
              wrote to the logs, so they can’t be shown here. Use “Lead history” for what was relayed
              before that.
            </p>
          )}

          <div className="space-y-2">
            {(data?.runs || []).map((run) => <RunRow key={run.id} run={run} showOrg={!orgId} />)}
          </div>
        </>
      )}
    </section>
  );
}
