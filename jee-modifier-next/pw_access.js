/**
 * pw_access.js - shared PW app-access client for JavaScript apps.
 *
 * Talks only to the shared proxy and holds no provider keys. Every call takes
 * the signed-in user's Google token; the proxy verifies it, checks the app
 * whitelist, calls the paid API with its own key, logs usage, and returns the
 * provider result.
 */

export const APP_NAME = "Question Modifier";
export const PROXY_BASE_URL = "https://pw-apps-proxy.vercel.app";

const TIMEOUT_MS = 30_000;
const AI_TIMEOUT_MS = 300_000;

export class PWAccessError extends Error {}

function authHeaders(googleToken) {
  return { Authorization: `Bearer ${googleToken}`, "Content-Type": "application/json" };
}

async function postJSON(path, googleToken, body, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(`${PROXY_BASE_URL}${path}`, {
      method: "POST",
      headers: authHeaders(googleToken),
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

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

export async function checkAllowed(googleToken, app = APP_NAME) {
  return (await checkAllowedStatus(googleToken, app)) === "allowed";
}

export async function logUsage(googleToken, { filename, input_unit, count, items, app = APP_NAME }) {
  try {
    const r = await postJSON(
      "/api/usage-log",
      googleToken,
      { app, filename, input_unit, count, items },
      TIMEOUT_MS,
    );
    return r.status === 200 ? await r.json() : null;
  } catch {
    return null;
  }
}

export class UsageSession {
  constructor(googleToken, { filename = "", input_unit = "", count = null, app = APP_NAME } = {}) {
    this.token = googleToken;
    this.filename = filename;
    this.input_unit = input_unit;
    this.count = count;
    this.app = app;
    this._byModel = new Map();
  }

  add(model, tokensIn = 0, tokensOut = 0, costInr = 0) {
    const key = model || "";
    const current = this._byModel.get(key) || { tokens_in: 0, tokens_out: 0, cost_inr: 0 };
    current.tokens_in += Number(tokensIn || 0);
    current.tokens_out += Number(tokensOut || 0);
    current.cost_inr += Number(costInr || 0);
    this._byModel.set(key, current);
  }

  async flush() {
    const items = [...this._byModel.entries()].map(([model, usage]) => ({
      model,
      tokens_in: usage.tokens_in,
      tokens_out: usage.tokens_out,
      cost_inr: Math.round(usage.cost_inr * 1e4) / 1e4,
    }));
    this._byModel.clear();
    if (!items.length) return null;
    return logUsage(this.token, {
      filename: this.filename,
      input_unit: this.input_unit,
      count: this.count,
      items,
      app: this.app,
    });
  }
}

export async function geminiGenerate(
  googleToken,
  { model, request, filename = "", input_unit = "", count = null, app = APP_NAME, session = null },
) {
  const body = { app, model, request, filename, input_unit, count };
  if (session) body.log = false;
  const r = await postJSON("/api/gemini/generate", googleToken, body, AI_TIMEOUT_MS);
  if (r.status !== 200) {
    throw new PWAccessError(`gemini proxy ${r.status}: ${(await r.text()).slice(0, 300)}`);
  }
  const data = await r.json();
  if (session) {
    session.add(data.model || model, data.usage?.tokens_in, data.usage?.tokens_out, data.cost_inr);
  }
  return data;
}

export async function mathpixOcr(
  googleToken,
  { request, filename = "", count = 1, app = APP_NAME, session = null },
) {
  const body = { app, request, filename, count };
  if (session) body.log = false;
  const r = await postJSON("/api/mathpix/ocr", googleToken, body, AI_TIMEOUT_MS);
  if (r.status !== 200) {
    throw new PWAccessError(`mathpix proxy ${r.status}: ${(await r.text()).slice(0, 300)}`);
  }
  const data = await r.json();
  if (session) {
    session.add(data.model || "Mathpix OCR", data.usage?.tokens_in, data.usage?.tokens_out, data.cost_inr);
  }
  return data;
}

export async function sarvamTts(
  googleToken,
  { request, filename = "", count = null, app = APP_NAME, session = null },
) {
  const body = { app, request, filename, count };
  if (session) body.log = false;
  const r = await postJSON("/api/sarvam/tts", googleToken, body, AI_TIMEOUT_MS);
  if (r.status !== 200) {
    throw new PWAccessError(`sarvam proxy ${r.status}: ${(await r.text()).slice(0, 300)}`);
  }
  const data = await r.json();
  if (session) {
    session.add(data.model || "Sarvam TTS", data.usage?.tokens_in, data.usage?.tokens_out, data.cost_inr);
  }
  return data;
}
