import { formatINR } from '@shared/currency.js';
import { isLowBalance } from '@shared/billing.js';

export default function BalanceBadge({ balance }) {
  const low = balance != null && isLowBalance(balance);
  return (
    <span
      className={`badge ${low ? 'badge-warn' : 'badge-brand'}`}
      title="Your balance"
    >
      <span aria-hidden>🪙</span>
      <span>{balance == null ? '…' : formatINR(balance)}</span>
    </span>
  );
}
