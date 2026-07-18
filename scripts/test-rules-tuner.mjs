/**
 * Fixture tests for the nightly rules tuner + dev-task proposer.  node scripts/test-rules-tuner.mjs
 */
import assert from 'node:assert/strict';
import { tuneRules, rollupActions, buildDevTaskProposals } from '../functions/utils/rulesTuner.js';

const overlayRule = (id, threshold) => ({
  id,
  enabled: true,
  trigger: { kind: 'property_views', threshold },
  conditions: { guestOnly: true, contextAny: [] },
  action: { kind: 'login_popup', slot: 'overlay', lang: 'en' },
  perSession: 1,
  priority: 10,
  reason: 'baseline',
});
const act = (ruleId, event, count) => ({ ruleId, actionKind: 'login_popup', event, count });

// 1. Rollup sums per rule/event class.
{
  const r = rollupActions([act('a', 'shown', 30), act('a', 'login_success', 3), act('a', 'dismissed', 10)]);
  assert.deepEqual(r.a, { shown: 30, dismissed: 10, converted: 3 });
}

// 2. Low conversion on real volume → threshold raised by 1, with a reason.
{
  const { rules, changes } = tuneRules([overlayRule('a', 3)], [act('a', 'shown', 40), act('a', 'login_success', 1)]);
  assert.equal(rules[0].trigger.threshold, 4);
  assert.equal(changes.length, 1);
  assert.match(changes[0].why, /firing too early/);
}

// 3. High conversion → threshold lowered (capture sooner), never below the overlay floor.
{
  const { rules } = tuneRules([overlayRule('a', 3)], [act('a', 'shown', 40), act('a', 'login_success', 15)]);
  assert.equal(rules[0].trigger.threshold, 2);
  const floor = tuneRules([overlayRule('b', 2)], [act('b', 'shown', 40), act('b', 'login_success', 15)]);
  assert.equal(floor.rules[0].trigger.threshold, 2, 'never below overlay floor');
}

// 4. Heavy dismissal → +2, capped at the ceiling.
{
  const { rules } = tuneRules([overlayRule('a', 9)], [act('a', 'shown', 40), act('a', 'dismissed', 36)]);
  assert.equal(rules[0].trigger.threshold, 10);
}

// 5. No volume → no touch; slot rules pass through untouched.
{
  const slotRule = { ...overlayRule('card', 1), action: { kind: 'properties_card', slot: 'blog_inline', lang: 'en' } };
  const { rules, changes } = tuneRules([overlayRule('a', 3), slotRule], [act('a', 'shown', 5), act('card', 'shown', 500)]);
  assert.equal(rules[0].trigger.threshold, 3);
  assert.equal(rules[1].trigger.threshold, 1);
  assert.equal(changes.length, 0);
}

// 6. Proposals: login-wall drop-off (need-human label), stable fingerprint, ≤2 per night.
{
  const sessions = [
    ...Array.from({ length: 30 }, () => ({ dropOffStage: 'dropped_at_login' })),
    ...Array.from({ length: 70 }, () => ({ dropOffStage: 'browsed_only' })),
  ];
  const digest = {
    sessions,
    anomalies: [
      { severity: 'high', metric: 'leads', message: 'Leads dropped: 2 vs ~10/day.' },
      { severity: 'high', metric: 'sessions', message: 'Sessions dropped hard.' },
    ],
    planCompletion: [{ adminUid: 'a', adminName: 'A', total: 30, done: 2, skipped: 1, autoDone: 2 }],
  };
  const proposals = buildDevTaskProposals(digest);
  assert.equal(proposals.length, 2, 'capped at 2 per night');
  assert.equal(proposals[0].fingerprint, 'login-wall-drop-off');
  assert.ok(proposals[0].labels.includes('need-human'), 'auth-adjacent goes to need-human');
  // Same digest tomorrow → same fingerprints (dedup happens by doc id platform-side).
  assert.deepEqual(proposals.map((p) => p.fingerprint), buildDevTaskProposals(digest).map((p) => p.fingerprint));
}

// 7. Quiet day → no proposals.
{
  assert.equal(buildDevTaskProposals({ sessions: [], anomalies: [], planCompletion: [] }).length, 0);
}

console.log('rulesTuner: all fixture tests passed ✓');
