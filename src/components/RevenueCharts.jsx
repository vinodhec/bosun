import { useEffect, useMemo, useRef, useState } from 'react';
import { formatINR } from '@shared/currency.js';

// Operator-only revenue charts, fed by adminMetrics().daily — one row per IST day with fix revenue
// (task.finalCharge) and each metered lane's debits. Two views over one shared range:
//   1. Daily revenue trend — total per day as bars, with a 7-day average line over it.
//   2. Revenue by source — one line per source (lanes folded into six groups).
// Plain SVG on purpose: the app ships no chart library and two charts don't justify one.

// Lanes fold into six sources so the line chart stays within a readable, fixed palette. The hue is
// bound to the SOURCE (never its rank), so hiding a line never repaints the others.
const SOURCES = [
  { key: 'fixes', label: 'Fixes & features', color: '#2a78d6', kinds: [] },
  { key: 'sourcing', label: 'Lead sourcing', color: '#eb6834', kinds: ['sourcing'] },
  { key: 'whatsapp', label: 'WhatsApp', color: '#1baf7a', kinds: ['selfpost_compose', 'whatsapp_usage'] },
  { key: 'assistant', label: 'Website assistant', color: '#eda100', kinds: ['assistant_message', 'assistant_outcome'] },
  { key: 'reels', label: 'Listing reels', color: '#e87ba4', kinds: ['reel_photo', 'reel_animated'] },
  { key: 'other', label: 'Other metered', color: '#008300', kinds: ['autopost_usage', 'daily_plan', 'conversion_popup'] },
];

const RANGES = [30, 60, 90];
const PAD = { top: 12, right: 12, bottom: 24, left: 52 };
const HEIGHT = 220;

const compactINR = (n) => {
  const v = Number(n) || 0;
  if (Math.abs(v) >= 100000) return `₹${(v / 100000).toFixed(v >= 1000000 ? 0 : 1)}L`;
  if (Math.abs(v) >= 1000) return `₹${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k`;
  return `₹${Math.round(v)}`;
};
const dayLabel = (iso) =>
  new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });

// 0 → a "nice" max with ~4 gridlines (1/2/2.5/5 × 10^n steps).
function niceTicks(max) {
  if (!(max > 0)) return [0, 1];
  const raw = max / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  const top = Math.ceil(max / step) * step;
  const ticks = [];
  for (let v = 0; v <= top + step / 2; v += step) ticks.push(v);
  return ticks;
}

const movingAvg = (vals, n = 7) =>
  vals.map((_, i) => {
    const from = Math.max(0, i - n + 1);
    const win = vals.slice(from, i + 1);
    return win.reduce((a, b) => a + b, 0) / win.length;
  });

function useWidth() {
  const ref = useRef(null);
  const [w, setW] = useState(640);
  useEffect(() => {
    if (!ref.current) return undefined;
    const ro = new ResizeObserver(([e]) => setW(Math.max(280, Math.floor(e.contentRect.width))));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

// Shared frame: gridlines, y labels, sparse x labels, crosshair + tooltip on pointer.
function Frame({ width, rows, yMax, children, renderTip, hover, setHover }) {
  const ticks = niceTicks(yMax);
  const top = ticks[ticks.length - 1];
  const iw = width - PAD.left - PAD.right;
  const ih = HEIGHT - PAD.top - PAD.bottom;
  const step = iw / rows.length;
  const x = (i) => PAD.left + step * (i + 0.5);
  const y = (v) => PAD.top + ih - (v / top) * ih;
  const every = Math.max(1, Math.ceil(rows.length / Math.max(2, Math.floor(iw / 70))));

  const onMove = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const i = Math.floor((e.clientX - r.left - PAD.left) / step);
    setHover(i >= 0 && i < rows.length ? i : null);
  };

  return (
    <div className="relative">
      <svg width={width} height={HEIGHT} className="block select-none"
        onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)}
              stroke={t === 0 ? '#d1d6e3' : '#eef0f5'} strokeWidth="1" />
            <text x={PAD.left - 8} y={y(t)} dy="0.32em" textAnchor="end" fontSize="10" fill="#8b93a7">
              {compactINR(t)}
            </text>
          </g>
        ))}
        {rows.map((r, i) => (i % every === 0 ? (
          <text key={r.day} x={x(i)} y={HEIGHT - 6} textAnchor="middle" fontSize="10" fill="#8b93a7">
            {dayLabel(r.day)}
          </text>
        ) : null))}
        {children({ x, y, step, ih })}
        {hover != null && (
          <line x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={PAD.top + ih}
            stroke="#5c6578" strokeWidth="1" strokeDasharray="2 2" pointerEvents="none" />
        )}
      </svg>
      {hover != null && (
        <div className="pointer-events-none absolute top-1 z-10 min-w-[150px] rounded-lg border border-line bg-white px-2.5 py-2 text-xs shadow-md"
          style={x(hover) > width / 2 ? { right: width - x(hover) + 10 } : { left: x(hover) + 10 }}>
          <div className="mb-1 font-medium text-ink-soft">{dayLabel(rows[hover].day)}</div>
          {renderTip(hover)}
        </div>
      )}
    </div>
  );
}

const TipRow = ({ color, label, value, dashed }) => (
  <div className="flex items-center gap-2 py-0.5">
    <svg width="12" height="4" className="shrink-0">
      <line x1="0" x2="12" y1="2" y2="2" stroke={color} strokeWidth="2" strokeDasharray={dashed ? '3 2' : undefined} />
    </svg>
    <span className="font-semibold text-ink">{value}</span>
    <span className="text-ink-soft">{label}</span>
  </div>
);

function TrendChart({ rows }) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState(null);
  const totals = rows.map((r) => r.total);
  const avg = movingAvg(totals);
  const yMax = Math.max(...totals, ...avg, 0);

  return (
    <div ref={ref}>
      <Frame width={width} rows={rows} yMax={yMax} hover={hover} setHover={setHover}
        renderTip={(i) => (
          <>
            <TipRow color="#a5b4fc" label="revenue" value={formatINR(totals[i])} />
            <TipRow color="#3730a3" label="7-day avg" value={formatINR(avg[i])} />
          </>
        )}>
        {({ x, y, step }) => {
          const bw = Math.max(1, step - 2); // 2px surface gap between bars
          const rad = Math.min(4, bw / 2);
          const base = y(0);
          return (
            <>
              {totals.map((v, i) => {
                if (!(v > 0)) return null;
                const top = y(v);
                const h = base - top;
                const r = Math.min(rad, h);
                const l = x(i) - bw / 2;
                return (
                  <path key={i} fill={hover === i ? '#818cf8' : '#a5b4fc'}
                    d={`M${l},${base} V${top + r} Q${l},${top} ${l + r},${top} H${l + bw - r} Q${l + bw},${top} ${l + bw},${top + r} V${base} Z`} />
                );
              })}
              <polyline fill="none" stroke="#3730a3" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round"
                points={avg.map((v, i) => `${x(i)},${y(v)}`).join(' ')} />
            </>
          );
        }}
      </Frame>
    </div>
  );
}

function SourcesChart({ rows, series, smooth }) {
  const [ref, width] = useWidth();
  const [hover, setHover] = useState(null);
  const lines = series.map((s) => {
    const raw = rows.map((r) => r.bySource[s.key]);
    return { ...s, raw, vals: smooth ? movingAvg(raw) : raw };
  });
  const yMax = Math.max(0, ...lines.flatMap((l) => l.vals));

  return (
    <div ref={ref}>
      <Frame width={width} rows={rows} yMax={yMax} hover={hover} setHover={setHover}
        renderTip={(i) => [...lines].sort((a, b) => b.vals[i] - a.vals[i]).map((l) => (
          <TipRow key={l.key} color={l.color} label={l.label} value={formatINR(l.vals[i])} />
        ))}>
        {({ x, y }) => (
          <>
            {lines.map((l) => (
              <polyline key={l.key} fill="none" stroke={l.color} strokeWidth="2"
                strokeLinejoin="round" strokeLinecap="round"
                points={l.vals.map((v, i) => `${x(i)},${y(v)}`).join(' ')} />
            ))}
            {hover != null && lines.map((l) => (
              <circle key={l.key} cx={x(hover)} cy={y(l.vals[hover])} r="4"
                fill={l.color} stroke="#fff" strokeWidth="2" pointerEvents="none" />
            ))}
          </>
        )}
      </Frame>
    </div>
  );
}

export default function RevenueCharts({ daily }) {
  const [range, setRange] = useState(30);
  const [smooth, setSmooth] = useState(false);
  const [hidden, setHidden] = useState(() => new Set());
  const [showTable, setShowTable] = useState(false);

  const all = useMemo(() => (daily?.days || []).map((d) => {
    const bySource = Object.fromEntries(SOURCES.map((s) => [s.key, 0]));
    bySource.fixes = Number(d.fixesInr) || 0;
    for (const [kind, amt] of Object.entries(d.lanes || {})) {
      const src = SOURCES.find((s) => s.kinds.includes(kind));
      // A lane added to adminMetrics but not mapped here still counts — it lands in "Other".
      bySource[src ? src.key : 'other'] += Number(amt) || 0;
    }
    const total = Object.values(bySource).reduce((a, b) => a + b, 0);
    return { day: d.day, bySource, total };
  }), [daily]);

  if (!all.length) return null;
  const rows = all.slice(-range);
  const prev = all.slice(-range * 2, -range);
  const sum = (rs) => rs.reduce((a, r) => a + r.total, 0);
  const total = sum(rows);
  const prevTotal = prev.length === range ? sum(prev) : null;
  const changePct = prevTotal > 0 ? Math.round(((total - prevTotal) / prevTotal) * 100) : null;
  const best = rows.reduce((b, r) => (r.total > b.total ? r : b), rows[0]);

  // Only sources that earned something in the range get a line; colours stay bound to the source.
  const active = SOURCES.filter((s) => rows.some((r) => r.bySource[s.key] > 0));
  const shown = active.filter((s) => !hidden.has(s.key));
  const toggle = (k) => setHidden((h) => { const n = new Set(h); n.has(k) ? n.delete(k) : n.add(k); return n; });

  const pill = (on) => `rounded-md px-2.5 py-1 text-xs font-semibold transition ${on ? 'bg-brand-600 text-white' : 'text-ink-soft ring-1 ring-line hover:bg-brand-50'}`;

  return (
    <section className="rounded-2xl border border-line bg-white p-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="font-semibold text-ink">Revenue trend</h2>
        <div className="flex gap-1.5">
          {RANGES.map((n) => (
            <button key={n} className={pill(range === n)} onClick={() => setRange(n)}>{n} days</button>
          ))}
        </div>
      </div>

      <div className="mt-3 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label={`Revenue · last ${range} days`} value={formatINR(total)} />
        <Stat label="Average per day" value={formatINR(total / rows.length)} />
        <Stat label={`vs previous ${range} days`}
          value={changePct == null ? '—' : `${changePct >= 0 ? '▲' : '▼'} ${Math.abs(changePct)}%`}
          tone={changePct == null ? undefined : changePct >= 0 ? 'good' : 'bad'}
          sub={prevTotal == null ? 'not enough history' : formatINR(prevTotal)} />
        <Stat label="Best day" value={formatINR(best.total)} sub={best.total > 0 ? dayLabel(best.day) : '—'} />
      </div>

      <div className="mt-4">
        <div className="flex items-center gap-3 text-xs text-ink-soft">
          <span className="font-medium text-ink">Daily revenue, all sources</span>
          <span className="flex items-center gap-1"><span className="inline-block h-2.5 w-2.5 rounded-sm bg-[#a5b4fc]" />per day</span>
          <span className="flex items-center gap-1"><span className="inline-block h-0.5 w-3 bg-[#3730a3]" />7-day average</span>
        </div>
        <div className="mt-1"><TrendChart rows={rows} /></div>
      </div>

      <div className="mt-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs font-medium text-ink">Revenue by source</span>
          <label className="flex items-center gap-1.5 text-xs text-ink-soft">
            <input type="checkbox" checked={smooth} onChange={(e) => setSmooth(e.target.checked)} />
            Smooth (7-day average)
          </label>
        </div>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {active.map((s) => {
            const off = hidden.has(s.key);
            const amt = rows.reduce((a, r) => a + r.bySource[s.key], 0);
            return (
              <button key={s.key} onClick={() => toggle(s.key)} aria-pressed={!off}
                className={`flex items-center gap-1.5 rounded-md px-2 py-0.5 text-xs ring-1 ring-line transition hover:bg-canvas ${off ? 'opacity-40' : ''}`}>
                <span className="inline-block h-0.5 w-3" style={{ background: s.color }} />
                <span className="text-ink">{s.label}</span>
                <span className="font-semibold text-ink">{formatINR(amt)}</span>
              </button>
            );
          })}
        </div>
        {active.length === 0 ? (
          <p className="mt-3 text-sm text-ink-soft">No revenue in this range yet.</p>
        ) : (
          <div className="mt-1"><SourcesChart rows={rows} series={shown} smooth={smooth} /></div>
        )}
      </div>

      <button className="mt-3 text-xs font-semibold text-brand-600 hover:underline" onClick={() => setShowTable((v) => !v)}>
        {showTable ? 'Hide' : 'Show'} table
      </button>
      {showTable && (
        <div className="mt-2 max-h-80 overflow-auto">
          <table className="w-full min-w-[560px] text-left text-xs">
            <thead className="sticky top-0 bg-white">
              <tr className="border-b border-line text-ink-soft">
                <th className="py-1.5 pr-3 font-medium">Day</th>
                {active.map((s) => <th key={s.key} className="py-1.5 pr-3 text-right font-medium">{s.label}</th>)}
                <th className="py-1.5 text-right font-medium">Total</th>
              </tr>
            </thead>
            <tbody>
              {[...rows].reverse().map((r) => (
                <tr key={r.day} className="border-b border-line/60">
                  <td className="py-1 pr-3 text-ink">{dayLabel(r.day)}</td>
                  {active.map((s) => <td key={s.key} className="py-1 pr-3 text-right text-ink-soft">{formatINR(r.bySource[s.key])}</td>)}
                  <td className="py-1 text-right font-semibold text-ink">{formatINR(r.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function Stat({ label, value, sub, tone }) {
  const cls = tone === 'good' ? 'text-green-700' : tone === 'bad' ? 'text-rose-600' : 'text-ink';
  return (
    <div className="rounded-xl border border-line bg-canvas/40 p-3">
      <div className="text-xs font-medium text-ink-soft">{label}</div>
      <div className={`mt-0.5 text-lg font-bold leading-tight ${cls}`}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-ink-soft">{sub}</div>}
    </div>
  );
}
