/**
 * Drive the REAL auto top-up (handlers/autoTopUp.js#runAutoTopUp + utils/walletCredit.js) against an
 * in-memory Firestore and assert the credit-line guards: it fires below the threshold, issues an
 * UNPAID invoice from the shared SW/ counter, never fires twice while an invoice is outstanding,
 * honours the monthly cap, and is a no-op above the line or when switched off.
 *
 * No Firebase, no network. Run:  cd functions && node scripts/validate-auto-topup.mjs
 */
import assert from 'node:assert/strict';
import { runAutoTopUp } from '../handlers/autoTopUp.js';
import { autoTopUpDecision, normalizeAutoTopUp, istMonthKey } from '../utils/autoTopUp.js';

// ── Minimal in-memory Firestore: transactions stage writes and apply them on commit.
const snapOf = (store, path) => {
  const d = store.get(path);
  return { exists: d !== undefined, id: path.split('/').pop(), data: () => d, get: (k) => d?.[k] };
};
const setPath = (obj, dotted, v) => {
  const keys = dotted.split('.'); let o = obj;
  for (const k of keys.slice(0, -1)) o = o[k] = { ...(o[k] || {}) };
  o[keys.at(-1)] = v;
};
class FakeDb {
  constructor() { this.store = new Map(); this.n = 0; }
  collection(c) {
    return { doc: (id) => ({ path: `${c}/${id || `auto${++this.n}`}`, get id() { return this.path.split('/').pop(); } }) };
  }
  async runTransaction(fn) {
    const ops = [];
    const out = await fn({
      get: async (ref) => snapOf(this.store, ref.path),
      set: (ref, d, opts) => ops.push(() => this.store.set(ref.path, { ...(opts?.merge ? this.store.get(ref.path) : {}), ...d })),
      update: (ref, d) => ops.push(() => {
        const cur = structuredClone(this.store.get(ref.path) || {});
        for (const [k, v] of Object.entries(d)) setPath(cur, k, v);
        this.store.set(ref.path, cur);
      }),
    });
    ops.forEach((op) => op());
    return out;
  }
  under(prefix) { return [...this.store.entries()].filter(([p]) => p.startsWith(prefix)).map(([, v]) => v); }
}

const ORG = 'organisations/o1';
const db = new FakeDb();
const org = () => db.store.get(ORG);
db.store.set(ORG, {
  name: 'Acme', balance: 450,
  autoTopUp: { enabled: true, thresholdInr: 200, amountInr: 1000, maxPerMonth: 2, maxUnpaid: 1 },
});

// 1. Above the threshold → nothing.
assert.equal(await runAutoTopUp(db, 'o1'), null);
assert.equal(org().balance, 450);

// 2. A debit pulls it under → one credit, one UNPAID invoice, one ledger row, state bumped.
db.store.set(ORG, { ...org(), balance: 150 });
const r1 = await runAutoTopUp(db, 'o1');
assert.ok(r1, 'should fire below threshold');
assert.equal(org().balance, 1150);
const [inv] = db.under('invoices/');
assert.equal(inv.paymentStatus, 'unpaid');
assert.equal(inv.source, 'auto_topup');
assert.equal(inv.creditInr, 1000);
assert.match(inv.number, /^SW\//);
const [txn] = db.under('transactions/');
assert.equal(txn.type, 'credit');
assert.equal(txn.amount, 1000);
assert.equal(txn.source, 'auto_topup');
assert.equal(txn.by, 'system:auto-topup');
assert.deepEqual(
  { unpaid: org().autoTopUpState.unpaid, due: org().autoTopUpState.unpaidCreditInr, n: org().autoTopUpState.monthCount },
  { unpaid: 1, due: 1000, n: 1 },
);
assert.equal(org().autoTopUpState.lastInvoiceNumber, inv.number);

// 3. A redelivered trigger right after (now above the line) → no-op.
assert.equal(await runAutoTopUp(db, 'o1'), null);

// 4. Spent down again while the first invoice is unpaid → blocked by maxUnpaid.
db.store.set(ORG, { ...org(), balance: -40 });
assert.equal(await runAutoTopUp(db, 'o1'), null);
assert.equal(autoTopUpDecision(org()).reason, 'unpaid_limit');
assert.equal(db.under('invoices/').length, 1);

// 5. The payment is recorded (what utils/receivables.js#recordPayment does to the org) → the next one fires.
db.store.set(ORG, { ...org(), autoTopUpState: { ...org().autoTopUpState, unpaid: 0, unpaidCreditInr: 0 } });
assert.ok(await runAutoTopUp(db, 'o1'));
assert.equal(org().balance, 960);
assert.equal(db.under('invoices/').length, 2);
assert.equal(db.store.get('counters/invoices')[Object.keys(db.store.get('counters/invoices'))[0]], 2, 'gapless counter');

// 6. Monthly cap (2) reached → blocked even with nothing unpaid.
db.store.set(ORG, { ...org(), balance: 0, autoTopUpState: { ...org().autoTopUpState, unpaid: 0, unpaidCreditInr: 0 } });
assert.equal(await runAutoTopUp(db, 'o1'), null);
assert.equal(autoTopUpDecision(org()).reason, 'monthly_limit');
// …and a new IST month resets it.
assert.equal(autoTopUpDecision({ ...org(), autoTopUpState: { ...org().autoTopUpState, month: '2000-01' } }).fire, true);

// 7. Switched off → nothing.
db.store.set(ORG, { ...org(), autoTopUp: { ...org().autoTopUp, enabled: false }, autoTopUpState: {} });
assert.equal(await runAutoTopUp(db, 'o1'), null);

// 8. Config validation.
assert.ok(normalizeAutoTopUp({ enabled: true, thresholdInr: 0, amountInr: 500 }).config);
assert.deepEqual(normalizeAutoTopUp({ enabled: true, thresholdInr: 200, amountInr: 1000 }).config,
  { enabled: true, thresholdInr: 200, amountInr: 1000, maxPerMonth: 4, maxUnpaid: 1 });
assert.ok(normalizeAutoTopUp({ thresholdInr: -1, amountInr: 500 }).error);
assert.ok(normalizeAutoTopUp({ thresholdInr: 100, amountInr: 50 }).error);
assert.ok(normalizeAutoTopUp({ thresholdInr: 100, amountInr: 500, maxUnpaid: 0 }).error);

// 9. IST month boundary: 2026-10-31 19:00 UTC is already November in India.
assert.equal(istMonthKey(Date.UTC(2026, 9, 31, 19, 0)), '2026-11');

console.log('validate-auto-topup: all checks passed');
