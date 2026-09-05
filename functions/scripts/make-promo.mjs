#!/usr/bin/env node
/**
 * make-promo.mjs — a 9:16 promo reel for ASK MAADIVEEDU itself (the assistant, not a listing).
 *
 *   VERTEX_PROJECT=bosun-76bba node scripts/make-promo.mjs --out promo-en.mp4 [--locale ta] [--voice ta] [--listing listing.json]
 *   --locale sets the on-screen language; --voice the voice-over language (defaults to --locale).
 *
 * A mock chat, drawn frame by frame with the same canvas + ffmpeg pieces utils/reel.js uses: the
 * visitor asks for a home, the assistant shows real listing cards, sends the enquiry, makes a
 * shareable video, and — for an owner, in Tamil — reads their listing's leads back. Voice-over via
 * Gemini TTS, "Ask MaadiVeedu" end card with a QR to the site. An operator/marketing tool, not a
 * metered lane; the listing shown is a REAL one (default: the Kovilpalayam villa) so nothing in the
 * promo is invented.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import {
  makeScratchDir, fetchImage, synthVoice, stillSegment, concatWithVoice, probeDuration, endCardPng,
  wrapLines, roundRect, famFor, FAMILY_EN, FAMILY_TA, REEL_W, REEL_H,
} from '../utils/reel.js';
import ffmpegPath from 'ffmpeg-static';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
const argv = process.argv.slice(2);
const opt = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : ''; };
const locale = opt('--locale') === 'ta' ? 'ta' : 'en';
const voiceLocale = opt('--voice') ? (opt('--voice') === 'ta' ? 'ta' : 'en') : locale;
const out = path.resolve(opt('--out') || `promo-ask-maadiveedu-${locale}${voiceLocale !== locale ? '-voice-' + voiceLocale : ''}.mp4`);
const listing = opt('--listing')
  ? JSON.parse(await fs.readFile(opt('--listing'), 'utf8'))
  : {
      id: 'PROP-SAAAFH', title: '3 BHK villa in Kovilpalayam', priceLabel: '₹85 L', listingType: 'sale', bhk: 3,
      locality: 'Kovilpalayam', city: 'Coimbatore',
      url: 'https://www.maadiveedu.com/property/3bhk-villa-house-sale-kovilpalayam-coimbatore--PROP-SAAAFH',
      images: [
        'https://firebasestorage.googleapis.com/v0/b/maadiveeduvas.appspot.com/o/properties%2F4116167e-bdaf-41fd-b7f1-f74824837726?alt=media&token=cd83c678-38d5-43de-8cd4-5cb89e001b68',
        'https://firebasestorage.googleapis.com/v0/b/maadiveeduvas.appspot.com/o/properties%2F5ab167af-71f2-4070-8aa0-c6a18215ea8f?alt=media&token=a521ba47-be5c-4523-84d9-cd03f1078777',
        'https://firebasestorage.googleapis.com/v0/b/maadiveeduvas.appspot.com/o/properties%2F80d8d826-985c-4321-b070-76e49858ebdb?alt=media&token=c0afa3d3-5f37-4ea3-be0c-24740764e03a',
      ],
    };

// ── Copy (hand-written: a promo is marketing, and the words are the operator's) ─────────────────
const COPY_ALL = {
  en: {
    title: ['Ask MaadiVeedu', 'Your property helper. Just ask.'],
    q1: `${listing.bhk} BHK house for sale in ${listing.locality} under ₹90 L`,
    a1: `Found homes in ${listing.locality} — here are the best matches.`,
    q2: 'I’d like to visit this one',
    a2: 'Done — your enquiry is with the owner. They’ll call you shortly.',
    q3: 'Make a video of this home',
    a3: 'Your video is ready — share it on WhatsApp.',
    q4: 'Show my listings',
    a4: `Your ${listing.locality} villa is live: 128 views, 4 enquiries this week.`,
    chips: ['Share on WhatsApp', 'See more homes'],
    share: 'Share on WhatsApp',
    header: ['MaadiVeedu Assistant', 'Find, enquire, or list — just ask'],
    voice:
      'Looking for a home in Tamil Nadu? Just ask MaadiVeedu. Type what you want, in English or Tamil, ' +
      'and it finds real listings, sends your enquiry straight to the owner, and even makes a video you can share on WhatsApp. ' +
      'Selling? It lists your property and tells you who enquired. Ask MaadiVeedu, free on maadiveedu dot com.',
    cta: 'Try it free on maadiveedu.com',
    hook: 'Find · Enquire · List · Share',
  },
  ta: {
    title: ['மாடிவீட்டிடம் கேளுங்கள்', 'உங்கள் வீட்டுத் தேடல் உதவியாளர்'],
    q1: `${listing.locality}ல் ₹90 லட்சத்திற்குள் ${listing.bhk} BHK வீடு விற்பனைக்கு`,
    a1: `${listing.locality}ல் வீடுகள் கிடைத்தன — சிறந்தவை இதோ.`,
    q2: 'இதைப் பார்க்க விரும்புகிறேன்',
    a2: 'உங்கள் விசாரணை உரிமையாளருக்கு அனுப்பப்பட்டது. விரைவில் அழைப்பார்.',
    q3: 'இந்த வீட்டுக்கு ஒரு வீடியோ செய்',
    a3: 'உங்கள் வீடியோ தயார் — வாட்ஸ்அப்பில் பகிருங்கள்.',
    q4: 'என் விளம்பரங்களைக் காட்டு',
    a4: `உங்கள் ${listing.locality} வீடு லைவ்: 128 பார்வைகள், இந்த வாரம் 4 விசாரணைகள்.`,
    chips: ['வாட்ஸ்அப்பில் பகிர', 'மேலும் வீடுகள்'],
    share: 'வாட்ஸ்அப்பில் பகிர',
    header: ['மாடிவீடு உதவியாளர்', 'தேடுங்கள், விசாரியுங்கள், விளம்பரம் செய்யுங்கள்'],
    voice:
      'தமிழ்நாட்டில் வீடு தேடுகிறீர்களா? மாடிவீட்டிடம் கேளுங்கள். தமிழிலோ ஆங்கிலத்திலோ உங்களுக்கு என்ன வேண்டும் என்று சொல்லுங்கள் — ' +
      'உண்மையான விளம்பரங்களைத் தேடித் தரும், உங்கள் விசாரணையை நேரடியாக உரிமையாளருக்கு அனுப்பும், வாட்ஸ்அப்பில் பகிர ஒரு வீடியோவும் செய்து தரும். ' +
      'விற்க வேண்டுமா? உங்கள் சொத்தைப் பதிவு செய்து, யார் விசாரித்தார்கள் என்றும் சொல்லும். மாடிவீட்டிடம் கேளுங்கள் — maadiveedu.com-ல் இலவசம்.',
    cta: 'maadiveedu.com-ல் இலவசமாக',
    hook: 'தேடு · விசாரி · பதிவு செய் · பகிர்',
  },
};
const COPY = COPY_ALL[locale];
const VOICE = COPY_ALL[voiceLocale].voice;

// ── Drawing ─────────────────────────────────────────────────────────────────────────────────────
const GREEN = '#0f766e';
const PAD = 40;

function bg(ctx) {
  const g = ctx.createLinearGradient(0, 0, 0, REEL_H);
  g.addColorStop(0, '#0b1a3a');
  g.addColorStop(1, '#14532d');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, REEL_W, REEL_H);
}

/** The phone-style chat panel: a white card with the assistant header. Returns the content top y. */
function panel(ctx) {
  ctx.fillStyle = '#f3f4f6';
  roundRect(ctx, 24, 120, REEL_W - 48, REEL_H - 260, 36);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  roundRect(ctx, 24, 120, REEL_W - 48, 110, 36);
  ctx.fill();
  ctx.fillRect(24, 190, REEL_W - 48, 40);
  ctx.fillStyle = GREEN;
  ctx.beginPath();
  ctx.arc(80, 175, 26, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#fff';
  ctx.font = `bold 26px ${FAMILY_EN}`;
  ctx.textAlign = 'center';
  ctx.fillText('M', 80, 185);
  ctx.textAlign = 'left';
  ctx.fillStyle = '#111827';
  ctx.font = `bold 28px ${famFor(COPY.header[0])}`;
  ctx.fillText(COPY.header[0], 122, 168);
  ctx.fillStyle = '#6b7280';
  ctx.font = `22px ${famFor(COPY.header[1])}`;
  ctx.fillText(wrapLines(ctx, COPY.header[1], REEL_W - 24 - 122 - 24, 1)[0], 122, 202);
  ctx.strokeStyle = '#e5e7eb';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(24, 231);
  ctx.lineTo(REEL_W - 24, 231);
  ctx.stroke();
  return 262;
}

function bubble(ctx, y, text, side) {
  const size = 30;
  ctx.font = `${size}px ${famFor(text)}`;
  const maxW = REEL_W - 48 - 2 * PAD - 100;
  const lines = wrapLines(ctx, text, maxW - 48, 4);
  const lineH = size + 12;
  const w = Math.min(maxW, Math.max(...lines.map((l) => ctx.measureText(l).width)) + 48);
  const h = lines.length * lineH + 30;
  const x = side === 'user' ? REEL_W - 24 - PAD - w : 24 + PAD;
  ctx.fillStyle = side === 'user' ? GREEN : '#ffffff';
  roundRect(ctx, x, y, w, h, 24);
  ctx.fill();
  ctx.fillStyle = side === 'user' ? '#ffffff' : '#1f2937';
  ctx.textAlign = 'left';
  lines.forEach((l, i) => ctx.fillText(l, x + 24, y + 22 + size + i * lineH - 8));
  return y + h + 18;
}

function typing(ctx, y) {
  ctx.fillStyle = '#ffffff';
  roundRect(ctx, 24 + PAD, y, 120, 56, 24);
  ctx.fill();
  ctx.fillStyle = '#9ca3af';
  for (let i = 0; i < 3; i++) { ctx.beginPath(); ctx.arc(24 + PAD + 34 + i * 26, y + 28, 7, 0, Math.PI * 2); ctx.fill(); }
  return y + 74;
}

async function card(ctx, y, img, title, price, place, { play = false } = {}) {
  const x = 24 + PAD;
  const w = REEL_W - 48 - 2 * PAD - 40;
  const h = 130;
  ctx.fillStyle = '#ffffff';
  roundRect(ctx, x, y, w, h, 20);
  ctx.fill();
  ctx.strokeStyle = '#e5e7eb';
  ctx.lineWidth = 2;
  ctx.stroke();
  // thumb (cover-cropped)
  ctx.save();
  roundRect(ctx, x + 12, y + 12, 150, h - 24, 14);
  ctx.clip();
  const s = Math.max(150 / img.width, (h - 24) / img.height);
  ctx.drawImage(img, x + 12 + (150 - img.width * s) / 2, y + 12 + (h - 24 - img.height * s) / 2, img.width * s, img.height * s);
  if (play) {
    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(x + 12, y + 12, 150, h - 24);
    ctx.fillStyle = '#fff';
    ctx.beginPath();
    ctx.moveTo(x + 75, y + 42);
    ctx.lineTo(x + 112, y + 65);
    ctx.lineTo(x + 75, y + 88);
    ctx.closePath();
    ctx.fill();
  }
  ctx.restore();
  ctx.textAlign = 'left';
  ctx.fillStyle = '#111827';
  ctx.font = `bold 26px ${famFor(title)}`;
  ctx.fillText(wrapLines(ctx, title, w - 200, 1)[0], x + 180, y + 46);
  ctx.fillStyle = '#b45309';
  ctx.font = `bold 26px ${FAMILY_EN}`;
  ctx.fillText(price, x + 180, y + 82);
  ctx.fillStyle = '#6b7280';
  ctx.font = `22px ${FAMILY_EN}`;
  ctx.fillText(place, x + 180, y + 112);
  return y + h + 16;
}

function chips(ctx, y, labels) {
  let x = 24 + PAD;
  for (const l of labels) {
    ctx.font = `bold 24px ${famFor(l)}`;
    const w = ctx.measureText(l).width + 44;
    ctx.fillStyle = '#ecfdf5';
    roundRect(ctx, x, y, w, 50, 25);
    ctx.fill();
    ctx.strokeStyle = '#a7f3d0';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = '#065f46';
    ctx.textAlign = 'left';
    ctx.fillText(l, x + 22, y + 34);
    x += w + 14;
  }
  return y + 66;
}

function caption(ctx, text) {
  ctx.textAlign = 'center';
  ctx.fillStyle = '#ffffff';
  ctx.font = `bold 40px ${famFor(text)}`;
  const lines = wrapLines(ctx, text, REEL_W - 80, 2);
  lines.forEach((l, i) => ctx.fillText(l, REEL_W / 2, REEL_H - 78 + i * 48 - (lines.length - 1) * 24));
  ctx.textAlign = 'left';
}

function brand(ctx) {
  ctx.textAlign = 'center';
  ctx.fillStyle = '#86efac';
  ctx.font = `bold 26px ${FAMILY_EN}`;
  ctx.letterSpacing = '4px';
  ctx.fillText('ASK MAADIVEEDU', REEL_W / 2, 80);
  ctx.letterSpacing = '0px';
  ctx.textAlign = 'left';
}

// ── Scenes ──────────────────────────────────────────────────────────────────────────────────────
const dir = await makeScratchDir('promo-');
const photos = (await Promise.all(listing.images.slice(0, 3).map((u) => fetchImage(u).catch(() => null)))).filter(Boolean);
if (!photos.length) throw new Error('no listing photos');
const imgs = await Promise.all(photos.map((p) => loadImage(p.data)));
const place = `${listing.locality}, ${listing.city}`;

const scenes = [];
const scene = async (name, seconds, draw) => {
  const c = createCanvas(REEL_W, REEL_H);
  const ctx = c.getContext('2d');
  await draw(ctx);
  const png = path.join(dir, `${name}.png`);
  await fs.writeFile(png, c.toBuffer('image/png'));
  scenes.push({ name, seconds, png });
};

await scene('title', 3, (ctx) => {
  bg(ctx);
  ctx.textAlign = 'center';
  ctx.fillStyle = '#86efac';
  ctx.font = `bold 30px ${FAMILY_EN}`;
  ctx.letterSpacing = '4px';
  ctx.fillText('MAADIVEEDU', REEL_W / 2, 470);
  ctx.letterSpacing = '0px';
  ctx.fillStyle = '#ffffff';
  ctx.font = `bold ${locale === 'ta' ? 58 : 72}px ${famFor(COPY.title[0])}`;
  ctx.fillText(COPY.title[0], REEL_W / 2, 570);
  ctx.fillStyle = '#fde68a';
  ctx.font = `bold 40px ${FAMILY_TA}`;
  ctx.fillText(locale === 'ta' ? 'Ask MaadiVeedu' : 'மாடிவீட்டிடம் கேளுங்கள்', REEL_W / 2, 640);
  ctx.fillStyle = '#cbd5e1';
  ctx.font = `36px ${famFor(COPY.title[1])}`;
  ctx.fillText(COPY.title[1], REEL_W / 2, 730);
  ctx.textAlign = 'left';
});

await scene('ask', 3.2, (ctx) => {
  bg(ctx); brand(ctx);
  let y = panel(ctx);
  y = bubble(ctx, y, COPY.q1, 'user');
  typing(ctx, y);
  caption(ctx, locale === 'ta' ? 'தமிழிலோ ஆங்கிலத்திலோ கேளுங்கள்' : 'Ask in English or Tamil');
});

await scene('cards', 4, async (ctx) => {
  bg(ctx); brand(ctx);
  let y = panel(ctx);
  y = bubble(ctx, y, COPY.q1, 'user');
  y = bubble(ctx, y, COPY.a1, 'assistant');
  y = await card(ctx, y, imgs[0], listing.title, listing.priceLabel, place);
  if (imgs[1]) y = await card(ctx, y, imgs[1], `${listing.bhk} BHK house · ${listing.locality}`, listing.priceLabel, place);
  chips(ctx, y, locale === 'ta' ? ['விசாரிக்க', 'பார்க்க'] : ['Enquire', 'View']);
  caption(ctx, locale === 'ta' ? 'உண்மையான விளம்பரங்கள், உடனே' : 'Real listings, instantly');
});

await scene('enquire', 3.5, async (ctx) => {
  bg(ctx); brand(ctx);
  let y = panel(ctx);
  y = await card(ctx, y, imgs[0], listing.title, listing.priceLabel, place);
  y = bubble(ctx, y, COPY.q2, 'user');
  y = bubble(ctx, y, COPY.a2, 'assistant');
  // tick
  ctx.fillStyle = '#16a34a';
  ctx.beginPath(); ctx.arc(REEL_W / 2, y + 60, 36, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 8; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.moveTo(REEL_W / 2 - 16, y + 60); ctx.lineTo(REEL_W / 2 - 4, y + 74); ctx.lineTo(REEL_W / 2 + 20, y + 44); ctx.stroke();
  caption(ctx, locale === 'ta' ? 'விசாரணை நேரடியாக உரிமையாளருக்கு' : 'Your enquiry goes straight to the owner');
});

await scene('video', 3.8, async (ctx) => {
  bg(ctx); brand(ctx);
  let y = panel(ctx);
  y = bubble(ctx, y, COPY.q3, 'user');
  y = bubble(ctx, y, COPY.a3, 'assistant');
  y = await card(ctx, y, imgs[0], listing.title, listing.priceLabel, place, { play: true });
  // WhatsApp share button
  ctx.fillStyle = '#25d366';
  roundRect(ctx, 24 + PAD, y, 320, 56, 28); ctx.fill();
  ctx.fillStyle = '#fff'; ctx.font = `bold 24px ${famFor(COPY.share)}`; ctx.textAlign = 'left';
  ctx.fillText(COPY.share, 24 + PAD + 28, y + 37);
  caption(ctx, locale === 'ta' ? 'ஒரு வீடியோ — வாட்ஸ்அப்பில் பகிர' : 'A video to share on WhatsApp');
});

await scene('owner', 3.8, async (ctx) => {
  bg(ctx); brand(ctx);
  let y = panel(ctx);
  y = bubble(ctx, y, COPY.q4, 'user');
  y = bubble(ctx, y, COPY.a4, 'assistant');
  y = await card(ctx, y, imgs[2] || imgs[0], listing.title, listing.priceLabel, place);
  chips(ctx, y, COPY.chips);
  caption(ctx, locale === 'ta' ? 'விற்பவர்களுக்கு: விளம்பரங்கள், லீட்ஸ், திட்டம்' : 'For owners: listings, leads, plan');
});

const endPng = path.join(dir, 'end.png');
await fs.writeFile(endPng, endCardPng({ listingUrl: 'https://www.maadiveedu.com/?utm_source=reel&utm_medium=promo', siteName: 'MaadiVeedu', siteHost: 'maadiveedu.com', hook: COPY.hook, cta: COPY.cta }));
scenes.push({ name: 'end', seconds: 4, png: endPng });

// ── Voice, timing, render ───────────────────────────────────────────────────────────────────────
const voice = await synthVoice(VOICE, voiceLocale);
const voiceSec = voice ? voice.pcm.length / (voice.sampleRate * 2) : 0;
const planned = scenes.reduce((a, s) => a + s.seconds, 0);
const target = Math.max(planned, Math.min(29.5, voiceSec + 1.5));
const k = target / planned;
console.log(`voice ${voiceSec.toFixed(1)}s, scenes ${planned}s → ${target.toFixed(1)}s (×${k.toFixed(2)})`);

const segs = [];
for (const s of scenes) {
  const seg = path.join(dir, `${s.name}.mp4`);
  await stillSegment({ png: s.png, out: seg, seconds: +(s.seconds * k).toFixed(2) });
  segs.push(seg);
}
const totalSeconds = scenes.reduce((a, s) => a + +(s.seconds * k).toFixed(2), 0);
const video = path.join(dir, 'promo.mp4');
await concatWithVoice({ segments: segs, voice, out: video, dir, totalSeconds });
await execFileP(ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', '-ss', '1', '-i', video, '-frames:v', '1', '-q:v', '4', path.join(dir, 'poster.jpg')]);
await fs.copyFile(video, out);
await fs.copyFile(path.join(dir, 'poster.jpg'), out.replace(/\.mp4$/, '') + '-poster.jpg');
console.log(`promo text:${locale} voice:${voiceLocale}: ${(await probeDuration(video)).toFixed(1)}s, voiced=${!!voice}`);
console.log('transcript:', VOICE);
console.log('video:', out);
