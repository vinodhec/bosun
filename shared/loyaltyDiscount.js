// bosun/shared/loyaltyDiscount.js
/**
 * @typedef {Object} Customer
 * @property {number} totalSpending - Total spending by the customer.
 * @property {number} purchaseFrequency - Number of purchases made by the customer.
 */

/**
 * @typedef {Object} LoyaltyTier
 * @property {string} name - Name of the loyalty tier.
 * @property {number} discount - Discount percentage offered to this tier.
 */

const LOYALTY_TIERS = [
  { name: 'Gold', discount: 20, minSpending: 5000, minFrequency: 50 },
  { name: 'Silver', discount: 15, minSpending: 3000, minFrequency: 30 },
  { name: 'Bronze', discount: 10, minSpending: 1000, minFrequency: 10 },
];

/**
 * Determine the loyalty tier for a customer based on their spending and frequency.
 * @param {Customer} customer - The customer profile.
 * @returns {LoyaltyTier} The loyalty tier applicable to the customer.
 */
function loyaltyTierFor(customer) {
  for (const tier of LOYALTY_TIERS) {
    if (customer.totalSpending >= tier.minSpending && customer.purchaseFrequency >= tier.minFrequency) {
      return tier;
    }
  }
  return { name: 'None', discount: 0 };
}

export { loyaltyTierFor };
