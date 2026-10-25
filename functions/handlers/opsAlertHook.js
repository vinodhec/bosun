/**
 * POST /opsAlertHook/{orgId}/{source}?t={token} — inbound PROVIDER alerts for the ops-watch service.
 *
 * The customer's cloud providers cannot sign a request with our HMAC scheme (Vercel's spend-management
 * webhook has no secret at all, GCP budget notifications arrive as a Pub/Sub push, GCP Monitoring
 * webhooks carry at most a token), so this endpoint authenticates with a per-org bearer token in the
 * URL (`?t=`) or the `x-ops-token` header, compared constant-time against
 * `orgSecrets/{orgId}.opsWatch.hookToken`. The token authorises exactly one thing: appending an alert
 * row for that org. Nothing here is billed, nothing here is read back to a browser.
 *
 * What happens on a hit: one `opsAlerts` row {orgId, source, summary, payloadJson, receivedAt} and a
 * best-effort Telegram line to the org's ops chat (`organisations/{orgId}.opsWatch.telegram`, bot token
 * in `orgSecrets/{orgId}.opsWatch.telegramBotToken`). The ops-watch runner on the customer's ops host
 * (mv-guard) reads the rows on its next pass, explains, and opens the ticket — this endpoint only
 * records and pings so the alert is never lost while the runner is between passes.
 *
 * `source` is a free label the operator picks when pasting the URL into the provider (vercel, gcp-budget,
 * gcp-alert, …); it is sanitised, never trusted for anything but the summary and the alarm key.
 */
import crypto from 'node:crypto';
import { onRequest } from 'firebase-functions/v2/https';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { logReject } from '../utils/customerAuth.js';

const REGION = 'asia-south1';
const MAX_BYTES = 32 * 1024;
export const OPS_ALERTS = 'opsAlerts';

function tokenOk(given, expected) {
  if (!given || !expected) return false;
  const a = Buffer.from(String(given));
  const b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const esc = (t) => String(t || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** GCP budget notifications arrive as a Pub/Sub push envelope with a base64 JSON body. */
function decodePubsub(body) {
  const data = body?.message?.data;
  if (!data) return null;
  try { return JSON.parse(Buffer.from(String(data), 'base64').toString('utf8')); } catch { return null; }
}

/** One human line per provider shape; falls back to the first 300 chars of the body. */
export function summarise(source, body) {
  const ps = decodePubsub(body);
  if (ps && ps.budgetDisplayName) {
    const pct = ps.alertThresholdExceeded != null ? ` (${Math.round(Number(ps.alertThresholdExceeded) * 100)}% threshold crossed)` : '';
    return `GCP budget "${ps.budgetDisplayName}": spent ${ps.currencyCode || ''} ${ps.costAmount} of ${ps.budgetAmount}${pct}`.replace(/\s+/g, ' ').trim();
  }
  if (body && body.incident) {
    const i = body.incident;
    return `GCP alert ${i.policy_name || ''} ${i.state || ''}: ${i.summary || i.condition_name || ''}`.replace(/\s+/g, ' ').trim();
  }
  if (source === 'vercel') {
    const pick = ['type', 'event', 'message', 'percentage', 'threshold', 'amount', 'budget', 'budgetAmount', 'currentSpend', 'teamName', 'reason'];
    const parts = pick.filter((k) => body && body[k] != null).map((k) => `${k}=${typeof body[k] === 'object' ? JSON.stringify(body[k]) : body[k]}`);
    return `Vercel spend alert${parts.length ? ': ' + parts.join(' · ') : ''}`;
  }
  const s = typeof body === 'string' ? body : JSON.stringify(body ?? {});
  return `${source} alert: ${s.slice(0, 300)}`;
}

async function sendTelegram({ botToken, chatId, text }) {
  const resp = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
    signal: AbortSignal.timeout(10000),
  });
  const body = await resp.json().catch(() => null);
  if (!resp.ok || body?.ok === false) throw new Error(`telegram ${resp.status} ${body?.description || ''}`.trim());
}

export const opsAlertHook = onRequest({ region: REGION, cors: false, memory: '256MiB', timeoutSeconds: 30 }, async (req, res) => {
  const parts = String(req.path || '').split('/').filter(Boolean);
  const orgId = (parts[0] || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
  const source = ((parts[1] || 'generic').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 32)) || 'generic';

  if (req.method !== 'POST') {
    logReject('opsAlertHook', { orgId, status: 405, reason: 'non-POST-method', extra: { method: req.method } });
    res.status(405).json({ error: 'POST only' });
    return;
  }
  if (!orgId) {
    logReject('opsAlertHook', { status: 400, reason: 'missing-org-in-path' });
    res.status(400).json({ error: 'path must be /opsAlertHook/{orgId}/{source}' });
    return;
  }
  const raw = req.rawBody ? req.rawBody.toString('utf8') : '';
  if (raw.length > MAX_BYTES) {
    logReject('opsAlertHook', { orgId, status: 413, reason: 'body-too-large', extra: { bytes: raw.length } });
    res.status(413).json({ error: 'body too large' });
    return;
  }

  const db = getFirestore();
  const secretSnap = await db.collection('orgSecrets').doc(orgId).get();
  const ops = secretSnap.exists ? secretSnap.data()?.opsWatch || {} : {};
  const given = (req.query && req.query.t) || req.get('x-ops-token');
  if (!tokenOk(given, ops.hookToken)) {
    // Flat 401 either way — the reason stays in our logs.
    logReject('opsAlertHook', { orgId, status: 401, reason: ops.hookToken ? 'bad-token' : 'org-has-no-hook-token', extra: { source } });
    res.status(401).json({ error: 'unauthorised' });
    return;
  }

  let body;
  try { body = raw ? JSON.parse(raw) : {}; } catch { body = { raw: raw.slice(0, 4000) }; }
  const summary = summarise(source, body).slice(0, 500);

  // The payload is stored as a string: provider JSON can nest arrays in arrays, which Firestore refuses.
  const ref = await db.collection(OPS_ALERTS).add({
    orgId,
    source,
    summary,
    payloadJson: raw.slice(0, 8000),
    contentType: req.get('content-type') || '',
    userAgent: (req.get('user-agent') || '').slice(0, 200),
    receivedAt: FieldValue.serverTimestamp(),
    ackedAt: null,
  });
  console.log('opsAlertHook:ok', orgId, source, ref.id, summary);

  // Best effort: the row above is the record; a Telegram failure must not fail the provider's call.
  try {
    const org = (await db.collection('organisations').doc(orgId).get()).data() || {};
    const tg = org.opsWatch?.telegram || {};
    if (tg.enabled && tg.chatId && ops.telegramBotToken) {
      await sendTelegram({ botToken: ops.telegramBotToken, chatId: tg.chatId, text: `🔔 <b>${esc(org.name || orgId)}</b> · ${esc(source)} alert\n${esc(summary)}` });
    }
  } catch (e) {
    console.warn('opsAlertHook:telegram', orgId, e?.message || e);
  }

  res.status(200).json({ ok: true, id: ref.id });
});
