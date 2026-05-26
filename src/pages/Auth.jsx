import { useState } from 'react';
import { useNavigate, Navigate, Link } from 'react-router-dom';
import { signInWithGoogle, signUpWithEmail, loginWithEmail } from '../firebase/auth.js';
import { useAuth } from '../hooks/useAuth.js';
import { ensureUser } from '../firebase/functions.js';

function friendlyError(e) {
  const code = e?.code || '';
  if (code.includes('invalid-credential') || code.includes('wrong-password')) return 'Wrong email or password.';
  if (code.includes('email-already-in-use')) return 'That email already has an account. Try signing in.';
  if (code.includes('weak-password')) return 'Please choose a longer password (at least 6 characters).';
  if (code.includes('invalid-email')) return 'That doesn’t look like a valid email.';
  if (code.includes('popup-closed')) return '';
  return 'Something went wrong. Please try again.';
}

export default function Auth() {
  const { user, loading } = useAuth();
  const navigate = useNavigate();
  const [mode, setMode] = useState('signup');
  const [email, setEmail] = useState('');
  const [pw, setPw] = useState('');
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);

  if (loading) return null;
  if (user) return <Navigate to="/dashboard" replace />;

  // Create the user record (idempotent) right after sign-in, then go to the dashboard.
  const done = async () => {
    try { await ensureUser(); } catch { /* non-fatal; retried on next sign-in */ }
    navigate('/dashboard');
  };

  const withGoogle = async () => {
    setBusy(true); setErr('');
    try { await signInWithGoogle(); done(); }
    catch (e) { setErr(friendlyError(e)); } finally { setBusy(false); }
  };

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true); setErr('');
    try {
      if (mode === 'signup') await signUpWithEmail(email, pw);
      else await loginWithEmail(email, pw);
      done();
    } catch (e2) { setErr(friendlyError(e2)); } finally { setBusy(false); }
  };

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm rounded-2xl border border-line bg-white p-6 shadow-sm">
        <Link to="/" className="flex items-center justify-center gap-2 font-bold">
          <span aria-hidden>🔧</span> Fix My Website
        </Link>
        <h1 className="mt-5 text-center text-xl font-bold text-ink">
          {mode === 'signup' ? 'Create your account' : 'Welcome back'}
        </h1>
        {mode === 'signup' && (
          <p className="mt-1 text-center text-sm text-ink-soft">Get ₹75 free credit to start.</p>
        )}

        <button
          onClick={withGoogle}
          disabled={busy}
          className="mt-5 flex w-full items-center justify-center gap-2 rounded-xl border border-line bg-white px-4 py-3 font-semibold text-ink transition hover:bg-canvas disabled:opacity-60"
        >
          Continue with Google
        </button>

        <div className="my-4 flex items-center gap-3 text-xs text-ink-soft">
          <span className="h-px flex-1 bg-line" /> or <span className="h-px flex-1 bg-line" />
        </div>

        <form onSubmit={submit} className="space-y-3">
          <input
            type="email" required value={email} onChange={(e) => setEmail(e.target.value)}
            placeholder="Email" autoComplete="email"
            className="w-full rounded-xl border border-line px-4 py-3 outline-none focus:border-brand-500"
          />
          <input
            type="password" required value={pw} onChange={(e) => setPw(e.target.value)}
            placeholder="Password" autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
            className="w-full rounded-xl border border-line px-4 py-3 outline-none focus:border-brand-500"
          />
          {err && <p className="text-sm text-bad">{err}</p>}
          <button
            type="submit" disabled={busy}
            className="w-full rounded-xl bg-brand-600 px-4 py-3 font-semibold text-white transition hover:bg-brand-700 disabled:opacity-60"
          >
            {busy ? 'Please wait…' : mode === 'signup' ? 'Sign up' : 'Sign in'}
          </button>
        </form>

        <button
          onClick={() => { setErr(''); setMode(mode === 'signup' ? 'login' : 'signup'); }}
          className="mt-4 w-full text-center text-sm text-ink-soft hover:text-ink"
        >
          {mode === 'signup' ? 'Already have an account? Sign in' : 'New here? Create an account'}
        </button>
      </div>
    </div>
  );
}
