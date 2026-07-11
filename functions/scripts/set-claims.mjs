#!/usr/bin/env node
// Set the orgId custom claim on the migrated users in mybosun-55015. Custom claims do NOT
// travel with auth:import or Firestore — the rules gate org + transaction reads on this claim.
// Reads the org membership straight from the migrated users collection (source of truth).
//   cd functions && node scripts/set-claims.mjs           # dry run
//   cd functions && node scripts/set-claims.mjs --commit
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';

const COMMIT = process.argv.includes('--commit');
const app = initializeApp({ projectId: 'mybosun-55015' });
const db = getFirestore(app);
const auth = getAuth(app);

const users = await db.collection('users').get();
console.log(`users=${users.size}  commit=${COMMIT}\n`);
for (const u of users.docs) {
  const orgId = u.get('orgId');
  if (!orgId) { console.log(`- ${u.id} (${u.get('email')}): no orgId, skip`); continue; }
  if (!COMMIT) { console.log(`- ${u.id} (${u.get('email')}): would set orgId=${orgId}`); continue; }
  await auth.setCustomUserClaims(u.id, { orgId });
  console.log(`- ${u.id} (${u.get('email')}): ✅ orgId=${orgId}`);
}
console.log(COMMIT ? '\n✅ Claims set.' : '\nDRY RUN — add --commit.');
process.exit(0);
