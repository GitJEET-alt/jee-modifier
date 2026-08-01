"""
pw_access.py — shared PW app-access client (drop-in for any PW app backend).

Copy this ONE file into an app, set APP_NAME below, and you get:
  - live app-wise whitelist checks,
  - append-only usage logging,
  - AI provider calls — Gemini (text/TTS/image), Claude, Mathpix, Sarvam TTS,
    ElevenLabs TTS — with keys that live ONLY on the proxy.

This module talks ONLY to the shared proxy. It NEVER contains a service-account
key or any provider (Gemini / Mathpix / ...) key. That is what makes API-key
safety automatic: the app simply has no key to leak.

Every call takes the signed-in user's Google token (the access token or id
token your app already obtains at login). The proxy verifies it, checks the
whitelist for APP_NAME, calls the paid API with its own key, logs usage, and
returns only the result.

SESSIONS — sign in once, stay signed in for 7 days. Google's own tokens die
after ~1 hour, so the kit automatically exchanges the Google token from login
for a proxy-issued 7-DAY SESSION PASS (POST /api/session) and sends the pass
on every call. Runs can no longer drop mid-way from token expiry; the only
interruption a user ever sees is a fresh Google login after 7 days. The
exchange, caching, and 401 retry all happen inside this file — apps just keep
passing their Google token like before.

Everywhere a `google_token` is accepted you may pass either the token STRING
from login, or a zero-arg "token provider" FUNCTION returning a fresh token.
The provider remains the most robust choice for processes that stay open for
days (the kit consults it whenever a new pass must be minted):

    creds = ...  # your google.oauth2.credentials.Credentials from sign-in
    def google_token():
        if not creds.valid or (creds.expiry and
                (creds.expiry - datetime.utcnow()).total_seconds() < 300):
            creds.refresh(google.auth.transport.requests.Request())
        return creds.token

    pw_access.gemini_generate(google_token, model=..., request=...)  # note: no ()
"""
import os
from typing import Optional, List, Dict, Any

import requests

# --------------------------------------------------------------------------
# PER-APP CONFIG — the only thing each app changes.
# APP_NAME must EXACTLY match a header in row 1 of the `Whitelisted` tab.
# --------------------------------------------------------------------------
# The placeholder below is intentionally NOT a registered app — a copy where
# it was forgotten fails loudly ("not registered") instead of silently
# billing some other app.
APP_NAME = "SET-YOUR-APP-NAME"

# Point this at your proxy. Override per-environment with PW_PROXY_BASE_URL.
PROXY_BASE_URL = os.environ.get(
    "PW_PROXY_BASE_URL", "https://pw-apps-proxy.vercel.app"
).rstrip("/")

_TIMEOUT = 30       # allowlist / logging — fast
_AI_TIMEOUT = 300   # AI provider calls — can be slow


class PWAccessError(Exception):
    """Raised when a paid proxy call (any AI provider) fails."""


def _headers(token: str) -> Dict[str, str]:
    return {
        "Authorization": f"Bearer {token}",
        "Content-Type": "application/json",
    }


def _resolve_token(google_token) -> str:
    """`google_token` may be a plain string OR a zero-arg callable (a "token
    provider") that returns a currently-valid Google token. It is only needed
    when a new 7-day session pass must be minted (first call of the process,
    and again when the pass expires or is rejected)."""
    return google_token() if callable(google_token) else google_token


# The proxy-issued 7-day session pass, cached per process. All calls ride on
# the pass, so Google's ~1-hour token expiry cannot interrupt a run.
_session = {"token": "", "expiry": 0.0}


def _auth_token(google_token, force_new: bool = False) -> str:
    """Return the credential to send: the cached 7-day session pass when it's
    still valid, else exchange the app's Google token for a fresh pass via
    POST /api/session. If the proxy doesn't offer sessions (older deploy) or
    the exchange fails, gracefully fall back to sending the Google token —
    every endpoint accepts both."""
    import time
    if not force_new and _session["token"] and time.time() < _session["expiry"] - 60:
        return _session["token"]
    g = _resolve_token(google_token)
    try:
        r = requests.post(f"{PROXY_BASE_URL}/api/session",
                          headers=_headers(g), json={}, timeout=_TIMEOUT)
        if r.status_code == 200:
            d = r.json()
            tok = d.get("session_token") or ""
            if tok:
                _session["token"] = tok
                _session["expiry"] = float(d.get("expires_at_ms") or 0) / 1000.0
                return tok
    except Exception:
        pass  # network blip — fall back to the Google token for this call
    return g


def _post(path: str, google_token, payload: dict, timeout: int):
    """POST to the proxy using the 7-day session pass (minted automatically
    from the app's Google token). On a 401 — pass expired/rejected — mint a
    fresh pass once and retry. If the Google token itself has also expired and
    only a string (not a provider) was given, that retry can still fail; the
    user then re-signs-in, which matches the 7-day re-login policy."""
    r = requests.post(
        f"{PROXY_BASE_URL}{path}",
        headers=_headers(_auth_token(google_token)),
        json=payload,
        timeout=timeout,
    )
    if r.status_code == 401:
        r = requests.post(
            f"{PROXY_BASE_URL}{path}",
            headers=_headers(_auth_token(google_token, force_new=True)),
            json=payload,
            timeout=timeout,
        )
    return r


def check_allowed(google_token: str, app: str = APP_NAME) -> bool:
    """Live app-wise whitelist check. Call this before EVERY paid/main run.
    Returns True only if the proxy confirms the user is allowed for `app`.
    Any error or network failure returns False (fail closed / deny)."""
    return check_allowed_status(google_token, app) == "allowed"


def check_allowed_status(google_token: str, app: str = APP_NAME) -> str:
    """Like check_allowed, but distinguishes the three outcomes so callers can
    implement 'proxy is the gate, with a local fallback if it's unreachable':
        "allowed"  — proxy verified the user IS allowed for this app
        "denied"   — proxy reached, user is NOT allowed (a real 'no')
        "error"    — proxy unreachable / bad token / server error (couldn't decide)
    """
    if not google_token:
        return "denied"
    try:
        r = _post("/api/allowlist", google_token, {"app": app}, _TIMEOUT)
        if r.status_code == 200:
            return "allowed" if bool(r.json().get("allowed")) else "denied"
        if r.status_code == 403:
            return "denied"
        return "error"  # 401/5xx/etc — can't be sure
    except Exception:
        return "error"


def log_usage(
    google_token: str,
    *,
    filename: str,
    input_unit: str,
    count: Any,
    items: List[Dict[str, Any]],
    video_duration: str = "",
    app: str = APP_NAME,
) -> Optional[dict]:
    """Append one usage row PER item to the `Usage Cost` tab. Use this only
    for usage the proxy didn't already log itself (the gemini_generate /
    mathpix_ocr helpers below log automatically). Never raises — returns None
    on failure so logging can't break the app.

    items example:
      [{"model": "gemini-2.5-flash", "tokens_in": 14500,
        "tokens_out": 2300, "cost_inr": 12.45}]
    """
    try:
        r = _post("/api/usage-log", google_token, {
            "app": app,
            "filename": filename,
            "input_unit": input_unit,
            "count": count,
            "items": items,
            "video_duration": video_duration,
        }, _TIMEOUT)
        return r.json() if r.status_code == 200 else None
    except Exception:
        return None


def _accumulate(session, resp, default_model=""):
    usage = resp.get("usage") or {}
    session.add(resp.get("model") or default_model,
                usage.get("tokens_in", 0), usage.get("tokens_out", 0),
                resp.get("cost_inr"))


class UsageSession:
    """Accumulates a task's provider usage and writes ONE row per provider on
    flush() — so multiple calls to the same provider collapse into a single
    Usage Cost row (one Gemini row, one Mathpix row, one Sarvam row) instead of
    one row per call.

        s = pw_access.UsageSession(token, filename="chapter1.pdf",
                                   input_unit="No. of pages", count=20)
        pw_access.gemini_generate(token, model=..., request=..., session=s)
        pw_access.gemini_generate(token, model=..., request=..., session=s)
        s.flush()   # ONE gemini row with the summed tokens + cost
    """

    def __init__(
        self, google_token, *, filename="", input_unit="", count=None,
        video_duration="", app=APP_NAME
    ):
        self.token = google_token
        self.filename = filename
        self.input_unit = input_unit
        self.count = count
        self.video_duration = video_duration
        self.app = app
        self._by_model = {}  # model -> {tokens_in, tokens_out, cost_inr}

    def add(self, model, tokens_in=0, tokens_out=0, cost_inr=None):
        agg = self._by_model.setdefault(
            model or "", {"tokens_in": 0, "tokens_out": 0, "cost_inr": 0.0,
                          "cost_known": False, "requests": 0})
        agg["tokens_in"] += int(tokens_in or 0)
        agg["tokens_out"] += int(tokens_out or 0)
        agg["requests"] += 1
        if cost_inr is not None:
            agg["cost_inr"] += float(cost_inr or 0.0)
            agg["cost_known"] = True

    def flush(self):
        """Write one row per provider used this task (with its API-request count).
        Returns the proxy response, or None if nothing was accumulated. Call once,
        at the end of the task. If a provider's cost wasn't known client-side
        it's omitted so the proxy computes it."""
        items = []
        for m, v in self._by_model.items():
            item = {"model": m, "tokens_in": v["tokens_in"],
                    "tokens_out": v["tokens_out"], "requests": v["requests"]}
            if v["cost_known"]:
                item["cost_inr"] = round(v["cost_inr"], 4)
            items.append(item)
        self._by_model = {}
        if not items:
            return None
        return log_usage(self.token, filename=self.filename, input_unit=self.input_unit,
                         count=self.count, items=items,
                         video_duration=self.video_duration, app=self.app)


def gemini_generate(
    google_token: str,
    *,
    model: str,
    request: dict,
    filename: str = "",
    input_unit: str = "",
    count: Any = None,
    video_duration: str = "",
    app: str = APP_NAME,
    session: "UsageSession" = None,
) -> dict:
    """Call Gemini THROUGH the proxy (platform LiteLLM gateway behind it).
    Send the same generateContent-shaped `request` as always; the proxy
    translates to/from the gateway, so `result` keeps the Gemini response
    shape and existing parsing is unchanged. Returns
        {"ok": True, "result": <Gemini-shaped response>,
         "model": ..., "usage": {...}, "cost_inr": ...}
    Model names: existing ids (gemini-2.5-flash / gemini-2.5-pro) keep working;
    newer gateway models (e.g. gemini-3.5-flash) can be passed the same way.
    Capacity chokes (429/503) are retried by the proxy automatically.
    LARGE REQUESTS (long PDFs, many images) are handled automatically: when the
    payload exceeds ~3.5 MB the kit uploads it to the proxy's temp storage via
    a short-lived signed link and sends only a reference — supported up to
    ~60 MB per call, with the exact same result and context quality.
    When `session` is given, usage is accumulated and written once by
    session.flush() instead of logged per call."""
    import json as _json
    payload = {"app": app, "model": model, "request": request, "filename": filename,
               "input_unit": input_unit, "count": count, "video_duration": video_duration}
    if session is not None:
        payload["log"] = False
    request_bytes = _json.dumps(request).encode("utf-8")
    if len(request_bytes) > 3_500_000:
        # Blob detour: our proxy's front door caps bodies at ~4.5 MB, so big
        # requests travel via temp storage instead (see /api/gemini/upload-url).
        up = _post("/api/gemini/upload-url", google_token, {"app": app}, _TIMEOUT)
        if up.status_code != 200:
            raise PWAccessError(f"gemini upload-url error {up.status_code}: {up.text[:300]}")
        pr = requests.put(
            up.json()["upload_url"], data=request_bytes,
            headers={"Content-Type": "application/json"}, timeout=_AI_TIMEOUT,
        )
        if pr.status_code != 200:
            raise PWAccessError(f"gemini upload error {pr.status_code}: {pr.text[:300]}")
        payload.pop("request")
        payload["request_blob_url"] = pr.json().get("url", "")
    r = _post("/api/gemini/generate", google_token, payload, _AI_TIMEOUT)
    if r.status_code != 200:
        raise PWAccessError(f"gemini proxy error {r.status_code}: {r.text[:300]}")
    data = r.json()
    if session is not None:
        _accumulate(session, data, default_model=model)
    return data


def mathpix_ocr(
    google_token: str,
    *,
    request: dict,
    filename: str = "",
    count: Any = 1,
    video_duration: str = "",
    app: str = APP_NAME,
    session: "UsageSession" = None,
) -> dict:
    """Call Mathpix THROUGH the proxy. The proxy holds the Mathpix keys, calls
    Mathpix, logs usage, and returns {"ok": True, "result": <mathpix response>,
    "cost_inr": ...}. When `session` is given, usage is accumulated and written
    once by session.flush() instead of logged per call."""
    payload = {
        "app": app, "request": request, "filename": filename, "count": count,
        "video_duration": video_duration,
    }
    if session is not None:
        payload["log"] = False
    r = _post("/api/mathpix/ocr", google_token, payload, _AI_TIMEOUT)
    if r.status_code != 200:
        raise PWAccessError(f"mathpix proxy error {r.status_code}: {r.text[:300]}")
    data = r.json()
    if session is not None:
        _accumulate(session, data, default_model="Mathpix OCR")
    return data


def sarvam_tts(
    google_token: str,
    *,
    request: dict,
    filename: str = "",
    count: Any = None,
    video_duration: str = "",
    app: str = APP_NAME,
    session: "UsageSession" = None,
) -> dict:
    """Call Sarvam Text-to-Speech THROUGH the proxy. The proxy holds
    SARVAM_API_KEY, calls Sarvam, logs usage (per character), and returns
    {"ok": True, "result": <sarvam response with base64 audio>, "cost_inr": ...}.
    `count` = characters billed; if omitted the proxy derives it from the text.
    When `session` is given, usage is accumulated and written once by
    session.flush() instead of logged per call."""
    payload = {
        "app": app, "request": request, "filename": filename, "count": count,
        "video_duration": video_duration,
    }
    if session is not None:
        payload["log"] = False
    r = _post("/api/sarvam/tts", google_token, payload, _AI_TIMEOUT)
    if r.status_code != 200:
        raise PWAccessError(f"sarvam proxy error {r.status_code}: {r.text[:300]}")
    data = r.json()
    if session is not None:
        _accumulate(session, data, default_model="Sarvam TTS")
    return data


def elevenlabs_tts(
    google_token,
    *,
    voice_id: str,
    request: dict,
    output_format: str = "mp3_44100_128",
    filename: str = "",
    count: Any = None,
    video_duration: str = "",
    app: str = APP_NAME,
    session: "UsageSession" = None,
) -> dict:
    """Call ElevenLabs Text-to-Speech THROUGH the proxy. The proxy holds
    ELEVENLABS_API_KEY, calls ElevenLabs, logs usage (per character), and
    returns {"ok": True, "result": {"audio_base64": ..., "content_type":
    "audio/mpeg", "output_format": ...}, "cost_inr": ...}.
    `request` is the raw ElevenLabs TTS body: {"text": ..., "model_id":
    "eleven_multilingual_v2", "voice_settings": {...}}. `voice_id` is the
    ElevenLabs voice to use. `count` = characters billed; if omitted the proxy
    derives it from request["text"]. When `session` is given, usage is
    accumulated and written once by session.flush() instead of logged per call."""
    payload = {"app": app, "voice_id": voice_id, "request": request,
               "output_format": output_format, "filename": filename, "count": count,
               "video_duration": video_duration}
    if session is not None:
        payload["log"] = False
    r = _post("/api/elevenlabs/tts", google_token, payload, _AI_TIMEOUT)
    if r.status_code != 200:
        raise PWAccessError(f"elevenlabs proxy error {r.status_code}: {r.text[:300]}")
    data = r.json()
    if session is not None:
        _accumulate(session, data, default_model="ElevenLabs TTS")
    return data


def claude_generate(
    google_token,
    *,
    model: str,
    request: dict,
    filename: str = "",
    input_unit: str = "",
    count: Any = None,
    video_duration: str = "",
    app: str = APP_NAME,
    session: "UsageSession" = None,
) -> dict:
    """Call Claude THROUGH the proxy (company Azure Anthropic endpoint behind
    it). `request` is a raw Anthropic Messages body: {"messages": [...],
    "system": ..., "max_tokens": ...} (max_tokens defaults to 4096 if omitted).
    `model` is chosen per call at app level, e.g. "claude-sonnet-4-5". Returns
        {"ok": True, "result": <raw Anthropic Messages response>,
         "model": ..., "usage": {...}, "cost_inr": ...}
    Read the reply text from result["content"][0]["text"]. Large requests
    (> ~3.5 MB) detour via temp storage automatically, like gemini_generate.
    Capacity chokes are retried by the proxy."""
    import json as _json
    payload = {"app": app, "model": model, "request": request, "filename": filename,
               "input_unit": input_unit, "count": count, "video_duration": video_duration}
    if session is not None:
        payload["log"] = False
    request_bytes = _json.dumps(request).encode("utf-8")
    if len(request_bytes) > 3_500_000:
        up = _post("/api/gemini/upload-url", google_token, {"app": app}, _TIMEOUT)
        if up.status_code != 200:
            raise PWAccessError(f"claude upload-url error {up.status_code}: {up.text[:300]}")
        pr = requests.put(
            up.json()["upload_url"], data=request_bytes,
            headers={"Content-Type": "application/json"}, timeout=_AI_TIMEOUT,
        )
        if pr.status_code != 200:
            raise PWAccessError(f"claude upload error {pr.status_code}: {pr.text[:300]}")
        payload.pop("request")
        payload["request_blob_url"] = pr.json().get("url", "")
    r = _post("/api/claude/generate", google_token, payload, _AI_TIMEOUT)
    if r.status_code != 200:
        raise PWAccessError(f"claude proxy error {r.status_code}: {r.text[:300]}")
    data = r.json()
    if session is not None:
        _accumulate(session, data, default_model=model)
    return data


def gemini_tts(
    google_token,
    *,
    text: str,
    voice: str = "Kore",
    model: str = "gemini-3.1-flash-tts-preview",
    filename: str = "",
    count: Any = None,
    video_duration: str = "",
    app: str = APP_NAME,
    session: "UsageSession" = None,
) -> dict:
    """Gemini text-to-speech THROUGH the proxy. Returns {"ok": True,
    "result": {"audio_base64": ..., "content_type": "audio/wav"}, ...}.
    Voices: Kore, Charon, Fenrir, Callirrhoe (and other Gemini TTS voices).
    Output is WAV (24 kHz mono). `count` = characters billed; defaults to
    len(text). Billed to the app group's Gemini key (column M)."""
    payload = {"app": app, "model": model, "text": text, "voice": voice,
               "filename": filename, "count": count, "video_duration": video_duration}
    if session is not None:
        payload["log"] = False
    r = _post("/api/gemini/tts", google_token, payload, _AI_TIMEOUT)
    if r.status_code != 200:
        raise PWAccessError(f"gemini tts proxy error {r.status_code}: {r.text[:300]}")
    data = r.json()
    if session is not None:
        _accumulate(session, data, default_model="Gemini TTS")
    return data


def gemini_image(
    google_token,
    *,
    prompt: str,
    model: str = "gemini-3.1-flash-image",
    filename: str = "",
    count: Any = 1,
    video_duration: str = "",
    app: str = APP_NAME,
    session: "UsageSession" = None,
) -> dict:
    """Gemini image generation THROUGH the proxy. Returns {"ok": True,
    "result": {"image_base64": ..., "content_type": "image/png", "text": ...},
    ...}. Models: gemini-3.1-flash-image (fast) or gemini-3-pro-image
    (high fidelity). Billed to the app group's Gemini key (column M)."""
    payload = {"app": app, "model": model, "prompt": prompt,
               "filename": filename, "count": count, "video_duration": video_duration}
    if session is not None:
        payload["log"] = False
    r = _post("/api/gemini/image", google_token, payload, _AI_TIMEOUT)
    if r.status_code != 200:
        raise PWAccessError(f"gemini image proxy error {r.status_code}: {r.text[:300]}")
    data = r.json()
    if session is not None:
        _accumulate(session, data, default_model="Gemini Image")
    return data
