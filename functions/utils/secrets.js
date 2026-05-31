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

// Defined LATER, once the GitHub App exists and its key is set in Secret Manager:
//   firebase functions:secrets:set GITHUB_APP_PRIVATE_KEY
// then re-add the defineSecret here and list it in createTask's `secrets` array.
// (Kept out of the build until set, so deploys don't require an unset secret.)
