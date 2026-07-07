/**
 * Self-check that this JS / Node app is wired to the PW proxy.
 *
 * Run with Node 18+:
 *   node verify_onboarding.mjs [path/to/.env] [optional_google_token]
 */
import { readFileSync, existsSync } from "node:fs";
import { APP_NAME, PROXY_BASE_URL, checkAllowedStatus } from "./pw_access.js";

const envPath = process.argv[2] || ".env";
const token = process.argv[3] || "";
let ok = true;

async function fetchWithTimeout(url, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { signal: ctrl.signal, headers: { connection: "close" } });
  } finally {
    clearTimeout(timer);
  }
}

console.log(`APP_NAME = ${JSON.stringify(APP_NAME)}`);
console.log(`PROXY    = ${PROXY_BASE_URL}`);

try {
  const r = await fetchWithTimeout(`${PROXY_BASE_URL}/api/apps`, 20000);
  const apps = r.ok ? (await r.json()).apps || [] : [];
  if (apps.includes(APP_NAME)) {
    console.log(`PASS: '${APP_NAME}' is registered on the proxy`);
  } else {
    console.log(`FAIL: '${APP_NAME}' not in /api/apps ${JSON.stringify(apps)} - add its column to the Whitelisted tab.`);
    ok = false;
  }
} catch (e) {
  console.log("WARN: could not reach /api/apps:", e.message);
  ok = false;
}

const leaked = [];
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || !trimmed.includes("=")) continue;
    const eq = trimmed.indexOf("=");
    const name = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (value && /GEMINI|MATHPIX|SARVAM|OPENAI/i.test(name)) leaked.push(name);
  }
}

if (leaked.length) {
  console.log(`FAIL: provider keys still present in ${envPath}: ${leaked.join(", ")}`);
  ok = false;
} else {
  console.log(`PASS: no provider keys in ${envPath}`);
}

if (token) {
  const status = await checkAllowedStatus(token);
  console.log(`allowlist check for supplied token: ${status}`);
  if (status === "error") console.log("  (token invalid/expired, or proxy unreachable)");
  ok = ok && (status === "allowed" || status === "denied");
}

console.log("\nRESULT:", ok ? "ALL GOOD" : "ISSUES FOUND");
process.exitCode = ok ? 0 : 1;
