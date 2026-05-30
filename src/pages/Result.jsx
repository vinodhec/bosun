import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { onSnapshot, taskDocRef } from '../firebase/firestore.js';
import { useAuth } from '../hooks/useAuth.js';
import { useBalance } from '../hooks/useBalance.js';
import IdealPromptTip from '../components/IdealPromptTip.jsx';
import { formatINR } from '@shared/currency.js';
import { isLowBalance } from '@shared/billing.js';

function Centered({ children }) {
  return <div className="flex min-h-screen items-center justify-center px-4 text-ink-soft">{children}</div>;
}

export default function Result() {
  const { taskId } = useParams();
  const navigate = useNavigate();
  const { user } = useAuth();
  const balance = useBalance(user?.uid);
  const [task, setTask] = useState(undefined);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!taskId) return undefined;
    return onSnapshot(taskDocRef(taskId), (snap) =>
      setTask(snap.exists() ? { id: snap.id, ...snap.data() } : null)
    );
  }, [taskId]);

  if (task === undefined) return <Centered>Loading…</Centered>;
  if (!task) return <Centered>We couldn’t find that fix.</Centered>;

  if (task.status === 'failed') {
    return (
      <div className="flex min-h-screen items-center justify-center px-4">
        <div className="w-full max-w-md rounded-2xl border border-line bg-white p-6 text-center shadow-sm">
          <h1 className="text-xl font-bold text-ink">Something went wrong 😔</h1>
          <p className="mt-2 text-ink-soft">No charges were applied.</p>
          <button
            onClick={() => navigate('/dashboard')}
            className="mt-5 w-full rounded-xl bg-brand-600 px-4 py-3 font-semibold text-white transition hover:bg-brand-700"
          >
            Try Again
          </button>
        </div>
      </div>
    );
  }

  if (task.status !== 'complete') {
    return <Centered>Still working on this fix…</Centered>;
  }

  const files = Array.isArray(task.filesChanged) ? task.filesChanged : [];
  const low = balance != null && isLowBalance(balance);

  return (
    <div className="flex min-h-screen items-start justify-center px-4 py-10">
      <div className="w-full max-w-md rounded-2xl border border-line bg-white p-6 shadow-sm">
        <h1 className="text-xl font-bold text-ink">Your fix is ready! ✅</h1>
        {task.resultSummary && <p className="mt-2 text-ink-soft">{task.resultSummary}</p>}

        <dl className="mt-5 space-y-2 rounded-xl bg-canvas p-4 text-sm">
          <div className="flex items-center justify-between">
            <dt className="text-ink-soft">Cost charged</dt>
            <dd className="font-semibold text-ink">{formatINR(task.finalCharge)}</dd>
          </div>
          <div className="flex items-center justify-between">
            <dt className="text-ink-soft">Remaining balance</dt>
            <dd className="font-semibold text-ink">{balance == null ? '…' : formatINR(balance)}</dd>
          </div>
        </dl>

        {files.length > 0 && (
          <div className="mt-4">
            <button
              onClick={() => setOpen((o) => !o)}
              className="flex w-full items-center justify-between rounded-xl border border-line px-4 py-3 text-left font-medium text-ink hover:bg-canvas"
            >
              See what changed
              <span aria-hidden>{open ? '−' : '+'}</span>
            </button>
            {open && (
              <ul className="mt-2 space-y-2">
                {files.map((f, i) => (
                  <li key={i} className="rounded-xl bg-canvas p-3 text-sm">
                    <p className="font-medium text-ink">{f.fileName}</p>
                    {f.description && <p className="mt-0.5 text-ink-soft">{f.description}</p>}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <IdealPromptTip text={task.idealDescription} keywords={task.idealKeywords} />

        <div className="mt-5 space-y-3">
          {task.prUrl && (
            <a
              href={task.prUrl} target="_blank" rel="noreferrer"
              className="block rounded-xl bg-brand-600 px-4 py-3 text-center font-semibold text-white transition hover:bg-brand-700"
            >
              See your fix online
            </a>
          )}
          {task.downloadUrl && (
            <a
              href={task.downloadUrl}
              className="block rounded-xl border border-line px-4 py-3 text-center font-semibold text-ink transition hover:bg-canvas"
            >
              Download fixed files
            </a>
          )}
          <button
            onClick={() => navigate('/dashboard')}
            className="block w-full rounded-xl border border-line px-4 py-3 text-center font-semibold text-ink transition hover:bg-canvas"
          >
            Fix Something Else
          </button>
          {low && (
            <button
              onClick={() => navigate('/topup')}
              className="block w-full rounded-xl bg-amber-100 px-4 py-3 text-center font-semibold text-amber-800 transition hover:bg-amber-200"
            >
              Top Up Credits
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
