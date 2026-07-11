import { onCall, HttpsError } from 'firebase-functions/v2/https';
import { getFirestore } from 'firebase-admin/firestore';
import { resolveOrgId, isMember } from '../utils/orgs.js';
import { invoiceSummary, renderInvoiceHtml } from '../utils/invoice.js';

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
