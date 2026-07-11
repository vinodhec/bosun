import { useState } from 'react';
import { listMyInvoices, getMyInvoiceHtml } from '@/firebase/functions';

const fmt = (n) => `₹${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const date = (ms) => (ms ? new Date(ms).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '');

// Customer view of GST tax invoices (issued when the team adds credits to the wallet). Loads on
// first open so it costs nothing on a normal dashboard visit. Each invoice opens as a printable
// page the owner can save as a PDF.
export default function InvoicesPanel({ orgId }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (next && rows === null) await load();
  }

  async function load() {
    setBusy(true); setErr('');
    try {
      const { data } = await listMyInvoices(orgId ? { orgId } : {});
      setRows(data?.invoices || []);
    } catch (e) {
      setErr('Could not load invoices.');
    } finally {
      setBusy(false);
    }
  }

  async function download(id) {
    try {
      const { data } = await getMyInvoiceHtml({ invoiceId: id });
      const w = window.open('', '_blank');
      if (!w) return;
      w.document.write(data.html);
      w.document.close();
      w.focus();
      setTimeout(() => w.print(), 400);
    } catch {
      setErr('Could not open that invoice.');
    }
  }

  return (
    <div className="w-full sm:w-auto">
      <button type="button" onClick={toggle} className="text-sm font-medium text-brand-700 hover:underline">
        {open ? 'Hide invoices' : 'Invoices'}
      </button>
      {open && (
        <div className="card mt-2 p-3 sm:min-w-[20rem]">
          {busy && <p className="text-sm text-ink-soft">Loading…</p>}
          {err && <p className="text-sm text-red-600">{err}</p>}
          {!busy && !err && rows && rows.length === 0 && (
            <p className="text-sm text-ink-soft">No invoices yet. One is created each time credits are added.</p>
          )}
          {!busy && rows && rows.length > 0 && (
            <ul className="divide-y divide-black/5">
              {rows.map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-3 py-2">
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium text-ink">{r.number}</p>
                    <p className="text-xs text-ink-soft">{date(r.issuedAtMs)} · {fmt(r.totalInr)}</p>
                  </div>
                  <button type="button" onClick={() => download(r.id)} className="btn btn-outline btn-sm shrink-0">
                    Download
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
