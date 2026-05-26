import { Link, useNavigate } from 'react-router-dom';
import { logout } from '../firebase/auth.js';
import { useAuth } from '../hooks/useAuth.js';
import BalanceBadge from './BalanceBadge.jsx';

// Client-side check only (cosmetic — to show the link). The real gate is server-side
// (ADMIN_EMAILS in the functions). Defaults to the operator's email.
const ADMINS = (import.meta.env.VITE_ADMIN_EMAILS || 'vinodhec@gmail.com')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

export default function Navbar({ balance }) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const isAdmin = !!user?.email && ADMINS.includes(user.email.toLowerCase());

  const linkCls = 'rounded-lg px-2.5 py-1.5 text-sm font-medium text-ink-soft hover:bg-canvas hover:text-ink';

  return (
    <header className="sticky top-0 z-10 border-b border-line bg-white/90 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-3xl items-center justify-between px-4">
        <Link to="/dashboard" className="flex items-center gap-2 font-bold text-ink">
          <span aria-hidden>🔧</span>
          <span className="hidden sm:inline">Fix My Website</span>
        </Link>
        <nav className="flex items-center gap-2 sm:gap-3">
          <BalanceBadge balance={balance} />
          {isAdmin && (
            <Link to="/admin" className={linkCls}>
              Admin
            </Link>
          )}
          <button onClick={() => logout().then(() => navigate('/'))} className={linkCls}>
            Sign out
          </button>
        </nav>
      </div>
    </header>
  );
}
