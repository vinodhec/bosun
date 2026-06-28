import { Link, useNavigate } from 'react-router-dom';
import { logout } from '../firebase/auth.js';
import { useAuth } from '../hooks/useAuth.js';
import BalanceBadge from './BalanceBadge.jsx';

const ADMINS = (import.meta.env.VITE_ADMIN_EMAILS || 'vinodhec@gmail.com')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);

export default function Navbar({ balance }) {
  const navigate = useNavigate();
  const { user } = useAuth();
  const isAdmin = !!user?.email && ADMINS.includes(user.email.toLowerCase());

  const linkCls = 'btn btn-ghost btn-sm font-medium';

  return (
    <header className="navbar">
      <div className="container-app flex h-[3.75rem] max-w-6xl items-center justify-between">
        <Link to="/dashboard" className="flex items-center gap-2.5 font-bold text-ink">
          <span className="logo-mark" aria-hidden>🔧</span>
          <span className="hidden sm:inline">Fix My Website</span>
        </Link>
        <nav className="flex items-center gap-1.5 sm:gap-2">
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
