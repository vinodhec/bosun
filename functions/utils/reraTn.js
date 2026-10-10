/**
 * TN RERA (rera.tn.gov.in) — read the public register of registered projects. No Apify: the pages
 * are public, static HTML with no login, captcha or JavaScript gate, so a plain fetch with a browser
 * UA, one page at a time with a short pause, is all that is needed (verified 2026-10-10: 706 pages).
 *
 *  - `/projects-map` embeds the CURRENT YEAR's registrations as one JSON blob (`const data = {...}`)
 *    with a details link, the project name/address text and site coordinates in compact DMS
 *    ("130604.9" = 13° 06' 04.9").
 *  - `/project-details/{uuid}` is the certificate: promoter, registration no/date, type, completion
 *    date, the "Project Details and Address" prose, current status. No promoter phone is published.
 */

export const RERA_BASE = 'https://rera.tn.gov.in';
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchText(url, timeoutMs = 25_000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html,*/*' }, signal: ctrl.signal });
    if (!res.ok) throw new Error(`rera ${res.status} for ${url}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'").replace(/&nbsp;/g, ' ');
}

function stripTags(s) {
  return decodeEntities(String(s).replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' '))
    .replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
}

/** Pull the `const data = {...}` object literal out of the map page by brace matching. */
export function extractMapJson(html) {
  const i = html.indexOf('const data = ');
  if (i < 0) throw new Error('rera map: data blob not found');
  const start = html.indexOf('{', i);
  let depth = 0;
  let inStr = null;
  for (let j = start; j < html.length; j++) {
    const c = html[j];
    if (inStr) {
      if (c === '\\') j++;
      else if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'") inStr = c;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return JSON.parse(html.slice(start, j + 1));
    }
  }
  throw new Error('rera map: unterminated data blob');
}

/** → [{ kind, reraNo, uuid, detailsUrl, projectName, description, latRaw, lngRaw }] */
export function parseMapRows(blob) {
  const original = blob?.original || {};
  const rows = [];
  for (const [kindKey, cols] of Object.entries(original)) {
    const kind = /layout/i.test(kindKey) ? 'layout' : 'building';
    const n = cols.file_no?.length || 0;
    for (let i = 0; i < n; i++) {
      const fileHtml = String(cols.file_no[i] || '');
      const href = fileHtml.match(/href='([^']+)'/)?.[1] || fileHtml.match(/href="([^"]+)"/)?.[1] || null;
      const reraNo = stripTags(fileHtml).replace(/^\W+/, '').trim();
      const uuid = href?.match(/project-details\/([0-9a-f-]{20,})/i)?.[1] || null;
      const nameHtml = String(cols.name?.[i] || '');
      const projectName = decodeEntities(nameHtml.match(/<b>\s*Project Name:\s*<\/b>\s*([^<]+)/i)?.[1] || '').trim() || null;
      const descMatch = nameHtml.match(/<b>\s*Project Details and Address:\s*<\/b>\s*([\s\S]*)$/i);
      const description = stripTags(descMatch ? descMatch[1] : nameHtml.replace(/<b>[^<]*<\/b>/g, ''));
      if (!reraNo) continue;
      rows.push({ kind, reraNo, uuid, detailsUrl: href, projectName, description, latRaw: String(cols.lat?.[i] ?? ''), lngRaw: String(cols.lng?.[i] ?? '') });
    }
  }
  return rows;
}

export async function fetchReraMapRows() {
  const html = await fetchText(`${RERA_BASE}/projects-map`, 60_000);
  return parseMapRows(extractMapJson(html));
}

const DETAIL_LABELS = new Set([
  'Registration No', 'Registration Certificate', 'Registration Certificate Date', 'Project Type', 'Promoter Name',
  'Project Name', 'QPR', 'Completion Certificate', 'Development Completion Date', 'Extension Certificate',
  'Project Details and Address', 'Current Status of the Project', 'Project Units Sold', 'Last Modified',
  'Promoter Details', 'Project Details', 'N/A',
]);

/** The certificate page is a label/value grid; read the value after each label unless it is itself a label. */
export function parseDetails(html) {
  const body = html.replace(/<(script|style|header|nav|footer)[^>]*>[\s\S]*?<\/\1>/gi, '');
  const tokens = stripTags(body.replace(/<\/(td|th|div|p|li|tr|h\d)>/gi, '\n')).split('\n').map((t) => t.trim()).filter(Boolean);
  const after = (label) => {
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i] !== label) continue;
      const v = tokens[i + 1];
      if (v && !DETAIL_LABELS.has(v) && !/^[-–—]+$/.test(v) && v.toUpperCase() !== 'NA') return v;
    }
    return null;
  };
  let description = null;
  tokens.forEach((t, i) => {
    if (description || t !== 'Project Details') return;
    const v = tokens[i + 1];
    if (v && v.length > 80 && !DETAIL_LABELS.has(v)) description = v;
  });
  if (!description) description = tokens.find((t) => t.length > 120 && /registration|comprised|s\.?\s?nos?\.|plots?|floor/i.test(t)) || null;
  const status = after('Current Status of the Project');
  return {
    reraNo: after('Registration No'),
    registrationDate: after('Registration Certificate Date'),
    projectType: after('Project Type'),
    promoterName: after('Promoter Name'),
    projectName: after('Project Name'),
    completionDate: after('Development Completion Date'),
    description,
    currentStatus: status && status.length < 200 ? status : null,
  };
}

export async function fetchReraDetails(uuid) {
  return parseDetails(await fetchText(`${RERA_BASE}/project-details/${uuid}`));
}

/** "130604.9" (compact DMS) or "13.1014" → decimal degrees; anything else → null. */
export function reraCoordToDecimal(raw) {
  const f = Number(String(raw ?? '').trim());
  if (!Number.isFinite(f) || f <= 0) return null;
  if (f < 1000) return f;
  const deg = Math.floor(f / 10000);
  const min = Math.floor((f - deg * 10000) / 100);
  const sec = f - deg * 10000 - min * 100;
  if (min >= 60 || sec >= 60) return null;
  return Math.round((deg + min / 60 + sec / 3600) * 1e6) / 1e6;
}

/** Metro bounding boxes — the same values as the platform's lib/sourcedProjects CITY_BOXES. */
export const CITY_BOXES = {
  Chennai: { minLat: 12.7, maxLat: 13.4, minLng: 79.85, maxLng: 80.35 },
  Coimbatore: { minLat: 10.85, maxLat: 11.25, minLng: 76.8, maxLng: 77.2 },
};

export function cityForPoint(lat, lng) {
  for (const [city, b] of Object.entries(CITY_BOXES)) {
    if (lat >= b.minLat && lat <= b.maxLat && lng >= b.minLng && lng <= b.maxLng) return city;
  }
  return null;
}

/** Firestore doc id for a registration number: "TNRERA/29/BLG/0160/2026" → "TNRERA_29_BLG_0160_2026". */
export const reraDocId = (reraNo) => String(reraNo).replace(/[^A-Za-z0-9]+/g, '_');
