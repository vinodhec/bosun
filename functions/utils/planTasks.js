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
 *   0. GROUPING — candidates carry a `groupKey` (the person: `s:<last10>` seller / `b:<last10>` buyer,
 *      the same identity the sourcing queue's seller groups use). The FIRST card for a person decides
 *      who owns them for the day; every later card — any category — follows, ignoring the quota,
 *      because it is the same phone call. Two admins dialling one owner on the same morning is the
 *      exact waste the queue already fixed with group-claim; the plan must not re-create it.
 *      Consequence: the quota is a CALL budget (`admin.units`), not a card count, and a plan can hold
 *      more cards than the quota — capped by MAX_CARDS_PER_PLAN, the ingest's own limit.
 *   1. AFFINITY — a lead already assigned to (or converted by) an eligible admin goes to them:
 *      continuity is preferred whenever the owner has room.
 *   2. ROUND-ROBIN — otherwise the least-loaded eligible admin takes it (fill-ratio, then a
 *      deterministic per-day rotation cursor so the same admin doesn't always win ties, then uid as
 *      the total order that makes the sort reproducible). This INCLUDES leads whose owner is at
 *      quota: THE PLAN WINS (operator decision 2026-08-03, #571) — the platform's ingest reassigns
 *      each planned lead to its plan admin on delivery, so allocating an over-claimed admin's
 *      backlog to teammates redistributes it instead of producing dead cards.
 *   3. Nobody eligible (language mismatch / everyone at quota) → counted in stats.unassigned, never
 *      silently dropped — the superadmin team view surfaces these.
 *
 * Eligibility mirrors the platform's own gates exactly: language scope (null = full access, [] =
 * nothing), buyer tasks only for admins with the buyer-leads grant, and the per-admin quota.
 */

// Category order IS the priority order. Keys match the platform's TASK_TYPES exactly — LOCKSTEP
// with web/src/lib/dailyTasks.ts TASK_TYPES in the platform repo: buyer_followup ranks ABOVE the
// seller cold-call lanes (operator 2026-08-09: buyer demand is priority #1, leads are scarce).
export const CATEGORY_ORDER = [
  'callback_due',
  'buyer_followup',
  'untouched_lead',
  'rnr_retry',
  'freshness_check',
];

// Why-lines are composed here (not by Gemini) so every card's justification is deterministic and
// grounded — the briefing may summarise, but per-task copy never hallucinates. A candidate with
// waiting buyer demand (work-state's demandCount) leads with it — "2 buyers waiting" is the reason
// this call ranks where it does, and the admin should hear it in the card, not just feel the order.
const buyersWaiting = (c) => {
  const n = Number(c.demandCount) || 0;
  return n > 0 ? `${n} buyer${n > 1 ? 's' : ''} waiting` : '';
};
const withDemand = (c, base) => {
  const d = buyersWaiting(c);
  return d ? `${d} · ${base}` : base;
};
const WHY = {
  callback_due: (c) => {
    const at = c.callbackAtMs ? new Date(c.callbackAtMs + 5.5 * 3600 * 1000) : null;
    const hh = at ? `${String(at.getUTCHours()).padStart(2, '0')}:${String(at.getUTCMinutes()).padStart(2, '0')}` : '';
    return withDemand(c, at ? `Callback promised · ${hh} IST` : 'Callback promised');
  },
  untouched_lead: (c) =>
    withDemand(c, c.freshnessTag === 'stale-fallback' ? 'Never called (older post — verify first)' : 'Fresh lead, never called'),
  rnr_retry: (c) => withDemand(c, `No answer ${c.attempts > 1 ? `×${c.attempts}` : 'once'} — cooled, retry`),
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

// The quota IS the operator's plan size — nothing else. `capacity` is the platform's number,
// resolved on /admin/sourcing-languages (per-person override → full-time / part-time target → org
// default) and delivered in the work-state, and it is the ONLY place plan size is decided.
// `maxTasksPerAdmin` is a safety rail against a garbage config value, not a second policy knob, so
// it stays at the platform's FULLTIME_CAPACITY_MAX (200) rather than a number that silently
// overrides what a superadmin typed on the page.
//
// A throughput feedback loop used to shrink this to `max(40, ceil(worked × 1.25))` whenever
// yesterday's plan was left unfinished. It was removed on operator instruction (2026-08-13): on
// 20260813 it pinned Sanjay and Arthi at 40 calls against full-time targets of 100 and 60, because
// each had left the previous day's plan part-worked — the setting on the staffing page and the plan
// people actually received had drifted apart with no way to see it from the page. Under-worked days
// are now a management signal (the attention watch already flags exactly that pair of conditions),
// not a silent quota cut.
export function quotaFor(admin, maxTasksPerAdmin) {
  return Math.max(1, Math.min(Number(admin.capacity) || 40, maxTasksPerAdmin));
}

// The ingest's MAX_TASKS_PER_PLAN (keep in lockstep with web/src/lib/dailyTasks.ts). Quota is
// counted in CALLS, not cards (see allocateTasks), so a roster of grouped sellers hands one admin
// more cards than their quota — this is the hard rail that keeps the delivery inside what the
// platform accepts. It sits well above the 200-call ceiling because grouped siblings ride free: at
// 100 it truncated Abi's 20260813 plan at 100 cards = 70 of her 100 calls, i.e. the rail was eating
// the call budget it exists to protect.
const MAX_CARDS_PER_PLAN = 400;

/**
 * `ignoreQuota` is used for one case only: a task whose person is ALREADY on this admin's plan. That
 * card costs no extra call, so the quota (a call budget) must not push the seller's third listing
 * onto a second admin — the whole point of grouping. Scope and skill still apply.
 */
function eligible(admin, task, { ignoreQuota = false } = {}) {
  if (admin.assigned.length >= MAX_CARDS_PER_PLAN) return false;
  if (!ignoreQuota && admin.quota <= admin.units) return false;
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
      quota: quotaFor(a, maxTasksPerAdmin),
      assigned: [],
      // Calls, not cards: a person already on this admin's plan costs 0 further units, so `units` is
      // what the quota and the load-balancing fill-ratio are measured against.
      units: 0,
      groups: new Set(),
    }))
    .sort((a, b) => a.uid.localeCompare(b.uid)); // fixed roster order → reproducible cursor math

  const stats = { unassigned: {}, perAdmin: {} };
  const n = roster.length;
  // groupKey → the admin who owns that person TODAY. Filled the first time any of their tasks is
  // allocated and consulted for every later one, across categories: a seller with a due callback, an
  // untouched second listing and a freshness re-check is ONE conversation with ONE admin.
  const groupOwner = new Map();
  const place = (admin, task) => {
    admin.assigned.push(task);
    if (task.groupKey) {
      if (!admin.groups.has(task.groupKey)) {
        admin.groups.add(task.groupKey);
        admin.units += 1;
        groupOwner.set(task.groupKey, admin.uid);
      }
    } else {
      admin.units += 1;
    }
  };

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
        demand: Number(c.demandCount) || 0, // waiting buyers — persisted to the plan card
        groupKey: c.groupKey || '', // 's:'/'b:' + last 10 digits — the person, '' when unknown
        groupSize: 1, // recomputed per plan below (what THIS admin's card should claim)
        why: WHY[category](c),
      };

      // 0) GROUP AFFINITY — outranks everything else, including the owner's own assignment and the
      // quota. If today's plan already sends someone to this number, every further task on it goes to
      // the same person: two admins dialling one owner (or one buyer) on the same morning is the
      // waste the sourcing queue's seller groups already eliminate, and a plan that splits them
      // re-creates it in the one place both admins are told to work from.
      if (task.groupKey && groupOwner.has(task.groupKey)) {
        const holder = roster.find((a) => a.uid === groupOwner.get(task.groupKey));
        if (holder && eligible(holder, task, { ignoreQuota: true })) {
          place(holder, task);
          continue;
        }
        // Holder can't take THIS card (skill/scope — e.g. a freshness re-check on a seller whose cold
        // call belongs to a consent-only admin): fall through and place it normally.
      }

      // 1) Affinity: the platform's owner (assignee, or converter for freshness) keeps their lead
      // while they have room. Owner ineligible (quota/scope/off roster) → fall through: the plan
      // wins, and the platform's ingest reassigns the lead to whoever it lands on below.
      const ownerUid = category === 'freshness_check' ? c.convertedBy : c.assignedTo;
      const owner = ownerUid ? roster.find((a) => a.uid === ownerUid) : null;
      if (owner && eligible(owner, task)) {
        place(owner, task);
        continue;
      }

      // 2) Least-loaded eligible admin; deterministic rotation + uid break ties.
      let pick = null;
      let pickKey = null;
      for (let i = 0; i < n; i++) {
        const a = roster[i];
        if (!eligible(a, task)) continue;
        const key = [a.units / a.quota, (i - cursor + n) % n, a.uid];
        if (
          !pick ||
          key[0] < pickKey[0] ||
          (key[0] === pickKey[0] && (key[1] < pickKey[1] || (key[1] === pickKey[1] && key[2] < pickKey[2])))
        ) {
          pick = a;
          pickKey = key;
        }
      }
      if (pick) place(pick, task);
      else stats.unassigned[category] = (stats.unassigned[category] || 0) + 1;
    }
  }

  // Final per-admin ordering: promised callbacks by time, then category order; Array.sort is stable
  // so within a band the platform's arrival order (already priority-sorted) is preserved.
  //
  // Then ONE more pass: a person's cards are pulled together behind their best-ranked card. Ordering
  // is how a plan is worked top-down, so cards for the same number sitting at #3 and #27 are read as
  // two calls no matter what the group label says — adjacency is what makes it one.
  let groupedPeople = 0;
  let groupedCards = 0;
  for (const a of roster) {
    a.assigned.sort((x, y) => {
      if (x.type === 'callback_due' && y.type === 'callback_due') {
        return (x.callbackAtMs || 0) - (y.callbackAtMs || 0);
      }
      return CATEGORY_ORDER.indexOf(x.type) - CATEGORY_ORDER.indexOf(y.type);
    });

    const members = new Map();
    for (const t of a.assigned) {
      if (!t.groupKey) continue;
      const arr = members.get(t.groupKey) || [];
      arr.push(t);
      members.set(t.groupKey, arr);
    }
    const emitted = new Set();
    const ordered = [];
    for (const t of a.assigned) {
      if (!t.groupKey) {
        ordered.push(t);
        continue;
      }
      if (emitted.has(t.groupKey)) continue;
      emitted.add(t.groupKey);
      ordered.push(...members.get(t.groupKey));
    }
    a.assigned = ordered;

    a.assigned.forEach((t, i) => {
      t.priority = i + 1;
      // What the CARD claims: how many of this person's cards are in THIS plan. The platform's
      // snapshot count can be larger (a sibling the category caps left out), and a card promising a
      // third listing the admin cannot see on the page is worse than no label.
      t.groupSize = t.groupKey ? members.get(t.groupKey).length : 1;
      delete t.callbackAtMs;
      delete t.language;
    });
    for (const [, list] of members) {
      if (list.length > 1) {
        groupedPeople += 1;
        groupedCards += list.length;
      }
    }
    stats.perAdmin[a.uid] = a.assigned.length;
  }
  // Proof the grouping is doing something: `people` conversations that cover `cards` listings, i.e.
  // `cards - people` calls the team no longer has to place.
  stats.grouped = { people: groupedPeople, cards: groupedCards, callsSaved: groupedCards - groupedPeople };

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
  const demandTasks = tasks.filter((t) => (Number(t.demand) || 0) > 0);
  // Grouped cards are one call each — the briefing must say "38 calls, 45 listings", or a plan that
  // grew in cards reads as a heavier day when it is in fact a lighter one.
  const groupKeys = new Set(tasks.filter((t) => t.groupKey).map((t) => t.groupKey));
  const callCount = groupKeys.size + tasks.filter((t) => !t.groupKey).length;
  const py = admin.planYesterday;
  const lines = [
    `Write a 2-3 sentence morning briefing for a real-estate sourcing admin named ${admin.name}.`,
    `Today's plan (${workState.dateKey}): ${tasks.length} tasks — ` +
      Object.entries(byType)
        .map(([k, v]) => `${v} ${k.replace(/_/g, ' ')}`)
        .join(', ') +
      '.',
  ];
  if (callCount < tasks.length) {
    lines.push(
      `${tasks.length - callCount} of these cards belong to a person who already appears earlier in the list — the plan is ${callCount} phone calls, not ${tasks.length}. Same-person cards sit together; cover all of them in the one call.`,
    );
  }
  if (demandTasks.length) {
    lines.push(
      `${demandTasks.length} of these calls have buyers ALREADY waiting for that locality/type — they are ranked first; closing one feeds a live buyer, so lead with this.`,
    );
  }
  lines.push(`Top priorities:\n${top.join('\n')}`);
  if (py && py.total > 0) {
    lines.push(
      `Yesterday's plan: ${py.done + py.autoDone} of ${py.total} tasks completed${py.skipped ? ` (${py.skipped} skipped)` : ''} — today's list is sized to that pace.`,
    );
  }
  lines.push(
    `Yesterday: ${admin.callsYesterday} calls, ${admin.converted7d} conversions in the last 7 days.`,
    'Tone: energetic, concrete, no fluff, no emojis, no invented numbers — use only the counts above.',
    'Return JSON: {"briefing": "<the briefing text>"}',
  );
  return lines.join('\n');
}

export const BRIEFING_SCHEMA = {
  type: 'object',
  properties: { briefing: { type: 'string' } },
  required: ['briefing'],
};
