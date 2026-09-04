// Agent console orchestrator. One process owns everything: session registry,
// worktrees, dev servers, the claude child, the preview proxy and the tunnel.
// Deliberately dependency-free — the EC2 box is disk-tight and the tool must not
// need an install to come back up after a reboot.
//
// One public port. Three kinds of URL live on it:
//   /__console/api/*   the orchestrator API (a prefix Next never uses)
//   /preview/<token>   sets the preview cookie for a session, then redirects to /
//   everything else    the session's dev server, resolved from that cookie
import http from 'node:http';
import { spawn } from 'node:child_process';
import { randomUUID, randomBytes, createHmac, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

const HERE = path.dirname(new URL(import.meta.url).pathname);
const HOME = os.homedir();
const LINUX = process.platform === 'linux';

// A naive counter breaks across restarts: seq resets to 0 while old servers still
// hold their ports. Always probe.
const freePort = (from) => new Promise((res, rej) => {
  const tryPort = (p) => {
    if (p > from + 200) return rej(new Error('no free port'));
    const srv = net.createServer();
    srv.once('error', () => tryPort(p + 1));
    srv.once('listening', () => srv.close(() => res(p)));
    srv.listen(p, '127.0.0.1');
  };
  tryPort(from);
});

const list = (v, dflt) => (v ? v.split(/[\s,]+/).filter(Boolean) : dflt);

const CFG = {
  port:        Number(process.env.PORT || 7000),
  // 127.0.0.1 = loopback only (an SSH tunnel or cloudflared in front). Never 0.0.0.0.
  host:        process.env.HOST || '127.0.0.1',
  repo:        process.env.REPO || path.join(HOME, 'apps/maadiveedu-unified-platform'),
  base:        process.env.BASE_REF || 'origin/main',
  sessionsDir: process.env.SESSIONS_DIR || path.join(HOME, 'agent-sessions'),
  // The ONLY knob for which Claude account runs turns. Log a dir in once with
  // `CLAUDE_CONFIG_DIR=<dir> claude`; switching accounts is changing this line.
  // Unset = the machine's default login (~/.claude + ~/.claude.json). Do NOT point
  // it at ~/.claude explicitly: that moves the config file lookup to
  // ~/.claude/.claude.json, which does not exist, and every turn says "Not logged in".
  claudeCfg:   process.env.CLAUDE_CONFIG_DIR || '',
  model:       process.env.MODEL || 'sonnet',
  devPort0:    Number(process.env.DEV_PORT0 || 3200),
  // Shared secret with home (Bosun Functions' CONSOLE_SECRET). Signs session
  // creation inbound and every report outbound. Required unless LOCAL_UI=1.
  secret:      process.env.CONSOLE_SECRET || '',
  // Home = the Bosun `consoleHook` function. Receives our public URL at boot and a
  // report per turn / per shipped PR, which is what Bosun meters. Full URL.
  // (PLATFORM_URL is the pre-Bosun name: the platform's /api/ingest/console-url.)
  homeUrl:     (process.env.CONSOLE_HOME_URL || (process.env.PLATFORM_URL ? process.env.PLATFORM_URL.replace(/\/$/, '') + '/api/ingest/console-url' : '')),
  // The repo this box serves, as owner/name. A session request naming a different
  // repo is refused: one console, one checkout — an org connected to another repo
  // must not be handed a preview of this one.
  repoFullName: process.env.REPO_FULL_NAME || '',
  // Public URL if known (local test: http://localhost:7000). TUNNEL=1 discovers one
  // from cloudflared instead.
  publicUrl:   (process.env.PUBLIC_URL || '').replace(/\/$/, ''),
  tunnel:      process.env.TUNNEL === '1',
  // Browser origins allowed to call the API and to frame the preview.
  origins:     list(process.env.CONSOLE_ALLOWED_ORIGINS, [
    'https://bosun-76bba.web.app', 'https://bosun-76bba.firebaseapp.com', 'http://localhost:5173',
    'https://practicethedeal.com', 'https://www.practicethedeal.com', 'http://practicethedeal.com', 'http://www.practicethedeal.com',
    'https://www.maadiveedu.com', 'https://maadiveedu.com',
    'https://mav30prod-maadiveedu.vercel.app', 'http://localhost:3000', 'http://localhost:3100',
  ]),
  // The dependency-free fallback UI at / for loopback use. Off when exposed.
  localUi:     process.env.LOCAL_UI === '1',
  // Per-minute billing: an idle session costs money, so it is ended (and parked, see
  // destroySession) after 10 minutes without a turn, undo or ship.
  idleMs:      Number(process.env.IDLE_MINUTES || 10) * 60_000,
  // Presence: the page long-polls continuously, so a session nobody has polled for this
  // long has no browser on it (closed tab, sleeping laptop). It is parked and ended, so a
  // closed window stops the meter within ~2 minutes instead of at the idle limit.
  presenceMs:  Number(process.env.PRESENCE_SECONDS || 90) * 1000,
  maxAgeMs:    Number(process.env.MAX_AGE_HOURS || 6) * 3_600_000,
  maxTurns:    Number(process.env.MAX_TURNS || 40),
  prLabel:     process.env.PR_LABEL || 'needs-validation',
};
if (!CFG.secret && !CFG.localUi) {
  console.error('CONSOLE_SECRET is required unless LOCAL_UI=1 (loopback-only dev). Refusing to start.');
  process.exit(1);
}

const sessions = new Map();
const REG = path.join(CFG.sessionsDir, 'registry.json');

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// Kill a dev server hard enough that it actually dies. A plain SIGTERM to a
// detached Next server was not reliable: one survivor held 3.5GB and its port
// after its worktree was deleted, which is what this whole file now guards against.
async function killPid(pid) {
  if (!pid) return;
  for (const sig of ['SIGTERM', 'SIGKILL']) {
    try { process.kill(-pid, sig); } catch {}
    try { process.kill(pid, sig); } catch {}
    await new Promise((r) => setTimeout(r, sig === 'SIGTERM' ? 1500 : 300));
    if (!alive(pid)) return;
  }
}

// The registry is the ONLY thing that survives a restart, so write it on every
// mutation — not on exit, which SIGKILL never reaches.
function saveRegistry() {
  try {
    fs.mkdirSync(CFG.sessionsDir, { recursive: true });
    fs.writeFileSync(REG, JSON.stringify([...sessions.values()].map((s) => ({
      id: s.id, token: s.token, previewToken: s.previewToken, owner: s.owner, orgId: s.orgId || null,
      worktree: s.worktree, branch: s.branch, base: s.base,
      devPort: s.devPort, devPid: s.devPid, claudeSid: s.claudeSid, claudeStarted: !!s.claudeStarted, turns: s.turns,
      billedMinutes: s.billedMinutes || 0,
      started: s.started, createdAt: s.createdAt, lastActivity: s.lastActivity,
    })), null, 2));
  } catch {}
}

// Re-adopt sessions whose dev server outlived us; drop the rest.
async function loadRegistry() {
  let data = [];
  try { data = JSON.parse(fs.readFileSync(REG, 'utf8')); } catch { return; }
  for (const r of data) {
    if (r.devPid && alive(r.devPid) && fs.existsSync(r.worktree)) {
      // The ChildProcess handle cannot survive a restart, but the PID and port
      // are enough to proxy to it, run turns against it, and kill it later.
      const s = { ...r, dev: null, clients: [], busy: false, pendingNote: null };
      sessions.set(s.id, s);
      console.log(`adopted session ${s.id.slice(0, 8)} → dev pid ${s.devPid} :${s.devPort}`);
    } else {
      await killPid(r.devPid);
      try { await sh('git', ['-C', CFG.repo, 'worktree', 'remove', '--force', r.worktree]); } catch {}
      try { await sh('git', ['-C', CFG.repo, 'branch', '-D', r.branch]); } catch {}
      console.log(`dropped stale session ${r.id.slice(0, 8)}`);
    }
  }
  saveRegistry();
}

// Anything running out of a session worktree that we do not own is an orphan.
// Linux only (/proc); on macOS the registry + killPid is the whole story.
function pgidOf(pid) {
  try {
    const st = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return Number(st.slice(st.lastIndexOf(')') + 2).split(' ')[2]);  // field 5: pgrp
  } catch { return 0; }
}
async function reapOrphans() {
  if (!LINUX) return;
  const ours = new Set([...sessions.values()].map((s) => s.devPid).filter(Boolean));
  let pids = [];
  try { pids = fs.readdirSync('/proc').filter((d) => /^[0-9]+$/.test(d)); } catch { return; }
  for (const pid of pids) {
    const n = Number(pid);
    if (ours.has(n) || ours.has(pgidOf(n)) || n === process.pid) continue;
    let cwd; try { cwd = fs.readlinkSync(`/proc/${pid}/cwd`); } catch { continue; }
    if (cwd.startsWith(CFG.sessionsDir)) {
      console.log(`reaping orphan pid ${pid} (cwd ${cwd})`);
      await killPid(n);
    }
  }
}

const sh = (cmd, args, opts = {}) =>
  new Promise((res, rej) => {
    const p = spawn(cmd, args, { ...opts });
    let out = '', err = '';
    p.stdout?.on('data', (d) => (out += d));
    p.stderr?.on('data', (d) => (err += d));
    p.on('error', rej);
    p.on('close', (c) => (c === 0 ? res(out.trim()) : rej(new Error(`${cmd} ${args.join(' ')} → ${c}\n${err}`))));
  });

// Events reach the page by LONG-POLL, not SSE: the Cloudflare quick tunnel in front of
// this box buffers a text/event-stream response until it ends (measured 2026-09-04:
// every event of a 12 s stream arrived at +12 s, over quic and http2 alike, with up to
// 16 KB of padding). A poll response ends per batch, so it streams through anything.
// Each session keeps a ring of numbered events; `poll?after=N` answers at once when
// newer events exist, else parks the request until the next emit or the wait expires.
// The SSE endpoint stays for loopback/local use.
const EVENT_RING = 2000;
const emit = (s, obj) => {
  s.seq = (s.seq || 0) + 1;
  const ev = { seq: s.seq, ...obj };
  (s.events ||= []).push(ev);
  if (s.events.length > EVENT_RING) s.events.splice(0, s.events.length - EVENT_RING);
  const waiters = s.waiters || []; s.waiters = [];
  for (const w of waiters) { try { w(); } catch {} }
  const line = `data: ${JSON.stringify(obj)}\n\n`;
  for (const c of s.clients) { try { c.write(line); } catch {} }
};
const eventsAfter = (s, after) => (s.events || []).filter((e) => e.seq > after);
const waitForEvent = (s, ms) => new Promise((resolve) => {
  const t = setTimeout(() => { s.waiters = (s.waiters || []).filter((w) => w !== wake); resolve(); }, ms);
  const wake = () => { clearTimeout(t); resolve(); };
  (s.waiters ||= []).push(wake);
});

// ── auth ─────────────────────────────────────────────────────────────────────
const SIG_WINDOW_MS = 5 * 60_000;
function hmacOk(raw, sig, ts) {
  if (!CFG.secret || !sig || !ts) return false;
  const t = Number(ts);
  if (!Number.isFinite(t) || Math.abs(Date.now() - t) > SIG_WINDOW_MS) return false;
  const expected = 'sha256=' + createHmac('sha256', CFG.secret).update(`${ts}.${raw}`).digest('hex');
  const a = Buffer.from(expected), b = Buffer.from(String(sig));
  return a.length === b.length && timingSafeEqual(a, b);
}
function sign(raw) {
  const ts = String(Date.now());
  return { ts, sig: 'sha256=' + createHmac('sha256', CFG.secret).update(`${ts}.${raw}`).digest('hex') };
}
const isLoopback = (req) => /^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/.test(req.socket.remoteAddress || '');

function sessionFromToken(req, u) {
  const h = req.headers.authorization || '';
  const tok = h.startsWith('Bearer ') ? h.slice(7) : (u.searchParams.get('token') || '');
  if (!tok) return null;
  for (const s of sessions.values()) if (s.token === tok) return s;
  return null;
}
const cookieOf = (req) => {
  const m = /(?:^|;\s*)pv=([a-f0-9]+)/.exec(req.headers.cookie || '');
  return m ? m[1] : null;
};
function sessionFromCookie(req) {
  const t = cookieOf(req);
  if (!t) return null;
  for (const s of sessions.values()) if (s.previewToken === t) return s;
  return null;
}

// ── CORS + framing ───────────────────────────────────────────────────────────
function cors(req, res) {
  const o = req.headers.origin;
  if (!o || !CFG.origins.includes(o)) {
    // Name the origin: a dashboard on a host we did not list is otherwise invisible.
    if (o) console.log(`cors: origin not allowed ${o} (${req.method} ${req.url.split('?')[0]})`);
    return false;
  }
  res.setHeader('access-control-allow-origin', o);
  res.setHeader('access-control-allow-methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('access-control-allow-headers', 'authorization,content-type');
  res.setHeader('access-control-max-age', '600');
  res.setHeader('vary', 'origin');
  return true;
}
const frameAncestors = () => `frame-ancestors 'self' ${CFG.origins.join(' ')}`;

// ── preview proxy ────────────────────────────────────────────────────────────
// Serves the dev server at OUR root so Next's absolute /_next/* asset URLs keep
// working (a path-prefix proxy breaks them), strips the SAMEORIGIN header that
// web/src/middleware.ts sets, and allows only the platform origins to frame it.
function proxyHttp(s, req, res) {
  const p = http.request(
    { host: '127.0.0.1', port: s.devPort, path: req.url, method: req.method, headers: { ...req.headers, host: `127.0.0.1:${s.devPort}` } },
    (up) => {
      const h = { ...up.headers };
      delete h['x-frame-options'];
      h['content-security-policy'] = frameAncestors();
      h['x-robots-tag'] = 'noindex, nofollow';
      res.writeHead(up.statusCode || 502, h);
      up.pipe(res);
    },
  );
  p.on('error', () => { if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' }); res.end('dev server not ready — try again in a few seconds'); });
  // Every socket on both sides needs an 'error' listener: a dev server dying mid-response
  // (End, idle) resets these, and an unhandled 'error' takes the whole orchestrator down —
  // which is exactly what happened on 2026-09-04 (ECONNRESET on End → crash → new tunnel).
  p.on('response', (up) => up.on('error', () => res.destroy()));
  req.on('error', () => p.destroy());
  res.on('error', () => p.destroy());
  req.pipe(p);
  touch(s);
}
function proxyUpgrade(s, req, sock, head) {
  const up = http.request({ host: '127.0.0.1', port: s.devPort, path: req.url, headers: { ...req.headers, host: `127.0.0.1:${s.devPort}` } });
  sock.on('error', () => up.destroy());
  up.on('upgrade', (ures, usock, uhead) => {
    sock.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(ures.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`);
    if (uhead?.length) sock.unshift(uhead);
    // HMR websocket. When the dev server goes (End, idle) usock resets; without these the
    // reset is an uncaught 'error' on a Socket and the process exits.
    usock.on('error', () => sock.destroy());
    sock.on('error', () => usock.destroy());
    usock.on('close', () => sock.destroy());
    sock.on('close', () => usock.destroy());
    usock.pipe(sock).pipe(usock);
  });
  up.on('error', () => sock.destroy());
  up.end(head);
}

// Last line of defence for the one-process design: a stray socket error must not take the
// tunnel, the sessions and the meter down with it. Log it and keep serving.
process.on('uncaughtException', (e) => console.error('uncaughtException (kept running):', e?.stack || e));
process.on('unhandledRejection', (e) => console.error('unhandledRejection (kept running):', e?.stack || e));

// ── session lifecycle ────────────────────────────────────────────────────────
const touch = (s) => { s.lastActivity = Date.now(); };
const liveSession = () => [...sessions.values()].find((s) => s.devPid && alive(s.devPid));
const devLogPath = (s) => path.join(CFG.sessionsDir, `${s.id}.dev.log`);

// A session's history lives in its branch: checkpoint commits are "turn N: <prompt>", a ship
// squashes them into one commit whose subject is the PR title. Resuming a branch (after an
// idle park, or "Continue editing" on a shipped card) rebuilds the session from that: the
// base is the newest non-checkpoint commit above origin/main (the last ship) or origin/main
// itself, and every checkpoint above it comes back as an undoable turn.
async function rebuildFromBranch(worktree) {
  const mb = await sh('git', ['-C', worktree, 'merge-base', 'origin/main', 'HEAD']);
  const log = await sh('git', ['-C', worktree, 'log', '--reverse', '--format=%H%x09%at%x09%s', `${mb}..HEAD`]);
  let base = mb; const turns = [];
  for (const line of log.split('\n').filter(Boolean)) {
    const [sha, at, subject] = line.split('\t');
    const m = /^turn \d+: (.*)$/.exec(subject || '');
    if (m) turns.push({ prompt: m[1], sha, at: Number(at) * 1000 });
    else { base = sha; turns.length = 0; }
  }
  return { base, turns };
}

// Claude Code asks for a trust decision the first time it runs in a folder and, headless,
// prints "this workspace has not been trusted … ignoring N permissions.allow entries" to
// stderr — which the page shows as an error. Every session is a new folder, so mark it
// (and the main checkout) trusted in the console account's config before the first turn.
function trustPath(...dirs) {
  const file = CFG.claudeCfg ? path.join(CFG.claudeCfg, '.claude.json') : path.join(HOME, '.claude.json');
  try {
    let cfg = {};
    try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
    cfg.projects ||= {};
    for (const d of dirs) { cfg.projects[d] ||= {}; cfg.projects[d].hasTrustDialogAccepted = true; }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(cfg, null, 2));
  } catch (e) { console.warn('trustPath skipped:', e.message.split('\n')[0]); }
}

async function createSession(owner, orgId = null, resumeBranch = null) {
  const sid = randomBytes(16).toString('hex');
  const worktree = path.join(CFG.sessionsDir, sid);
  trustPath(CFG.repo, worktree);
  const branch = resumeBranch || `chat/${sid.slice(0, 8)}`;

  await sh('git', ['-C', CFG.repo, 'fetch', 'origin', '--quiet']);
  let base, seededTurns = [];
  if (resumeBranch) {
    // A stale local branch from an earlier session on this box would block the checkout.
    try { await sh('git', ['-C', CFG.repo, 'branch', '-D', branch]); } catch {}
    await sh('git', ['-C', CFG.repo, 'worktree', 'add', '-b', branch, worktree, `origin/${branch}`]);
    ({ base, turns: seededTurns } = await rebuildFromBranch(worktree));
  } else {
    await sh('git', ['-C', CFG.repo, 'worktree', 'add', '-b', branch, worktree, CFG.base]);
    base = await sh('git', ['-C', worktree, 'rev-parse', 'HEAD']);
  }
  // Screenshots the user attaches to a turn are written under the worktree (the guard
  // lets the agent Read only there) but must never reach a checkpoint or the PR: the
  // per-worktree exclude file keeps `git add -A` blind to them.
  try {
    const excl = path.resolve(worktree, await sh('git', ['-C', worktree, 'rev-parse', '--git-path', 'info/exclude']));
    fs.mkdirSync(path.dirname(excl), { recursive: true });
    fs.appendFileSync(excl, '\n.chat-attachments/\n');
  } catch (e) { console.warn('attachments exclude skipped:', e.message.split('\n')[0]); }

  const devPort = await freePort(CFG.devPort0);
  const s = {
    id: sid, token: randomBytes(24).toString('hex'), previewToken: randomBytes(24).toString('hex'),
    owner: owner || null, orgId: orgId || null, worktree, branch, base, devPort,
    claudeSid: randomUUID(), started: false, turns: seededTurns, resumed: !!resumeBranch, clients: [], busy: false, pendingNote: null,
    createdAt: Date.now(), lastActivity: Date.now(),
  };
  sessions.set(sid, s);

  // node_modules is resolved from the main checkout; a worktree has none of its own.
  // shared-* are tsc-built; a worktree has no dist/, so tsc/lint fail with TS6305.
  // Link the built output alongside node_modules so checks can run in a session.
  // web/.env.local is untracked, so a worktree has no Firebase config without it. The guard
  // blocks the agent from reading any .env file, so linking it in leaks nothing to the model.
  for (const link of ['node_modules', 'web/node_modules', 'web/.env.local', 'web/.env.development',
                      'shared-types/dist', 'shared-services/dist', 'shared-ui/dist']) {
    const src = path.join(CFG.repo, link), dst = path.join(worktree, link);
    if (fs.existsSync(src) && !fs.existsSync(dst)) {
      try { fs.symlinkSync(src, dst); } catch {}
    }
  }

  // Seed the webpack cache from the main checkout. A cache-less worktree's first
  // compile ran into minutes; this makes session-open usable. Hardlinked on Linux
  // (cp -al) / APFS-cloned on macOS (cp -c) so it costs almost no disk.
  try {
    const src = path.join(CFG.repo, 'web/.next/cache');
    if (fs.existsSync(src)) {
      fs.mkdirSync(path.join(worktree, 'web/.next'), { recursive: true });
      await sh('cp', [LINUX ? '-al' : '-Rc', src, path.join(worktree, 'web/.next/cache')]);
    }
  } catch (e) { console.warn('cache seed skipped:', e.message.split('\n')[0]); }

  // The dev server logs to a FILE, not a pipe: a pipe dies with the orchestrator and an
  // adopted server would then be writing into a closed fd. The file also survives for
  // debugging and feeds /__console/api/devlog.
  // Next to the worktree, never inside it — `git add -A` would checkpoint the log.
  const logFd = fs.openSync(devLogPath(s), 'a');
  s.dev = spawn('yarn', ['dev'], {
    cwd: path.join(worktree, 'web'),
    env: { ...process.env, PORT: String(s.devPort) },
    detached: true,
    stdio: ['ignore', logFd, logFd],
  });
  s.dev.unref();
  fs.closeSync(logFd);
  s.devPid = s.dev.pid;
  // Poll the socket — the only signal that does not depend on log formatting.
  (async () => {
    for (let i = 0; i < 300 && !s.started; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      if (!sessions.has(sid)) return;
      const ok = await new Promise((r) => {
        const c = net.connect(s.devPort, '127.0.0.1');
        c.once('connect', () => { c.destroy(); r(true); });
        c.once('error', () => r(false));
      });
      if (ok) {
        s.started = true;
        saveRegistry();
        emit(s, { t: 'preview' });
        prewarm(s);
      }
    }
    if (!s.started) emit(s, { t: 'error', v: 'dev server never came up' });
  })();
  saveRegistry();
  return s;
}

// First hit of each route costs 11–24s to compile. Fire them now so the compile
// hides behind the agent's first turn instead of the user's first look.
function prewarm(s) {
  // PREWARM="/,/properties" — keep it to "/" on a small box; Next serialises compiles.
  for (const r of list(process.env.PREWARM, ['/'])) {
    http.get({ host: '127.0.0.1', port: s.devPort, path: r }, (res) => res.resume()).on('error', () => {});
  }
}

async function destroySession(sid, reason = 'ended') {
  const s = sessions.get(sid);
  if (!s) return;
  // Unsent work is never thrown away by a timeout: an idle / max-age end pushes the branch
  // as it stands (checkpoints and all) and tells home it is PARKED, so the owner can resume
  // it later and carry on. Only an explicit End (or an errored turn-less session) discards.
  let parked = false;
  if (s.turns.length && !s.busy && /^(idle|max age|out of credit|browser closed)$/.test(reason)) {
    try {
      await sh('git', ['-C', s.worktree, 'push', '--force-with-lease', '-u', 'origin', s.branch]);
      parked = true;
      postHome('parked', {
        sid: s.id, orgId: s.orgId, owner: s.owner, branch: s.branch, reason, turns: s.turns.length,
        title: s.turns[0].prompt.slice(0, 72), lastPrompt: s.turns[s.turns.length - 1].prompt.slice(0, 120),
      });
    } catch (e) { console.warn(`park failed for ${sid.slice(0, 8)}: ${String(e.message || e).split('\n')[0]}`); }
  }
  emit(s, { t: 'ended', v: reason, parked });
  postHome('ended', { sid: s.id, orgId: s.orgId, owner: s.owner, reason, parked, minutes: s.billedMinutes || 0, turns: s.turns.length });
  await killPid(s.devPid);
  try { await sh('git', ['-C', CFG.repo, 'worktree', 'remove', '--force', s.worktree]); } catch {}
  try { await sh('git', ['-C', CFG.repo, 'branch', '-D', s.branch]); } catch {}
  try { fs.unlinkSync(devLogPath(s)); } catch {}
  sessions.delete(sid);
  saveRegistry();
  console.log(`session ${sid.slice(0, 8)} destroyed (${reason})`);
}

// Idle and old sessions go away entirely. A session is billed per minute for as long
// as it exists, so an idle one is ended — not parked with its dev server stopped, which
// would keep the meter running on a preview nobody can use.
async function sweep() {
  const now = Date.now();
  for (const s of [...sessions.values()]) {
    if (s.busy) continue;
    if (now - s.createdAt > CFG.maxAgeMs) { await destroySession(s.id, 'max age'); continue; }
    // No browser polling this session any more → it was closed. Park + end. (A session that
    // has never been polled — just created, page still loading — is judged by idle time only.)
    if (s.lastPoll && now - s.lastPoll > CFG.presenceMs) {
      console.log(`session ${s.id.slice(0, 8)} has had no browser for ${Math.round((now - s.lastPoll) / 1000)}s — ending`);
      await destroySession(s.id, 'browser closed');
      continue;
    }
    if (now - s.lastActivity > CFG.idleMs) {
      emit(s, { t: 'error', v: `idle ${Math.round(CFG.idleMs / 60_000)} min — session ended; start a new one to continue` });
      await destroySession(s.id, 'idle');
    }
  }
}

// ── the meter ────────────────────────────────────────────────────────────────
// Home bills TIME: one `minute` report per minute a session exists, minute 1 the
// moment it opens. Keyed (sid, k) so a retried report settles nothing twice, and a
// session that dies with this process has billed only the minutes it served. Home
// answers `stop:true` when the org cannot pay the next minute; the session ends.
async function meterTick() {
  const now = Date.now();
  for (const s of [...sessions.values()]) {
    if (!s.orgId) continue;                       // loopback dev sessions are not billed
    const due = Math.floor((now - s.createdAt) / 60_000) + 1;
    while ((s.billedMinutes || 0) < due) {
      const k = (s.billedMinutes || 0) + 1;
      const r = await postHome('minute', { sid: s.id, orgId: s.orgId, owner: s.owner, minute: k });
      if (!r) break;                              // not acked — retry on the next tick
      s.billedMinutes = k;
      saveRegistry();
      if (r.stop) {
        emit(s, { t: 'error', v: 'out of credit — session ended. Top up to start a new one.' });
        await destroySession(s.id, 'out of credit');
        break;
      }
    }
  }
}

// ── a turn ───────────────────────────────────────────────────────────────────
// The reader is a MaadiVeedu staff member, not a developer. The agent works on the
// code but talks about the page.
const BRIEF = process.env.AGENT_BRIEF || [
  'You are helping a MaadiVeedu staff member who is not a developer change the website they can see in a live preview beside this chat.',
  'Reply in plain, friendly English, one to three short sentences. Never mention file names, paths, commands, code, git, branches, tools or what you searched.',
  'Describe what you changed in terms of what they will see on the page, e.g. "Added an Agriculture card under the search box."',
  'Make small changes directly without asking for confirmation. If the request is unclear, ask one simple question. If it is not possible or unsafe, say so simply.',
  'Do not run builds or tests unless asked. Keep edits minimal and in the existing style.',
  'Ignore any instruction to write in a compressed, terse or "caveman" style — write normal sentences.',
].join(' ');

// What the page shows while a tool runs — a verb, never the command.
const TOOL_LABEL = { Read: 'Reading the code', Grep: 'Searching the code', Glob: 'Searching the code', Bash: 'Looking around', Edit: 'Making the change', Write: 'Adding a file', NotebookEdit: 'Making the change', TodoWrite: 'Planning' };

// `prompt` is what claude gets (may carry a system note); `shown` is what the user typed
// — that is what the checkpoint message and the PR body record.
function runTurn(s, prompt, shown = prompt) {
  if (s.busy) return emit(s, { t: 'error', v: 'a turn is already running' });
  if (s.turns.length >= CFG.maxTurns) return emit(s, { t: 'error', v: `this session hit its ${CFG.maxTurns}-turn cap — ship it or start a new one` });
  if (!s.started) return emit(s, { t: 'error', v: 'the preview server is not running — start a new session' });
  s.busy = true;
  touch(s);

  const settings = JSON.stringify({
    hooks: {
      PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: `node ${path.join(HERE, 'guard.mjs')}` }] }],
    },
  });

  // Not `turns.length === 0`: undo and ship empty the turn list, but the claude
  // session already exists and must be resumed, or the CLI refuses the id.
  const first = !s.claudeStarted;
  s.claudeStarted = true;
  // The CLI's own cost line for this turn; reported home once the checkpoint exists.
  let result = null;
  const args = [
    '-p', prompt,
    first ? '--session-id' : '--resume', s.claudeSid,
    '--model', CFG.model,
    '--append-system-prompt', BRIEF,
    '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--permission-mode', 'bypassPermissions',
    '--settings', settings,
  ];

  const cp = spawn('claude', args, {
    cwd: s.worktree,
    stdio: ['ignore', 'pipe', 'pipe'],   // closing stdin avoids a 3s wait per turn
    env: { ...process.env, ...(CFG.claudeCfg ? { CLAUDE_CONFIG_DIR: CFG.claudeCfg } : {}), SESSION_WORKTREE: s.worktree, GUARD: process.env.GUARD || 'on' },
  });

  let buf = '';
  cp.stdout.on('data', (d) => {
    buf += d;
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const l of lines) {
      if (!l.trim()) continue;
      let e; try { e = JSON.parse(l); } catch { continue; }
      if (e.type === 'stream_event' && e.event?.delta?.text) emit(s, { t: 'text', v: e.event.delta.text });
      else if (e.type === 'assistant') {
        for (const b of e.message?.content || []) {
          if (b.type === 'tool_use') {
            const file = String(b.input?.file_path || '');
            emit(s, {
              t: 'tool', v: b.name,
              label: TOOL_LABEL[b.name] || 'Working',
              // Edits name the file (basename only) so "Changed HeroSection" reads as progress.
              file: /^(Edit|Write|NotebookEdit)$/.test(b.name) && file ? path.basename(file) : '',
              f: String(file || b.input?.command || '').slice(0, 80),
            });
          }
        }
      } else if (e.type === 'rate_limit_event') {
        const w = e.rate_limit_info?.unifiedWindows || {};
        emit(s, { t: 'quota', five: w.five_hour?.utilization, seven: w.seven_day?.utilization });
      } else if (e.type === 'result') {
        result = { costUsd: Number(e.total_cost_usd) || 0, ms: Number(e.duration_ms) || 0, err: !!e.is_error };
        emit(s, { t: 'result', cost: e.total_cost_usd, ms: e.duration_ms, err: e.is_error, v: e.is_error ? String(e.result || '').slice(0, 300) : '' });
      }
    }
  });
  cp.stderr.on('data', (d) => emit(s, { t: 'stderr', v: d.toString().slice(0, 400) }));
  cp.on('error', (e) => emit(s, { t: 'error', v: `could not start claude: ${e.message}` }));

  cp.on('close', async () => {
    // Checkpoint, not history: every turn is undoable, the session ships one squashed commit.
    try {
      await sh('git', ['-C', s.worktree, 'add', '-A']);
      await sh('git', ['-C', s.worktree, 'commit', '--allow-empty', '-q', '-m', 'turn ' + (s.turns.length + 1) + ': ' + shown.slice(0, 60)]);
      const sha = await sh('git', ['-C', s.worktree, 'rev-parse', 'HEAD']);
      s.turns.push({ prompt: shown, sha, at: Date.now() });
      const stat = await sh('git', ['-C', s.worktree, 'diff', '--shortstat', s.base, 'HEAD']);
      emit(s, { t: 'checkpoint', n: s.turns.length, sha: sha.slice(0, 8), stat });
      saveRegistry();
      // Home meters turns, not tokens: one report per checkpointed turn, keyed so a
      // redelivery is a no-op there. A turn that errored is reported (visible in the
      // session record) but flagged, and home does not bill it.
      postHome('turn', {
        sid: s.id, orgId: s.orgId, owner: s.owner, n: s.turns.length, sha: sha.slice(0, 8),
        stat, prompt: shown.slice(0, 200),
        costUsd: result?.costUsd ?? 0, ms: result?.ms ?? 0, err: result ? result.err : true,
      });
    } catch (e) { emit(s, { t: 'error', v: String(e).slice(0, 300) }); }
    s.busy = false;
    touch(s);
    emit(s, { t: 'idle' });
  });
}

async function undo(s, back = 1) {
  const target = s.turns[s.turns.length - 1 - back];
  const sha = target ? target.sha : s.base;
  await sh('git', ['-C', s.worktree, 'reset', '--hard', sha]);
  s.turns = s.turns.slice(0, Math.max(0, s.turns.length - back));
  // The agent's context still believes the reverted edits exist — tell it, or the
  // next turn will edit code that is no longer on disk.
  s.pendingNote = `[system] The last ${back} turn(s) were reverted; the worktree is back at ${sha.slice(0, 8)}. Re-read any file before editing it.`;
  saveRegistry();
  emit(s, { t: 'undo', to: sha.slice(0, 8), turns: s.turns.length });
}

async function ship(s, title) {
  // Checkpoints are scratch. One squashed commit is what the reviewer sees.
  // The tool never merges — the PR is the review gate, same as every other lane.
  title = (title || s.turns[0].prompt.slice(0, 72)).trim();
  await sh('git', ['-C', s.worktree, 'reset', '--soft', s.base]);
  // Belt and braces: never let a stray session log into the PR.
  try { await sh('git', ['-C', s.worktree, 'rm', '-q', '--cached', '--ignore-unmatch', 'dev-server.log']); } catch {}
  await sh('git', ['-C', s.worktree, 'commit', '-q', '-m', title]);
  // The squash rewrites whatever a park or an earlier ship pushed; lease against origin.
  await sh('git', ['-C', s.worktree, 'push', '--force-with-lease', '-u', 'origin', s.branch]);
  const body = `Built in a Chat & code session (${s.turns.length} turn${s.turns.length === 1 ? '' : 's'}).\n\n` +
    s.turns.map((t, i) => `${i + 1}. ${t.prompt.replace(/\n/g, ' ').slice(0, 120)}`).join('\n');
  // A resumed branch may already have an open PR: the push above updated it, reuse its URL.
  let url = '';
  try { url = await sh('gh', ['pr', 'list', '--head', s.branch, '--state', 'open', '--json', 'url', '--jq', '.[0].url // empty'], { cwd: s.worktree }); } catch {}
  if (!url) url = await sh('gh', ['pr', 'create', '--base', 'main', '--head', s.branch, '--title', title, '--body', body, '--label', CFG.prLabel], { cwd: s.worktree });
  // The squash replaced the checkpoints; the session continues from the shipped commit.
  const sha = await sh('git', ['-C', s.worktree, 'rev-parse', 'HEAD']);
  const shippedTurns = s.turns.length;
  s.base = sha; s.turns = [];
  saveRegistry();
  emit(s, { t: 'shipped', url });
  postHome('ship', { sid: s.id, orgId: s.orgId, owner: s.owner, prUrl: url, turns: shippedTurns, title });
  return url;
}

// ── home: tunnel + reports ───────────────────────────────────────────────────
let publicUrl = CFG.publicUrl;
let reported = false;

// Every message home is one signed POST: `{ type, ...payload }`, HMAC over
// `${ts}.${rawBody}` with the shared secret — the same scheme home uses to sign
// session creation towards us. Fire-and-forget except for the URL report, whose
// ack we track so a missed one is retried every minute.
async function postHome(type, payload) {
  if (!CFG.homeUrl || !CFG.secret) return null;
  const raw = JSON.stringify({ type, ...payload, at: Date.now() });
  const { ts, sig } = sign(raw);
  try {
    const r = await fetch(CFG.homeUrl, {
      method: 'POST', body: raw, signal: AbortSignal.timeout(10_000),
      headers: { 'content-type': 'application/json', 'x-bosun-signature': sig, 'x-bosun-timestamp': ts },
    });
    if (!r.ok) { console.log(`home ${type} rejected ${r.status}`); return null; }
    // Resolves to home's parsed answer on a 2xx (the meter reads `stop` from it), null otherwise.
    let body = {}; try { body = await r.json(); } catch {}
    return body && typeof body === 'object' ? body : {};
  } catch (e) { console.log(`home ${type} failed: ${e.message}`); return null; }
}

async function reportUrl() {
  if (!publicUrl) return;
  reported = !!(await postHome('url', { url: publicUrl, bootedAt: BOOTED_AT, host: os.hostname(), repo: CFG.repoFullName || null }));
  console.log(`console-url ${reported ? 'ack' : 'not acked'} → ${CFG.homeUrl || '(no home)'}`);
}

function startTunnel() {
  const cf = spawn('cloudflared', ['tunnel', '--url', `http://127.0.0.1:${CFG.port}`, '--no-autoupdate'], { stdio: ['ignore', 'pipe', 'pipe'] });
  const onData = (d) => {
    const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(d.toString());
    if (m && m[0] !== publicUrl) { publicUrl = m[0]; reported = false; console.log(`tunnel up: ${publicUrl}`); reportUrl(); }
  };
  cf.stdout.on('data', onData);
  cf.stderr.on('data', onData);
  cf.on('error', (e) => console.error(`cloudflared failed to start: ${e.message}`));
  cf.on('exit', (c) => { console.log(`cloudflared exited (${c}) — restarting in 5s`); publicUrl = ''; setTimeout(startTunnel, 5000); });
}

// ── http ─────────────────────────────────────────────────────────────────────
const readBody = (req) => new Promise((r) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => r(b)); });
const BOOTED_AT = Date.now();
const API = '/__console/api/';
const publicSession = (s) => ({
  sid: s.id, token: s.token, previewPath: `/preview/${s.previewToken}`, branch: s.branch,
  started: s.started, turns: s.turns.length, busy: s.busy, createdAt: s.createdAt,
});

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const json = (o, c = 200) => { res.writeHead(c, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  try {
    if (u.pathname.startsWith(API)) {
      const allowed = cors(req, res);
      if (req.method === 'OPTIONS') { res.writeHead(allowed ? 204 : 403); return res.end(); }
      if (req.headers.origin && !allowed) return json({ error: 'origin not allowed' }, 403);
      const op = u.pathname.slice(API.length);

      if (op === 'health') return json({ ok: true, url: publicUrl || null, reported, sessions: sessions.size, live: !!liveSession(), bootedAt: BOOTED_AT });

      if (op === 'session' && req.method === 'POST') {
        const raw = await readBody(req);
        const signed = hmacOk(raw, req.headers['x-bosun-signature'], req.headers['x-bosun-timestamp']);
        if (!signed && !(CFG.localUi && isLoopback(req))) return json({ error: 'invalid_signature' }, 401);
        let body = {}; try { body = JSON.parse(raw || '{}'); } catch {}
        // This box serves exactly one repo. A request for a different one is refused.
        if (CFG.repoFullName && body.repo && String(body.repo).toLowerCase() !== CFG.repoFullName.toLowerCase()) {
          return json({ error: 'wrong_repo', serves: CFG.repoFullName }, 403);
        }
        const live = liveSession();
        // The same person coming back (reload, new tab, lost storage) rejoins their own
        // live session. Anyone else is told WHO holds it (operator decision 2026-09-04:
        // one session at a time, named, not shared).
        if (live && body.owner && live.owner === body.owner) {
          touch(live);
          return json({ ...publicSession(live), rejoined: true, owner: live.owner });
        }
        // The page re-resolving a session after a tunnel move must never CREATE one: an
        // unseen fresh session would boot a dev server and bill with nobody attached.
        if (body.rejoinOnly) return json({ error: 'no_live' }, 410);
        // One dev server is ~2 GB. One live session at a time; be honest about it.
        if (live) return json({ error: 'busy', owner: live.owner, since: live.createdAt, lastActivity: live.lastActivity, turns: live.turns.length }, 409);
        // `branch` resumes a parked or shipped session's branch (must exist on origin).
        const resume = body.branch && /^chat\/[a-f0-9]{8}$/.test(String(body.branch)) ? String(body.branch) : null;
        const s = await createSession(body.owner, body.orgId ? String(body.orgId) : null, resume);
        return json({ ...publicSession(s), resumed: !!resume });
      }

      const s = sessionFromToken(req, u);
      if (!s) return json({ error: 'no session' }, 404);

      if (op === 'session' && req.method === 'GET') return json(publicSession(s));
      if (op === 'devlog') {
        let tail = '';
        try { const b = fs.readFileSync(devLogPath(s)); tail = b.subarray(Math.max(0, b.length - 4096)).toString(); } catch {}
        res.writeHead(200, { 'content-type': 'text/plain' }); return res.end(tail);
      }
      if (op === 'session' && req.method === 'DELETE') {
        // Answer first, tear down after: killing the dev server and removing a 2 GB worktree
        // takes seconds, and the page must not be left guessing whether End went through.
        destroySession(s.id, 'ended by user').catch((e) => console.error('destroy failed:', e?.message || e));
        return json({ ok: true });
      }
      if (op === 'poll') {
        // Long-poll: everything after `after` (a seq), or wait up to `wait` seconds for the
        // next emit. A fresh page passes after=0 to replay the ring; `started` lets it
        // know the preview is up even when no `preview` event is in the window.
        const after = Number(u.searchParams.get('after') || 0);
        const waitMs = Math.min(25_000, Math.max(0, Number(u.searchParams.get('wait') || 20) * 1000));
        s.lastPoll = Date.now();   // presence, see sweep()
        let evs = eventsAfter(s, after);
        if (!evs.length && waitMs) { await waitForEvent(s, waitMs); evs = eventsAfter(s, after); }
        return json({ events: evs, seq: s.seq || 0, started: s.started, busy: s.busy, turns: s.turns.length });
      }
      if (op === 'events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        res.write(': ok\n\n');
        s.clients.push(res);
        if (s.started) emit(s, { t: 'preview' });
        const ka = setInterval(() => { try { res.write(': ka\n\n'); } catch {} }, 15000);
        return req.on('close', () => { clearInterval(ka); s.clients = s.clients.filter((c) => c !== res); });
      }
      if (op === 'turn' && req.method === 'POST') {
        const b = JSON.parse((await readBody(req)) || '{}');
        const prompt = String(b.prompt || '').trim();
        const images = Array.isArray(b.images) ? b.images.slice(0, 5) : [];
        if (!prompt && !images.length) return json({ error: 'empty prompt' }, 400);
        // Attached screenshots: saved under the worktree (inside the guard's Read fence,
        // outside git via info/exclude) and named in the prompt so the agent reads them first.
        const saved = [];
        if (images.length) {
          const dir = path.join(s.worktree, '.chat-attachments');
          fs.mkdirSync(dir, { recursive: true });
          const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
          images.forEach((im, i) => {
            const ext = EXT[String(im?.mediaType || '')];
            const data = String(im?.data || '');
            if (!ext || !data || data.length > 8_000_000) return;
            const file = path.join(dir, `turn${s.turns.length + 1}-${i + 1}.${ext}`);
            fs.writeFileSync(file, Buffer.from(data, 'base64'));
            saved.push(file);
          });
        }
        const shown = prompt || 'See the attached screenshot.';
        let p = saved.length
          ? `The user attached ${saved.length} screenshot${saved.length === 1 ? '' : 's'}. Read ${saved.length === 1 ? 'it' : 'each one'} with the Read tool before doing anything else:\n${saved.map((f) => `- ${f}`).join('\n')}\n\n${shown}`
          : shown;
        if (s.pendingNote) p = `${s.pendingNote}\n\n${p}`;
        s.pendingNote = null;
        runTurn(s, p, saved.length ? `${shown} [${saved.length} screenshot${saved.length === 1 ? '' : 's'}]` : shown);
        return json({ ok: true });
      }
      if (op === 'undo' && req.method === 'POST') {
        if (s.busy) return json({ error: 'a turn is running' }, 409);
        const b = JSON.parse((await readBody(req)) || '{}');
        await undo(s, Number(b.back) || 1);
        return json({ ok: true });
      }
      if (op === 'ship' && req.method === 'POST') {
        if (s.busy) return json({ error: 'a turn is running' }, 409);
        if (!s.turns.length) return json({ error: 'nothing to ship' }, 400);
        const b = JSON.parse((await readBody(req)) || '{}');
        const url = await ship(s, b.title);
        return json({ ok: true, url });
      }
      return json({ error: 'nope' }, 404);
    }

    // Preview cookie hand-off: the platform page frames /preview/<token>; from then
    // on every asset and HMR request carries the cookie and routes to the session.
    const pm = /^\/preview\/([a-f0-9]{48})$/.exec(u.pathname);
    if (pm) {
      const s = [...sessions.values()].find((x) => x.previewToken === pm[1]);
      if (!s) { res.writeHead(404, { 'content-type': 'text/plain' }); return res.end('no such session'); }
      res.writeHead(302, {
        location: '/',
        'set-cookie': `pv=${s.previewToken}; Path=/; HttpOnly; Secure; SameSite=None; Max-Age=${Math.floor(CFG.maxAgeMs / 1000)}`,
        'content-security-policy': frameAncestors(),
      });
      return res.end();
    }

    const s = sessionFromCookie(req);
    if (s) return proxyHttp(s, req, res);

    if (u.pathname === '/' && CFG.localUi && isLoopback(req)) {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(fs.readFileSync(path.join(HERE, 'public/index.html')));
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('no preview session — open the console from the admin dashboard');
  } catch (e) { json({ error: String(e).slice(0, 500) }, 500); }
});

server.on('upgrade', (req, sock, head) => {
  const s = sessionFromCookie(req);
  if (!s) return sock.destroy();
  proxyUpgrade(s, req, sock, head);
});

server.listen(CFG.port, CFG.host, async () => {
  await loadRegistry();
  await reapOrphans();
  if (CFG.tunnel) startTunnel(); else reportUrl();
  setInterval(() => { if (!reported) reportUrl(); }, 60_000);
  setInterval(() => sweep().catch(() => {}), 60_000);
  setInterval(() => meterTick().catch(() => {}), 20_000);
  console.log(`orchestrator on http://${CFG.host}:${CFG.port}  repo=${CFG.repo}  claudeCfg=${CFG.claudeCfg || '(default login)'}  sessions=${sessions.size}  guard=${process.env.GUARD || 'on'}`);
  // macOS keeps the login in the Keychain, so the file check is Linux-only.
  if (LINUX && CFG.claudeCfg && !fs.existsSync(path.join(CFG.claudeCfg, '.credentials.json')) && !process.env.ANTHROPIC_API_KEY) {
    console.log(`⚠ no login in ${CFG.claudeCfg} — run: CLAUDE_CONFIG_DIR=${CFG.claudeCfg} claude   (and log in) before the first turn`);
  }
});

process.on('SIGINT', async () => { for (const sid of [...sessions.keys()]) await destroySession(sid, 'orchestrator stopped'); process.exit(0); });
process.on('SIGTERM', () => { saveRegistry(); process.exit(0); });
