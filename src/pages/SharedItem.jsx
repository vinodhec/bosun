import { useCallback, useEffect, useState, lazy, Suspense } from 'react';
import { useParams, useSearchParams, useNavigate } from 'react-router-dom';
import {
  getSharedDesign, forkDesign, refineMockup,
  getSharedFeature, forkFeature,
  getSharedSession,
} from '../firebase/functions.js';
import { readImageAttachment } from '../utils/images.js';
import Navbar from '../components/Navbar.jsx';

// The markup tool pulls in the screenshot + drawing libraries — load them only when the teammate
// opens "Mark up the screen".
const MockAnnotator = lazy(() => import('../components/MockAnnotator.jsx'));

// A teammate opened a share link for a design, a feature plan, or a fix. We show it read-only and let
// them build their OWN version from it ("fork"). Sign-in is required (RequireAuth) because sharing is
// scoped to the same organisation — the server verifies membership.
//
// Per type, "use this as a starting point" does the most useful thing:
//   design  → copies the mock into their own design (they then request changes)
//   feature → copies the plan into their own feature in review (they approve / edit / refine)
//   fix     → pre-fills their normal "fix a website" box with the brief (they tweak and run it)
//
// Plain language only — no technical words.
export default function SharedItem() {
  const { type, id } = useParams();
  const [params] = useSearchParams();
  const shareToken = params.get('t') || '';
  const navigate = useNavigate();

  const [item, setItem] = useState(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const [showAnnotator, setShowAnnotator] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setErr('');
    try {
      if (type === 'design') {
        const { data } = await getSharedDesign({ designId: id, shareToken });
        setItem({ ...data.design });
      } else if (type === 'feature') {
        const { data } = await getSharedFeature({ featureId: id, shareToken });
        setItem({ ...data.feature });
      } else if (type === 'fix') {
        const { data } = await getSharedSession({ taskId: id, shareToken });
        setItem({ ...data.session });
      } else {
        setErr('This link isn’t something we recognise.');
      }
    } catch (e) {
      setErr(friendly(e));
    } finally {
      setLoading(false);
    }
  }, [type, id, shareToken]);

  useEffect(() => { load(); }, [load]);

  const useThis = async () => {
    setBusy(true); setErr('');
    try {
      if (type === 'design') {
        await forkDesign({ designId: id, shareToken });
        navigate('/dashboard');
      } else if (type === 'feature') {
        await forkFeature({ featureId: id, shareToken });
        navigate('/dashboard');
      } else if (type === 'fix') {
        // A fix has no copyable artifact — seed the owner's normal fix box with the brief.
        navigate('/dashboard', { state: { prefillFix: item?.brief || '' } });
      }
    } catch (e) {
      setErr(friendly(e));
      setBusy(false);
    }
  };

  // The teammate marked up the shared mock → make it THEIR version with those changes: fork the
  // design into their dashboard, then send the marked-up picture as the opening change request.
  const onApplyMarkup = async (file, summary) => {
    setBusy(true); setErr('');
    try {
      const { data } = await forkDesign({ designId: id, shareToken });
      const newId = data?.designId;
      const att = await readImageAttachment(file);
      await refineMockup({
        designId: newId,
        changes: summary || 'Please make the changes I marked on the screen.',
        images: [{ mediaType: att.mediaType, data: att.data }],
      });
      navigate('/dashboard');
    } catch (e) {
      setErr(friendly(e));
      setBusy(false);
    }
  };

  const heading = type === 'feature' ? 'A teammate shared this plan'
    : type === 'fix' ? 'A teammate shared this fix'
    : 'A teammate shared this design';

  const cta = type === 'fix' ? 'Use this as a starting point' : 'Use this as my starting point';

  return (
    <div className="min-h-screen bg-canvas">
      <Navbar />
      <main className="mx-auto max-w-3xl px-4 py-8">
        {loading ? (
          <p className="text-ink-soft">Loading…</p>
        ) : err && !item ? (
          <ErrorBox msg={err} onBack={() => navigate('/dashboard')} />
        ) : item ? (
          <div className="rounded-2xl border border-line bg-white p-5">
            <p className="text-xs font-medium uppercase tracking-wide text-brand-600">{heading}</p>
            {item.prompt && <p className="mt-1 text-sm text-ink-soft">“{item.prompt}”</p>}
            {item.problem && <p className="mt-1 text-sm text-ink-soft">“{item.problem}”</p>}

            {/* DESIGN: the live mock + the conversation behind it. */}
            {type === 'design' && (
              <>
                <h1 className="mt-1 text-lg font-semibold text-ink">Here’s how the screen looks ✨</h1>
                {item.brief && <p className="mt-2 text-sm text-ink-soft">{item.brief}</p>}
                {item.mockUrl && (
                  <>
                    <iframe src={item.mockUrl} sandbox="" title="Shared screen" className="mt-3 h-[480px] w-full rounded-xl border border-line bg-white" />
                    <a href={item.mockUrl} target="_blank" rel="noreferrer" className="mt-1 inline-block text-xs font-medium text-brand-600 hover:underline">Open full screen ↗</a>
                  </>
                )}
                <Chat turns={item.turns} />
              </>
            )}

            {/* FEATURE: the proposed plan, step by step. */}
            {type === 'feature' && (
              <>
                <h1 className="mt-1 text-lg font-semibold text-ink">The plan 📋</h1>
                <ol className="mt-3 space-y-2">
                  {(item.steps || []).map((s, i) => (
                    <li key={i} className="rounded-xl border border-line bg-canvas/60 p-3">
                      <p className="text-sm font-semibold text-ink">{i + 1}. {s.title}</p>
                      {s.description && <p className="mt-0.5 text-sm text-ink-soft">{s.description}</p>}
                    </li>
                  ))}
                </ol>
              </>
            )}

            {/* FIX: what was changed + the conversation. */}
            {type === 'fix' && (
              <>
                <h1 className="mt-1 text-lg font-semibold text-ink">What we changed ✅</h1>
                {item.summary && <p className="mt-2 text-sm text-ink-soft">{item.summary}</p>}
                {Array.isArray(item.changes) && item.changes.length > 0 && (
                  <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-ink-soft">
                    {item.changes.map((c, i) => <li key={i}>{c}</li>)}
                  </ul>
                )}
              </>
            )}

            <div className="mt-5 border-t border-line pt-4">
              {item.isOwn ? (
                <p className="text-sm text-ink-soft">This is your own work — open it from your dashboard to make changes.</p>
              ) : (
                <>
                  <p className="text-sm text-ink-soft">Want to build your own version? We’ll set you up from here.</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button onClick={useThis} disabled={busy} className="rounded-xl bg-brand-600 px-5 py-2.5 text-sm font-semibold text-white transition hover:bg-brand-700 disabled:opacity-60">
                      {busy ? 'Setting up…' : cta}
                    </button>
                    {type === 'design' && item.mockHtml && (
                      <button onClick={() => setShowAnnotator(true)} disabled={busy} className="rounded-xl px-5 py-2.5 text-sm font-semibold text-brand-600 transition hover:bg-brand-50 disabled:opacity-60">
                        ✏️ Mark up &amp; build my version
                      </button>
                    )}
                  </div>
                </>
              )}
              {err && <p className="mt-2 text-sm text-bad">{err}</p>}
            </div>
          </div>
        ) : null}
      </main>

      {showAnnotator && item?.mockHtml && (
        <Suspense fallback={null}>
          <MockAnnotator mockHtml={item.mockHtml} onApply={onApplyMarkup} onClose={() => setShowAnnotator(false)} />
        </Suspense>
      )}
    </div>
  );
}

function Chat({ turns }) {
  const list = Array.isArray(turns) ? turns : [];
  if (!list.length) return null;
  return (
    <div className="mt-4">
      <p className="text-xs font-medium text-ink-soft">The conversation behind it</p>
      <div className="mt-2 space-y-2">
        {list.map((t, i) => (
          <div key={i} className={t.role === 'owner' ? 'flex justify-end' : 'flex justify-start'}>
            <div className={`max-w-[85%] rounded-2xl px-3 py-2 text-sm ${t.role === 'owner' ? 'bg-brand-600 text-white' : 'bg-canvas text-ink ring-1 ring-line'}`}>
              {t.text}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ErrorBox({ msg, onBack }) {
  return (
    <div className="rounded-2xl border border-line bg-white p-6">
      <h1 className="font-semibold text-ink">We couldn’t open this</h1>
      <p className="mt-2 text-sm text-ink-soft">{msg}</p>
      <button onClick={onBack} className="mt-4 rounded-xl bg-brand-600 px-4 py-2 text-sm font-semibold text-white hover:bg-brand-700">
        Go to my dashboard
      </button>
    </div>
  );
}

function friendly(e) {
  const m = String(e?.message || '');
  if (m.includes('NOT_SHARED')) return 'This isn’t being shared anymore.';
  if (m.includes('NOT_A_MEMBER')) return 'This was shared inside another team, so you can’t open it.';
  if (m.includes('NOT_FOUND')) return 'We couldn’t find this.';
  if (m.includes('ALREADY_YOURS')) return 'This is already yours — find it on your dashboard.';
  if (m.includes('NO_PLAN')) return 'This plan isn’t ready to use yet.';
  return 'Something went wrong. Please try again.';
}
