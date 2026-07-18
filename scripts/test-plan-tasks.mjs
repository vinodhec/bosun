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
