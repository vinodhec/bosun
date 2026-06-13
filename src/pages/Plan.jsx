import { useState } from 'react';
import { useAuth } from '../hooks/useAuth.js';
import { useOrg } from '../hooks/useOrg.js';
import { planFeature, publishPlan } from '../firebase/functions.js';
import Navbar from '../components/Navbar.jsx';

const EMPTY_TASK = { title: '', description: '', acceptanceCriteria: [], dependsOn: [] };

function friendlyError(e) {
  const m = String(e?.message || '');
  if (m.includes('NO_BOARD_CONNECTED')) return 'Your task board isn’t connected yet — the Bosun team will set it up for you.';
  if (m.includes('NO_ORG')) return 'Your account isn’t set up yet — the Bosun team will sort it.';
  if (m.includes('LOW_BALANCE')) return 'You don’t have enough credit to send these tasks. Please top up and try again.';
  return 'Something went wrong. Your tasks were not sent and you were not charged.';
}

// A stable id for this batch, so sending the same list twice (e.g. after a hiccup) never
// creates the cards twice. Generated once per feature; cleared when starting over.
function newPlanId() {
  return (crypto?.randomUUID?.() || `plan${Date.now()}${Math.round(Math.random() * 1e6)}`);
}

export default function Plan() {
  const { user } = useAuth();
  const org = useOrg(user);

  const [prompt, setPrompt] = useState('');
  const [tasks, setTasks] = useState(null); // null = not suggested yet; [] = empty list
  const [planId, setPlanId] = useState('');
  const [thinking, setThinking] = useState(false);
  const [sending, setSending] = useState(false);
  const [err, setErr] = useState('');
  const [published, setPublished] = useState(null); // { cards: [...] }

  const balance = org === undefined ? null : org?.balance ?? null;
  const boardConnected = !!org?.trello?.connected;
  const boardName = org?.trello?.boardName || '';

  const suggest = async () => {
    if (!prompt.trim()) return;
    setThinking(true); setErr(''); setPublished(null);
    try {
      const { data } = await planFeature({ prompt: prompt.trim() });
      setTasks(Array.isArray(data?.tasks) ? data.tasks : []);
      setPlanId(newPlanId());
    } catch (e) {
      setErr(friendlyError(e));
    } finally {
      setThinking(false);
    }
  };

  const updateTask = (i, patch) =>
    setTasks((prev) => prev.map((t, j) => (j === i ? { ...t, ...patch } : t)));
  const removeTask = (i) => setTasks((prev) => prev.filter((_, j) => j !== i));
  const addTask = () => setTasks((prev) => [...(prev || []), { ...EMPTY_TASK }]);

  const startOver = () => {
    setPrompt(''); setTasks(null); setPlanId(''); setErr(''); setPublished(null);
  };

  const send = async () => {
    const ready = (tasks || [])
      .map((t) => ({
        title: String(t.title || '').trim(),
        description: String(t.description || '').trim(),
        acceptanceCriteria: (t.acceptanceCriteria || []).map((c) => String(c).trim()).filter(Boolean),
        dependsOn: (t.dependsOn || []).map((c) => String(c).trim()).filter(Boolean),
      }))
      .filter((t) => t.title);
    if (!ready.length) { setErr('Please add at least one task with a title.'); return; }

    setSending(true); setErr('');
    try {
      const { data } = await publishPlan({ planId, prompt: prompt.trim(), tasks: ready });
      setPublished({ cards: data?.cards || [] });
    } catch (e) {
      setErr(friendlyError(e));
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="min-h-screen">
      <Navbar balance={balance} />
      <main className="mx-auto w-full max-w-2xl px-4 py-6 space-y-6">
        <header>
          <h1 className="text-xl font-bold text-ink">Plan a feature</h1>
          <p className="mt-1 text-sm text-ink-soft">
            Describe what you’d like to add to your website. We’ll suggest the tasks to get it
            done — you can edit them, then send them to your task board.
          </p>
        </header>

        {org === null && (
          <div className="rounded-xl bg-amber-50 p-4 text-sm text-amber-800 ring-1 ring-amber-200">
            Your account isn’t set up yet — the Bosun team will get you ready.
          </div>
        )}

        {org && !boardConnected && (
          <div className="rounded-xl bg-amber-50 p-4 text-sm text-amber-800 ring-1 ring-amber-200">
            Your task board isn’t connected yet — the Bosun team will set it up so your tasks
            have somewhere to go.
          </div>
        )}

        {/* SUCCESS — the cards were created. */}
        {published ? (
          <section className="rounded-2xl border border-line bg-white p-5 sm:p-6">
            <h2 className="text-lg font-bold text-ink">Tasks added ✅</h2>
            <p className="mt-1 text-sm text-ink-soft">
              {published.cards.length} {published.cards.length === 1 ? 'task is' : 'tasks are'} now on
              {boardName ? <> your <span className="font-medium text-ink">{boardName}</span> board.</> : ' your board.'}
            </p>
            <ul className="mt-3 space-y-2">
              {published.cards.map((c) => (
                <li key={c.id || c.title} className="flex items-center justify-between gap-3 rounded-xl border border-line bg-canvas p-3">
                  <span className="text-sm font-medium text-ink">{c.title}</span>
                  {c.url && (
                    <a href={c.url} target="_blank" rel="noreferrer" className="shrink-0 text-sm font-semibold text-brand-600 hover:underline">
                      Open →
                    </a>
                  )}
                </li>
              ))}
            </ul>
            <button onClick={startOver} className="mt-4 rounded-xl bg-brand-600 px-5 py-2.5 font-semibold text-white transition hover:bg-brand-700">
              Plan another feature
            </button>
          </section>
        ) : (
          <>
            {/* STEP 1 — describe the feature. */}
            <section className="rounded-2xl border border-line bg-white p-5 sm:p-6">
              <label className="text-sm font-semibold text-ink">Describe the feature you want.</label>
              <textarea
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                rows={4}
                placeholder="Example: Let customers book a table online and get a confirmation by email"
                className="mt-2 w-full resize-y rounded-xl border border-line px-3 py-2 text-sm outline-none focus:border-brand-500"
              />
              <button
                onClick={suggest}
                disabled={thinking || !prompt.trim()}
                className="mt-3 inline-flex items-center justify-center rounded-xl bg-brand-600 px-5 py-2.5 font-semibold text-white transition hover:bg-brand-700 disabled:opacity-60"
              >
                {thinking ? 'Thinking…' : tasks ? 'Suggest again' : 'Suggest tasks'}
              </button>
              <p className="mt-2 text-xs text-ink-soft">Suggesting tasks is free — you only pay when you send them to your board.</p>
            </section>

            {/* STEP 2 — review / edit the suggested tasks. */}
            {tasks && (
              <section className="space-y-3">
                <div className="flex items-center justify-between px-1">
                  <h2 className="text-sm font-semibold uppercase tracking-wide text-ink-soft">Here are the tasks we suggest</h2>
                  <span className="text-xs text-ink-soft">{tasks.length} {tasks.length === 1 ? 'task' : 'tasks'}</span>
                </div>

                {tasks.length === 0 && (
                  <p className="rounded-xl border border-dashed border-line p-4 text-sm text-ink-soft">
                    We couldn’t suggest tasks for that. You can add them yourself below, or describe the feature differently and try again.
                  </p>
                )}

                {tasks.map((t, i) => (
                  <TaskEditor key={i} index={i} task={t} onChange={(patch) => updateTask(i, patch)} onRemove={() => removeTask(i)} />
                ))}

                <button onClick={addTask} className="rounded-xl border border-line px-4 py-2 text-sm font-semibold text-ink-soft transition hover:bg-canvas">
                  + Add a task
                </button>

                {err && <p className="text-sm text-bad">{err}</p>}

                <div className="flex flex-wrap items-center gap-3 pt-1">
                  <button
                    onClick={send}
                    disabled={sending || !boardConnected || !tasks.some((t) => String(t.title || '').trim())}
                    className="inline-flex items-center justify-center rounded-xl bg-good px-5 py-2.5 font-semibold text-white transition hover:opacity-90 disabled:opacity-60"
                  >
                    {sending ? 'Sending…' : 'Send to my board →'}
                  </button>
                  <button onClick={startOver} disabled={sending} className="rounded-xl px-4 py-2.5 font-semibold text-ink-soft transition hover:bg-line/40 disabled:opacity-60">
                    Start over
                  </button>
                </div>
              </section>
            )}

            {err && !tasks && <p className="px-1 text-sm text-bad">{err}</p>}
          </>
        )}
      </main>
    </div>
  );
}

// One editable suggested task: title, description, and acceptance criteria (one per line).
function TaskEditor({ index, task, onChange, onRemove }) {
  const criteriaText = (task.acceptanceCriteria || []).join('\n');
  return (
    <div className="rounded-2xl border border-line bg-white p-4">
      <div className="flex items-start justify-between gap-3">
        <span className="mt-1 text-xs font-semibold uppercase tracking-wide text-ink-soft">Task {index + 1}</span>
        <button onClick={onRemove} className="text-xs font-medium text-ink-soft underline transition hover:text-bad">
          Remove
        </button>
      </div>
      <input
        value={task.title || ''}
        onChange={(e) => onChange({ title: e.target.value })}
        placeholder="Task title"
        className="mt-2 w-full rounded-lg border border-line px-3 py-2 text-sm font-medium text-ink outline-none focus:border-brand-500"
      />
      <textarea
        value={task.description || ''}
        onChange={(e) => onChange({ description: e.target.value })}
        rows={2}
        placeholder="What needs to happen, in a sentence or two"
        className="mt-2 w-full resize-y rounded-lg border border-line px-3 py-2 text-sm text-ink-soft outline-none focus:border-brand-500"
      />
      <label className="mt-2 block text-xs font-medium text-ink-soft">How we’ll know it’s done (one per line)</label>
      <textarea
        value={criteriaText}
        onChange={(e) => onChange({ acceptanceCriteria: e.target.value.split('\n') })}
        rows={3}
        placeholder={'Example:\nCustomer can pick a date and time\nThey get a confirmation email'}
        className="mt-1 w-full resize-y rounded-lg border border-line px-3 py-2 text-sm text-ink-soft outline-none focus:border-brand-500"
      />
    </div>
  );
}
