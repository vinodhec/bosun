import { useEffect, useState } from 'react';
import { listMyInvoices, getMyInvoiceHtml, getMyInvoiceShareLink } from '@/firebase/functions';
import { shareOnWhatsApp } from '@/utils/share.js';

const fmt = (n) => `₹${Number(n || 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmt0 = (n) => `₹${Number(n || 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
const date = (ms) => (ms ? new Date(ms).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '');

const CHIP = {
  paid: 'bg-green-50 text-green-700 ring-green-200',
  partial: 'bg-amber-50 text-amber-700 ring-amber-200',
  unpaid: 'bg-red-50 text-red-700 ring-red-200',
};
function StatusChip({ inv }) {
  const label = inv.paymentStatus === 'paid' ? 'Paid'
    : inv.paymentStatus === 'partial' ? `${fmt0(inv.dueInr)} to pay`
    : 'To pay';
  return <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ${CHIP[inv.paymentStatus] || CHIP.unpaid}`}>{label}</span>;
}

// Customer view of GST tax invoices (issued when the team adds credits to the wallet). Visibility
// is granted per-user by the operator: on mount we ask the backend whether this person is allowed;
// if not, the whole panel renders nothing. Each invoice shows whether it is paid or still to pay,
// opens as a printable page to save as a PDF, and can be sent on WhatsApp (to the accountant, a
// partner…) as a public link that always shows the current status.
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

  async function share(id) {
    setErr('');
    try {
      const { data } = await getMyInvoiceShareLink({ invoiceId: id });
      shareOnWhatsApp(data.message);
    } catch {
      setErr('Could not share that invoice.');
    }
  }

  // Hidden entirely while checking access and for users without the grant.
  if (allowed !== true) return null;

  const pending = (rows || []).filter((r) => r.paymentStatus !== 'paid');
  const dueTotal = pending.reduce((a, r) => a + (r.dueInr || 0), 0);

  return (
    <div className="w-full sm:w-auto">
      <button type="button" onClick={() => setOpen((o) => !o)} className="text-sm font-medium text-brand-700 hover:underline">
        {open ? 'Hide invoices' : pending.length ? `Invoices · ${pending.length} to pay` : 'Invoices'}
      </button>
      {open && (
        <div className="card mt-2 p-3 sm:min-w-[22rem]">
          {busy && <p className="text-sm text-ink-soft">Loading…</p>}
          {err && <p className="text-sm text-red-600">{err}</p>}
          {!busy && !err && rows && rows.length === 0 && (
            <p className="text-sm text-ink-soft">No invoices yet. One is created each time credits are added.</p>
          )}
          {!busy && rows && rows.length > 0 && (
            <>
              <p className="mb-1 text-xs text-ink-soft">
                {rows.length - pending.length} paid · {pending.length} to pay{dueTotal > 0 ? ` · ${fmt0(dueTotal)} outstanding` : ''}
              </p>
              <ul className="divide-y divide-black/5">
                {rows.map((r) => (
                  <li key={r.id} className="flex items-center justify-between gap-3 py-2">
                    <div className="min-w-0">
                      <p className="flex flex-wrap items-center gap-2 text-sm font-medium text-ink"><span className="truncate">{r.number}</span><StatusChip inv={r} /></p>
                      <p className="text-xs text-ink-soft">{date(r.issuedAtMs)} · {fmt(r.totalInr)}{r.paymentStatus === 'paid' && r.paidAtMs ? ` · paid ${date(r.paidAtMs)}` : ''}</p>
                    </div>
                    <div className="flex shrink-0 gap-1.5">
                      <button type="button" onClick={() => download(r.id)} className="btn btn-outline btn-sm">
                        Download
                      </button>
                      <button type="button" onClick={() => share(r.id)} className="btn btn-sm bg-[#25D366] text-white hover:bg-[#1ebe5d]" title="Send on WhatsApp">
                        WhatsApp
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      )}
    </div>
  );
}
