"""
pw_access.py — shared PW app-access client (drop-in for any PW app backend).

Copy this ONE file into an app, set APP_NAME below, and you get:
  - live app-wise whitelist checks,
  - append-only usage logging,
  - Gemini / Mathpix calls with keys that live ONLY on the proxy.

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
APP_NAME = "Final ZIP Package"

# Point this at your proxy. Override per-environment with PW_PROXY_BASE_URL.
PROXY_BASE_URL = os.environ.get(
    "PW_PROXY_BASE_URL", "https://pw-apps-proxy.vercel.app"
).rstrip("/")

_TIMEOUT = 30       # allowlist / logging — fast
_AI_TIMEOUT = 300   # Gemini / Mathpix — can be slow


class PWAccessError(Exception):
    """Raised when a paid proxy call (Gemini/Mathpix) fails."""


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
        (token-vending Gemini), it's omitted so the proxy computes it."""
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


# Vertex token cache. The SA token is identical for every user (it authenticates
# the proxy's service account, not the end user), so it's shared process-wide.
# Per-user authorization is enforced by check_allowed() before each run.
_vertex_cache = {"token": "", "project": "", "location": "global", "expiry": 0.0}


def _get_vertex(google_token, app=APP_NAME):
    """Fetch (and cache) a short-lived Vertex token from the proxy; refresh
    ~10 min before expiry."""
    import time
    now = time.time()
    if _vertex_cache["token"] and now < _vertex_cache["expiry"] - 600:
        return _vertex_cache
    r = _post("/api/vertex/token", google_token, {"app": app}, _TIMEOUT)
    if r.status_code != 200:
        raise PWAccessError(f"vertex token error {r.status_code}: {r.text[:300]}")
    d = r.json()
    _vertex_cache.update({
        "token": d.get("token", ""),
        "project": d.get("project", ""),
        "location": d.get("location", "global"),
        "expiry": now + int(d.get("expires_in", 3300)),
    })
    return _vertex_cache


# Gemini (especially 2.5-pro) intermittently answers 429 RESOURCE_EXHAUSTED
# for a few minutes — shared-capacity throttling, NOT something the app did.
# Plan: retry the primary location after a short wait, then try other regions
# (separate capacity pools), then one last patient retry. Only 429/503 are
# retried; real errors surface immediately.
_VERTEX_FALLBACK_LOCATIONS = ["us-central1", "europe-west4"]


def _vertex_url(project: str, location: str, model: str) -> str:
    host = ("aiplatform.googleapis.com" if location == "global"
            else f"{location}-aiplatform.googleapis.com")
    return (f"https://{host}/v1/projects/{project}/locations/{location}"
            f"/publishers/google/models/{model}:generateContent")


def _vertex_generate(v: dict, model: str, request: dict) -> dict:
    import time
    primary = v["location"]
    attempts = [(primary, 0), (primary, 8)]
    attempts += [(l, 0) for l in _VERTEX_FALLBACK_LOCATIONS if l != primary]
    attempts += [(primary, 30)]
    last_text = ""
    for loc, wait in attempts:
        if wait:
            time.sleep(wait)
        r = requests.post(
            _vertex_url(v["project"], loc, model),
            headers={"Authorization": f"Bearer {v['token']}",
                     "Content-Type": "application/json"},
            json=request,
            timeout=_AI_TIMEOUT,
        )
        if r.status_code == 200:
            return r.json()
        if r.status_code == 404 and loc != primary:
            last_text = r.text  # model not hosted in this region — try the next
            continue
        if r.status_code not in (429, 503):
            raise PWAccessError(f"vertex gemini error {r.status_code}: {r.text[:300]}")
        last_text = r.text
    raise PWAccessError(
        f"vertex gemini busy (429) — retried {len(attempts)} times across "
        f"{sorted(set(l for l, _ in attempts))}: {last_text[:200]}")


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
    """Call Gemini via Vertex AI. Fetches a short-lived Vertex token from the
    proxy (cached), then calls Vertex DIRECTLY — so there is NO 4.5 MB proxy body
    limit (important for large PDFs/images). Returns
        {"ok": True, "result": <raw generateContent response>,
         "model": ..., "usage": {...}, "cost_inr": None}
    `result` has the same shape as the Gemini API, so existing parsing is
    unchanged. Cost is computed by the proxy when the usage row is written.
    When `session` is given, usage is added to it and written by session.flush().
    Capacity chokes (429/503) are ridden out automatically: short-wait retries
    plus regional fallback (see _vertex_generate)."""
    v = _get_vertex(google_token, app)
    data = _vertex_generate(v, model, request)
    um = data.get("usageMetadata") or {}
    tin = int(um.get("promptTokenCount") or 0)
    tout = int((um.get("candidatesTokenCount") or 0) + (um.get("thoughtsTokenCount") or 0))
    if session is not None:
        session.add(model, tin, tout, None)  # cost computed by the proxy at flush
    else:
        log_usage(google_token, filename=filename, input_unit=input_unit, count=count,
                  items=[{"model": model, "tokens_in": tin, "tokens_out": tout, "requests": 1}],
                  video_duration=video_duration, app=app)
    return {"ok": True, "result": data, "model": model,
            "usage": {"tokens_in": tin, "tokens_out": tout}, "cost_inr": None}


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
