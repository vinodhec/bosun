import { useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth.js';
import { useBalance } from '../hooks/useBalance.js';
import { createRazorpayOrder } from '../firebase/functions.js';
import Navbar from '../components/Navbar.jsx';
import { formatINR } from '@shared/currency.js';

const PACKAGES = [
  { amount: 500, blurb: 'Good for ~6 fixes' },
  { amount: 1000, blurb: 'Good for ~13 fixes', popular: true },
  { amount: 2000, blurb: 'Good for ~26 fixes' },
];

export default function TopUp() {
  const { state } = useLocation();
  const { user } = useAuth();
  const balance = useBalance(user?.uid);
  const [busy, setBusy] = useState(0);
  const [msg, setMsg] = useState('');
  const [err, setErr] = useState('');

  const buy = async (amount) => {
    setErr(''); setMsg('');
    if (!window.Razorpay) { setErr('Payments aren’t available right now. Please try again later.'); return; }
    setBusy(amount);
    try {
      const { data } = await createRazorpayOrder({ amount });
      const rzp = new window.Razorpay({
        key: data.keyId,
        amount: amount * 100,
        currency: 'INR',
        name: 'Bosun',
        description: `${formatINR(amount)} credits`,
        order_id: data.orderId,
        prefill: { email: user?.email || '' },
        theme: { color: '#4f46e5' },
        handler: () => {
          setBusy(0);
          setMsg(`${formatINR(amount)} added! Your balance will update in a few seconds.`);
        },
        modal: { ondismiss: () => setBusy(0) },
      });
      rzp.open();
    } catch {
      setBusy(0);
      setErr('We couldn’t start the payment. Please try again.');
    }
  };

  return (
    <div className="page-bg min-h-screen">
      <Navbar balance={balance} />
      <main className="container-app mx-auto px-4 py-10">
        <h1 className="text-xl font-bold text-ink">Add Credits</h1>
        {state?.message && (
          <p className="mt-3 rounded-xl bg-amber-50 px-4 py-3 text-sm font-medium text-amber-800">
            {state.message}
          </p>
        )}
        {msg && (
          <p className="mt-3 rounded-xl bg-green-50 px-4 py-3 text-sm font-medium text-green-700">{msg}</p>
        )}
        {err && <p className="mt-3 text-sm text-bad">{err}</p>}

        <div className="mt-5 grid gap-4 sm:grid-cols-3">
          {PACKAGES.map((p) => (
            <div
              key={p.amount}
              className={`relative rounded-2xl border bg-white p-5 text-center ${p.popular ? 'border-brand-500 ring-1 ring-brand-500' : 'border-line'
                }`}
            >
              {p.popular && (
                <span className="absolute -top-2 left-1/2 -translate-x-1/2 rounded-full bg-brand-600 px-2.5 py-0.5 text-xs font-semibold text-white">
                  POPULAR
                </span>
              )}
              <p className="text-2xl font-extrabold text-ink">{formatINR(p.amount)}</p>
              <p className="mt-1 text-sm text-ink-soft">{p.blurb}</p>
              <button
                onClick={() => buy(p.amount)}
                disabled={busy === p.amount}
                className="mt-4 w-full rounded-xl bg-brand-600 px-4 py-2.5 font-semibold text-white transition hover:bg-brand-700 disabled:opacity-60"
              >
                {busy === p.amount ? 'Opening…' : 'Add'}
              </button>
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}
