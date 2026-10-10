import { onCall, onRequest, HttpsError } from 'firebase-functions/v2/https';
import { getFirestore } from 'firebase-admin/firestore';
import { resolveOrgId, isMember } from '../utils/orgs.js';
import { invoiceSummary, renderInvoiceHtml, shareUrlFor, shareMessageFor } from '../utils/invoice.js';
import { ensureShareToken } from '../utils/invoiceShare.js';

// Customer-facing invoice views. Invoices are org-scoped; a member sees their org's tax invoices
// (issued on wallet top-ups) and can open one as printable HTML to save as a PDF.
const REGION = 'asia-south1';

export const listMyInvoices = onCall({ region: REGION }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Please sign in.');
  const db = getFirestore();
  const userSnap = await db.collection('users').doc(uid).get();
  // Invoice visibility is granted per-user by the operator (adminSetUserInvoices) — not every
  // org member sees them. `allowed:false` lets the UI hide the panel entirely.
  if (!userSnap.exists || userSnap.data().canViewInvoices !== true) return { allowed: false, invoices: [] };
  const orgId = resolveOrgId(userSnap.data(), request.data?.orgId);
  if (!orgId) return { allowed: true, invoices: [] };
  const snap = await db
    .collection('invoices')
    .where('orgId', '==', orgId)
    .orderBy('issuedAtMs', 'desc')
    .limit(100)
    .get();
  return { allowed: true, invoices: snap.docs.map((d) => ({ id: d.id, ...invoiceSummary(d.data()) })) };
});

export const getMyInvoiceHtml = onCall({ region: REGION }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Please sign in.');
  const invoiceId = String(request.data?.invoiceId ?? '').trim();
  if (!invoiceId) throw new HttpsError('invalid-argument', 'invoiceId required.');
  const db = getFirestore();
  const snap = await db.collection('invoices').doc(invoiceId).get();
  if (!snap.exists) throw new HttpsError('not-found', 'Invoice not found.');
  const inv = snap.data();
  const userSnap = await db.collection('users').doc(uid).get();
  const u = userSnap.exists ? userSnap.data() : null;
  if (!isMember(u, inv.orgId) || u?.canViewInvoices !== true) {
    throw new HttpsError('permission-denied', 'Not your invoice.');
  }
  return { html: renderInvoiceHtml(inv) };
});

// Share link (customer side, same grant as viewing): mints the public token on first use and
// returns the URL plus a ready-to-send WhatsApp message. The dashboard opens wa.me with it.
export const getMyInvoiceShareLink = onCall({ region: REGION }, async (request) => {
  const uid = request.auth?.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Please sign in.');
  const invoiceId = String(request.data?.invoiceId ?? '').trim();
  if (!invoiceId) throw new HttpsError('invalid-argument', 'invoiceId required.');
  const db = getFirestore();
  const ref = db.collection('invoices').doc(invoiceId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError('not-found', 'Invoice not found.');
  const inv = snap.data();
  const userSnap = await db.collection('users').doc(uid).get();
  const u = userSnap.exists ? userSnap.data() : null;
  if (!isMember(u, inv.orgId) || u?.canViewInvoices !== true) {
    throw new HttpsError('permission-denied', 'Not your invoice.');
  }
  const token = await ensureShareToken(ref, inv);
  const url = shareUrlFor(token);
  return { invoiceId, url, message: shareMessageFor(inv, url) };
});

// PUBLIC printable invoice page, reached by share token only — Hosting rewrites /i/<token> here
// (firebase.json). No auth: whoever holds the link (a WhatsApp recipient) can open it, which is the
// point. The page is the same renderInvoiceHtml the signed-in views use, stamped with the LIVE
// payment status, so a forwarded link always shows the current balance due. Never cached or indexed.
export const publicInvoice = onRequest({ region: REGION, cors: false, timeoutSeconds: 30 }, async (req, res) => {
  res.set('Cache-Control', 'private, no-store');
  res.set('X-Robots-Tag', 'noindex, nofollow');
  if (req.method !== 'GET') { res.status(405).send('GET only'); return; }
  const fromPath = decodeURIComponent((req.path || '').split('/').filter(Boolean).pop() || '');
  const token = String(req.query?.t || fromPath || '').trim();
  if (!/^[a-f0-9]{32}$/.test(token)) { res.status(404).type('html').send(NOT_FOUND_HTML); return; }
  const snap = await getFirestore().collection('invoices').where('shareToken', '==', token).limit(1).get();
  if (snap.empty) { res.status(404).type('html').send(NOT_FOUND_HTML); return; }
  res.status(200).type('html').send(renderInvoiceHtml(snap.docs[0].data()));
});

const NOT_FOUND_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>Invoice not found</title>
<meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="font:16px/1.5 -apple-system,Segoe UI,Roboto,sans-serif;color:#111;max-width:480px;margin:48px auto;padding:0 20px">
<h1 style="font-size:20px">This invoice link isn't valid</h1>
<p style="color:#555">The link may be incomplete or may have been withdrawn. Please ask the sender to share it again.</p>
</body></html>`;
