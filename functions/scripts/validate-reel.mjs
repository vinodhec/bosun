#!/usr/bin/env node
/**
 * validate-reel.mjs — render a listing reel end to end WITHOUT Firebase.
 *
 *   node scripts/validate-reel.mjs                       # pure: synthetic photos, fallback script,
 *                                                        #   no voice, no Veo — pins the ffmpeg/canvas path
 *   VERTEX_PROJECT=bosun-76bba node scripts/validate-reel.mjs --live
 *                                                        # + gemini flash-lite script + Gemini TTS voice
 *   VERTEX_PROJECT=bosun-76bba node scripts/validate-reel.mjs --live --animated
 *                                                        # + a Veo 3.1 Lite hero clip (≈ ₹27 of COGS)
 *   … --images https://a.jpg,https://b.jpg  --locale ta  --out /path/reel.mp4
 *
 * Prints what buildReel reports (photos used, script source, voice, hero, duration, ms) and leaves
 * the mp4 + poster where --out says (default: the scratch dir it prints). Eyeball the video after
 * touching the canvas overlays or the ffmpeg filter graphs — a caption that clips or a zoom that
 * jitters shows up here before it reaches a WhatsApp status.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import ffmpegPath from 'ffmpeg-static';
import { buildReel, makeScratchDir, captionOverlayPng, endCardPng, fallbackScript, fmtInr } from '../utils/reel.js';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : ''; };
const live = flag('--live');
const animated = flag('--animated');
const locale = opt('--locale') === 'ta' ? 'ta' : 'en';
const execFileP = promisify(execFile);

let passed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`); }
  catch (e) { console.error(`  ✗ ${name}\n    ${e.message}`); process.exitCode = 1; }
}

console.log('reel: pure checks');
check('fallback script covers every photo and names the place', () => {
  const s = fallbackScript({ bhk: 2, listingType: 'rent', locality: 'Velachery', city: 'Chennai', price: 18000 }, 'en', 4);
  assert.equal(s.captions.length, 4);
  assert.match(s.hook, /2 BHK for rent in Velachery/);
  assert.match(s.voiceover, /Ask MaadiVeedu/);
  const ta = fallbackScript({ bhk: 2, listingType: 'rent', locality: 'Velachery', city: 'Chennai', price: 18000 }, 'ta', 2);
  assert.match(ta.voiceover, /மாடிவீட்டிடம்/);
});
check('price formatting', () => {
  assert.equal(fmtInr(18000, 'rent'), '₹18,000/month');
  assert.equal(fmtInr(4500000, 'sale'), '₹45 L');
  assert.equal(fmtInr(12000000), '₹1.2 Cr');
});
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
check('caption overlay renders a PNG for Latin and for Tamil (long caption, no price)', () => {
  const a = captionOverlayPng({ caption: 'Spacious & bright 2 BHK with a long balcony view over the park and more words', price: '₹18,000/month', place: 'Velachery, Chennai' });
  assert.ok(a.subarray(0, 4).equals(PNG) && a.length > 5000);
  const b = captionOverlayPng({ caption: 'வேளச்சேரியில் 2 BHK வாடகைக்கு', price: '', place: '' });
  assert.ok(b.subarray(0, 4).equals(PNG) && b.length > 5000);
});
check('end card renders a PNG with the QR', () => {
  const p = endCardPng({ listingUrl: 'https://maadiveedu.com/property/x?utm_source=reel', siteHost: 'maadiveedu.com', hook: 'A 3 BHK villa on Sathy Road with a garden', cta: 'Ask MaadiVeedu' });
  assert.ok(p.subarray(0, 4).equals(PNG) && p.length > 20000);
});

// ── A real render ───────────────────────────────────────────────────────────────────────────────
const dir = await makeScratchDir('validate-reel-');
let images = opt('--images') ? opt('--images').split(',').map((s) => s.trim()).filter(Boolean) : [];
let server = null;
if (!images.length) {
  // Synthetic "photos": three landscape frames of different colours/patterns, served from a tiny
  // local HTTP server so the fetchImage path (URL → bytes → mime) is the one that runs in prod.
  const http = await import('node:http');
  const files = [];
  const specs = [['0x8b5e3c', 'testsrc2'], ['0x3b82f6', 'smptebars'], ['0x16a34a', 'testsrc']];
  for (let i = 0; i < specs.length; i++) {
    const f = path.join(dir, `src${i}.jpg`);
    await execFileP(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `${specs[i][1]}=s=1280x853:d=1`, '-frames:v', '1', '-q:v', '3', f]);
    files.push(f);
  }
  server = http.createServer(async (req, res) => {
    const i = Number((req.url.match(/(\d+)\.jpg/) || [])[1]);
    const f = files[i];
    if (!f) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': 'image/jpeg' });
    res.end(await fs.readFile(f));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  images = files.map((_, i) => `http://127.0.0.1:${port}/${i}.jpg`);
  images.push(`http://127.0.0.1:${port}/9.jpg`); // a 404 — must be skipped, not fatal
}

const listing = {
  id: 'PROP-DEMO1', title: '2 BHK flat near Phoenix Mall', price: 18000, priceLabel: '₹18,000/month',
  listingType: 'rent', propertyType: 'apartment', bhk: 2, areaSqft: 950, locality: 'Velachery', city: 'Chennai',
  url: 'https://maadiveedu.com/property/2-bhk-flat-velachery-PROP-DEMO1',
  description: 'Second floor, covered car parking, 24-hour water, near the bus stand.',
  images,
};
if (!live) {
  // Pure mode must not touch a model: unset any ambient auth so writeScript/synthVoice degrade.
  delete process.env.GEMINI_API_KEY;
  delete process.env.VERTEX_PROJECT;
  delete process.env.GOOGLE_CLOUD_PROJECT;
  delete process.env.GCLOUD_PROJECT;
}

console.log(`\nreel: render (${live ? 'live' : 'pure'}${animated ? ', animated' : ''}, ${locale})`);
const t0 = Date.now();
const out = await buildReel({ listing, style: animated ? 'animated' : 'photo', locale, site: { name: 'MaadiVeedu', url: 'https://maadiveedu.com' }, dir, log: (...a) => console.log('   ', ...a) });
if (server) server.close();

check('a video and a poster were produced', () => {
  assert.ok(out.videoPath && out.posterPath);
});
check(`duration is sane (${out.durationSec.toFixed(1)}s)`, () => {
  assert.ok(out.durationSec > 8 && out.durationSec < 40, `got ${out.durationSec}`);
});
check('one bad photo URL was skipped, the rest used', () => {
  assert.equal(out.photos, opt('--images') ? images.length : 3);
});
check('output is 720x1280 H.264 with an audio track when voiced', async () => {
  const { stderr } = await execFileP(ffmpegPath, ['-hide_banner', '-i', out.videoPath]).catch((e) => e);
  assert.match(String(stderr), /720x1280/);
  assert.match(String(stderr), /h264/);
  if (out.voiced) assert.match(String(stderr), /Audio: aac/);
});
if (!live) check('pure mode used the fallback script and no voice', () => {
  assert.equal(out.script.source, 'fallback');
  assert.equal(out.voiced, false);
});
if (live) check('live mode wrote the script with the model and voiced it', () => {
  assert.equal(out.script.source, 'model');
  assert.equal(out.voiced, true);
});
if (animated) check(`animated delivered (${out.styleDelivered}${out.fallbackReason ? ': ' + out.fallbackReason : ''})`, () => {
  assert.equal(out.styleDelivered, 'animated');
});

const dest = opt('--out') || path.join(dir, 'reel.mp4');
if (dest !== out.videoPath) {
  await fs.copyFile(out.videoPath, dest);
  await fs.copyFile(out.posterPath, dest.replace(/\.mp4$/, '') + '-poster.jpg');
}
console.log('\n  script:', JSON.stringify(out.script));
console.log(`  ${out.styleDelivered} reel, ${out.durationSec.toFixed(1)}s, ${out.photos} photos, voiced=${out.voiced}, ${out.ms} ms render, ${Date.now() - t0} ms total`);
console.log(`  video: ${dest}`);
console.log(`\n${passed} checks passed${process.exitCode ? ', with FAILURES' : ''}`);
