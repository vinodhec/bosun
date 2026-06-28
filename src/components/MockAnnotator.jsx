import { useEffect, useRef, useState } from 'react';
import { Canvas, Rect, Textbox, Line, Triangle, Group, PencilBrush, FabricImage } from 'fabric';
import { snapdom } from '@zumer/snapdom';
import { getDesignMockHtml } from '../firebase/functions.js';

// "Mark up the screen" — lets the owner point at, circle and label the live mock, then sends that as
// a change request so we know exactly what to change. The mock is shown elsewhere in a cross-origin,
// sandboxed iframe the browser won't let us draw onto — so here we re-render the SAME mock HTML
// same-origin, take a faithful screenshot of it (snapDOM), and let the owner draw on that screenshot
// (fabric.js). On "Use this markup" we flatten the screenshot + markup into ONE image and hand it
// back to the change request. Plain language only — no canvas/iframe/screenshot words shown.

const WIDTHS = { desktop: 1024, phone: 390 }; // re-capture widths for the device toggle
const MAX_DISPLAY_W = 760;                    // how wide we draw it inside the modal
const SWATCHES = ['#ef4444', '#2563eb', '#16a34a', '#f59e0b', '#111827']; // red/blue/green/amber/ink

const TOOLS = [
  { id: 'select', label: 'Move', hint: 'Select & move your marks' },
  { id: 'arrow', label: 'Point', hint: 'Drag an arrow at a spot' },
  { id: 'note', label: 'Add a note', hint: 'Click to drop a label' },
  { id: 'box', label: 'Box', hint: 'Drag a box around an area' },
  { id: 'draw', label: 'Draw', hint: 'Freehand / circle things' },
];

// Build an arrow (a line + a head) as one movable mark.
function makeArrow(x1, y1, x2, y2, color) {
  const line = new Line([x1, y1, x2, y2], { stroke: color, strokeWidth: 3 });
  const angle = (Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI;
  const head = new Triangle({
    left: x2, top: y2, originX: 'center', originY: 'center',
    width: 16, height: 18, fill: color, angle: angle + 90,
  });
  const g = new Group([line, head]);
  g.annType = 'arrow';
  return g;
}

// Rough "top-left / middle-centre / …" position for the change summary text.
function describePos(cx, cy, w, h) {
  const vy = cy < h / 3 ? 'top' : cy < (2 * h) / 3 ? 'middle' : 'bottom';
  const vx = cx < w / 3 ? 'left' : cx < (2 * w) / 3 ? 'centre' : 'right';
  return vy === 'middle' && vx === 'centre' ? 'the centre' : `the ${vy}-${vx}`;
}

// `mockHtml` may be passed directly (the teammate share view already has it); otherwise we fetch it
// for the owner via the owner-gated callable using `designId`.
export default function MockAnnotator({ designId, mockHtml: mockHtmlProp = '', onApply, onClose }) {
  const hostRef = useRef(null);     // offscreen container that holds the re-render iframe
  const canvasElRef = useRef(null); // the drawing surface
  const fcRef = useRef(null);       // the fabric canvas instance
  const htmlRef = useRef('');       // the mock HTML (fetched once, reused on device toggle)
  const draw = useRef(null);        // in-progress arrow/box while dragging

  const [device, setDevice] = useState('desktop');
  const [tool, setTool] = useState('arrow');
  const [color, setColor] = useState(SWATCHES[0]);
  const [status, setStatus] = useState('loading'); // loading | ready | error
  const [err, setErr] = useState('');

  // Esc closes.
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Render the mock same-origin at `width`, screenshot it, and return { dataUrl, w, h }.
  async function captureMock(width) {
    if (!htmlRef.current) {
      if (mockHtmlProp) {
        htmlRef.current = String(mockHtmlProp);
      } else {
        const res = await getDesignMockHtml({ designId });
        htmlRef.current = String(res?.data?.mockHtml || '');
      }
    }
    if (!htmlRef.current) throw new Error('NO_MOCK');

    const host = hostRef.current;
    host.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.style.width = `${width}px`;
    const iframe = document.createElement('iframe');
    iframe.setAttribute('sandbox', 'allow-same-origin'); // same-origin so we can read it; NO scripts
    iframe.style.cssText = `width:${width}px;border:0;display:block;background:#fff`;
    iframe.srcdoc = htmlRef.current;
    wrap.appendChild(iframe);
    host.appendChild(wrap);

    // Wait for the mock to lay out, then size the frame to its full content height.
    await new Promise((resolve) => {
      iframe.addEventListener('load', resolve, { once: true });
      setTimeout(resolve, 4000); // safety net
    });
    await new Promise((r) => setTimeout(r, 200));
    try {
      const h = iframe.contentDocument?.body?.scrollHeight || 720;
      iframe.style.height = `${h}px`;
    } catch { iframe.style.height = '720px'; }
    await new Promise((r) => setTimeout(r, 100));

    const shot = await snapdom.toCanvas(wrap, { backgroundColor: '#ffffff' });
    host.innerHTML = '';
    return { dataUrl: shot.toDataURL('image/png'), w: shot.width, h: shot.height };
  }

  // (Re)build the drawing surface for the current device width.
  async function build(width) {
    setStatus('loading'); setErr('');
    try {
      const { dataUrl, w, h } = await captureMock(width);
      const natural = await new Promise((resolve, reject) => {
        const im = new Image();
        im.onload = () => resolve(im);
        im.onerror = () => reject(new Error('IMG'));
        im.src = dataUrl;
      });
      const baseW = natural.width || w;
      const baseH = natural.height || h;
      const scale = Math.min(1, MAX_DISPLAY_W / baseW);
      const dispW = Math.round(baseW * scale);
      const dispH = Math.round(baseH * scale);

      fcRef.current?.dispose();
      const fc = new Canvas(canvasElRef.current, { width: dispW, height: dispH, selection: true });
      const bg = await FabricImage.fromURL(dataUrl);
      bg.set({ selectable: false, evented: false });
      bg.scaleToWidth(dispW);
      fc.backgroundImage = bg;
      fc.requestRenderAll();
      fcRef.current = fc;
      wireTools(fc, dispW, dispH);
      applyTool(fc, tool, color);
      setStatus('ready');
    } catch (e) {
      console.warn('MockAnnotator build', e?.message || e);
      setErr(e?.message === 'NO_MOCK' ? 'There’s no screen to mark up yet.' : 'We couldn’t open the screen to mark up. Please try again.');
      setStatus('error');
    }
  }

  useEffect(() => { build(WIDTHS[device]); /* eslint-disable-next-line */ }, [device]);
  useEffect(() => () => fcRef.current?.dispose(), []);

  // Pointer behaviour for the active tool. Re-bound once per canvas; reads live tool/color via refs.
  const toolRef = useRef(tool); toolRef.current = tool;
  const colorRef = useRef(color); colorRef.current = color;

  function wireTools(fc) {
    fc.on('mouse:down', (opt) => {
      const t = toolRef.current;
      const c = colorRef.current;
      const p = fc.getScenePoint(opt.e);
      if (t === 'note') {
        const tb = new Textbox('Type here', {
          left: p.x, top: p.y, width: 180, fontSize: 20, fill: c,
          fontFamily: 'Inter, system-ui, sans-serif', editable: true,
        });
        tb.annType = 'note';
        fc.add(tb); fc.setActiveObject(tb); tb.enterEditing(); tb.selectAll();
        fc.requestRenderAll();
        return;
      }
      if (t === 'arrow') { draw.current = { kind: 'arrow', x: p.x, y: p.y, obj: null }; return; }
      if (t === 'box') {
        const r = new Rect({ left: p.x, top: p.y, width: 1, height: 1, fill: 'rgba(0,0,0,0)', stroke: c, strokeWidth: 3 });
        r.annType = 'box';
        draw.current = { kind: 'box', x: p.x, y: p.y, obj: r };
        fc.add(r);
        return;
      }
    });
    fc.on('mouse:move', (opt) => {
      if (!draw.current) return;
      const c = colorRef.current;
      const p = fc.getScenePoint(opt.e);
      const d = draw.current;
      if (d.kind === 'arrow') {
        if (d.obj) fc.remove(d.obj);
        d.obj = makeArrow(d.x, d.y, p.x, p.y, c);
        fc.add(d.obj);
        fc.requestRenderAll();
      } else if (d.kind === 'box') {
        d.obj.set({ width: Math.abs(p.x - d.x), height: Math.abs(p.y - d.y), left: Math.min(p.x, d.x), top: Math.min(p.y, d.y) });
        fc.requestRenderAll();
      }
    });
    fc.on('mouse:up', () => {
      const d = draw.current;
      if (d?.obj && ((d.obj.width || 0) < 4 && (d.obj.height || 0) < 4)) fc.remove(d.obj); // ignore a stray click
      draw.current = null;
    });
  }

  function applyTool(fc, t, c) {
    const drawing = t === 'draw';
    fc.isDrawingMode = drawing;
    if (drawing) {
      const brush = new PencilBrush(fc);
      brush.color = c; brush.width = 4;
      fc.freeDrawingBrush = brush;
    }
    fc.selection = t === 'select';
    fc.getObjects().forEach((o) => { o.selectable = t === 'select'; o.evented = t === 'select'; });
    fc.defaultCursor = t === 'select' ? 'default' : 'crosshair';
    fc.requestRenderAll();
  }

  // Mark freehand strokes so the summary can mention them.
  useEffect(() => {
    const fc = fcRef.current; if (!fc) return;
    const onPath = (e) => { if (e.path) e.path.annType = 'draw'; };
    fc.on('path:created', onPath);
    return () => fc.off('path:created', onPath);
  }, [status]);

  const pick = (t) => { setTool(t); const fc = fcRef.current; if (fc) applyTool(fc, t, color); };
  const pickColor = (c) => {
    setColor(c);
    const fc = fcRef.current; if (!fc) return;
    if (fc.isDrawingMode && fc.freeDrawingBrush) fc.freeDrawingBrush.color = c;
    const a = fc.getActiveObject();
    if (a) { if (a.annType === 'note') a.set('fill', c); else a.set('stroke', c); fc.requestRenderAll(); }
  };
  const undo = () => { const fc = fcRef.current; if (!fc) return; const o = fc.getObjects(); if (o.length) { fc.remove(o[o.length - 1]); fc.requestRenderAll(); } };
  const clearAll = () => { const fc = fcRef.current; if (!fc) return; fc.remove(...fc.getObjects()); fc.requestRenderAll(); };

  function buildSummary(fc) {
    const w = fc.getWidth(), h = fc.getHeight();
    const lines = [];
    for (const o of fc.getObjects()) {
      const c = o.getCenterPoint();
      const where = describePos(c.x, c.y, w, h);
      if (o.annType === 'note') {
        const txt = String(o.text || '').replace(/\s+/g, ' ').trim();
        if (txt && txt !== 'Type here') lines.push(`At ${where}: “${txt}”`);
        else lines.push(`A note at ${where}`);
      } else if (o.annType === 'arrow') lines.push(`An arrow pointing to ${where}`);
      else if (o.annType === 'box') lines.push(`A box around ${where}`);
      else if (o.annType === 'draw') lines.push(`A mark drawn at ${where}`);
    }
    if (!lines.length) return '';
    return `I’ve marked up the screen (see the attached image):\n- ${lines.join('\n- ')}`;
  }

  const download = () => {
    const fc = fcRef.current; if (!fc) return;
    const a = document.createElement('a');
    a.href = fc.toDataURL({ format: 'png' });
    a.download = 'marked-up-screen.png';
    a.click();
  };

  const apply = async () => {
    const fc = fcRef.current; if (!fc) return;
    fc.discardActiveObject(); fc.requestRenderAll();
    const dataUrl = fc.toDataURL({ format: 'png' });
    const blob = await (await fetch(dataUrl)).blob();
    const file = new File([blob], 'marked-up-screen.png', { type: 'image/png' });
    onApply(file, buildSummary(fc));
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/60 p-4" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="flex max-h-[92vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl bg-white shadow-xl">
        {/* Toolbar */}
        <div className="flex flex-wrap items-center gap-2 border-b border-line p-3">
          <span className="mr-1 text-sm font-semibold text-ink">Mark up the screen</span>
          {TOOLS.map((t) => (
            <button
              key={t.id}
              onClick={() => pick(t.id)}
              title={t.hint}
              className={`rounded-lg px-2.5 py-1.5 text-xs font-semibold transition ${tool === t.id ? 'bg-brand-600 text-white' : 'text-ink-soft hover:bg-line/50'}`}
            >
              {t.label}
            </button>
          ))}
          <span className="mx-1 h-5 w-px bg-line" />
          {SWATCHES.map((c) => (
            <button
              key={c}
              onClick={() => pickColor(c)}
              aria-label="Colour"
              className={`h-6 w-6 rounded-full border-2 ${color === c ? 'border-ink' : 'border-white'} shadow`}
              style={{ background: c }}
            />
          ))}
          <span className="mx-1 h-5 w-px bg-line" />
          <button onClick={undo} className="rounded-lg px-2.5 py-1.5 text-xs font-semibold text-ink-soft hover:bg-line/50">Undo</button>
          <button onClick={clearAll} className="rounded-lg px-2.5 py-1.5 text-xs font-semibold text-ink-soft hover:bg-line/50">Clear</button>
          <div className="ml-auto flex items-center gap-1 rounded-lg bg-canvas p-0.5">
            {['desktop', 'phone'].map((dv) => (
              <button
                key={dv}
                onClick={() => setDevice(dv)}
                className={`rounded-md px-2.5 py-1 text-xs font-semibold capitalize transition ${device === dv ? 'bg-white text-ink shadow-sm' : 'text-ink-soft'}`}
              >
                {dv === 'desktop' ? 'Computer' : 'Phone'}
              </button>
            ))}
          </div>
          <button onClick={onClose} aria-label="Close" className="rounded-lg px-2 py-1 text-lg text-ink-soft hover:bg-line/50">×</button>
        </div>

        {/* Stage */}
        <div className="min-h-0 flex-1 overflow-auto bg-canvas/60 p-4">
          {status === 'loading' && <p className="py-12 text-center text-sm text-ink-soft">Getting your screen ready to mark up…</p>}
          {status === 'error' && <p className="py-12 text-center text-sm text-bad">{err}</p>}
          <div className={`mx-auto w-fit ${status === 'ready' ? '' : 'hidden'}`}>
            <canvas ref={canvasElRef} className="rounded-lg shadow ring-1 ring-line" />
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-2 border-t border-line p-3">
          <p className="text-xs text-ink-soft">Point, note or box what you want changed — we’ll send this picture with your request.</p>
          <div className="ml-auto flex gap-2">
            <button onClick={download} disabled={status !== 'ready'} className="rounded-lg px-3 py-2 text-sm font-semibold text-ink-soft hover:bg-line/50 disabled:opacity-50">Download</button>
            <button onClick={onClose} className="rounded-lg px-3 py-2 text-sm font-semibold text-ink-soft hover:bg-line/50">Cancel</button>
            <button onClick={apply} disabled={status !== 'ready'} className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-brand-700 disabled:opacity-50">Use this markup →</button>
          </div>
        </div>

        {/* Offscreen: the same-origin re-render we screenshot. */}
        <div ref={hostRef} aria-hidden style={{ position: 'fixed', left: '-99999px', top: 0, pointerEvents: 'none' }} />
      </div>
    </div>
  );
}
