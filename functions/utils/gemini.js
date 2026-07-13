import { GoogleGenAI } from '@google/genai';

// Shared, reusable Gemini client for Bosun. ONE place to configure auth + defaults so every feature
// calls Gemini the same way — today the sourced-listing relevance gate (utils/classifyListing.js),
// and whatever we add next. Keep new Gemini use going through generateJson()/geminiClient() rather
// than newing up GoogleGenAI ad hoc.
//
// Auth auto-detects (no code change to switch):
//   - GEMINI_API_KEY set   → Gemini Developer API (simplest; matches our other Secret Manager keys).
//   - else VERTEX_PROJECT  → Vertex AI via ADC (no key; unified GCP billing, region VERTEX_LOCATION).

export const GEMINI_FLASH_LITE = 'gemini-2.5-flash-lite'; // cheap workhorse — classify/extract
export const GEMINI_FLASH = 'gemini-2.5-flash';           // step up when a task needs more nuance

let _client = null;

// Resolve the Vertex project from explicit config or the ambient GCP project (set automatically in
// deployed Cloud Functions), so Vertex works keyless without any per-deploy wiring.
function vertexProject() {
  return process.env.VERTEX_PROJECT || process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || '';
}

/** Memoised GoogleGenAI client, or null if Gemini isn't configured. */
export function geminiClient() {
  if (_client) return _client;
  if (process.env.GEMINI_API_KEY) {
    // Developer API — explicit key wins if set.
    _client = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
    return _client;
  }
  const project = vertexProject();
  if (project) {
    // Vertex AI via ADC — the function authenticates as its own service account (no key).
    _client = new GoogleGenAI({ vertexai: true, project, location: process.env.VERTEX_LOCATION || 'global' });
    return _client;
  }
  return null;
}

/** True when a Gemini auth path is available. Callers use this to decide whether to degrade. */
export function geminiConfigured() {
  return !!(process.env.GEMINI_API_KEY || vertexProject());
}

/**
 * One-shot structured generation. Enforces JSON via responseSchema and returns the PARSED object, or
 * null on any failure (unconfigured, network, non-JSON) so callers own the degrade path. Deterministic
 * by default (temperature 0).
 */
export async function generateJson({ model = GEMINI_FLASH_LITE, prompt, system, schema, temperature = 0, maxOutputTokens = 512 }) {
  const ai = geminiClient();
  if (!ai || !prompt) return null;
  // One retry on transient failures (429 rate limit / 5xx) — burst runs hammer the classifier and a
  // single blip shouldn't degrade a lead to fail-open. Hard auth errors (403 etc.) don't retry.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const resp = await ai.models.generateContent({
        model,
        contents: prompt,
        config: {
          ...(system ? { systemInstruction: system } : {}),
          responseMimeType: 'application/json',
          ...(schema ? { responseSchema: schema } : {}),
          temperature,
          maxOutputTokens,
        },
      });
      const text = resp.text;
      return text ? JSON.parse(text) : null;
    } catch (e) {
      const msg = String(e?.message || e);
      const transient = /\b(429|500|503|UNAVAILABLE|RESOURCE_EXHAUSTED|fetch failed|ETIMEDOUT)\b/i.test(msg);
      console.error('gemini:generateJson:err', msg.slice(0, 300), transient && attempt === 0 ? '(retrying)' : '');
      if (!transient || attempt === 1) return null;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  return null;
}
