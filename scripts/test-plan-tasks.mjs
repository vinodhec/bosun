/**
 * Standalone fixture tests for the daily-planner allocator (functions/utils/planTasks.js).
 * No Firebase, no network — run directly:  node scripts/test-plan-tasks.mjs
 */
import assert from 'node:assert/strict';
import { allocateTasks } from '../functions/utils/planTasks.js';

const admin = (uid, over = {}) => ({
  uid,
  name: uid,
  role: 'admin',
  sourcingLanguages: null,
  canAccessBuyerLeads: false,
  capacity: 40,
  openAssigned: 0,
  callsYesterday: 0,
  converted7d: 0,
  ...over,
});

const cand = (leadId, over = {}) => ({
  leadId,
  refId: `SP-${leadId}`,
  title: `t-${leadId}`,
  city: 'Chennai',
  locality: 'Velachery',
  language: 'ta',
  assignedTo: null,
  attempts: 0,
  freshnessTag: 'fresh',
  callbackAtMs: null,
  createdAtMs: 1,
  lastActionAtMs: null,
  hasPhone: true,
  requirementId: null,
  propertyId: null,
  listingType: '',
  convertedAtMs: null,
  convertedBy: null,
  ...over,
});

const ws = (admins, categories) => ({
  dateKey: '20260719',
  istDayStartMs: 0,
  generatedAtMs: 0,
  admins,
  categories: {
    callback_due: [],
    untouched_lead: [],
    rnr_retry: [],
    buyer_followup: [],
    freshness_check: [],
    ...categories,
  },
  policy: { rnrCooldownMs: 4 * 3600 * 1000, freshness: { saleMonths: 3, rentMonths: 1 } },
});

const planFor = (result, uid) => result.plans.find((p) => p.adminUid === uid);

// 1. Affinity beats round-robin: an assigned lead goes to its owner even if others are emptier.
{
  const r = allocateTasks(
    ws([admin('a'), admin('b')], { untouched_lead: [cand('L1', { assignedTo: 'b' }), cand('L2'), cand('L3')] }),
  );
  assert.ok(planFor(r, 'b').tasks.some((t) => t.leadId === 'L1'), 'owner keeps their assigned lead');
}

// 2. Language gate: a scoped admin never receives an off-language task.
{
  const r = allocateTasks(
    ws([admin('a', { sourcingLanguages: ['hi'] }), admin('b')], {
      untouched_lead: [cand('L1'), cand('L2'), cand('L3')], // all Tamil
    }),
  );
  assert.equal(planFor(r, 'a').tasks.length, 0, 'hi-scoped admin gets no Tamil tasks');
  assert.equal(planFor(r, 'b').tasks.length, 3);
}

// 3. []-scope admin gets an empty plan; nobody-eligible tasks are counted, not dropped.
{
  const r = allocateTasks(
    ws([admin('a', { sourcingLanguages: [] })], { untouched_lead: [cand('L1'), cand('L2')] }),
  );
  assert.equal(planFor(r, 'a').tasks.length, 0);
  assert.equal(r.stats.unassigned.untouched_lead, 2, 'orphaned tasks are surfaced in stats');
}

// 4. Capacity respected: quota = min(capacity, maxTasksPerAdmin).
{
  const cands = Array.from({ length: 30 }, (_, i) => cand(`L${i}`));
  const r = allocateTasks(ws([admin('a', { capacity: 7 })], { untouched_lead: cands }), {
    maxTasksPerAdmin: 40,
  });
  assert.equal(planFor(r, 'a').tasks.length, 7);
  assert.equal(r.stats.unassigned.untouched_lead, 23);
}

// 5. Buyer tasks only reach admins with the grant.
{
  const r = allocateTasks(
    ws([admin('a'), admin('b', { canAccessBuyerLeads: true })], {
      buyer_followup: [cand('B1', { leadId: 'req_x1' }), cand('B2', { leadId: 'req_x2' })],
    }),
  );
  assert.equal(planFor(r, 'a').tasks.length, 0);
  assert.equal(planFor(r, 'b').tasks.length, 2);
}

// 6. Superadmins are excluded from plans.
{
  const r = allocateTasks(ws([admin('s', { role: 'superadmin' }), admin('a')], { untouched_lead: [cand('L1')] }));
  assert.equal(r.plans.length, 1, 'superadmin has no plan');
  assert.equal(r.plans[0].adminUid, 'a');
}

// 7. Determinism: same input twice → deep-equal output.
{
  const input = () =>
    ws([admin('a'), admin('b'), admin('c')], {
      callback_due: [cand('C1', { callbackAtMs: 500 }), cand('C2', { callbackAtMs: 100 })],
      untouched_lead: Array.from({ length: 17 }, (_, i) => cand(`U${i}`)),
      rnr_retry: [cand('R1', { attempts: 2 })],
    });
  assert.deepEqual(allocateTasks(input()), allocateTasks(input()), 'allocation is a pure function');
}

// 8. Per-admin ordering: callbacks first (by promise time), priorities are 1-based and contiguous.
{
  const r = allocateTasks(
    ws([admin('a')], {
      callback_due: [cand('C1', { callbackAtMs: 500 }), cand('C2', { callbackAtMs: 100 })],
      untouched_lead: [cand('U1')],
    }),
  );
  const tasks = planFor(r, 'a').tasks;
  assert.deepEqual(
    tasks.map((t) => t.leadId),
    ['C2', 'C1', 'U1'],
    'earliest promise first, then category order',
  );
  assert.deepEqual(tasks.map((t) => t.priority), [1, 2, 3]);
}

// 9. Load-balance: tasks spread across equally-eligible admins rather than piling on one.
{
  const r = allocateTasks(
    ws([admin('a'), admin('b')], { untouched_lead: Array.from({ length: 10 }, (_, i) => cand(`U${i}`)) }),
  );
  assert.equal(planFor(r, 'a').tasks.length, 5);
  assert.equal(planFor(r, 'b').tasks.length, 5);
}

// 10. Freshness affinity goes to the converter.
{
  const r = allocateTasks(
    ws([admin('a'), admin('b')], {
      freshness_check: [cand('F1', { convertedBy: 'b', propertyId: 'p1' })],
    }),
  );
  assert.ok(planFor(r, 'b').tasks.some((t) => t.leadId === 'F1'));
}

console.log('planTasks: all 10 fixture tests passed ✓');

// 11. Skills gate: a consent_calls-only admin never receives buyer/freshness tasks; a null-skills
// admin takes anything; skill beats round-robin availability.
{
  const { allocateTasks: alloc } = await import('../functions/utils/planTasks.js');
  const r = alloc(
    ws(
      [
        admin('caller', { adminSkillsIgnored: true, skills: ['consent_calls'] }),
        admin('checker', { skills: ['freshness_check'] }),
      ],
      {
        untouched_lead: [cand('L1'), cand('L2')],
        freshness_check: [cand('F1', { convertedBy: null, propertyId: 'p1' })],
      },
    ),
  );
  const callerTasks = planFor(r, 'caller').tasks.map((t) => t.type);
  const checkerTasks = planFor(r, 'checker').tasks.map((t) => t.type);
  assert.ok(callerTasks.every((t) => t === 'untouched_lead'), 'caller only gets call tasks');
  assert.deepEqual(checkerTasks, ['freshness_check'], 'checker only gets freshness tasks');
}

// 12. Null skills = full-skill admin (backward compatible).
{
  const { allocateTasks: alloc } = await import('../functions/utils/planTasks.js');
  const r = alloc(ws([admin('a', { skills: null })], { untouched_lead: [cand('L1')], freshness_check: [cand('F1', { propertyId: 'p1' })] }));
  assert.equal(planFor(r, 'a').tasks.length, 2);
}
console.log('planTasks: skills fixtures passed ✓');

// ── quotaFor: the throughput loop must not punish a fully-cleared plan ─────────────────────────
{
  const { quotaFor } = await import('../functions/utils/planTasks.js');
  const MAX = 100;

  // Cleared 40/40 with capacity raised to 80 → trust the operator's capacity, not yesterday's plan.
  assert.equal(
    quotaFor({ capacity: 80, planYesterday: { total: 40, done: 0, autoDone: 40 } }, MAX),
    80,
    '100% cleared → stretch from capacity, not from worked',
  );
  // Left work on the table → the loop still bites (25% over what they actually worked).
  assert.equal(
    quotaFor({ capacity: 80, planYesterday: { total: 80, done: 0, autoDone: 48 } }, MAX),
    60,
    'partial completion → worked × 1.25',
  );
  // …but never below the floor.
  assert.equal(
    quotaFor({ capacity: 80, planYesterday: { total: 80, done: 0, autoDone: 8 } }, MAX),
    40,
    'a bad day still gets the 40-task floor',
  );
  // No history → static capacity, unchanged.
  assert.equal(quotaFor({ capacity: 80, planYesterday: null }, MAX), 80, 'no history → capacity');
  // The rail clamps a garbage capacity, and a capacity BELOW the floor still wins.
  assert.equal(quotaFor({ capacity: 500, planYesterday: null }, MAX), MAX, 'rail clamps capacity');
  assert.equal(
    quotaFor({ capacity: 20, planYesterday: { total: 20, done: 0, autoDone: 2 } }, MAX),
    20,
    'explicit sub-floor capacity is never overridden by the floor',
  );
  console.log('planTasks: quota fixtures passed ✓');
}
