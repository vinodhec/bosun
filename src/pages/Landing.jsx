import { Link } from 'react-router-dom';

const CAPABILITIES = [
  { icon: '🔧', title: 'Fix Issues', desc: 'Bugs, broken features, performance problems - we find and fix them.' },
  { icon: '✨', title: 'Build Features', desc: 'New functionality, improvements, experiments - broken into shippable steps.' },
  { icon: '🎨', title: 'Design Screens', desc: 'Modern, pixel-perfect UI components built to match your brand.' },
  { icon: '📊', title: 'Analyze Competition', desc: 'See how you stack up against competitors - side-by-side.' },
];

const STEPS = [
  { n: '1', t: 'Describe what you need', d: 'Tell us in plain words. Screenshots help us get it exactly right.' },
  { n: '2', t: 'AI builds it', d: 'Our Managed Agent clones your repo, makes changes, and opens a PR.' },
  { n: '3', t: 'Review and deploy', d: 'Test it, refine it, then merge to ship live. Done in minutes.' },
];

export default function Landing() {
  return (
    <div className="page-bg min-h-screen">
      <header className="container-app flex items-center justify-between py-5">
        <span className="flex items-center gap-2.5 font-bold text-xl text-ink">
          <span className="logo-mark" aria-hidden>✦</span>
          Bosun
        </span>
        <Link
          to="/auth"
          className="btn btn-ghost btn-sm font-semibold text-brand-600 hover:text-brand-700"
        >
          Sign in
        </Link>
      </header>

      <main className="container-app max-w-4xl py-12 sm:py-28">
        <div className="animate-fade-up text-center">
          <span className="badge badge-brand mx-auto mb-6">
            <span aria-hidden>⚡</span>
            AI-powered website management for small businesses
          </span>
        </div>

        <h1 className="animate-fade-up animate-fade-up-delay-1 mt-8 text-5xl font-black tracking-tight text-ink sm:text-6xl sm:leading-[1.1]">
          Get things done
          {' '}
          <span className="bg-gradient-to-r from-brand-600 via-brand-500 to-teal-600 bg-clip-text text-transparent">
            without the developers
          </span>
        </h1>
        <p className="animate-fade-up animate-fade-up-delay-2 mt-6 text-xl leading-relaxed text-ink-soft sm:text-2xl">
          Fix bugs, build features, design screens, and analyze competitors. All with AI. Starting from ₹75.
        </p>

        <div className="animate-fade-up animate-fade-up-delay-3 mt-10 flex flex-col gap-3 sm:flex-row sm:justify-center">
          <Link to="/auth" className="btn btn-primary btn-lg">
            Get Started Free
          </Link>
          <Link to="/auth" className="btn btn-outline btn-lg">
            View pricing
          </Link>
        </div>
        <p className="animate-fade-up animate-fade-up-delay-3 mt-4 text-center text-sm text-ink-muted">₹75 free credit • No payment required to start</p>

        {/* Capabilities grid */}
        <div className="mt-24 grid gap-6 sm:grid-cols-2">
          {CAPABILITIES.map((cap, i) => (
            <div
              key={cap.title}
              className={`animate-fade-up card-subtle p-6 transition-all hover:shadow-md ${
                i === 0 ? 'animate-fade-up-delay-1' :
                i === 1 ? 'animate-fade-up-delay-2' :
                i === 2 ? 'animate-fade-up-delay-3' : ''
              }`}
            >
              <div className="text-3xl mb-3" aria-hidden>{cap.icon}</div>
              <h3 className="text-lg font-bold text-ink">{cap.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-ink-soft">{cap.desc}</p>
            </div>
          ))}
        </div>

        {/* How it works */}
        <div className="mt-24">
          <h2 className="text-center text-3xl font-bold text-ink mb-12">How it works</h2>
          <div className="grid gap-6 sm:grid-cols-3">
            {STEPS.map((s, i) => (
              <div
                key={s.n}
                className={`step-card animate-fade-up ${i === 0 ? 'animate-fade-up-delay-1' : i === 1 ? 'animate-fade-up-delay-2' : 'animate-fade-up-delay-3'}`}
              >
                <div className="step-num">{s.n}</div>
                <h3 className="mt-4 font-semibold text-ink">{s.t}</h3>
                <p className="mt-2 text-sm leading-relaxed text-ink-soft">{s.d}</p>
              </div>
            ))}
          </div>
        </div>

        {/* Trust signals */}
        <div className="mt-24 rounded-2xl border border-line bg-gradient-to-br from-brand-50 to-white p-8 text-center">
          <p className="text-sm font-semibold uppercase tracking-widest text-brand-600">Trusted by small businesses</p>
          <p className="mt-4 text-lg text-ink-soft">Fast, affordable, transparent pricing. You only pay when it is done.</p>
        </div>
      </main>

      <footer className="container-app border-t border-line py-8 text-center text-sm text-ink-muted mt-12">
        <p>Made for India • Powered by Claude AI</p>
      </footer>
    </div>
  );
}
