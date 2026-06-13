// Minimal Figma REST wrappers that enrich a fix task with DESIGN CONTEXT for design-to-code.
//
// Why REST and not MCP: Figma's official MCP server is OAuth-only and gated to approved clients,
// so it can't live in the managed-agent vault the way our GitHub/Jam static-bearer creds do. Each
// org instead connects a Figma Personal Access Token, stored ONLY in orgSecrets/{orgId}.figma (the
// vault — never readable by, nor returned to, the browser). When a customer pastes a figma.com link
// into their problem text, the backend pulls the design via REST: the node tree (exact geometry,
// spacing, fonts, colours) PLUS a rendered PNG. Both are fed to the agent so it can reproduce the
// design pixel-perfect. nodejs22 has a global `fetch`, so there's no SDK dependency.

const API = 'https://api.figma.com/v1';

// A figma.com design/file/proto link the owner pasted into their problem text.
const FIGMA_URL_RE = /https?:\/\/(?:www\.)?figma\.com\/(?:design|file|proto)\/[^\s)>\]"']+/i;

/** Return the first figma.com URL found in free text, or null. */
export function extractFigmaUrl(text) {
  const m = String(text || '').match(FIGMA_URL_RE);
  return m ? m[0] : null;
}

/** Parse a figma URL into { fileKey, nodeId } (nodeId normalised to colon form, or null). */
export function parseFigmaUrl(url) {
  try {
    const u = new URL(url);
    const m = u.pathname.match(/\/(?:design|file|proto)\/([A-Za-z0-9]+)/);
    const fileKey = m ? m[1] : null;
    // Prefer the explicitly selected node; fall back to a prototype starting point if present.
    let nodeId = u.searchParams.get('node-id') || u.searchParams.get('starting-point-node-id');
    if (nodeId) nodeId = nodeId.replace(/-/g, ':'); // 502-1810 → 502:1810
    return { fileKey, nodeId };
  } catch {
    return { fileKey: null, nodeId: null };
  }
}

async function call(path, token) {
  if (!token) throw new Error('NO_FIGMA_TOKEN');
  const res = await fetch(`${API}${path}`, { headers: { 'X-Figma-Token': token } });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const err = new Error(`figma_${res.status}`);
    err.status = res.status;
    err.body = body.slice(0, 300);
    throw err;
  }
  return res.json();
}

/** Validate a token + return the connected Figma account ({ id, handle, email }). */
export async function getMe({ token }) {
  const me = await call('/me', token);
  return { id: me?.id || '', handle: me?.handle || '', email: me?.email || '' };
}

const hex = (c) => {
  if (!c) return null;
  const h = (n) => Math.round((n ?? 0) * 255).toString(16).padStart(2, '0');
  const base = `#${h(c.r)}${h(c.g)}${h(c.b)}`;
  return c.a != null && c.a < 1 ? `${base} @${+c.a.toFixed(2)}` : base;
};

const solidFill = (n) => (n?.fills || []).find((f) => f.type === 'SOLID' && f.visible !== false);

/**
 * Flatten a node subtree into a compact, EXACT spec the agent can build to. We surface the values
 * that make a build pixel-perfect — absolute position (alignment), size, auto-layout direction +
 * gap + padding, fills/strokes as hex, corner radius, and per-text font family/weight/size/line-
 * height/letter-spacing/colour. Capped so a huge frame can't blow the prompt budget.
 */
function summariseNode(root, { maxLines = 140, maxChars = 7000 } = {}) {
  const out = [];
  const ox = root?.absoluteBoundingBox?.x ?? 0;
  const oy = root?.absoluteBoundingBox?.y ?? 0;
  (function walk(n, depth) {
    if (out.length >= maxLines || !n) return;
    const pad = '  '.repeat(depth);
    const bb = n.absoluteBoundingBox;
    // Position is given RELATIVE to the root frame so the agent reads alignment/offsets directly.
    const pos = bb ? `@(${Math.round(bb.x - ox)},${Math.round(bb.y - oy)}) ${Math.round(bb.width)}×${Math.round(bb.height)}` : '';
    if (n.type === 'TEXT') {
      const s = n.style || {};
      const f = solidFill(n);
      const lh = s.lineHeightPx ? `/${Math.round(s.lineHeightPx)}` : '';
      const ls = s.letterSpacing ? ` ls=${+s.letterSpacing.toFixed(2)}` : '';
      const align = s.textAlignHorizontal && s.textAlignHorizontal !== 'LEFT' ? ` align=${s.textAlignHorizontal.toLowerCase()}` : '';
      out.push(`${pad}TEXT ${pos} "${String(n.characters || '').replace(/\s+/g, ' ').slice(0, 80)}" — ${s.fontFamily || '?'} ${s.fontWeight || ''}/${s.fontSize || '?'}px${lh}${ls}${align} ${hex(f?.color) || ''}`);
    } else {
      const bits = [n.type];
      if (n.name && !/^(Frame|Group|Rectangle|Vector|Ellipse) ?\d*/.test(n.name)) bits.push(`"${n.name}"`);
      if (pos) bits.push(pos);
      if (n.layoutMode && n.layoutMode !== 'NONE') {
        const p = [n.paddingTop, n.paddingRight, n.paddingBottom, n.paddingLeft].map((v) => v || 0);
        bits.push(`${n.layoutMode === 'HORIZONTAL' ? 'row' : 'col'} gap=${n.itemSpacing || 0} pad=${p.join(',')}`);
        if (n.primaryAxisAlignItems && n.primaryAxisAlignItems !== 'MIN') bits.push(`justify=${n.primaryAxisAlignItems.toLowerCase()}`);
      }
      const f = solidFill(n);
      if (f) bits.push(`bg=${hex(f.color)}`);
      if (Array.isArray(n.strokes) && n.strokes.length && n.strokeWeight) {
        const sf = n.strokes.find((s) => s.type === 'SOLID');
        bits.push(`border=${n.strokeWeight}px${sf ? ' ' + hex(sf.color) : ''}`);
      }
      const r = n.cornerRadius ?? (Array.isArray(n.rectangleCornerRadii) ? n.rectangleCornerRadii[0] : null);
      if (r) bits.push(`radius=${r}`);
      const blur = (n.effects || []).find((e) => e.type === 'BACKGROUND_BLUR' && e.visible !== false);
      if (blur) bits.push(`backdrop-blur=${blur.radius}`);
      out.push(pad + bits.join(' '));
    }
    for (const c of n.children || []) walk(c, depth + 1);
  })(root, 0);
  let text = out.join('\n');
  if (text.length > maxChars) text = text.slice(0, maxChars) + '\n…(truncated)';
  return text;
}

/**
 * Pull design context for a linked Figma node: an EXACT structural/text/style spec plus a rendered
 * PNG. Returns `{ name, summary, image, fileKey, nodeId }` or null. Designed to degrade gracefully —
 * a locked/invalid link or a render hiccup yields null (or a null image) rather than failing the fix.
 */
export async function fetchDesignContext({ token, fileKey, nodeId }) {
  if (!token || !fileKey) return null;

  // Resolve the target node. With an explicit node-id we fetch just that subtree; without one we
  // grab the file's first top-level frame so a bare file link still yields something to build.
  let node = null;
  let targetId = nodeId || null;
  if (nodeId) {
    const data = await call(`/files/${fileKey}/nodes?ids=${encodeURIComponent(nodeId)}&geometry=paths`, token);
    node = data?.nodes?.[nodeId]?.document || null;
  } else {
    const file = await call(`/files/${fileKey}?depth=2`, token);
    const page = (file?.document?.children || [])[0];
    const frame = (page?.children || []).find((c) => ['FRAME', 'COMPONENT', 'INSTANCE'].includes(c.type)) || page;
    node = frame || null;
    targetId = frame?.id || null;
  }
  if (!node) return null;

  const summary = summariseNode(node);

  // Render the node to a PNG (scale 1 ≈ a few hundred KB; Anthropic down-samples to ~1568px anyway).
  let image = null;
  if (targetId) {
    try {
      const img = await call(`/images/${fileKey}?ids=${encodeURIComponent(targetId)}&format=png&scale=1`, token);
      const url = img?.images?.[targetId];
      if (url) {
        const res = await fetch(url);
        if (res.ok) {
          const buf = Buffer.from(await res.arrayBuffer());
          if (buf.length <= 4 * 1024 * 1024) image = { mediaType: 'image/png', data: buf.toString('base64') };
        }
      }
    } catch (e) {
      console.warn('figma:render_failed', e?.status || '', e?.message || e);
    }
  }

  return { name: node.name || 'design', summary, image, fileKey, nodeId: targetId };
}

/**
 * The single integration point for the fix pipeline: given an org, its vault secrets, and the free
 * text the owner typed, return design context iff (a) the text contains a figma link AND (b) the org
 * has a connected Figma token. Returns null otherwise, and swallows any fetch error to null — a bad
 * link must never fail the fix, only forgo the design enrichment.
 */
export async function designContextFromText({ org, secretData, text }) {
  const url = extractFigmaUrl(text);
  if (!url) return null;
  if (!org?.figma?.connected || !secretData?.figma?.token) return null;
  try {
    const { fileKey, nodeId } = parseFigmaUrl(url);
    return await fetchDesignContext({ token: secretData.figma.token, fileKey, nodeId });
  } catch (e) {
    console.warn('figma:design_context_failed', e?.status || '', e?.message || e);
    return null;
  }
}
