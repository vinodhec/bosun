#!/usr/bin/env node
// Throwaway: inspect bosun-76bba orgs/users to plan the scoped migration. Uses ADC.
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
const db = getFirestore(initializeApp({ projectId: 'bosun-76bba' }));

const orgs = await db.collection('organisations').get();
console.log(`\n=== organisations (${orgs.size}) ===`);
for (const o of orgs.docs) {
  console.log(`  id=${o.id}  name=${JSON.stringify(o.get('name'))}  balance=${o.get('balance')}  repo=${o.get('github')?.repoFullName || '-'}  figma=${o.get('figma')?.connected || false}`);
}
const users = await db.collection('users').get();
console.log(`\n=== users (${users.size}) ===`);
for (const u of users.docs) console.log(`  uid=${u.id}  email=${u.get('email')}  orgId=${u.get('orgId')}  role=${u.get('role')}`);
process.exit(0);
