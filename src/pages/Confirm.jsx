import { useState } from 'react';
import { useLocation, useNavigate, Navigate } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth.js';
import { useBalance } from '../hooks/useBalance.js';
import { createTask } from '../firebase/functions.js';

export default function Confirm() {
  const { state } = useLocation();
  const navigate = useNavigate();
  const { user } = useAuth();
  const balance = useBalance(user?.uid);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  // Arrived here without a classified request → back to start.
  if (!state?.prompt) return <Navigate to="/dashboard" replace />;

  const { prompt, complexity = 'medium', reason } = state;

  const confirm = async () => {
    setBusy(true); setErr('');
    try {
      const { data } = await createTask({ prompt, complexity });
      navigate(`/running/${data.taskId}`, { replace: true });
    } catch (e) {
      setErr('We couldn’t start the fix. You were not charged. Please try again.');
      setBusy(false);
    }
  };

  return (
    <div className="page-bg min-h-screen">
      <div className="container-app mx-auto flex min-h-screen items-center justify-center px-4 py-10">
        <div className="w-full max-w-md rounded-3xl border border-line bg-white p-8 shadow-sm">
          <h1 className="text-xl font-bold text-ink">We&rsquo;ll fix this for you!</h1>
          <p className="mt-2 rounded-xl bg-canvas p-3 text-sm text-ink-soft">&ldquo;{prompt}&rdquo;</p>
          {reason && <p className="mt-3 text-sm text-ink-soft">{reason}</p>}

          <dl className="mt-5 space-y-2 text-sm">
            <div className="flex items-center justify-between">
              <dt className="text-ink-soft">Time needed</dt>
              <dd className="font-semibold text-ink">3–5 minutes</dd>
            </div>
          </dl>

          <p className="mt-4 rounded-xl bg-brand-50 p-3 text-xs text-ink-soft">
            You&rsquo;ll see the exact price once the fix is ready — and you&rsquo;re only
            charged when you approve it.
          </p>

          {err && <p className="mt-4 text-sm text-bad">{err}</p>}

          <div className="mt-5 flex gap-3">
            <button
              onClick={() => navigate('/dashboard')}
              className="flex-1 rounded-xl border border-line px-4 py-3 font-semibold text-ink transition hover:bg-canvas"
            >
              Cancel
            </button>
            <button
              onClick={confirm}
              disabled={busy || balance == null}
              className="flex-1 rounded-xl bg-brand-600 px-4 py-3 font-semibold text-white transition hover:bg-brand-700 disabled:opacity-60"
            >
              {busy ? 'Starting…' : 'Yes, Fix It!'}
            </button>
          </div>
        </div>
      </div>
      );
}
