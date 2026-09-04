#!/usr/bin/env node
// PreToolUse guard — ALLOW-LIST. Anything not named here is refused.
// Runs regardless of --permission-mode, so the CLI stays on bypassPermissions
// (never stalls on an unanswerable prompt) while this decides what may run.
// Exit 2 = block; stderr is shown to the model so it can adapt.
//
// ON by default. GUARD=off disables it — for a loopback-only experiment, never
// on a box that also holds other repos' secrets.
if (process.env.GUARD === 'off') process.exit(0);

let raw = '';
process.stdin.on('data', (d) => (raw += d));
process.stdin.on('end', () => {
  let ev = {}; try { ev = JSON.parse(raw || '{}'); } catch { process.exit(0); }
  const tool = ev.tool_name || '';
  const input = ev.tool_input || {};
  const root = (process.env.SESSION_WORKTREE || '').replace(/\/$/, '');
  const deny = (why) => { console.error(why); process.exit(2); };

  const ALLOWED_TOOLS = new Set(['Read', 'Grep', 'Glob', 'TodoWrite', 'Edit', 'Write', 'NotebookEdit', 'Bash']);
  if (!ALLOWED_TOOLS.has(tool)) deny(`Blocked: tool "${tool}" is not on the allow-list.`);

  // Every file the agent touches — read OR write — must live inside this session's
  // worktree, and env files are off limits even there (the worktree carries the
  // platform's tracked .env.local).
  const inside = (p) => !root || !p || (path0(p).startsWith(root + '/') || path0(p) === root);
  const isEnv = (p) => /(^|\/)\.env(\.|$)/.test(p);
  const path0 = (p) => (p.startsWith('/') ? p : root + '/' + p.replace(/^\.\//, ''));

  if (['Write', 'Edit', 'NotebookEdit', 'Read'].includes(tool)) {
    const p = String(input.file_path || input.notebook_path || '');
    if (!inside(p)) deny(`Blocked: file access is confined to ${root}. Attempted: ${p}`);
    if (isEnv(p)) deny(`Blocked: env files are not readable or writable in a session.`);
    process.exit(0);
  }
  if (tool === 'Grep' || tool === 'Glob') {
    const p = String(input.path || '');
    if (p && !inside(p)) deny(`Blocked: searches are confined to ${root}. Attempted: ${p}`);
    process.exit(0);
  }
  if (tool !== 'Bash') process.exit(0);

  const ALLOW = [
    /^git (status|diff|log|show|add|branch|rev-parse|stash|restore|ls-files|blame)\b/,
    /^git commit\b/, /^git (checkout|switch) -[bc]\b/,
    /^yarn (dev|build|lint|test)\b/,
    /^npx nx (lint|test|build|graph)\b/,
    /^npx tsc\b/, /^node --check\b/,
    /^(ls|cat|head|tail|wc|find|grep|rg|awk|echo|pwd|which|stat|file|du|df|basename|dirname|sort|uniq|cut|tr|diff|true|date)\b/,
    /^sed -n\b/,
    /^mkdir( -p)?\b/, /^touch\b/,
    /^curl\b[^|;]*\b(127\.0\.0\.1|localhost)\b/,
  ];

  const cmd = String(input.command || '');
  // Check EVERY segment — otherwise `ls && vercel --prod` slips through on `ls`.
  // An escaped pipe (grep "a\|b") is a regex alternation, not a shell pipe — keep it whole.
  const segments = cmd.split(/&&|\|\||;|(?<!\\)\||\n/).map((s) => s.trim()).filter(Boolean);
  for (const seg of segments) {
    const norm = seg.replace(/^(\w+=\S+\s+)+/, '').trim();       // strip FOO=bar prefixes
    if (!ALLOW.some((re) => re.test(norm))) {
      deny(`Blocked: "${norm.slice(0, 60)}" is not on the Bash allow-list.\n` +
           `Allowed: git (read ops, add, commit, checkout -b), yarn dev/build/lint/test, ` +
           `npx nx lint/test/build, npx tsc, file readers (ls cat grep find rg sed -n ...), mkdir, touch, curl to localhost.\n` +
           `Dependency installs, deploys, gh, firebase, vercel, rm and network calls are refused by design.`);
    }
    // Paths: nothing outside the worktree, no home-relative, no parent-walking, no env files.
    if (/(^|[\s"'=])~/.test(norm) || /(^|\/)\.\.(\/|\s|$)/.test(norm)) deny(`Blocked: "~" and ".." paths are not allowed; stay inside ${root}.`);
    for (const m of norm.matchAll(/(?:^|[\s"'=])(\/[^\s"']+)/g)) {
      const p = m[1];
      if (p === '/dev/null' || p.startsWith('/dev/')) continue;
      if (!inside(p)) deny(`Blocked: ${p} is outside this session's worktree ${root}.`);
    }
    if (/\.env(\.|\b)/.test(norm)) deny(`Blocked: env files are off limits in a session.`);
  }
  process.exit(0);
});
