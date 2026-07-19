/**
 * Nightly conversion-rules tuner + dev-task proposer — pure functions, no I/O.
 *
 * The tuner is the "agent rewrites the rules" half of the framework: it reads yesterday's
 * action-ledger rollup (shown / dismissed / converted per rule) and adjusts thresholds
 * CONSERVATIVELY — one step per night, only on real volume, always with a written reason. The
 * platform re-validates everything against its fences at ingest, so even a wild change here can
 * never exceed the operator's bounds (defense in depth: we also clamp locally).
 *
 * The proposer turns structural findings (anomalies, login-wall drop-off, plan-completion slumps)
 * into dev-task PROPOSALS. Per operator decision these are never filed directly: they land on the
 * superadmin's Intelligence Reports page, and only APPROVED proposals become GitHub issues on the
 * next nightly cycle. Fingerprints are stable per finding-kind so a recurring problem never
 * duplicates. Sensitive areas (auth/login/payments) are labeled `need-human` per the dev-pipeline
 * conventions — the pipeline will not auto-implement those.
 */

// Mirror of the platform's fence band (the platform still re-clamps at ingest — this keeps our
// proposals honest rather than relying on the fence to fix them).
export const THRESHOLD_MIN_OVERLAY = 2;
export const THRESHOLD_MAX = 10;

// Volume floors: never tune on noise.
const MIN_SHOWN_TO_JUDGE = 20;
const LOW_CONVERSION = 0.05;
const HIGH_CONVERSION = 0.25;
const HIGH_DISMISS = 0.8;

/** Rollup helper: digest.actions rows → per-rule {shown, dismissed, converted}. */
export function rollupActions(actions = []) {
  const byRule = {};
  for (const a of actions) {
    const r = (byRule[a.ruleId] = byRule[a.ruleId] || { shown: 0, dismissed: 0, converted: 0 });
    // 'reshown' = a latched login_gate re-appearing in a later session — real exposure for
    // tuning purposes, but never billed (billing prices 'shown' rows only, see settle).
    if (a.event === 'shown' || a.event === 'reshown') r.shown += a.count;
    else if (a.event === 'dismissed') r.dismissed += a.count;
    else if (a.event === 'login_success' || a.event === 'captured' || a.event === 'clicked') r.converted += a.count;
  }
  return byRule;
}

/**
 * Tune a rules pack against yesterday's outcomes. `rules` is the pack we last delivered (or the
 * platform defaults echoed back to us); returns { rules, changes:[{id, what, why}] }. Only overlay
 * rules are tuned in v1 — slot cards pass through untouched.
 */
export function tuneRules(rules, actions) {
  const byRule = rollupActions(actions);
  const changes = [];
  const tuned = rules.map((rule) => {
    if (rule.action?.slot !== 'overlay' || !rule.enabled) return rule;
    const stats = byRule[rule.id];
    if (!stats || stats.shown < MIN_SHOWN_TO_JUDGE) return rule;
    const conversion = stats.converted / stats.shown;
    const dismissRate = stats.dismissed / stats.shown;
    let threshold = rule.trigger.threshold;
    let why = null;

    if (dismissRate >= HIGH_DISMISS && threshold < THRESHOLD_MAX) {
      threshold = Math.min(THRESHOLD_MAX, threshold + 2);
      why = `${Math.round(dismissRate * 100)}% dismissed at ${stats.shown} shows — visitors aren't ready this early`;
    } else if (conversion < LOW_CONVERSION && threshold < THRESHOLD_MAX) {
      threshold = threshold + 1;
      why = `${Math.round(conversion * 100)}% conversion over ${stats.shown} shows — firing too early`;
    } else if (conversion > HIGH_CONVERSION && threshold > THRESHOLD_MIN_OVERLAY) {
      threshold = threshold - 1;
      why = `${Math.round(conversion * 100)}% conversion over ${stats.shown} shows — capture the intent sooner`;
    }

    if (threshold === rule.trigger.threshold) return rule;
    changes.push({ id: rule.id, what: `threshold ${rule.trigger.threshold}→${threshold}`, why });
    return { ...rule, trigger: { ...rule.trigger, threshold }, reason: `tuned: ${why}` };
  });
  return { rules: tuned, changes };
}

/** Sessions with this share of dropped_at_login (and enough volume) trigger a login-wall proposal. */
const LOGIN_DROP_SHARE = 0.25;
const MIN_SESSIONS_FOR_PROPOSALS = 50;
const COMPLETION_SLUMP = 0.4;
const MIN_PLANNED_TASKS = 20;

/**
 * Build dev-task proposals from the day's structural findings. Deterministic templates; stable
 * fingerprints (no date) so recurring findings dedup into one proposal.
 */
export function buildDevTaskProposals(digest) {
  const proposals = [];
  const sessions = digest.sessions || [];

  // Login-wall friction: a big share of engaged sessions dying at the login prompt is a product
  // problem, not a tuning problem. Auth-adjacent → need-human label per pipeline conventions.
  if (sessions.length >= MIN_SESSIONS_FOR_PROPOSALS) {
    const loginDrops = sessions.filter((s) => s.dropOffStage === 'dropped_at_login').length;
    const share = loginDrops / sessions.length;
    if (share >= LOGIN_DROP_SHARE) {
      proposals.push({
        fingerprint: 'login-wall-drop-off',
        title: 'Investigate login-wall drop-off (large share of sessions die at the login prompt)',
        body: [
          '## Context / problem',
          `The nightly session analysis found ${loginDrops} of ${sessions.length} sessions (${Math.round(share * 100)}%) ended at a login prompt without signing in.`,
          'Visitors are abandoning at the wall instead of converting — evaluate softening or removing the login gate on the affected surfaces, or improving the prompt copy/timing.',
          '## Acceptance criteria',
          '- [ ] Identify which surfaces produce the most dropped_at_login sessions (session-timelines data)',
          '- [ ] Proposal (or change) that measurably reduces the drop share',
          '## Notes',
          'Auto-proposed by the Bosun nightly agent from real funnel data; approved by the superadmin.',
        ].join('\n'),
        labels: ['web', 'need-human'], // auth-adjacent: never auto-implemented
        severity: 'high',
        evidence: `${loginDrops}/${sessions.length} sessions dropped at login (${Math.round(share * 100)}%)`,
      });
    }
  }

  // Anomaly-driven: a hard drop in leads/sessions is worth an engineering look if it persists.
  for (const a of digest.anomalies || []) {
    if (a.severity !== 'high') continue;
    proposals.push({
      fingerprint: `anomaly-${a.metric}-drop`,
      title: `Investigate ${a.metric} drop flagged by the nightly agent`,
      body: [
        '## Context / problem',
        a.message,
        'If this persists more than a day it may be a regression (tracking, search, or a broken flow) rather than traffic noise.',
        '## Acceptance criteria',
        `- [ ] Root cause for the ${a.metric} drop identified (regression vs organic)`,
        '- [ ] Fix landed or finding documented',
        '## Notes',
        'Auto-proposed by the Bosun nightly agent; approved by the superadmin.',
      ].join('\n'),
      labels: ['web', 'ready-for-dev', 'priority:high'],
      severity: 'high',
      evidence: a.message,
    });
  }

  // Plan-completion slump: admins are ignoring the daily plan — a workflow/UX problem to escalate.
  const completion = digest.planCompletion || [];
  const totals = completion.reduce(
    (acc, p) => ({ total: acc.total + p.total, closed: acc.closed + p.done + p.skipped + p.autoDone }),
    { total: 0, closed: 0 },
  );
  if (totals.total >= MIN_PLANNED_TASKS && totals.closed / totals.total < COMPLETION_SLUMP) {
    proposals.push({
      fingerprint: 'daily-plan-completion-slump',
      title: `Daily work-plan completion is low (${Math.round((totals.closed / totals.total) * 100)}%) — review the Today's Tasks workflow`,
      body: [
        '## Context / problem',
        `Yesterday's plans: ${totals.closed} of ${totals.total} tasks closed (${Math.round((totals.closed / totals.total) * 100)}%). Admins may not be working from the plan — the page may need better visibility, or the plan sizes/ordering need adjusting.`,
        '## Acceptance criteria',
        '- [ ] Understand why plans are not being worked (ask admins / check page usage)',
        '- [ ] Concrete change proposed (UX, plan size, or notification)',
        '## Notes',
        'Auto-proposed by the Bosun nightly agent; approved by the superadmin.',
      ].join('\n'),
      labels: ['web', 'ready-for-dev'],
      severity: 'info',
      evidence: `${totals.closed}/${totals.total} planned tasks closed`,
    });
  }

  return proposals.slice(0, 2); // ≤2 proposals per night — a trickle the superadmin will actually read
}

/**
 * Staffing proposals — recruit / re-skill / ramp guidance for the superadmin, built from the
 * planner's own unassigned-task history (tasks nobody was eligible for = a skill/language gap;
 * persistent zero-unassigned with saturated quotas would be a ramp-up signal). kind:'staffing' —
 * these go into the SAME approval queue as dev tasks but are NEVER filed to GitHub: approving one
 * is the superadmin acknowledging an operations action (recruit, change skills on the staffing
 * page, adjust capacity).
 */
export function buildStaffingProposals(recentPlannerRuns) {
  const proposals = [];
  const unassignedByCategory = {};
  let daysWithData = 0;
  for (const run of recentPlannerRuns || []) {
    const un = run.unassigned || run.stats?.unassigned || {};
    if (Object.keys(un).length) daysWithData++;
    for (const [category, count] of Object.entries(un)) {
      unassignedByCategory[category] = (unassignedByCategory[category] || 0) + Number(count || 0);
    }
  }
  for (const [category, total] of Object.entries(unassignedByCategory)) {
    if (total < 10) continue; // a real gap, not a blip
    proposals.push({
      kind: 'staffing',
      fingerprint: `staffing-gap-${category}`,
      title: `Staffing gap: ${total} ${category.replace(/_/g, ' ')} tasks had NO eligible admin recently`,
      body: [
        '## Context / problem',
        `Across the last ${daysWithData || recentPlannerRuns.length} planned days, ${total} "${category}" tasks could not be assigned — no admin had the matching responsibility/language with free capacity.`,
        '## Suggested operator actions',
        `- Grant the "${category}" responsibility to an existing admin on /admin/sourcing-languages, or`,
        '- Raise a capable admin\'s daily capacity (Tasks/day), or',
        '- Recruit for this area.',
        '## Notes',
        'Auto-proposed by the Bosun nightly agent from planner allocation data. Approving acknowledges the action — nothing is filed to GitHub.',
      ].join('\n'),
      labels: ['staffing'],
      severity: total >= 30 ? 'high' : 'info',
      evidence: `${total} unassigned ${category} tasks across recent plans`,
    });
  }
  return proposals.slice(0, 2);
}
