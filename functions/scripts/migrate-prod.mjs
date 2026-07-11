#!/usr/bin/env node
// One-time production migration: copy ONE org (MaadiVeedu - Unified) + its users + its
// secrets from the old Bosun project (bosun-76bba) into the new prod project (mybosun-55015).
// Uses ADC (gcloud owner creds on both projects) — no service-account key files needed.
//
// Copies, doc IDs preserved (uid/orgId must match Auth + claims):
//   - organisations/<ORG_ID>        — with balance FORCED to BALANCE_OVERRIDE (3000)
//   - orgSecrets/<ORG_ID>           — raw githubToken + figma.token (rebuild vaults after)
//   - users where orgId == ORG_ID   — the 5 members
// Other orgs (Sarran, MaadiVeedu) are intentionally left behind. Tasks/chats/features/
// transactions/etc. are NOT copied — the new system starts blank.
//
//   cd functions
//   node scripts/migrate-prod.mjs             # DRY RUN — prints what it would write
//   node scripts/migrate-prod.mjs --commit    # actually write
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const COMMIT = process.argv.includes('--commit');
const ORG_ID = 'q0u3BNn2Hy7CowRYEilC';        // MaadiVeedu - Unified
const BALANCE_OVERRIDE = 3000;

const src = getFirestore(initializeApp({ projectId: 'bosun-76bba' }, 'src'));
const dst = getFirestore(initializeApp({ projectId: 'mybosun-55015' }, 'dst'));
console.log(`org=${ORG_ID}  balance→${BALANCE_OVERRIDE}  commit=${COMMIT}\n`);

// --- organisation (balance overridden) ---
const orgSnap = await src.collection('organisations').doc(ORG_ID).get();
if (!orgSnap.exists) { console.error('source org not found'); process.exit(1); }
const orgData = { ...orgSnap.data(), balance: BALANCE_OVERRIDE };
console.log(`organisations/${ORG_ID}: name=${JSON.stringify(orgData.name)} balance ${orgSnap.get('balance')}→${BALANCE_OVERRIDE} repo=${orgData.github?.repoFullName || '-'}`);

// --- orgSecrets ---
const secSnap = await src.collection('orgSecrets').doc(ORG_ID).get();
console.log(`orgSecrets/${ORG_ID}: ${secSnap.exists ? `githubToken=${!!secSnap.get('githubToken')} figma=${!!secSnap.get('figma')?.token}` : 'MISSING'}`);

// --- users of this org ---
const usersSnap = await src.collection('users').where('orgId', '==', ORG_ID).get();
console.log(`users (${usersSnap.size}):`);
usersSnap.forEach((u) => console.log(`  ${u.id}  ${u.get('email')}  role=${u.get('role')}`));

if (!COMMIT) { console.log('\nDRY RUN — add --commit to write.'); process.exit(0); }

await dst.collection('organisations').doc(ORG_ID).set(orgData);
if (secSnap.exists) await dst.collection('orgSecrets').doc(ORG_ID).set(secSnap.data());
for (const u of usersSnap.docs) await dst.collection('users').doc(u.id).set(u.data());
console.log(`\n✅ Wrote org + ${secSnap.exists ? 'secrets + ' : ''}${usersSnap.size} users to mybosun-55015.`);
process.exit(0);
