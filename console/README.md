# Console — the Chat & code box

Chat on the left, live preview on the right. The agent edits a git worktree of the customer's
repo; the dev server's HMR reflects each edit in ~2s, with no deploy in the loop. Shipping opens
a PR labelled `needs-validation` — the same gate every other change goes through. The tool never
merges.

This directory is the **orchestrator**: one dependency-free Node process on Bosun's EC2 box. Its
home is Bosun (`functions/handlers/consoleTasks.js`): the Bosun dashboard's "Chat & code" tab opens
sessions through `openConsoleSession`, and the box reports its URL, every live minute, every turn
and every shipped PR to `consoleHook`. **Billing is per minute** (`console_minute`, ₹12/min, minute 1
at session open) — see `shared/billing.js`.

It lives outside the customer's repo on purpose: a session must not be able to break the tool
that is running it. (History before 2026-09-04 is in `vinodhec/agent-console`.)

## Run

    set -a; . ~/.config/agent-console.env; set +a     # see Environment
    node server.mjs                                   # http://127.0.0.1:7000

On EC2 it runs as a user service (`agent-console.service`, see below). On a laptop for
development, `LOCAL_UI=1 PUBLIC_URL=http://localhost:7000 node server.mjs` and set
`CONSOLE_URL=http://localhost:7000` in Bosun's `functions/.env`.

## Environment

| var | default | notes |
|---|---|---|
| `PORT` / `HOST` | 7000 / 127.0.0.1 | one port for API + preview. Never bind 0.0.0.0. |
| `REPO` | `~/apps/maadiveedu-unified-platform` | sessions branch from `BASE_REF` (`origin/main`) |
| `REPO_FULL_NAME` | — | `owner/name` this box serves. A session request for any other repo is refused (403 `wrong_repo`). |
| `SESSIONS_DIR` | `~/agent-sessions` | one worktree per session + `registry.json` |
| `CLAUDE_CONFIG_DIR` | `~/.claude-console` | **the account that runs turns.** Log it in once: `CLAUDE_CONFIG_DIR=~/.claude-console claude`, or set `CLAUDE_CODE_OAUTH_TOKEN` (from `claude setup-token`) in the env file. `ANTHROPIC_API_KEY` is honoured instead when set. |
| `MODEL` | `sonnet` | opus burns a Pro window far faster |
| `CONSOLE_SECRET` | — | = Bosun functions' `CONSOLE_SECRET`. Verifies session creation (inbound) and signs every report (outbound). Required unless `LOCAL_UI=1`. |
| `CONSOLE_HOME_URL` | — | Bosun's `consoleHook` function URL. Everything the box says goes here. |
| `TUNNEL` | unset | `1` spawns `cloudflared tunnel --url` and reports the trycloudflare URL it gets |
| `PUBLIC_URL` | — | known public URL (local dev) when not tunnelling |
| `CONSOLE_ALLOWED_ORIGINS` | Bosun hosting + maadiveedu.com origins + localhost | browser origins allowed to call the API and frame the preview |
| `LOCAL_UI` | unset | `1` serves the dependency-free fallback UI at `/` to loopback callers and lets them create sessions unsigned (unbilled: no org) |
| `GUARD` | on | `off` disables `guard.mjs`. Only ever for a loopback experiment. |
| `IDLE_MINUTES` / `MAX_AGE_HOURS` / `MAX_TURNS` | 30 / 6 / 40 | idle → session **ended** (billing stops); max age → session destroyed. With per-minute billing, set `IDLE_MINUTES` low (10). |
| `PR_LABEL` | `needs-validation` | label on every shipped PR |

## URLs on the one port

- `/__console/api/*` — the API. `POST session` needs the HMAC signature
  (`x-bosun-signature`, `x-bosun-timestamp`, `sha256(ts + '.' + rawBody)`) and a body
  `{ owner, orgId, repo }`; everything else needs the session token (`Authorization: Bearer`
  or `?token=` for the SSE stream). Ops: `session` (POST/GET/DELETE), `events` (SSE), `turn`,
  `undo`, `ship`, `health`, `devlog`.
- `/preview/<previewToken>` — sets the `pv` cookie and redirects to `/`. The dashboard frames
  this URL; from then on every asset and HMR websocket carries the cookie.
- everything else — proxied to the cookie's session dev server, `X-Frame-Options`
  stripped, `Content-Security-Policy: frame-ancestors <allowed origins>` added.

## What the box tells home (`CONSOLE_HOME_URL`)

One signed POST per event, `{ type, ...payload, at }`:

| type | when | home does |
|---|---|---|
| `url` | boot, and whenever the tunnel hostname changes; retried every minute until acked | stores `config/console.url` — where `openConsoleSession` sends the next session |
| `minute` | minute `k` of a session, `k = 1` at open, then every minute (`meterTick`, 20s) | settles `console_minute` (idempotent on `sid:mk`); answers `stop:true` when the org can't pay the next minute → the box ends the session |
| `turn` | after each checkpoint | session record (turn count, the CLI's cost line); not billed |
| `ship` | after `gh pr create` | session record (PR url) |
| `ended` | on destroy, with the reason | session record |

## How a session works

1. `git fetch` + `worktree add -b chat/<id> origin/main`
2. `node_modules` + `shared-*/dist` symlinked from the main checkout; `.next/cache`
   hardlinked (`cp -al`, APFS-cloned on macOS) — a cache-less worktree's first compile
   ran into minutes
3. `yarn dev` on a probed-free port; the preview proxy fronts it
4. each turn: `claude -p --resume <sid> --output-format stream-json` → SSE → the page
5. each turn ends in a **checkpoint commit** (disposable, enables undo)
6. **ship** squashes checkpoints into one commit → push → `gh pr create --label needs-validation`

One live session at a time (a dev server is ~2 GB on a 7 GB box): a second
`POST session` gets `409 busy` with the live session's start time. The same owner rejoins
their own live session instead.

## Guard (`guard.mjs`)

A `PreToolUse` hook, on by default. Allow-list of tools and Bash commands; every file
read or written must be inside the session worktree; `.env*` is off limits even there;
no `~`, no `..`, no absolute paths outside the worktree; no installs, deploys, `gh`,
`firebase`, `vercel`, `rm`, or network calls. Only the orchestrator pushes.

## EC2 service

    mkdir -p ~/.config/systemd/user
    cp agent-console.service ~/.config/systemd/user/
    systemctl --user daemon-reload && systemctl --user enable --now agent-console
    loginctl enable-linger ec2-user          # keep it running after logout
    journalctl --user -u agent-console -f

## Known gaps

- **Shared `node_modules`.** Symlinked at the main checkout, so `yarn add` in a session
  would mutate every session. The guard blocks it; per-session installs are deferred.
- **Third-party cookie.** The preview cookie is set by a different origin than the
  dashboard page. Chrome allows it (`SameSite=None; Secure`); Safari may not — the page
  offers "open preview in a new tab" for that case.
- **One repo per box.** `REPO_FULL_NAME` pins it; a second customer needs a second box (or a
  checkout-per-org rewrite of `createSession`).
