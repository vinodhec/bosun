import { useEffect, useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { onSnapshot, taskDocRef } from '../firebase/firestore.js';

const STEPS = ['Reading your website', 'Finding the problem', 'Applying the fix'];

export default function Running() {
  const { taskId } = useParams();
  const navigate = useNavigate();
  const [step, setStep] = useState(0);

  // Live status: when the fix completes (or fails), go to the result screen.
  useEffect(() => {
    if (!taskId) return undefined;
    return onSnapshot(taskDocRef(taskId), (snap) => {
      const status = snap.exists() ? snap.data().status : null;
      if (status === 'complete' || status === 'failed') {
        navigate(`/result/${taskId}`, { replace: true });
      }
    });
  }, [taskId, navigate]);

  // Gently advance the visible step while we wait (cosmetic).
  useEffect(() => {
    const t = setInterval(() => setStep((s) => Math.min(s + 1, STEPS.length - 1)), 45000);
    return () => clearInterval(t);
  }, []);

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm rounded-2xl border border-line bg-white p-6 text-center shadow-sm">
        <div className="text-3xl">🔧</div>
        <h1 className="mt-3 text-lg font-bold text-ink">Working on it…</h1>
        <p className="mt-1 text-sm text-ink-soft">Please wait 3–5 minutes. You can leave this open.</p>

        <ul className="mt-6 space-y-3 text-left">
          {STEPS.map((label, i) => {
            const state = i < step ? 'done' : i === step ? 'active' : 'todo';
            return (
              <li key={label} className="flex items-center gap-3">
                <span aria-hidden>
                  {state === 'done' ? '✅' : state === 'active' ? '⏳' : '◻️'}
                </span>
                <span className={state === 'todo' ? 'text-ink-soft' : 'font-medium text-ink'}>
                  {label}
                </span>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
