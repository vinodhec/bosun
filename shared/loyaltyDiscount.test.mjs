// bosun/shared/loyaltyDiscount.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { loyaltyTierFor } from './loyaltyDiscount.js';

const tests = [
  { customer: { totalSpending: 6000, purchaseFrequency: 60 }, expected: 'Gold' },
  { customer: { totalSpending: 3500, purchaseFrequency: 35 }, expected: 'Silver' },
  { customer: { totalSpending: 1500, purchaseFrequency: 15 }, expected: 'Bronze' },
  { customer: { totalSpending: 500, purchaseFrequency: 5 }, expected: 'None' },
];

test('Loyalty Tier determination', () => {
  for (const { customer, expected } of tests) {
    const result = loyaltyTierFor(customer);
    assert.strictEqual(result.name, expected);
  }
});
