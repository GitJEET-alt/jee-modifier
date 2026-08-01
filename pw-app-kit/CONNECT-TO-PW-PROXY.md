# Connect your app to the PW shared proxy — drop-in onboarding

> **Developer:** put this `pw-app-kit` folder into your app, then tell your AI
> assistant (Anti-Gravity):
>
> **“Onboard this app to the PW proxy following CONNECT-TO-PW-PROXY.md. My APP_NAME is '<your exact app name>'.”**
>
> Then do the 2 human steps below. The AI does everything else.

---

## Fixed facts (already set up — never change these)

| Thing | Value |
|---|---|
| Proxy base URL | `https://pw-apps-proxy.vercel.app` |
| Control sheet (ONE shared sheet for ALL apps) | `https://docs.google.com/spreadsheets/d/1aaF3y0VsgyB_YcyfDK33VWcCagzwxBPOwjoe2TvfbHE` |
| Allowed sign-in domain | `pw.live` |
| Providers already on the proxy (no keys in your app) | Gemini text → `gemini_generate` · Claude → `claude_generate` · Gemini TTS → `gemini_tts` · Gemini images → `gemini_image` · Mathpix → `mathpix_ocr` · Sarvam TTS → `sarvam_tts` · ElevenLabs TTS → `elevenlabs_tts` |

**Your app ships ZERO API keys.** The proxy holds them all.

---

## Client by app shape (local, hosted backend, or pure frontend)

Works for ANY host — local desktop, your own Vercel/Render, a static site. Pick
the client that fits; the steps are otherwise identical.

| App shape | Who calls the proxy | Client to copy in |
|---|---|---|
| Local desktop, OR hosted app **with a backend** (FastAPI, Node, Vercel functions) | the backend | `pw_access.py` (Python) or `pw_access.js` (Node) |
| **Pure frontend / SPA**, no backend (static React/Vue on Vercel, etc.) | the browser, directly | `pw_access.js` (browser) |

- The proxy has **open CORS + Bearer-token auth**, so a browser on any domain can
  call it directly. The browser only ever holds the **user's own** Google token —
  never a provider key — so this is safe even in a public frontend bundle.
- The proxy accepts a Google token from **any** Google sign-in, so a hosted app
  may use its **own** Google client ID. `@pw.live` is still required.
- **Gemini goes through the proxy for every app shape** (backend and browser
  alike, via the company's platform gateway behind it). Keep sending the same
  generateContent-style `request` — the proxy translates both directions, so
  responses stay Gemini-shaped. Existing model ids (`gemini-2.5-flash`,
  `gemini-2.5-pro`) keep working; newer ones (e.g. `gemini-3.5-flash`) can be
  passed the same way. **Large requests (long PDFs, many images) are automatic**:
  above ~3.5 MB the kit silently detours the payload through the proxy's temp
  storage — up to **~60 MB per call**, same result, nothing for the app to do.

---

## Human steps — just 2, one-time

1. **Register your app on the sheet.** Open the control sheet → `Whitelisted` tab
   → put your **exact APP_NAME** in the next empty cell of **row 1**, and list the
   allowed users' emails down that column.
2. **Hand it to your AI assistant** with the sentence at the top of this file.

That's all a human does. Everything below is for the AI.

---

## AI assistant — execute in order, do not skip a step

1. **Add the client.** Copy the right client (see "Client by app shape") into
   the app — `pw_access.py` (Python backend) or `pw_access.js` (Node backend or
   browser). Set `APP_NAME = "<exact name>"`; leave `PROXY_BASE_URL` at default.
2. **Verify registration.** `GET https://pw-apps-proxy.vercel.app/api/apps` and
   confirm `<APP_NAME>` is in the returned list. If it is **not** → STOP and tell
   the human to finish Human Step 1 (exact spelling matters).
3. **Locate the Google token.** Find where the app obtains the signed-in
   user's Google token (access token or id token). For a backend, that's its
   OAuth flow; for a **pure frontend**, use Google Identity Services ("Sign in
   with Google") in the browser. If the app has no Google sign-in, add one (or
   ask the human) — a verified `@pw.live` token is required.

   **Sessions are automatic.** The kit exchanges that Google token for a
   proxy-issued **7-day session pass** on first use and rides on the pass from
   then on — so Google's ~1-hour token expiry cannot interrupt a run, and
   users re-login only after 7 days. Nothing to wire in the app. Optional
   hardening for processes that stay open for days: pass a zero-arg **token
   provider** function instead of the token string (the kit consults it
   whenever a new pass must be minted) — reference implementations are in the
   headers of `pw_access.py` / `pw_access.js`.
4. **Add the access gate.** Before *every* paid/main action:
   ```python
   import pw_access
   if not pw_access.check_allowed(google_token):
       raise PermissionError("Not authorized for this app.")
   ```
   Deny on `False`. (You may keep any existing whitelist ONLY as a fallback for
   when the proxy is unreachable.)
5. **Route AI calls through the proxy.** Replace every direct provider call:
   - Gemini `generateContent` → `pw_access.gemini_generate(token, model=..., request=<same body>, filename=, input_unit=, count=, video_duration=)`
   - Claude (Anthropic Messages) → `pw_access.claude_generate(token, model="claude-sonnet-4-5", request={"messages": [...]}, filename=, input_unit=, count=)`
     (model chosen per call; reply text in `result["content"][0]["text"]`)
   - Gemini TTS → `pw_access.gemini_tts(token, text=..., voice="Kore")` (WAV in `result["audio_base64"]`)
   - Gemini image generation → `pw_access.gemini_image(token, prompt=...)` (PNG in `result["image_base64"]`)
   - Mathpix `/v3/text` → `pw_access.mathpix_ocr(token, request=<same body>, filename=, count=, video_duration=)`
   - Sarvam `/text-to-speech` → `pw_access.sarvam_tts(token, request=<same body>, filename=, count=, video_duration=)`
   - ElevenLabs `/v1/text-to-speech/{voice_id}` → `pw_access.elevenlabs_tts(token, voice_id=..., request=<same body>, filename=, count=, video_duration=)`
     (returns base64 audio in `result["audio_base64"]`, `audio/mpeg`)

   (JS client `pw_access.js`: `geminiGenerate` / `claudeGenerate` / `geminiTts` /
   `geminiImage` / `mathpixOcr` / `sarvamTts` /
   `elevenLabsTts`, same fields, e.g. `await geminiGenerate(token, { model, request, ... })`.)

   `video_duration` is optional and only for video apps. Pass it as `mm:ss`
   (example: `03:42`) to fill column L (`Video Duration`) in `Usage Cost`.
   Non-video apps should omit it.

   **Per-task logging (do this if a task makes MORE THAN ONE AI call):** create
   one `UsageSession` per task, pass `session=` to each call, and `flush()` at
   the end. This writes **one Usage Cost row per provider** (one Gemini row, one
   Sarvam row…) instead of one row per call.
   ```python
   s = pw_access.UsageSession(token, filename=fn, input_unit="No. of pages", count=n,
                              video_duration="03:42")  # optional, video apps only
   pw_access.gemini_generate(token, model=..., request=..., session=s)
   pw_access.gemini_generate(token, model=..., request=..., session=s)  # more calls
   s.flush()   # -> ONE combined gemini row
   ```
   ```js
   const s = new UsageSession(token, { filename, input_unit, count,
                                       video_duration: "03:42" }); // optional
   await geminiGenerate(token, { model, request, session: s });
   await s.flush();
   ```
   A task that makes only ONE call can skip the session (each call logs itself).

   Read `resp["result"]` for the raw provider response — existing parsing stays
   unchanged. If the app uses a provider **not** listed above → STOP and tell the
   human to ask the proxy owner to add it (a one-time proxy change).
6. **Remove keys.** Delete every provider API key (`GEMINI_API_KEY`,
   `MATHPIX_*`, `SARVAM_*`, etc.) from `.env`, code, and the build.
7. **Test** with a whitelisted `@pw.live` user's token:
   (a) `check_allowed` returns `True`, (b) one AI call returns a result,
   (c) a new row appears in the `Usage Cost` tab.
8. **Report** the completion checklist below.

---

## Login & session standards (apply to the app's own sign-in)

The proxy handles access + logging, but each app owns its Google sign-in. Apply
these so login behaves the same across every PW app:

- **Domain:** only `@pw.live` accounts (the proxy enforces this too).
- **Session length: 7 days.** If the app mints its own session token/JWT, set
  its expiry to 7 days (e.g. `timedelta(days=7)`).
- **7-day sign-in is handled by the kit.** Google's own token dies after
  ~1 hour, but the kit automatically exchanges it for a proxy-issued 7-day
  session pass — no refresh logic in the app, no mid-run drop-outs. The only
  interruption a user should ever see is a fresh Google login after 7 days.
  (Requires the current `pw_access` file — older copies without the session
  exchange still hit the 1-hour wall.)
- **Fail closed:** if the allowlist check errors or the network is down → DENY.
- **Check before every run:** call `check_allowed()` before each paid/main
  action, not just at login (a user can be removed from the sheet mid-session).
- **Don't auto-open the browser:** start Google sign-in only on a user click,
  never on app startup.
- **Store only session/user tokens** locally (browser storage, or OS keychain
  for desktop apps). NEVER store a provider API key anywhere in the app.

---

## Completion checklist — nothing missed

- [ ] `pw_access.py` added, `APP_NAME` set to the exact sheet header
- [ ] `/api/apps` lists this `APP_NAME`
- [ ] `check_allowed()` gates every run and denies on failure
- [ ] all provider calls go through `pw_access` (no direct provider calls remain)
- [ ] no API keys left in `.env`, code, or build
- [ ] session = 7 days; sign-in is `@pw.live`-only and not auto-opened on startup
- [ ] the **current `pw_access` file** is in the app (it auto-exchanges the
      Google token for a 7-day session pass) — runs longer than 1 hour survive
- [ ] a real run logged a row to the `Usage Cost` tab
