import { defineSecret } from 'firebase-functions/params';

// Runtime secrets, stored in Google Secret Manager (NOT in .env / code).
// Set the value with:  firebase functions:secrets:set ANTHROPIC_API_KEY
// A function gets it injected into process.env only if it lists the secret in its
// `secrets: [...]` option.
export const ANTHROPIC_API_KEY = defineSecret('ANTHROPIC_API_KEY');

// Jam Personal Access Token (jam_pat_…) — lets the managed agent read a customer-shared jam.dev
// recording via the Jam MCP server (used as a static bearer). Set it before deploying any function
// that lists it:  firebase functions:secrets:set JAM_PAT
export const JAM_PAT = defineSecret('JAM_PAT');

// Apify API token — powers the sourced-listing relay's raw data-fetch layer (Bosun's only cost on
// that lane). Shared across orgs (it's our token, not theirs). Listed only in runSourcingJobs.
//   firebase functions:secrets:set APIFY_TOKEN
export const APIFY_TOKEN = defineSecret('APIFY_TOKEN');

// Gemini (utils/gemini.js) authenticates via Vertex AI + ADC (the runtime service account) — no
// bound secret. We deliberately do NOT defineSecret('GEMINI_API_KEY') here: a defineSecret makes
// `firebase deploy` demand the secret exist in Secret Manager (interactive prompt), which we don't
// want for the keyless Vertex path. To use the Gemini Developer API instead, provide GEMINI_API_KEY
// via the function env (.env) — gemini.js reads process.env.GEMINI_API_KEY directly.

// Defined LATER, once the GitHub App exists and its key is set in Secret Manager:
//   firebase functions:secrets:set GITHUB_APP_PRIVATE_KEY
// then re-add the defineSecret here and list it in createTask's `secrets` array.
// (Kept out of the build until set, so deploys don't require an unset secret.)
