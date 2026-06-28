import { Link } from 'react-router-dom';

const STEPS = [
  { n: '1', t: 'Describe what’s broken', d: 'Tell us in plain words — like texting a friend.' },
  { n: '2', t: 'We fix it automatically', d: 'Our AI finds the problem and fixes it for you.' },
  { n: '3', t: 'Download your fix', d: 'Get your working website back in minutes.' },
];

export default function Landing() {
  return (
    <div className="page-bg min-h-screen">
      <header className="container-app flex items-center justify-between py-5">
        <span className="flex items-center gap-2.5 font-bold text-ink">
          <span className="logo-mark" aria-hidden>🔧</span>
          Fix My Website
        </span>
        <Link
          to="/auth"
          className="btn btn-ghost btn-sm font-semibold text-brand-600 hover:text-brand-700"
        >
          Sign in
        </Link>
      </header>

      <main className="container-app max-w-3xl py-16 text-center sm:py-24">
        <div className="animate-fade-up">
          <span className="badge badge-brand mx-auto mb-6">
            <span aria-hidden>✦</span>
            Built for small businesses in India
          </span>
        </div>

        <h1 className="animate-fade-up animate-fade-up-delay-1 text-4xl font-extrabold tracking-tight text-ink sm:text-5xl sm:leading-[1.1]">
          Fix your website problems{' '}
          <span className="bg-gradient-to-r from-brand-600 to-brand-700 bg-clip-text text-transparent">
            in minutes
          </span>
        </h1>
        <p className="animate-fade-up animate-fade-up-delay-2 mt-5 text-lg text-ink-soft sm:text-xl">
          No developers needed. Starting from ₹75.
        </p>

        <div className="animate-fade-up animate-fade-up-delay-3 mt-10">
          <Link to="/auth" className="btn btn-primary btn-lg">
            Get Started Free
          </Link>
          <p className="mt-3.5 text-sm text-ink-muted">₹75 free credit when you sign up.</p>
        </div>

        <div className="mt-20 grid gap-5 text-left sm:grid-cols-3">
          {STEPS.map((s, i) => (
            <div
              key={s.n}
              className={`step-card animate-fade-up ${i === 0 ? 'animate-fade-up-delay-1' : i === 1 ? 'animate-fade-up-delay-2' : 'animate-fade-up-delay-3'}`}
            >
              <div className="step-num">{s.n}</div>
              <h3 className="mt-4 font-semibold text-ink">{s.t}</h3>
              <p className="mt-1.5 text-sm leading-relaxed text-ink-soft">{s.d}</p>
            </div>
          ))}
        </div>
      </main>

      <footer className="container-app border-t border-line py-8 text-center text-sm text-ink-muted">
        Simple, honest pricing — you only pay when the fix is done.
      </footer>
    </div>
  );
}
