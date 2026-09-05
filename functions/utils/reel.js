/**
 * Listing reel maker — turns ONE property listing into a 9:16 video for WhatsApp status / Instagram.
 *
 * What a reel is (photo style, ~20 s):
 *   [photo 1 … photo N, ~3 s each, slow Ken-Burns move, caption + price overlaid]
 *   [end card, 3 s: "Ask MaadiVeedu" + a QR to the listing]
 *   + a voice-over in the visitor's language (Gemini TTS) over the whole thing.
 * The animated style opens on a 6 s Veo 3.1 Lite clip animated FROM the cover photo (subtle camera
 * move, nothing invented), then continues with the remaining photos exactly as above.
 *
 * Where each piece runs, and why:
 *   - script   : gemini flash-lite writes the hook, per-photo captions and the voice-over — one JSON
 *                call, deterministic fallback if it fails (a reel must never fail on words).
 *   - voice    : gemini-2.5-flash-preview-tts (24 kHz PCM) — Tamil, English and Tanglish all work.
 *   - hero     : Veo 3.1 Lite image-to-video on the SAME Vertex project/location the assistant uses
 *                (utils/gemini.js). Returns bytes, no GCS round trip. RAI-filtered or failed → the
 *                job degrades to photo style; the caller bills the cheaper line.
 *   - captions : drawn on a canvas (@napi-rs/canvas — Skia, prebuilt, shapes Tamil correctly) with
 *                our bundled Noto fonts and written out as transparent PNGs. NOT ffmpeg's drawtext —
 *                the static ffmpeg 7 build has no harfbuzz, so no drawtext at all — and not SVG via
 *                resvg, which drew Tamil vowel signs in the wrong place.
 *   - render   : ffmpeg-static. Every segment is encoded with identical x264 settings so the final
 *                concat is a stream copy; only the audio mux re-encodes.
 *   - storage  : Firebase Storage under reels/{orgId}/{jobId}/, served through unguessable
 *                download-token URLs (the same pattern as utils/compareShots.js). Bosun never
 *                streams video itself.
 *
 * Everything here is pure "make a file" logic — no Firestore, no billing. handlers/reelJobs.js owns
 * the job lifecycle and the meter.
 */
import ffmpegPath from 'ffmpeg-static';
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
import qrcode from 'qrcode-generator';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { getStorage } from 'firebase-admin/storage';
import { geminiClient, generateJson, GEMINI_FLASH_LITE } from './gemini.js';

const execFileP = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FONT_DIR = path.join(HERE, '..', 'assets', 'fonts');
// Registered once per process. Family order in the CSS font string decides fallback: Tamil first so
// Tamil clusters shape inside one font; Latin/digits fall through to Noto Sans.
GlobalFonts.registerFromPath(path.join(FONT_DIR, 'NotoSansTamil-Bold.ttf'), 'Noto Sans Tamil');
GlobalFonts.registerFromPath(path.join(FONT_DIR, 'NotoSans-Bold.ttf'), 'Noto Sans');
GlobalFonts.registerFromPath(path.join(FONT_DIR, 'NotoSans-Regular.ttf'), 'Noto Sans');
// Tamil-first for Tamil strings (so a cluster shapes inside one font); Latin-first otherwise — the
// Tamil face is bold-only, and Latin-first keeps digits in a regular-weight line regular.
const FAMILY_TA = '"Noto Sans Tamil", "Noto Sans"';
const FAMILY_EN = '"Noto Sans", "Noto Sans Tamil"';
const famFor = (text) => (hasTamil(text) ? FAMILY_TA : FAMILY_EN);

export const REEL_W = 720;
export const REEL_H = 1280;
export const FPS = 24;
/** Seconds each photo holds, at least. Stretched (up to MAX_PHOTO_SECONDS) so the voice-over fits:
 *  3.2 × 5 photos + 3 s end card ≈ 19 s; a 3-photo listing with an 18 s voice holds each ~5.5 s.
 *  A WhatsApp status is 30 s max — MAX_TOTAL_SECONDS keeps every reel under it. */
export const PHOTO_SECONDS = 3.2;
export const MAX_PHOTO_SECONDS = 7;
export const MAX_TOTAL_SECONDS = 29;
export const MAX_PHOTOS = 5;
export const END_CARD_SECONDS = 3;
export const HERO_SECONDS = 6;
export const TTS_MODEL = 'gemini-2.5-flash-preview-tts';
export const VEO_MODEL = 'veo-3.1-lite-generate-001';
/** Veo Lite takes 40–120 s for 6 s of 720p; give it up to 4 minutes before we fall back to photos. */
const VEO_POLL_MS = 6000;
const VEO_MAX_WAIT_MS = 240_000;
const IMAGE_FETCH_TIMEOUT_MS = 15_000;
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;

// ── Small helpers ────────────────────────────────────────────────────────────────────────────────

/** Word-wrap by MEASURED width (script-agnostic — Tamil glyphs are wide, digits narrow). */
function wrapLines(ctx, text, maxWidth, maxLines) {
  const words = String(text || '').trim().split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  for (const w of words) {
    const next = (cur + ' ' + w).trim();
    if (ctx.measureText(next).width > maxWidth && cur) {
      lines.push(cur);
      cur = w;
      if (lines.length === maxLines) break;
    } else {
      cur = next;
    }
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  const shown = lines.join(' ');
  if (lines.length === maxLines && shown.length < words.join(' ').length) {
    let last = lines[maxLines - 1];
    while (last && ctx.measureText(last + '…').width > maxWidth) last = last.replace(/\s*\S+$/, '');
    lines[maxLines - 1] = (last || lines[maxLines - 1].slice(0, -2)) + '…';
  }
  return lines;
}

function hasTamil(s) {
  return /[\u0B80-\u0BFF]/.test(String(s || ''));
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export function fmtInr(n, listingType) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '';
  const trim = (x) => String(x).replace(/\.0+$|(\.\d*?)0+$/, '$1');
  let s;
  if (v >= 1e7) s = `₹${trim((v / 1e7).toFixed(2))} Cr`;
  else if (v >= 1e5) s = `₹${trim((v / 1e5).toFixed(1))} L`;
  else s = `₹${Math.round(v).toLocaleString('en-IN')}`;
  return listingType === 'rent' ? `${s}/month` : s;
}

function bhkWord(listing) {
  const n = Number(listing.bhk);
  if (Number.isFinite(n) && n > 0) return `${n} BHK`;
  const t = String(listing.propertyType || '');
  return t === 'plot' ? 'Plot' : t === 'commercial' ? 'Commercial space' : t === 'pg' ? 'PG' : t ? t[0].toUpperCase() + t.slice(1) : 'Home';
}

function placeWord(listing) {
  return [listing.locality, listing.city].filter(Boolean).join(', ');
}

async function ffmpeg(args, { timeoutMs = 240_000 } = {}) {
  try {
    await execFileP(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 });
  } catch (e) {
    const err = String(e?.stderr || e?.message || e).slice(0, 600);
    throw new Error(`ffmpeg: ${err}`);
  }
}

// ── 1. Words: script + voice ─────────────────────────────────────────────────────────────────────

/** Deterministic words for when the model is unavailable — a reel never fails on copy. */
export function fallbackScript(listing, locale, photoCount) {
  const bhk = bhkWord(listing);
  const place = placeWord(listing) || listing.city || '';
  const price = listing.priceLabel || fmtInr(listing.price, listing.listingType);
  const forWhat = listing.listingType === 'rent' ? (locale === 'ta' ? 'வாடகைக்கு' : 'for rent') : (locale === 'ta' ? 'விற்பனைக்கு' : 'for sale');
  const hook = locale === 'ta' ? `${place ? place + 'யில் ' : ''}${bhk} ${forWhat}` : `${bhk} ${forWhat}${place ? ' in ' + place : ''}`;
  const pool = locale === 'ta'
    ? ['விசாலமான அறைகள்', 'நல்ல வெளிச்சம்', 'தயாராக இருக்கிறது', 'இன்றே பாருங்கள்', 'உடனே தொடர்பு கொள்ளுங்கள்']
    : ['Spacious and bright', 'Ready to move in', 'See every corner', 'Ask for a visit today', 'Owner-direct, no brokerage'];
  const captions = Array.from({ length: photoCount }, (_, i) => (i === 0 ? hook : pool[(i - 1) % pool.length]));
  const voiceover = locale === 'ta'
    ? `${place ? place + 'யில் ' : ''}${bhk} ${forWhat}. ${price ? 'விலை ' + price + '.' : ''} முழு விவரங்களுக்கும் பார்வையிடவும் மாடிவீட்டிடம் கேளுங்கள்.`
    : `${bhk} ${forWhat}${place ? ' in ' + place : ''}. ${price ? price + '.' : ''} Ask MaadiVeedu for details or to arrange a visit.`;
  return { hook, captions, voiceover, cta: locale === 'ta' ? 'மாடிவீட்டிடம் கேளுங்கள்' : 'Ask MaadiVeedu' };
}

/**
 * The reel's words from gemini flash-lite: a hook, one short caption per photo, and a 12–18 second
 * voice-over in the visitor's language. Facts are pinned to the listing fields we pass — the model
 * is told it may not add rooms, amenities or numbers the listing does not state.
 */
export async function writeScript(listing, locale, photoCount) {
  const fallback = fallbackScript(listing, locale, photoCount);
  const lang = locale === 'ta' ? 'Tamil (Tamil script)' : 'English';
  const facts = {
    type: listing.propertyType || '', bhk: listing.bhk || null, listingType: listing.listingType || '',
    price: listing.priceLabel || fmtInr(listing.price, listing.listingType), areaSqft: listing.areaSqft || null,
    locality: listing.locality || '', city: listing.city || '', title: listing.title || '',
    description: String(listing.description || '').slice(0, 300),
  };
  const out = await generateJson({
    model: GEMINI_FLASH_LITE,
    system:
      'You write the words for a 20-second vertical property video (a reel) shown on WhatsApp in Tamil Nadu, India. ' +
      'Warm, plain, confident. Use ONLY the facts given — never invent rooms, amenities, floors, distances, numbers or a price. ' +
      'No hashtags, no emojis, no exclamation marks in captions.',
    prompt:
      `Language: ${lang}.\nListing facts (JSON): ${JSON.stringify(facts)}\nPhotos: ${photoCount}.\n` +
      `Return JSON: { "hook": <one caption for the first photo, max 6 words, says what and where>, ` +
      `"captions": [<exactly ${photoCount} captions, first = hook, each max 6 words, one idea each, no repeats>], ` +
      `"voiceover": <the spoken script, about ${20 + 6 * photoCount} words (never more than ${30 + 6 * photoCount}), natural speech, mention what it is, where, the price if given, and end by saying to ask MaadiVeedu to visit>, ` +
      `"cta": <max 4 words inviting them to ask MaadiVeedu> }`,
    schema: {
      type: 'object',
      properties: {
        hook: { type: 'string' },
        captions: { type: 'array', items: { type: 'string' } },
        voiceover: { type: 'string' },
        cta: { type: 'string' },
      },
      required: ['hook', 'captions', 'voiceover'],
    },
    temperature: 0.4,
    maxOutputTokens: 600,
    thinkingBudget: 0,
  });
  if (!out || !out.voiceover) return { ...fallback, source: 'fallback' };
  const captions = Array.isArray(out.captions) ? out.captions.map((c) => String(c || '').trim().slice(0, 60)) : [];
  while (captions.length < photoCount) captions.push(fallback.captions[captions.length] || '');
  return {
    hook: String(out.hook || captions[0] || fallback.hook).slice(0, 60),
    captions: captions.slice(0, photoCount),
    voiceover: String(out.voiceover).slice(0, 700),
    cta: String(out.cta || fallback.cta).slice(0, 40),
    source: 'model',
  };
}

/**
 * Gemini TTS → raw 16-bit mono PCM at 24 kHz (what the preview model returns as audio/L16). ffmpeg
 * reads it with `-f s16le -ar 24000 -ac 1`. Returns null on any failure — the reel goes out silent
 * rather than not at all.
 */
export async function synthVoice(text, locale) {
  const ai = geminiClient();
  if (!ai || !text) return null;
  const direction = locale === 'ta'
    ? 'Read this in natural Tamil, warmly, like a friendly property host, at an easy pace: '
    : 'Read this warmly, like a friendly property host, at an easy pace: ';
  try {
    const resp = await ai.models.generateContent({
      model: TTS_MODEL,
      contents: direction + text,
      config: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } },
      },
    });
    const part = resp.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
    if (!part) return null;
    const mime = String(part.inlineData.mimeType || '');
    const rate = Number((mime.match(/rate=(\d+)/) || [])[1]) || 24000;
    return { pcm: Buffer.from(part.inlineData.data, 'base64'), sampleRate: rate };
  } catch (e) {
    console.error('reel:tts:err', String(e?.message || e).slice(0, 300));
    return null;
  }
}

// ── 2. Pictures: photos, hero clip, overlays ─────────────────────────────────────────────────────

export async function fetchImage(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), IMAGE_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { accept: 'image/*' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const type = String(res.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!type.startsWith('image/')) throw new Error(`not an image: ${type}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > MAX_IMAGE_BYTES) throw new Error(`bad size ${buf.length}`);
    return { data: buf, mimeType: type === 'image/jpg' ? 'image/jpeg' : type };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Veo 3.1 Lite, image → 6 s of 9:16 720p video, from the listing's OWN cover photo. The prompt
 * forbids invention — this is a camera move over the real room, not an imagined house (a fake
 * balcony in a property ad is misrepresentation). Returns the mp4 bytes, or throws with a reason
 * (`filtered`, `timeout`, or the API error) so the caller can degrade to photos.
 */
export async function veoHeroClip(image, listing) {
  const ai = geminiClient();
  if (!ai) throw new Error('gemini not configured');
  const what = `${bhkWord(listing)} ${listing.propertyType === 'plot' ? 'plot' : 'home'}`;
  const prompt =
    `Slow, smooth cinematic camera move over this exact ${what}: a gentle push-in with slight parallax, ` +
    'like a steady handheld walk-through. Keep every wall, window, floor, object and colour exactly as in the photo. ' +
    'Do not add people, text, furniture or anything not in the photo. Natural daylight, realistic, calm.';
  let op = await ai.models.generateVideos({
    model: VEO_MODEL,
    prompt,
    image: { imageBytes: image.data.toString('base64'), mimeType: image.mimeType },
    config: { aspectRatio: '9:16', durationSeconds: HERO_SECONDS, resolution: '720p', numberOfVideos: 1 },
  });
  const started = Date.now();
  while (!op.done) {
    if (Date.now() - started > VEO_MAX_WAIT_MS) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, VEO_POLL_MS));
    op = await ai.operations.getVideosOperation({ operation: op });
  }
  if (op.error) throw new Error(`veo: ${String(op.error.message || JSON.stringify(op.error)).slice(0, 200)}`);
  const video = op.response?.generatedVideos?.[0]?.video;
  if (!video?.videoBytes) {
    const filtered = Number(op.response?.raiMediaFilteredCount) > 0;
    throw new Error(filtered ? 'filtered' : 'no video returned');
  }
  return Buffer.from(video.videoBytes, 'base64');
}

/**
 * The per-photo overlay: a small "MaadiVeedu" tag top-left, and at the bottom a dark gradient with
 * the caption, the price and the place. Drawn once per photo as a transparent 720×1280 PNG and
 * composited by ffmpeg — see the module note on why not drawtext.
 */
export function captionOverlayPng({ caption, price, place, siteName = 'MaadiVeedu' }) {
  const canvas = createCanvas(REEL_W, REEL_H);
  const ctx = canvas.getContext('2d');
  // Bottom gradient.
  const g = ctx.createLinearGradient(0, REEL_H - 540, 0, REEL_H);
  g.addColorStop(0, 'rgba(0,0,0,0)');
  g.addColorStop(1, 'rgba(0,0,0,0.84)');
  ctx.fillStyle = g;
  ctx.fillRect(0, REEL_H - 540, REEL_W, 540);
  // Site tag.
  ctx.font = `bold 24px ${famFor(siteName)}`;
  const tagW = ctx.measureText(siteName).width + 40;
  ctx.fillStyle = 'rgba(0,0,0,0.45)';
  roundRect(ctx, 28, 44, tagW, 44, 18);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.textBaseline = 'middle';
  ctx.fillText(siteName, 48, 67);
  // Text block, bottom-anchored: caption (≤2 lines), price, place.
  ctx.textBaseline = 'alphabetic';
  const tamil = hasTamil(caption);
  const capSize = tamil ? 46 : 50;
  const lineH = tamil ? 66 : 60;
  ctx.font = `bold ${capSize}px ${famFor(caption)}`;
  const lines = wrapLines(ctx, caption, REEL_W - 80, 2);
  let y = REEL_H - 96;
  if (place) {
    ctx.font = `30px ${famFor(place)}`;
    ctx.fillStyle = 'rgba(255,255,255,0.88)';
    ctx.fillText(place, 40, y);
    y -= 50;
  }
  if (price) {
    ctx.font = `bold 46px ${FAMILY_EN}`;
    ctx.fillStyle = '#facc15';
    ctx.fillText(price, 40, y);
    y -= 66;
  }
  ctx.font = `bold ${capSize}px ${famFor(caption)}`;
  ctx.fillStyle = '#ffffff';
  for (let i = lines.length - 1; i >= 0; i--) {
    ctx.fillText(lines[i], 40, y);
    y -= lineH;
  }
  return canvas.toBuffer('image/png');
}

function drawQr(ctx, text, x, y, size) {
  const qr = qrcode(0, 'M');
  qr.addData(String(text));
  qr.make();
  const n = qr.getModuleCount();
  const cell = size / n;
  ctx.fillStyle = '#0b1a3a';
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.isDark(r, c)) ctx.fillRect(x + c * cell, y + r * cell, Math.ceil(cell), Math.ceil(cell));
    }
  }
}

/**
 * The end card — the reason the reel exists for MaadiVeedu: "Ask MaadiVeedu", bilingual, a QR that
 * opens the listing (tagged utm_source=reel), the site host. Whoever the reel is forwarded to lands
 * on the site with the assistant one tap away.
 */
export function endCardPng({ listingUrl, siteName = 'MaadiVeedu', siteHost = 'maadiveedu.com', hook = '', cta = '' }) {
  const canvas = createCanvas(REEL_W, REEL_H);
  const ctx = canvas.getContext('2d');
  const bg = ctx.createLinearGradient(0, 0, REEL_W, REEL_H);
  bg.addColorStop(0, '#0b1a3a');
  bg.addColorStop(1, '#14532d');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, REEL_W, REEL_H);
  ctx.textAlign = 'center';
  const centre = (text, y, font, color) => { ctx.font = font; ctx.fillStyle = color; ctx.fillText(text, REEL_W / 2, y); };
  ctx.letterSpacing = '4px';
  centre(siteName.toUpperCase(), 230, `bold 30px ${FAMILY_EN}`, '#86efac');
  ctx.letterSpacing = '0px';
  centre(`Ask ${siteName}`, 320, `bold 66px ${FAMILY_EN}`, '#ffffff');
  centre('மாடிவீட்டிடம் கேளுங்கள்', 384, `bold 40px ${FAMILY_TA}`, '#fde68a');
  ctx.font = `38px ${famFor(hook)}`;
  const hookLines = wrapLines(ctx, hook, REEL_W - 120, 2);
  hookLines.forEach((l, i) => centre(l, 456 + i * 52, `38px ${famFor(hook)}`, '#cbd5e1'));
  const qrSize = 300;
  const qrX = (REEL_W - qrSize) / 2;
  const qrY = 590;
  ctx.fillStyle = '#ffffff';
  roundRect(ctx, qrX - 18, qrY - 18, qrSize + 36, qrSize + 36, 24);
  ctx.fill();
  drawQr(ctx, listingUrl, qrX, qrY, qrSize);
  centre(cta || 'Scan to see this home', qrY + qrSize + 78, `bold 34px ${famFor(cta)}`, '#ffffff');
  centre(siteHost, qrY + qrSize + 126, `30px ${FAMILY_EN}`, '#cbd5e1');
  centre(`Made with Ask ${siteName}`, REEL_H - 70, `24px ${FAMILY_EN}`, '#94a3b8');
  return canvas.toBuffer('image/png');
}

// ── 3. Render ────────────────────────────────────────────────────────────────────────────────────

const X264 = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '24', '-pix_fmt', 'yuv420p', '-r', String(FPS), '-an'];

/**
 * One photo → one segment: the photo fitted into 9:16 over a blurred, darkened copy of itself
 * (listing photos are landscape; a hard crop would lose the room), upscaled ×2 so the Ken-Burns
 * zoom has pixels to work with, then zoompan + the caption overlay + a short fade.
 */
async function photoSegment({ photoPath, overlayPng, out, seconds, index }) {
  const frames = Math.round(seconds * FPS);
  const zoomIn = index % 2 === 0;
  const step = (0.18 / frames).toFixed(6); // reach ×1.18 exactly at the last frame, however long the hold
  const z = zoomIn ? `min(1+${step}*on,1.18)` : `max(1.18-${step}*on,1.0)`;
  const fadeOut = Math.max(0, seconds - 0.35).toFixed(2);
  const filter =
    `[0:v]scale=${REEL_W * 2}:${REEL_H * 2}:force_original_aspect_ratio=increase,crop=${REEL_W * 2}:${REEL_H * 2},boxblur=30:5,eq=brightness=-0.18[bg];` +
    `[0:v]scale=${REEL_W * 2}:${REEL_H * 2}:force_original_aspect_ratio=decrease[fg];` +
    `[bg][fg]overlay=(W-w)/2:(H-h)/2,` +
    `zoompan=z='${z}':d=${frames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${REEL_W}x${REEL_H}:fps=${FPS}[v];` +
    `[v][1:v]overlay=0:0:format=auto,fade=t=in:st=0:d=0.3,fade=t=out:st=${fadeOut}:d=0.35,format=yuv420p[o]`;
  await ffmpeg(['-i', photoPath, '-i', overlayPng, '-filter_complex', filter, '-map', '[o]', '-t', String(seconds), ...X264, out]);
}

async function heroSegment({ clipPath, overlayPng, out, seconds }) {
  const fadeOut = Math.max(0, seconds - 0.35).toFixed(2);
  const filter =
    `[0:v]scale=${REEL_W}:${REEL_H}:force_original_aspect_ratio=increase,crop=${REEL_W}:${REEL_H},fps=${FPS}[v];` +
    `[v][1:v]overlay=0:0:format=auto,fade=t=in:st=0:d=0.3,fade=t=out:st=${fadeOut}:d=0.35,format=yuv420p[o]`;
  await ffmpeg(['-i', clipPath, '-i', overlayPng, '-filter_complex', filter, '-map', '[o]', '-t', String(seconds), ...X264, out]);
}

async function stillSegment({ png, out, seconds }) {
  await ffmpeg(['-loop', '1', '-framerate', String(FPS), '-i', png, '-t', String(seconds), '-vf', `fade=t=in:st=0:d=0.4,format=yuv420p`, ...X264, out]);
}

/**
 * Stream-copy the segments together and lay the voice under them. The total length is passed
 * explicitly (`-t` + `apad=whole_dur`): an open-ended apad with `-shortest` on a copied video stream
 * never signals the end and ffmpeg sits at 100% CPU forever — measured, not theoretical.
 */
async function concatWithVoice({ segments, voice, out, dir, totalSeconds }) {
  const list = path.join(dir, 'list.txt');
  await fs.writeFile(list, segments.map((s) => `file '${s.replace(/'/g, "'\\''")}'`).join('\n'));
  if (voice) {
    const pcm = path.join(dir, 'voice.pcm');
    await fs.writeFile(pcm, voice.pcm);
    await ffmpeg([
      '-f', 'concat', '-safe', '0', '-i', list,
      '-f', 's16le', '-ar', String(voice.sampleRate), '-ac', '1', '-i', pcm,
      '-filter_complex', `[1:a]adelay=500|500,volume=1.4,apad=whole_dur=${totalSeconds.toFixed(2)}[a]`,
      '-map', '0:v', '-map', '[a]', '-c:v', 'copy', '-c:a', 'aac', '-b:a', '96k', '-t', totalSeconds.toFixed(2), '-movflags', '+faststart', out,
    ]);
  } else {
    await ffmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-c:v', 'copy', '-an', '-movflags', '+faststart', out]);
  }
}

async function probeDuration(file) {
  try {
    const { stderr } = await execFileP(ffmpegPath, ['-hide_banner', '-i', file], { maxBuffer: 1024 * 1024 }).catch((e) => e);
    const m = String(stderr || '').match(/Duration:\s*(\d+):(\d+):(\d+\.?\d*)/);
    return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : 0;
  } catch {
    return 0;
  }
}

// ── 4. Storage ───────────────────────────────────────────────────────────────────────────────────

function bucketName() {
  return process.env.REELS_BUCKET || `${process.env.GCLOUD_PROJECT || process.env.GOOGLE_CLOUD_PROJECT}.firebasestorage.app`;
}

async function uploadFile(bucket, objectPath, localPath, contentType) {
  const token = randomUUID();
  await bucket.upload(localPath, {
    destination: objectPath,
    resumable: false,
    contentType,
    metadata: { cacheControl: 'public,max-age=31536000', metadata: { firebaseStorageDownloadTokens: token } },
  });
  return `https://firebasestorage.googleapis.com/v0/b/${bucket.name}/o/${encodeURIComponent(objectPath)}?alt=media&token=${token}`;
}

export async function uploadReel({ orgId, jobId, videoPath, posterPath }) {
  const bucket = getStorage().bucket(bucketName());
  const base = `reels/${orgId}/${jobId}`;
  const [videoUrl, posterUrl] = await Promise.all([
    uploadFile(bucket, `${base}/reel.mp4`, videoPath, 'video/mp4'),
    uploadFile(bucket, `${base}/poster.jpg`, posterPath, 'image/jpeg'),
  ]);
  return { videoUrl, posterUrl };
}

// ── 5. The whole thing ───────────────────────────────────────────────────────────────────────────

function withUtm(url) {
  try {
    const u = new URL(url);
    u.searchParams.set('utm_source', 'reel');
    u.searchParams.set('utm_medium', 'assistant');
    return u.toString();
  } catch {
    return url;
  }
}

/**
 * Build the reel for one listing. Pure "make files" — returns local paths plus what happened, and
 * the caller uploads/bills. `style` is what was asked; `styleDelivered` is what was made (animated
 * degrades to photo when Veo cannot help, with `fallbackReason`).
 *
 * @param {object} p
 * @param {object} p.listing   { id, title, price, priceLabel, listingType, propertyType, bhk, areaSqft,
 *                               locality, city, url, description, images:[url] }
 * @param {'photo'|'animated'} p.style
 * @param {'en'|'ta'} p.locale
 * @param {{name:string,url:string}} p.site
 * @param {string} p.dir       scratch directory (caller cleans up)
 * @param {function} [p.log]
 */
export async function buildReel({ listing, style = 'photo', locale = 'en', site = {}, dir, log = () => {} }) {
  const t0 = Date.now();
  const siteName = String(site.name || 'MaadiVeedu').slice(0, 40);
  let siteHost = 'maadiveedu.com';
  try { siteHost = new URL(site.url || listing.url).host.replace(/^www\./, ''); } catch { /* keep default */ }

  // Photos first — everything else hangs off how many we actually got.
  const urls = (Array.isArray(listing.images) ? listing.images : []).filter((u) => /^https?:\/\//.test(String(u))).slice(0, MAX_PHOTOS);
  const fetched = await Promise.all(urls.map((u) => fetchImage(u).catch((e) => { log('photo skipped', u.slice(0, 80), e.message); return null; })));
  const photos = fetched.filter(Boolean);
  if (!photos.length) throw new Error('no usable photos');
  log(`photos ${photos.length}/${urls.length}`);

  // Words, voice and the hero clip are independent — run them together.
  const wantHero = style === 'animated';
  const [script, hero] = await Promise.all([
    writeScript(listing, locale, photos.length).catch((e) => { log('script fallback', e.message); return { ...fallbackScript(listing, locale, photos.length), source: 'fallback' }; }),
    wantHero ? veoHeroClip(photos[0], listing).then((buf) => ({ buf })).catch((e) => ({ error: String(e.message || e) })) : Promise.resolve(null),
  ]);
  const voice = await synthVoice(script.voiceover, locale);
  log(`script:${script.source} voice:${voice ? Math.round(voice.pcm.length / voice.sampleRate / 2) + 's' : 'none'} hero:${hero ? (hero.buf ? 'ok' : hero.error) : 'n/a'}`);

  // Overlays.
  const price = listing.priceLabel || fmtInr(listing.price, listing.listingType);
  const place = placeWord(listing);
  const overlayFor = async (i, caption) => {
    const p = path.join(dir, `ov${i}.png`);
    await fs.writeFile(p, captionOverlayPng({ caption, price, place, siteName }));
    return p;
  };
  const endPng = path.join(dir, 'end.png');
  await fs.writeFile(endPng, endCardPng({ listingUrl: withUtm(listing.url || site.url || `https://${siteHost}`), siteName, siteHost, hook: script.hook, cta: script.cta }));

  // Segments, in order. Photos hold longer when the voice needs the time (bounded — see PHOTO_SECONDS).
  const segments = [];
  let idx = 0;
  const heroOk = !!hero?.buf;
  const stillCount = photos.length - (heroOk ? 1 : 0);
  const voiceSec = voice ? voice.pcm.length / (voice.sampleRate * 2) : 0;
  const fixedSec = (heroOk ? HERO_SECONDS : 0) + END_CARD_SECONDS;
  const needed = voiceSec > 0 ? (voiceSec + 1.2 - fixedSec) / Math.max(1, stillCount) : 0;
  const photoSeconds = Math.min(MAX_PHOTO_SECONDS, Math.max(PHOTO_SECONDS, Math.min(needed, (MAX_TOTAL_SECONDS - fixedSec) / Math.max(1, stillCount))));
  log(`timing photo:${photoSeconds.toFixed(1)}s ×${stillCount} voice:${voiceSec.toFixed(1)}s`);
  if (heroOk) {
    const clip = path.join(dir, 'hero.mp4');
    await fs.writeFile(clip, hero.buf);
    const seg = path.join(dir, `seg${idx}.mp4`);
    await heroSegment({ clipPath: clip, overlayPng: await overlayFor(idx, script.captions[0] || script.hook), out: seg, seconds: HERO_SECONDS });
    segments.push(seg);
    idx++;
  }
  for (let i = 0; i < photos.length; i++) {
    if (heroOk && i === 0) continue; // the cover became the hero shot
    const photoPath = path.join(dir, `p${i}.${photos[i].mimeType === 'image/png' ? 'png' : 'jpg'}`);
    await fs.writeFile(photoPath, photos[i].data);
    const seg = path.join(dir, `seg${idx}.mp4`);
    await photoSegment({ photoPath, overlayPng: await overlayFor(idx, script.captions[i] || ''), out: seg, seconds: photoSeconds, index: idx });
    segments.push(seg);
    idx++;
  }
  const endSeg = path.join(dir, `seg${idx}.mp4`);
  await stillSegment({ png: endPng, out: endSeg, seconds: END_CARD_SECONDS });
  segments.push(endSeg);

  const totalSeconds = (heroOk ? HERO_SECONDS : 0) + stillCount * photoSeconds + END_CARD_SECONDS;
  const videoPath = path.join(dir, 'reel.mp4');
  await concatWithVoice({ segments, voice, out: videoPath, dir, totalSeconds });
  const posterPath = path.join(dir, 'poster.jpg');
  await ffmpeg(['-ss', heroOk ? '2' : '1', '-i', videoPath, '-frames:v', '1', '-q:v', '4', posterPath]);
  const durationSec = await probeDuration(videoPath);

  return {
    videoPath,
    posterPath,
    durationSec,
    styleDelivered: heroOk ? 'animated' : 'photo',
    fallbackReason: wantHero && !heroOk ? String(hero?.error || 'hero unavailable').slice(0, 120) : null,
    photos: photos.length,
    script: { source: script.source, hook: script.hook, voiceover: script.voiceover, captions: script.captions, cta: script.cta },
    voiced: !!voice,
    ms: Date.now() - t0,
  };
}

/** A fresh scratch dir under the OS tmp (Cloud Functions: in-memory /tmp — clean it up after). */
export async function makeScratchDir(prefix = 'reel-') {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}
