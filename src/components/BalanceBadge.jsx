import { formatINR } from '@shared/currency.js';
import { isLowBalance } from '@shared/billing.js';

export default function BalanceBadge({ balance }) {
  const low = balance != null && isLowBalance(balance);
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-semibold ${
        low ? 'bg-amber-50 text-amber-700' : 'bg-brand-50 text-brand-700'
      }`}
      title="Your balance"
    >
      <span aria-hidden>🪙</span>
      <span>{balance == null ? '…' : formatINR(balance)}</span>
    </span>
  );
}
