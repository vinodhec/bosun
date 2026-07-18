/**
 * Fixture tests for the session-intelligence pure functions (segmentation, demand aggregation,
 * anomaly detection). No Firebase, no network:  node scripts/test-session-intel.mjs
 */
import assert from 'node:assert/strict';
import { segmentOf, budgetBandOf, buildDemandMap, detectAnomalies } from '../functions/handlers/sessionIntelligence.js';

// 1. Segmentation precedence.
assert.equal(segmentOf({ engaged: true, pageCount: 5, flags: { enquiry: true } }), 'serious');
assert.equal(segmentOf({ engaged: true, pageCount: 5, flags: { contact: true } }), 'serious');
assert.equal(segmentOf({ engaged: true, pageCount: 5, flags: { postProperty: true, enquiry: true } }), 'seller_intent');
assert.equal(segmentOf({ engaged: true, pageCount: 5, flags: { search: true, propertyView: true } }), 'warm');
assert.equal(segmentOf({ engaged: true, pageCount: 5, flags: { wishlist: true } }), 'warm');
assert.equal(segmentOf({ engaged: false, pageCount: 1, flags: {} }), 'bounced');
assert.equal(segmentOf({ engaged: true, pageCount: 3, flags: {} }), 'browser');

// 2. Budget bands.
assert.equal(budgetBandOf(0, 0), '');
assert.equal(budgetBandOf(0, 25000), 'rent');
assert.equal(budgetBandOf(0, 2000000), '<25L');
assert.equal(budgetBandOf(2500000, 4500000), '25-50L');
assert.equal(budgetBandOf(0, 9000000), '50L-1Cr');
assert.equal(budgetBandOf(0, 15000000), '1Cr+');

// 3. Demand aggregation: grouping, unserved counting, distinct sessions, sort order.
{
  const rows = buildDemandMap([
    { sid: 'a', city: 'Chennai', locality: 'Velachery', propertyType: 'Flat / Apartment', listingType: 'Sale', bhkType: '2BHK', minPrice: 0, maxPrice: 4000000, searches: 3, freshResultCount: 5, noFreshSupply: false },
    { sid: 'b', city: 'Chennai', locality: 'Velachery', propertyType: 'Flat / Apartment', listingType: 'Sale', bhkType: '2BHK', minPrice: 0, maxPrice: 4500000, searches: 2, freshResultCount: 0, noFreshSupply: true },
    { sid: 'a', city: 'Chennai', locality: 'Porur', propertyType: '', listingType: 'Rent', bhkType: '', minPrice: 0, maxPrice: 15000, searches: 1, freshResultCount: 2, noFreshSupply: false },
    { sid: 'c', city: '', locality: '', propertyType: '', listingType: '', bhkType: '', minPrice: 0, maxPrice: 0, searches: 9, freshResultCount: 0, noFreshSupply: false }, // no place → dropped
  ]);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].locality, 'Velachery'); // 5 searches beats 1
  assert.equal(rows[0].searchedCount, 5);
  assert.equal(rows[0].unservedCount, 2);
  assert.equal(rows[0].sessions, 2); // a + b
  assert.equal(rows[1].budgetBand, 'rent');
}

// 4. Anomalies: spike + drop against the trailing average; silent when history is thin.
{
  const baseline = Array.from({ length: 7 }, () => ({ sessions: 100, leads: 10, searches: 50 }));
  const spike = detectAnomalies({ sessions: 250, leads: 10, searches: 50 }, baseline);
  assert.equal(spike.length, 1);
  assert.equal(spike[0].kind, 'sessions-spike');
  const drop = detectAnomalies({ sessions: 100, leads: 3, searches: 50 }, baseline);
  assert.equal(drop.length, 1);
  assert.equal(drop[0].kind, 'leads-drop');
  assert.equal(drop[0].severity, 'high');
  assert.equal(detectAnomalies({ sessions: 100, leads: 10, searches: 50 }, []).length, 0); // no history → quiet
  assert.equal(detectAnomalies({ sessions: 9, leads: 0, searches: 0 }, [{ sessions: 2, leads: 1, searches: 1 }]).length, 0); // baseline < 5 → too thin to judge
}

console.log('sessionIntelligence: all fixture tests passed ✓');
