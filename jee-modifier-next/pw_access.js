/**
 * pw_access.js — shared PW app-access client for JavaScript apps.
 *
 * The JS twin of pw_access.py. Use it in:
 *   - browser SPAs / static sites (React, Vue, plain JS), and
 *   - Node / Vercel / edge backends.
 *
 * Talks ONLY to the shared proxy and holds NO keys — so it's safe even in a
 * public frontend bundle. Every call takes the signed-in user's Google token
 * (access token OR id token); the proxy verifies it, checks the app-wise
 * whitelist, calls the paid API with its own key, logs usage, returns result.
 *
 * SESSIONS — sign in once, stay signed in for 7 days. Google's own tokens die
 * after ~1 hour, so the kit automatically exchanges the Google token from
 * login for a proxy-issued 7-DAY SESSION PASS (POST /api/session) and sends
 * the pass on every call. Runs can no longer drop mid-way from token expiry;
 * the only interruption a user ever sees is a fresh Google login after 7
 * days. The exchange, caching, and 401 retry all happen inside this file —
 * apps just keep passing their Google token like before.
 *
 * Everywhere a `googleToken` is accepted you may pass either the token STRING
 * from login, or a zero-arg (async) "token provider" FUNCTION returning a
 * fresh token — the most robust choice for processes that stay open for days
 * (the kit consults it whenever a new pass must be minted). See USAGE
 * EXAMPLES at the bottom.
 *
 * Works anywhere `fetch` exists: modern browsers, Node 18+, edge runtimes.
 * This file is ESM. For CommonJS, swap `export` for `module.exports = { ... }`.
 */

// --- PER-APP CONFIG — the only thing each app changes ---------------------
// APP_NAME must EXACTLY match a header in row 1 of the `Whitelisted` tab.
// The placeholder is intentionally NOT a registered app — a copy where it was
// forgotten fails loudly instead of silently billing some other app.
export const APP_NAME = "Question Modifier";
export const PROXY_BASE_URL = "https://pw-apps-proxy.vercel.app";

const TIMEOUT_MS = 30_000;      // allowlist / logging
const AI_TIMEOUT_MS = 300_000;  // AI provider calls — can be slow

export class PWAccessError extends Error {}

function authHeaders(token) {
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

/** `googleToken` may be a plain string OR a zero-arg (async) function — a
 *  "token provider" — that returns a currently-valid Google token. It is only
 *  needed when a new 7-day session pass must be minted (first call, and again
 *  when the pass expires or is rejected). */
async function resolveToken(googleToken) {
  return typeof googleToken === "function" ? await googleToken() : googleToken;
}

// The proxy-issued 7-day session pass, cached per page/process. All calls
// ride on the pass, so Google's ~1-hour token expiry cannot interrupt a run.
const _session = { token: "", expiry: 0 };

/** Return the credential to send: the cached 7-day pass when still valid,
 *  else exchange the app's Google token for a fresh pass via POST
 *  /api/session. If the proxy doesn't offer sessions (older deploy) or the
 *  exchange fails, gracefully fall back to sending the Google token — every
 *  endpoint accepts both. */
async function authToken(googleToken, forceNew = false) {
  if (!forceNew && _session.token && Date.now() < _session.expiry - 60_000) {
    return _session.token;
  }
  const g = await resolveToken(googleToken);
  try {
    const r = await postOnce("/api/session", g, {}, TIMEOUT_MS);
    if (r.status === 200) {
      const d = await r.json();
      if (d.session_token) {
        _session.token = d.session_token;
        _session.expiry = Number(d.expires_at_ms) || 0;
        return _session.token;
      }
    }
  } catch { /* network blip — fall back to the Google token for this call */ }
  return g;
}

async function postOnce(path, token, body, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(`${PROXY_BASE_URL}${path}`, {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/** POST to the proxy using the 7-day session pass (minted automatically from
 *  the app's Google token). On a 401 — pass expired/rejected — mint a fresh
 *  pass once and retry. If the Google token has also expired and only a string
 *  (not a provider) was given, that retry can still fail; the user then
 *  re-signs-in, which matches the 7-day re-login policy. */
async function postJSON(path, googleToken, body, timeoutMs) {
  let r = await postOnce(path, await authToken(googleToken), body, timeoutMs);
  if (r.status === 401) {
    r = await postOnce(path, await authToken(googleToken, true), body, timeoutMs);
  }
  return r;
}

/** "allowed" | "denied" | "error" — lets callers treat "proxy unreachable"
 *  (error) differently from a real "no" (denied). */
export async function checkAllowedStatus(googleToken, app = APP_NAME) {
  if (!googleToken) return "denied";
  try {
    const r = await postJSON("/api/allowlist", googleToken, { app }, TIMEOUT_MS);
    if (r.status === 200) return (await r.json()).allowed ? "allowed" : "denied";
    if (r.status === 403) return "denied";
    return "error";
  } catch {
    return "error";
  }
}

/** Call before EVERY paid/main run. Fail closed (false on any error). */
export async function checkAllowed(googleToken, app = APP_NAME) {
  return (await checkAllowedStatus(googleToken, app)) === "allowed";
}

/** Append one Usage Cost row per item. Never throws — returns null on failure. */
export async function logUsage(
  googleToken,
  { filename, input_unit, count, items, video_duration = "", app = APP_NAME }
) {
  try {
    const r = await postJSON("/api/usage-log", googleToken,
      { app, filename, input_unit, count, items, video_duration }, TIMEOUT_MS);
    return r.status === 200 ? await r.json() : null;
  } catch {
    return null;
  }
}

/** Accumulates a task's provider usage and writes ONE row per provider on
 *  flush() — so many calls to the same provider collapse into a single Usage
 *  Cost row (one Gemini row, one Mathpix row, one Sarvam row). */
export class UsageSession {
  constructor(
    googleToken,
    { filename = "", input_unit = "", count = null, video_duration = "", app = APP_NAME } = {}
  ) {
    this.token = googleToken;
    this.filename = filename;
    this.input_unit = input_unit;
    this.count = count;
    this.video_duration = video_duration;
    this.app = app;
    this._byModel = new Map();
  }
  add(model, tokensIn = 0, tokensOut = 0, costInr = null) {
    const k = model || "";
    const a = this._byModel.get(k)
      || { tokens_in: 0, tokens_out: 0, cost_inr: 0, cost_known: false, requests: 0 };
    a.tokens_in += Number(tokensIn || 0);
    a.tokens_out += Number(tokensOut || 0);
    a.requests += 1;
    if (costInr != null) { a.cost_inr += Number(costInr || 0); a.cost_known = true; }
    this._byModel.set(k, a);
  }
  async flush() {
    const items = [...this._byModel.entries()].map(([model, v]) => {
      const item = { model, tokens_in: v.tokens_in, tokens_out: v.tokens_out, requests: v.requests };
      if (v.cost_known) item.cost_inr = Math.round(v.cost_inr * 1e4) / 1e4;
      return item;
    });
    this._byModel.clear();
    if (!items.length) return null;
    return logUsage(this.token,
      {
        filename: this.filename, input_unit: this.input_unit, count: this.count,
        items, video_duration: this.video_duration, app: this.app,
      });
  }
}

/** Gemini THROUGH the proxy (platform LiteLLM gateway behind it) — same path
 *  for browser and Node. Send the same generateContent-shaped `request` as
 *  always; the proxy translates to/from the gateway, so `result` keeps the
 *  Gemini response shape and existing parsing is unchanged.
 *  Model names: existing ids (gemini-2.5-flash / gemini-2.5-pro) keep working;
 *  newer gateway models (e.g. gemini-3.5-flash) can be passed the same way.
 *  Capacity chokes (429/503) are retried by the proxy automatically.
 *  LARGE REQUESTS (long PDFs, many images) are handled automatically: when
 *  the payload exceeds ~3.5 MB the kit uploads it to the proxy's temp storage
 *  via a short-lived signed link and sends only a reference — supported up to
 *  ~60 MB per call, same result and context quality. */
export async function geminiGenerate(googleToken,
  {
    model, request, filename = "", input_unit = "", count = null,
    video_duration = "", app = APP_NAME, session = null,
  }) {
  const body = { app, model, request, filename, input_unit, count, video_duration };
  if (session) body.log = false;
  const requestJson = JSON.stringify(request);
  if (requestJson.length > 3_500_000) {
    // Blob detour: the proxy's front door caps bodies at ~4.5 MB, so big
    // requests travel via temp storage instead (see /api/gemini/upload-url).
    const up = await postJSON("/api/gemini/upload-url", googleToken, { app }, TIMEOUT_MS);
    if (up.status !== 200) throw new PWAccessError(`gemini upload-url ${up.status}: ${(await up.text()).slice(0, 300)}`);
    const { upload_url } = await up.json();
    const pr = await fetch(upload_url, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: requestJson,
    });
    if (pr.status !== 200) throw new PWAccessError(`gemini upload ${pr.status}: ${(await pr.text()).slice(0, 300)}`);
    delete body.request;
    body.request_blob_url = (await pr.json()).url || "";
  }
  const r = await postJSON("/api/gemini/generate", googleToken, body, AI_TIMEOUT_MS);
  if (r.status !== 200) throw new PWAccessError(`gemini proxy ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const data = await r.json();
  if (session) session.add(data.model || model, data.usage?.tokens_in, data.usage?.tokens_out, data.cost_inr);
  return data;
}

/** Mathpix OCR through the proxy. Returns { ok, result, cost_inr }. */
export async function mathpixOcr(
  googleToken,
  { request, filename = "", count = 1, video_duration = "", app = APP_NAME, session = null }
) {
  const body = { app, request, filename, count, video_duration };
  if (session) body.log = false;
  const r = await postJSON("/api/mathpix/ocr", googleToken, body, AI_TIMEOUT_MS);
  if (r.status !== 200) throw new PWAccessError(`mathpix proxy ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const data = await r.json();
  if (session) session.add(data.model || "Mathpix OCR", data.usage?.tokens_in, data.usage?.tokens_out, data.cost_inr);
  return data;
}

/** Sarvam Text-to-Speech through the proxy. Returns { ok, result, cost_inr };
 *  `result` includes the base64 audio (result.audios). */
export async function sarvamTts(
  googleToken,
  { request, filename = "", count = null, video_duration = "", app = APP_NAME, session = null }
) {
  const body = { app, request, filename, count, video_duration };
  if (session) body.log = false;
  const r = await postJSON("/api/sarvam/tts", googleToken, body, AI_TIMEOUT_MS);
  if (r.status !== 200) throw new PWAccessError(`sarvam proxy ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const data = await r.json();
  if (session) session.add(data.model || "Sarvam TTS", data.usage?.tokens_in, data.usage?.tokens_out, data.cost_inr);
  return data;
}

/** ElevenLabs Text-to-Speech through the proxy. Returns { ok, result, cost_inr };
 *  `result` is { audio_base64, content_type: "audio/mpeg", output_format }.
 *  `request` is the raw ElevenLabs TTS body: { text, model_id, voice_settings }.
 *  `count` = characters billed; if omitted the proxy derives it from request.text. */
export async function elevenLabsTts(googleToken,
  {
    voice_id, request, output_format = "mp3_44100_128", filename = "",
    count = null, video_duration = "", app = APP_NAME, session = null,
  }) {
  const body = { app, voice_id, request, output_format, filename, count, video_duration };
  if (session) body.log = false;
  const r = await postJSON("/api/elevenlabs/tts", googleToken, body, AI_TIMEOUT_MS);
  if (r.status !== 200) throw new PWAccessError(`elevenlabs proxy ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const data = await r.json();
  if (session) session.add(data.model || "ElevenLabs TTS", data.usage?.tokens_in, data.usage?.tokens_out, data.cost_inr);
  return data;
}

/** Claude THROUGH the proxy (company Azure Anthropic endpoint behind it).
 *  `request` is a raw Anthropic Messages body: { messages: [...], system,
 *  max_tokens } (max_tokens defaults to 4096 if omitted). `model` is chosen
 *  per call at app level, e.g. "claude-sonnet-4-5". Read the reply text from
 *  result.content[0].text. Large requests (> ~3.5 MB) detour via temp storage
 *  automatically. Capacity chokes are retried by the proxy. */
export async function claudeGenerate(googleToken,
  {
    model, request, filename = "", input_unit = "", count = null,
    video_duration = "", app = APP_NAME, session = null,
  }) {
  const body = { app, model, request, filename, input_unit, count, video_duration };
  if (session) body.log = false;
  const requestJson = JSON.stringify(request);
  if (requestJson.length > 3_500_000) {
    const up = await postJSON("/api/gemini/upload-url", googleToken, { app }, TIMEOUT_MS);
    if (up.status !== 200) throw new PWAccessError(`claude upload-url ${up.status}: ${(await up.text()).slice(0, 300)}`);
    const { upload_url } = await up.json();
    const pr = await fetch(upload_url, {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: requestJson,
    });
    if (pr.status !== 200) throw new PWAccessError(`claude upload ${pr.status}: ${(await pr.text()).slice(0, 300)}`);
    delete body.request;
    body.request_blob_url = (await pr.json()).url || "";
  }
  const r = await postJSON("/api/claude/generate", googleToken, body, AI_TIMEOUT_MS);
  if (r.status !== 200) throw new PWAccessError(`claude proxy ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const data = await r.json();
  if (session) session.add(data.model || model, data.usage?.tokens_in, data.usage?.tokens_out, data.cost_inr);
  return data;
}

/** Gemini text-to-speech through the proxy. Returns { ok, result, cost_inr };
 *  `result` is { audio_base64, content_type: "audio/wav" } (24 kHz mono WAV).
 *  Voices: Kore, Charon, Fenrir, Callirrhoe (and other Gemini TTS voices). */
export async function geminiTts(googleToken,
  {
    text, voice = "Kore", model = "gemini-3.1-flash-tts-preview", filename = "",
    count = null, video_duration = "", app = APP_NAME, session = null,
  }) {
  const body = { app, model, text, voice, filename, count, video_duration };
  if (session) body.log = false;
  const r = await postJSON("/api/gemini/tts", googleToken, body, AI_TIMEOUT_MS);
  if (r.status !== 200) throw new PWAccessError(`gemini tts proxy ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const data = await r.json();
  if (session) session.add(data.model || "Gemini TTS", data.usage?.tokens_in, data.usage?.tokens_out, data.cost_inr);
  return data;
}

/** Gemini image generation through the proxy. Returns { ok, result, cost_inr };
 *  `result` is { image_base64, content_type: "image/png", text }. Models:
 *  gemini-3.1-flash-image (fast) or gemini-3-pro-image (high fidelity). */
export async function geminiImage(googleToken,
  {
    prompt, model = "gemini-3.1-flash-image", filename = "",
    count = 1, video_duration = "", app = APP_NAME, session = null,
  }) {
  const body = { app, model, prompt, filename, count, video_duration };
  if (session) body.log = false;
  const r = await postJSON("/api/gemini/image", googleToken, body, AI_TIMEOUT_MS);
  if (r.status !== 200) throw new PWAccessError(`gemini image proxy ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const data = await r.json();
  if (session) session.add(data.model || "Gemini Image", data.usage?.tokens_in, data.usage?.tokens_out, data.cost_inr);
  return data;
}

/*
USAGE EXAMPLES

--- Browser SPA (Sign in with Google → call the proxy directly) ---
  // 1) Get a Google token in the browser via Google Identity Services (GIS).
  //    For identity/allowlist, an id_token from the credential flow is enough:
  //      google.accounts.id.initialize({ client_id: YOUR_GOOGLE_CLIENT_ID, callback: onCredential });
  //    onCredential(resp) => const googleToken = resp.credential;   // a Google id_token
  // 2) Gate + call:
  import { checkAllowed, geminiGenerate } from "./pw_access.js";
  if (!(await checkAllowed(googleToken))) throw new Error("Not authorized");
  const out = await geminiGenerate(googleToken, {
    model: "gemini-2.5-flash",
    request: { contents: [{ role: "user", parts: [{ text: "Hello" }] }] },
    filename: "demo", input_unit: "No. of questions", count: 1,
  });
  console.log(out.result);   // raw Gemini response

--- LONG RUNS (>1 hour): pass a token PROVIDER, not a string -------------
  // Google tokens die after ~1 hour. A cached string WILL start failing with
  // 401 mid-run. Instead pass a function that returns a fresh token; the kit
  // calls it before each request and retries once on 401.
  //
  // Browser (GIS access-token flow — silent refresh, no popup while the
  // user's Google session is alive):
  const tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: YOUR_GOOGLE_CLIENT_ID, scope: "openid email", callback: () => {},
  });
  let cached = { token: "", expiry: 0 };
  async function googleToken() {                    // <-- the provider
    if (cached.token && Date.now() < cached.expiry - 5 * 60_000) return cached.token;
    return new Promise((resolve, reject) => {
      tokenClient.callback = (resp) => {
        if (resp.error) return reject(new Error(resp.error));
        cached = { token: resp.access_token, expiry: Date.now() + (resp.expires_in || 3600) * 1000 };
        resolve(cached.token);
      };
      tokenClient.requestAccessToken({ prompt: "" }); // silent
    });
  }
  await geminiGenerate(googleToken, { ... });        // note: the function itself, no ()

--- Node / Vercel backend (token forwarded from your frontend) ---
  import { checkAllowed, sarvamTts, elevenLabsTts } from "./pw_access.js";
  // googleToken = the user's token your backend received after sign-in
  // (for long backend jobs, forward a provider that re-fetches from your
  //  OAuth refresh flow instead of a captured string)
  if (!(await checkAllowed(googleToken))) return res.status(403).end();
  const tts = await sarvamTts(googleToken, {
    request: { text: "नमस्ते", target_language_code: "hi-IN", model: "bulbul:v3", speaker: "anushka" },
    count: 6,
  });

--- ElevenLabs TTS (browser or Node) ---
  const out = await elevenLabsTts(googleToken, {
    voice_id: "JBFqnCBsd6RMkjVDRZzb",
    request: { text: "Hello there", model_id: "eleven_multilingual_v2" },
    filename: "intro.mp3",
  });
  // out.result.audio_base64 → decode to bytes and save/play (audio/mpeg)
*/
