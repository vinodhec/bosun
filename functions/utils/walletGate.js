import { HttpsError } from 'firebase-functions/v2/https';
import { blocksNewWork, isServicePaused } from './billing.js';

// The wallet gate on NEW agent work. An org in the red cannot START anything that spends COGS —
// chat & build, a fix, a feature plan or build step, a design, a comparison. See the rationale on
// `blocksNewWork` in shared/billing.js; the customer wording lives there too.
//
// The waiver is the operator's: an org with 'agent_work' in `billingPaused` is free by decision
// (testing / goodwill), so its balance can never be the reason to withhold the work.
export const AGENT_WORK_SERVICE = 'agent_work';

// Throw if this org can't start new work. Callers that already hold the org doc use this one.
export function assertCanStartWork(org) {
  if (!org) throw new HttpsError('failed-precondition', 'NO_ORG');
  if (isServicePaused(org, AGENT_WORK_SERVICE)) return;
  if (blocksNewWork(org.balance)) throw new HttpsError('failed-precondition', 'LOW_BALANCE');
}

// Load the org and assert the same. Returns the org data so a caller can reuse it.
export async function assertOrgCanStartWork(db, orgId) {
  if (!orgId) throw new HttpsError('failed-precondition', 'NO_ORG');
  const snap = await db.collection('organisations').doc(orgId).get();
  if (!snap.exists) throw new HttpsError('failed-precondition', 'NO_ORG');
  const org = snap.data();
  assertCanStartWork(org);
  return org;
}
