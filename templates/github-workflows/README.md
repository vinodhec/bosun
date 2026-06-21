# Deploy workflows (per customer repo)

Bosun never holds your Vercel/Firebase credentials. It only **moves git refs**; these
GitHub Actions (in *your* repo, with *your* secrets) do the actual deploy of **both**
Vercel and Firebase.

```
agent fix ─▶ PR into main   → Vercel native PR Preview on the TESTING project (mav3.0)
  Bosun "Deploy to testing"  → merges PR → main     → Vercel native deploy (mav3.0) + deploy-testing.yml (Firebase)
  Bosun "Deploy to production" → tags main's head (v*) → deploy-prod.yml (Vercel --prod mav3.0prod + Firebase)
```

**Previews come from the testing project automatically.** `mav3.0` (testing) is Git-connected
to the repo (production branch `main`), so Vercel itself builds a Preview for every PR and
deploys testing on merge to `main`. No custom preview workflow is needed, and production
(`mav3.0prod`, NOT Git-connected) is never involved in previews.

So the Actions only do what Vercel's native integration doesn't:
- **deploy-testing.yml** — Firebase (testing) on push to `main`.
- **deploy-prod.yml** — Vercel `--prod` (mav3.0prod, via CLI) + Firebase (prod) on a pushed `v*` tag.

## Install
1. Copy `deploy-testing.yml` and `deploy-prod.yml` into the repo's `.github/workflows/`.
2. Add the secrets/vars below (Settings → Secrets and variables → Actions).
3. The build/deploy mirror maadiveedu's `yarn deploy` (`vercel --prod && firebase deploy`):
   - **Vercel** runs a *cloud* build using each project's own settings — nothing to tune.
   - **Firebase** deploys `functions,firestore,storage` (no hosting — web is on Vercel). The
     build line (`nx run-many -t build -p shared-types shared-services functions`) is inferred
     from the Nx graph; adjust only that line if your build differs.

## Secrets
| Name | What |
|---|---|
| `VERCEL_TOKEN` | Vercel access token |
| `VERCEL_ORG_ID` | Vercel org/team id |
| `VERCEL_PROJECT_ID_TESTING` | Vercel project for testing (maadiveedu: `mav3.0`) |
| `VERCEL_PROJECT_ID_PROD` | Vercel project for prod (maadiveedu: `mav3.0prod`) |
| `FIREBASE_TOKEN` | one token from `firebase login:ci` — works for both Firebase projects |

## Vars
| Name | maadiveedu value |
|---|---|
| `FIREBASE_PROJECT_TESTING` | `maadiveedu-6b8ce` |
| `FIREBASE_PROJECT_PROD` | `maadiveeduvas` |

`FIREBASE_TOKEN` comes from `firebase login:ci` (a CI refresh token tied to your
account, which owns both projects). The Vercel project id selects which environment the
build targets.

## Firebase-Hosting orgs (no Vercel)

For a repo hosted entirely on Firebase Hosting (`org.deploy.host === 'firebase'`), use
`firebase-deploy-testing.yml` + `firebase-deploy-prod.yml` instead of the Vercel pair. There's
no automatic per-PR preview, so Bosun drives preview/revert through `workflow_dispatch`:

```
"See a preview"     → workflow_dispatch(ref = PR branch) → deploy branch to the testing site
"Deploy to testing" → merge PR → base push              → deploy base to the testing site
"Undo preview"      → workflow_dispatch(ref = base)      → redeploy base to the testing site
"Go live"           → tag v* at base head               → firebase-deploy-prod.yml
```

Setup per repo:
1. Copy both `firebase-deploy-*.yml` into `.github/workflows/` (edit base branch, node version,
   install, and the build+deploy command — usually your repo's own `deploy:test` / `deploy:prod`).
2. Add a `FIREBASE_SERVICE_ACCOUNT` repo secret — a service-account JSON key with **Firebase
   Hosting Admin** on **both** the testing and production projects.
3. Connect the repo in the Admin panel with **Deploy host = Firebase**, the base branch, the two
   project ids, and the testing site URL. The GitHub token needs **Workflows RW** (to dispatch).

