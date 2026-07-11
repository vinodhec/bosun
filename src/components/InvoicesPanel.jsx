import { useEffect, useState } from 'react';
import { listMyInvoices, getMyInvoiceHtml } from '@/firebase/functions';

const fmt = (n) => `₹${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const date = (ms) => (ms ? new Date(ms).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '');

// Customer view of GST tax invoices (issued when the team adds credits to the wallet). Visibility
// is granted per-user by the operator: on mount we ask the backend whether this person is allowed;
// if not, the whole panel renders nothing. Each invoice opens as a printable page to save as a PDF.
export default function InvoicesPanel({ orgId }) {
  const [allowed, setAllowed] = useState(null); // null = checking, false = hide, true = show
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  // One lightweight call on mount / org switch decides both access AND fills the list.
  useEffect(() => {
    let live = true;
    setBusy(true); setErr('');
    listMyInvoices(orgId ? { orgId } : {})
      .then(({ data }) => {
        if (!live) return;
        setAllowed(data?.allowed !== false);
        setRows(data?.invoices || []);
      })
      .catch(() => { if (live) { setAllowed(false); } })
      .finally(() => { if (live) setBusy(false); });
    return () => { live = false; };
  }, [orgId]);

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

  // Hidden entirely while checking access and for users without the grant.
  if (allowed !== true) return null;

  return (
    <div className="w-full sm:w-auto">
      <button type="button" onClick={() => setOpen((o) => !o)} className="text-sm font-medium text-brand-700 hover:underline">
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
