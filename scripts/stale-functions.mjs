#!/usr/bin/env node
/**
 * Which deployed Cloud Functions are still running an OLD copy of a file?
 *
 * Every function bundles its own module graph at deploy time, so a change to a shared file
 * (a price in shared/billing.js, say) only takes effect in the functions that get redeployed
 * after it. Deploying "the obvious ones" misses the transitive importers — on 2026-09-08 the
 * plan-day reprice reached planDailyTasks/sourcingPlanNow/usageMeter but not adminPlanNow
 * (adminSourcing.js → planDailyTasks.js → shared/billing.js), which kept billing the old ₹200
 * until it was noticed four days later.
 *
 * Usage (from the repo root, ADC must be able to read Cloud Functions):
 *   node scripts/stale-functions.mjs shared/billing.js            # since that file's last commit
 *   node scripts/stale-functions.mjs shared/billing.js --all      # every importer, stale or not
 *   node scripts/stale-functions.mjs shared/billing.js --since 2026-09-08T11:23:00Z
 *
 * Prints a ready-to-paste `firebase deploy --only functions:a,functions:b` line.
 */
import { readFileSync, existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve, relative } from 'node:path';
import { execSync } from 'node:child_process';

const PROJECT = 'bosun-76bba';
const REGION = 'asia-south1';
const ROOT = resolve(dirname(new URL(import.meta.url).pathname), '..');
const FN = resolve(ROOT, 'functions');

const args = process.argv.slice(2);
const target = args.find((a) => !a.startsWith('--'));
if (!target) { console.error('usage: stale-functions.mjs <file> [--all] [--since ISO]'); process.exit(2); }
const showAll = args.includes('--all');
const sinceArg = args.includes('--since') ? args[args.indexOf('--since') + 1] : null;

// /shared/* is copied into functions/shared/ at predeploy — that copy is what the graph imports.
const targetAbs = resolve(ROOT, target.replace(/^shared\//, 'functions/shared/'));
if (!existsSync(targetAbs)) { console.error(`no such file: ${targetAbs}`); process.exit(2); }

// Time the file last changed, from git, unless told otherwise.
const sinceIso = sinceArg
  || execSync(`git log -1 --format=%cI -- ${JSON.stringify(target)}`, { cwd: ROOT }).toString().trim();
const since = new Date(sinceIso);

// Walk relative imports from a file; returns the set of absolute paths reachable.
const graphCache = new Map();
function reach(file, seen = new Set()) {
  if (seen.has(file)) return seen;
  seen.add(file);
  let src = '';
  try { src = readFileSync(file, 'utf8'); } catch { return seen; }
  const re = /(?:import|export)\s[^'"]*?from\s*['"](\.{1,2}\/[^'"]+)['"]|import\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g;
  for (const m of src.matchAll(re)) {
    const rel = m[1] || m[2];
    reach(resolve(dirname(file), rel), seen);
  }
  return seen;
}

// index.js: `export { a, b } from './handlers/x.js'` — one entry per deployed function.
const index = readFileSync(resolve(FN, 'index.js'), 'utf8');
const exportsByFile = new Map();
for (const m of index.matchAll(/export\s*\{([^}]*)\}\s*from\s*['"](\.\/[^'"]+)['"]/g)) {
  const names = m[1].split(',').map((s) => s.trim().split(/\s+as\s+/).pop()).filter(Boolean);
  const file = resolve(FN, m[2]);
  exportsByFile.set(file, [...(exportsByFile.get(file) || []), ...names]);
}

const importers = [];
for (const [file, names] of exportsByFile) {
  if (!graphCache.has(file)) graphCache.set(file, reach(file));
  if (graphCache.get(file).has(targetAbs)) importers.push(...names.map((n) => ({ name: n, file: relative(FN, file) })));
}

// Deployed update times.
const require = createRequire(resolve(FN, 'package.json'));
const { GoogleAuth } = require('google-auth-library');
const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
const client = await auth.getClient();
const deployed = new Map();
let pageToken = '';
do {
  const url = `https://cloudfunctions.googleapis.com/v2/projects/${PROJECT}/locations/${REGION}/functions?pageSize=500${pageToken ? `&pageToken=${pageToken}` : ''}`;
  const { data } = await client.request({ url });
  for (const f of data.functions || []) deployed.set(f.name.split('/').pop(), f.updateTime);
  pageToken = data.nextPageToken || '';
} while (pageToken);

console.log(`${target} last changed ${since.toISOString()} — ${importers.length} deployed function(s) bundle it\n`);
const stale = [];
for (const { name, file } of importers.sort((a, b) => a.name.localeCompare(b.name))) {
  const at = deployed.get(name);
  const isStale = !at || new Date(at) < since;
  if (isStale) stale.push(name);
  if (isStale || showAll) console.log(`${isStale ? 'STALE ' : 'ok    '} ${name.padEnd(30)} ${at || '(not deployed)'}  ${file}`);
}
if (!stale.length) console.log('nothing stale.');
else console.log(`\nfirebase deploy --project ${PROJECT} --only ${stale.map((n) => `functions:${n}`).join(',')}`);
