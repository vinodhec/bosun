import { Link } from 'react-router-dom';

const STEPS = [
  { n: '1', t: 'Describe what’s broken', d: 'Tell us in plain words — like texting a friend.' },
  { n: '2', t: 'We fix it automatically', d: 'Our AI finds the problem and fixes it for you.' },
  { n: '3', t: 'Download your fix', d: 'Get your working website back in minutes.' },
];

export default function Landing() {
  return (
    <div className="min-h-screen">
      <header className="mx-auto flex max-w-5xl items-center justify-between px-4 py-4">
        <span className="flex items-center gap-2 font-bold">
          <span aria-hidden>🔧</span> Fix My Website
        </span>
        <Link to="/auth" className="text-sm font-semibold text-brand-600 hover:text-brand-700">
          Sign in
        </Link>
      </header>

      <main className="mx-auto max-w-3xl px-4 py-16 text-center sm:py-24">
        <h1 className="text-4xl font-extrabold tracking-tight text-ink sm:text-5xl">
          Fix your website problems in minutes
        </h1>
        <p className="mt-4 text-lg text-ink-soft">No developers needed. Starting from ₹75.</p>

        <Link
          to="/auth"
          className="mt-8 inline-flex items-center justify-center rounded-xl bg-brand-600 px-7 py-3.5 text-base font-semibold text-white shadow-sm transition hover:bg-brand-700"
        >
          Get Started Free
        </Link>
        <p className="mt-3 text-sm text-ink-soft">₹75 free credit when you sign up.</p>

        <div className="mt-16 grid gap-5 text-left sm:grid-cols-3">
          {STEPS.map((s) => (
            <div key={s.n} className="rounded-2xl border border-line bg-white p-5">
              <div className="flex h-9 w-9 items-center justify-center rounded-full bg-brand-50 font-bold text-brand-600">
                {s.n}
              </div>
              <h3 className="mt-3 font-semibold text-ink">{s.t}</h3>
              <p className="mt-1 text-sm text-ink-soft">{s.d}</p>
            </div>
          ))}
        </div>
      </main>
    </div>
  );
}
