/**
 * Daily admin work-queue allocation — the deterministic brain of the planner service.
 *
 * This is the ONLY implementation of the allocation rules anywhere (the platform deliberately has
 * none — its 07:00 fallback calls our sourcingPlanNow instead of planning locally, so the rules can
 * never fork). Pure functions, no I/O, no clock: same workState in → byte-identical plans out, which
 * is what makes a scheduler retry, an on-demand re-run, and a unit test all trivially safe.
 *
 * Input is the platform's work-state snapshot (GET /api/sourcing/work-state): candidate tasks per
 * category, already priority-sorted by the platform (it owns the queue semantics — callbacks by
 * promise time, untouched fresh-first, RNR fewest-attempts), plus the admin roster with language
 * scope, capacity and light throughput stats.
 *
 * Allocation, per category in priority order (callbacks are promises; freshness is maintenance):
 *   1. AFFINITY — a lead already assigned to (or converted by) an eligible admin goes to them: the
 *      platform's ownership rule ("assigned = theirs") must survive planning.
 *   2. ROUND-ROBIN — otherwise the least-loaded eligible admin takes it (fill-ratio, then a
 *      deterministic per-day rotation cursor so the same admin doesn't always win ties, then uid as
 *      the total order that makes the sort reproducible).
 *   3. Nobody eligible (language mismatch / everyone at quota) → counted in stats.unassigned, never
 *      silently dropped — the superadmin team view surfaces these.
 *
 * Eligibility mirrors the platform's own gates exactly: language scope (null = full access, [] =
 * nothing), buyer tasks only for admins with the buyer-leads grant, and the per-admin quota.
 */

// Category order IS the priority order. Keys match the platform's TASK_TYPES exactly.
export const CATEGORY_ORDER = [
  'callback_due',
  'untouched_lead',
  'rnr_retry',
  'buyer_followup',
  'freshness_check',
];

// Why-lines are composed here (not by Gemini) so every card's justification is deterministic and
// grounded — the briefing may summarise, but per-task copy never hallucinates.
const WHY = {
  callback_due: (c) => {
    const at = c.callbackAtMs ? new Date(c.callbackAtMs + 5.5 * 3600 * 1000) : null;
    const hh = at ? `${String(at.getUTCHours()).padStart(2, '0')}:${String(at.getUTCMinutes()).padStart(2, '0')}` : '';
    return at ? `Callback promised · ${hh} IST` : 'Callback promised';
  },
  untouched_lead: (c) =>
    c.freshnessTag === 'stale-fallback' ? 'Never called (older post — verify first)' : 'Fresh lead, never called',
  rnr_retry: (c) => `No answer ${c.attempts > 1 ? `×${c.attempts}` : 'once'} — cooled, retry`,
  buyer_followup: () => 'Buyer waiting — match inventory & reply',
  freshness_check: () => 'Published listing past its freshness window — confirm still available',
};

/** FNV-1a over a string — the deterministic per-day rotation seed (no Math.random in a planner). */
export function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

// Task type → responsibility. Mirrors the platform's ADMIN_SKILLS catalog (lib/adminSkills.ts) —
// change them in lockstep. The three call-queue types share one skill: they're all consent calls.
export const TASK_SKILL = {
  callback_due: 'consent_calls',
  untouched_lead: 'consent_calls',
  rnr_retry: 'consent_calls',
  buyer_followup: 'buyer_followup',
  freshness_check: 'freshness_check',
};

function eligible(admin, task) {
  if (admin.quota <= admin.assigned.length) return false;
  if (task.type === 'buyer_followup' && !admin.canAccessBuyerLeads) return false;
  // Skills/responsibilities: null = full-skill admin; an array must cover the task's skill.
  const skill = TASK_SKILL[task.type];
  if (skill && Array.isArray(admin.skills) && !admin.skills.includes(skill)) return false;
  if (admin.sourcingLanguages == null) return true; // full language access
  return admin.sourcingLanguages.includes(task.language);
}

/**
 * Allocate the work-state's candidates into per-admin plans.
 * Returns { plans: [{ adminUid, adminName, tasks: [...] }], stats }.
 */
export function allocateTasks(workState, { maxTasksPerAdmin = 40 } = {}) {
  const roster = (workState.admins || [])
    .filter((a) => a.role !== 'superadmin' && a.role !== 'super_admin')
    .map((a) => ({
      ...a,
      quota: Math.max(1, Math.min(Number(a.capacity) || 40, maxTasksPerAdmin)),
      assigned: [],
    }))
    .sort((a, b) => a.uid.localeCompare(b.uid)); // fixed roster order → reproducible cursor math

  const stats = { unassigned: {}, perAdmin: {} };
  const n = roster.length;

  for (const category of CATEGORY_ORDER) {
    const candidates = (workState.categories || {})[category] || [];
    const cursor = n ? fnv1a(`${workState.dateKey}:${category}`) % n : 0;
    for (const c of candidates) {
      const task = {
        id: `${category}__${c.leadId}`,
        type: category,
        leadId: c.leadId,
        propertyId: c.propertyId || null,
        refId: c.refId || '',
        title: c.title || '',
        city: c.city || '',
        locality: c.locality || '',
        language: c.language,
        attemptsAtPlan: Number(c.attempts) || 0,
        callbackAtMs: c.callbackAtMs || null,
        why: WHY[category](c),
      };

      // 1) Affinity: the platform's owner (assignee, or converter for freshness) keeps their lead.
      const ownerUid = category === 'freshness_check' ? c.convertedBy : c.assignedTo;
      const owner = ownerUid ? roster.find((a) => a.uid === ownerUid) : null;
      if (owner && eligible(owner, task)) {
        owner.assigned.push(task);
        continue;
      }

      // 2) Least-loaded eligible admin; deterministic rotation + uid break ties.
      let pick = null;
      let pickKey = null;
      for (let i = 0; i < n; i++) {
        const a = roster[i];
        if (!eligible(a, task)) continue;
        const key = [a.assigned.length / a.quota, (i - cursor + n) % n, a.uid];
        if (
          !pick ||
          key[0] < pickKey[0] ||
          (key[0] === pickKey[0] && (key[1] < pickKey[1] || (key[1] === pickKey[1] && key[2] < pickKey[2])))
        ) {
          pick = a;
          pickKey = key;
        }
      }
      if (pick) pick.assigned.push(task);
      else stats.unassigned[category] = (stats.unassigned[category] || 0) + 1;
    }
  }

  // Final per-admin ordering: promised callbacks by time, then category order; Array.sort is stable
  // so within a band the platform's arrival order (already priority-sorted) is preserved.
  for (const a of roster) {
    a.assigned.sort((x, y) => {
      if (x.type === 'callback_due' && y.type === 'callback_due') {
        return (x.callbackAtMs || 0) - (y.callbackAtMs || 0);
      }
      return CATEGORY_ORDER.indexOf(x.type) - CATEGORY_ORDER.indexOf(y.type);
    });
    a.assigned.forEach((t, i) => {
      t.priority = i + 1;
      delete t.callbackAtMs;
      delete t.language;
    });
    stats.perAdmin[a.uid] = a.assigned.length;
  }

  return {
    plans: roster.map((a) => ({ adminUid: a.uid, adminName: a.name, tasks: a.assigned })),
    stats,
  };
}

/**
 * The morning-briefing prompt for one admin — structured counts and platform-authored why-lines
 * only; NO scraped lead text ever reaches the model, so the briefing cannot leak or hallucinate
 * lead content. English v1 (operator decision).
 */
export function briefingPrompt(admin, tasks, workState) {
  const byType = {};
  for (const t of tasks) byType[t.type] = (byType[t.type] || 0) + 1;
  const top = tasks.slice(0, 3).map((t) => `- ${t.type}: ${t.why} (${t.locality || t.city})`);
  return [
    `Write a 2-3 sentence morning briefing for a real-estate sourcing admin named ${admin.name}.`,
    `Today's plan (${workState.dateKey}): ${tasks.length} tasks — ` +
      Object.entries(byType)
        .map(([k, v]) => `${v} ${k.replace(/_/g, ' ')}`)
        .join(', ') +
      '.',
    `Top priorities:\n${top.join('\n')}`,
    `Yesterday: ${admin.callsYesterday} calls, ${admin.converted7d} conversions in the last 7 days.`,
    'Tone: energetic, concrete, no fluff, no emojis, no invented numbers — use only the counts above.',
    'Return JSON: {"briefing": "<the briefing text>"}',
  ].join('\n');
}

export const BRIEFING_SCHEMA = {
  type: 'object',
  properties: { briefing: { type: 'string' } },
  required: ['briefing'],
};
