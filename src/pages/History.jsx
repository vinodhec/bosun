import { useAuth } from '../hooks/useAuth.js';
import { useBalance } from '../hooks/useBalance.js';
import { useTasks } from '../hooks/useTasks.js';
import Navbar from '../components/Navbar.jsx';
import TaskCard from '../components/TaskCard.jsx';

export default function History() {
  const { user } = useAuth();
  const uid = user?.uid;
  const balance = useBalance(uid);
  const { tasks, loading } = useTasks(uid, 50);

  return (
    <div className="min-h-screen">
      <Navbar balance={balance} />
      <main className="mx-auto max-w-3xl space-y-3 px-4 py-6">
        <h1 className="text-xl font-bold text-ink">Your fixes</h1>
        {loading ? (
          <p className="text-sm text-ink-soft">Loading…</p>
        ) : tasks.length === 0 ? (
          <p className="rounded-xl border border-dashed border-line bg-white p-6 text-center text-sm text-ink-soft">
            No fixes yet.
          </p>
        ) : (
          tasks.map((t) => <TaskCard key={t.id} task={t} />)
        )}
      </main>
    </div>
  );
}
