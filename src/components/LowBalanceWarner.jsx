import { Link } from 'react-router-dom';
import { isLowBalance } from '@shared/billing.js';

export default function LowBalanceWarner({ balance }) {
  if (balance == null || !isLowBalance(balance)) return null;
  return (
    <Link
      to="/topup"
      className="flex items-center justify-between gap-3 rounded-xl bg-amber-50 px-4 py-3 text-sm font-medium text-amber-800 ring-1 ring-amber-200 transition hover:bg-amber-100"
    >
      <span>Running low! Top up to keep fixing</span>
      <span aria-hidden>→</span>
    </Link>
  );
}
