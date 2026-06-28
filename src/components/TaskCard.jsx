import { Link } from 'react-router-dom';
import { formatINR } from '@shared/currency.js';

const STATUS = {
  queued: { label: 'Waiting', cls: 'bg-slate-100 text-slate-600' },
  running: { label: 'Working on it', cls: 'bg-blue-50 text-blue-700' },
  complete: { label: 'Fixed ✅', cls: 'bg-green-50 text-green-700' },
  failed: { label: 'Failed ❌', cls: 'bg-rose-50 text-rose-700' },
};

function when(ts) {
  try {
    const d = ts?.toDate ? ts.toDate() : null;
    return d
      ? new Intl.DateTimeFormat('en-IN', {
        day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
      }).format(d)
      : '';
  } catch {
    return '';
  }
}

export default function TaskCard({ task }) {
  const s = STATUS[task.status] || STATUS.queued;
  const done = task.status === 'complete';
  return (
    <div className="rounded-3xl border border-line bg-white p-5 shadow-sm transition hover:-translate-y-0.5 hover:shadow-md">
      <div className="flex items-start justify-between gap-3">
        <p className="line-clamp-2 font-semibold text-ink">{task.prompt}</p>
        <span className={`shrink-0 rounded-full px-3 py-1.5 text-xs font-semibold ${s.cls}`}>
          {s.label}
        </span>
      </div>
      <div className="mt-3 flex flex-wrap items-center justify-between gap-3 text-sm text-ink-soft">
        <span>{when(task.createdAt)}</span>
        {done && <span>Cost: {formatINR(task.finalCharge)}</span>}
      </div>
      {done && (
        <Link
          to={`/result/${task.id}`}
          className="mt-4 inline-flex items-center text-sm font-semibold text-brand-600 transition hover:text-brand-700"
        >
          View result →
        </Link>
      )}
    </div>
  );
}
