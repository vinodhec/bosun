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
    <div className="page-bg min-h-screen">
      <Navbar balance={balance} />
      <main className="container-app mx-auto space-y-3 py-10">
        <div className="rounded-3xl border border-line bg-white p-6 shadow-sm">
          <h1 className="text-2xl font-semibold text-ink">Your fixes</h1>
          <p className="mt-2 text-sm text-ink-soft">All your changes and charge history are shown here.</p>
        </div>
        <div className="space-y-3">
          {loading ? (
            <p className="text-sm text-ink-soft">Loading…</p>
          ) : tasks.length === 0 ? (
            <p className="rounded-xl border border-dashed border-line bg-white p-6 text-center text-sm text-ink-soft">
              No fixes yet.
            </p>
          ) : (
            tasks.map((t) => <TaskCard key={t.id} task={t} />)
          )}
        </div>
      </main>
    </div>
  );
}
