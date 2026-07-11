#!/usr/bin/env node
// Run AFTER migrate-prod.mjs, with the NEW Anthropic account's key.
// The migrated orgs still carry `github.vaultId` from the OLD Anthropic account — those
// vaults don't exist under the new key. This rebuilds a fresh vault per org from the
// migrated raw githubToken (+ re-seeds the shared Jam credential) and rewrites vaultId.
// Figma needs nothing here — it uses the REST API (orgSecrets.figma.token), not a vault.
//
//   cd functions
//   ANTHROPIC_API_KEY=sk-ant-...(new account) \
//   JAM_PAT=jam_pat_...(optional) \
//   node scripts/reprovision-vaults.mjs            # dry run
//   ... add  --commit  to actually create vaults + rewrite vaultId.
// (Uses ADC for Firestore — gcloud owner creds on mybosun-55015.)
import { initializeApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { ensureOrgGithubVault, ensureOrgJamCredential } from '../utils/vault.js';

const COMMIT = process.argv.includes('--commit');
if (!process.env.ANTHROPIC_API_KEY) { console.error('Set ANTHROPIC_API_KEY (the NEW account key).'); process.exit(1); }

const db = getFirestore(initializeApp({ projectId: 'mybosun-55015' }, 'dst'));
console.log(`Dest: mybosun-55015   commit=${COMMIT}\n`);

const orgs = await db.collection('organisations').get();
for (const o of orgs.docs) {
  const gh = o.get('github');
  if (!gh?.repoFullName) { console.log(`- ${o.id}: no repo connected, skip`); continue; }
  const secret = await db.collection('orgSecrets').doc(o.id).get();
  const token = secret.get('githubToken');
  if (!token) { console.log(`- ${o.id}: repo set but NO githubToken in orgSecrets — needs operator re-connect`); continue; }

  if (!COMMIT) { console.log(`- ${o.id}: would rebuild vault for ${gh.repoFullName} (old vaultId=${gh.vaultId})`); continue; }

  const vaultId = await ensureOrgGithubVault({ orgId: o.id, vaultId: null, token }); // fresh vault
  await ensureOrgJamCredential({ vaultId, token: process.env.JAM_PAT });
  await o.ref.set({ github: { ...gh, vaultId } }, { merge: true });
  console.log(`- ${o.id}: ✅ new vaultId=${vaultId} (${gh.repoFullName})`);
}

console.log(COMMIT ? '\n✅ Vaults rebuilt.' : '\nDRY RUN — add --commit to write.');
process.exit(0);
