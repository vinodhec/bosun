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
    <div className="page-bg-auth flex min-h-screen items-center justify-center px-4 py-12">
      <div className="card-elevated w-full max-w-sm animate-fade-up p-7 sm:p-8">
        <Link to="/" className="flex items-center justify-center gap-2.5 font-bold text-ink">
          <span className="logo-mark" aria-hidden>🔧</span>
          Fix My Website
        </Link>
        <h1 className="mt-6 text-center text-xl font-bold text-ink">
          {mode === 'signup' ? 'Create your account' : 'Welcome back'}
        </h1>
        {mode === 'signup' && (
          <p className="mt-1.5 text-center text-sm text-ink-soft">Get ₹75 free credit to start.</p>
        )}

        <button
          onClick={withGoogle}
          disabled={busy}
          className="btn btn-outline mt-6 w-full py-3"
        >
          <svg className="h-5 w-5" viewBox="0 0 24 24" aria-hidden>
            <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" />
            <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
            <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
            <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
          </svg>
          Continue with Google
        </button>

        <div className="my-5 flex items-center gap-3 text-xs text-ink-muted">
          <span className="h-px flex-1 bg-line" /> or <span className="h-px flex-1 bg-line" />
        </div>

        <form onSubmit={submit} className="space-y-3">
          <input
            type="email" required value={email} onChange={(e) => setEmail(e.target.value)}
            placeholder="Email" autoComplete="email"
            className="input"
          />
          <input
            type="password" required value={pw} onChange={(e) => setPw(e.target.value)}
            placeholder="Password" autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
            className="input"
          />
          {err && <p className="text-sm text-bad">{err}</p>}
          <button type="submit" disabled={busy} className="btn btn-primary w-full py-3">
            {busy ? 'Please wait…' : mode === 'signup' ? 'Sign up' : 'Sign in'}
          </button>
        </form>

        <button
          onClick={() => { setErr(''); setMode(mode === 'signup' ? 'login' : 'signup'); }}
          className="mt-5 w-full text-center text-sm text-ink-soft transition hover:text-ink"
        >
          {mode === 'signup' ? 'Already have an account? Sign in' : 'New here? Create an account'}
        </button>
      </div>
    </div>
  );
}
