#!/usr/bin/env node
/**
 * make-reel.mjs — make ONE listing reel by hand, no Firebase (operator demo / eyeballing tool).
 *
 *   VERTEX_PROJECT=bosun-76bba node scripts/make-reel.mjs listing.json --out reel.mp4 [--animated] [--locale ta]
 *
 * listing.json = the same shape the platform's make_reel tool sends (see handlers/reelJobs.js):
 *   { id, title, price, priceLabel, listingType, propertyType, bhk, areaSqft, locality, city, url,
 *     description, images:[url…] }
 * Nothing is uploaded or billed — the file lands where --out says.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { buildReel, makeScratchDir } from '../utils/reel.js';

const argv = process.argv.slice(2);
const file = argv.find((a) => !a.startsWith('--'));
if (!file) { console.error('usage: make-reel.mjs listing.json --out reel.mp4 [--animated] [--locale ta]'); process.exit(2); }
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : ''; };
const listing = JSON.parse(await fs.readFile(file, 'utf8'));
const style = argv.includes('--animated') ? 'animated' : 'photo';
const locale = opt('--locale') === 'ta' ? 'ta' : 'en';
const out = path.resolve(opt('--out') || `reel-${listing.id || 'demo'}-${style}-${locale}.mp4`);

const dir = await makeScratchDir('make-reel-');
const t0 = Date.now();
const r = await buildReel({ listing, style, locale, site: { name: 'MaadiVeedu', url: 'https://www.maadiveedu.com' }, dir, log: (...a) => console.log('  ', ...a) });
await fs.copyFile(r.videoPath, out);
await fs.copyFile(r.posterPath, out.replace(/\.mp4$/, '') + '-poster.jpg');
await fs.rm(dir, { recursive: true, force: true });
console.log(JSON.stringify({ styleDelivered: r.styleDelivered, fallbackReason: r.fallbackReason, durationSec: r.durationSec, photos: r.photos, voiced: r.voiced, script: r.script, ms: Date.now() - t0 }, null, 2));
console.log('video:', out);
