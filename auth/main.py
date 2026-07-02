"""TOTP authentication service for VPAL.

Provides session-cookie-based authentication backed by per-user TOTP secrets
stored in environment variables.  Designed to sit behind Nginx auth_request so
no unauthenticated request ever reaches the static application or Ollama proxy.
"""

import hashlib
import hmac
import io
import os
import time
from collections import defaultdict
from contextlib import asynccontextmanager
from typing import Annotated, AsyncIterator

import pyotp
import segno
from fastapi import FastAPI, Form, Request, Response
from fastapi.responses import HTMLResponse, JSONResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles
from itsdangerous import BadSignature, SignatureExpired, TimestampSigner

# ---------------------------------------------------------------------------
# Configuration (all values come from environment — never hardcoded)
# ---------------------------------------------------------------------------

_SECRET_KEY: str = os.environ["SECRET_KEY"]
_SESSION_TTL_SECONDS: int = int(os.environ.get("SESSION_TTL_HOURS", "8")) * 3600
_SETUP_TOKEN: str = os.environ.get("SETUP_TOKEN", "")
_APP_TITLE: str = "VPAL"

_signer: TimestampSigner = TimestampSigner(_SECRET_KEY)

# ---------------------------------------------------------------------------
# User store — up to 5 users loaded from env vars on every auth check so that
# the .env file can be updated without restarting the container.
# ---------------------------------------------------------------------------

_MAX_USERS = 5


def _load_users() -> dict[str, str]:
    """Return {username: totp_secret} from USER_N / TOTP_SECRET_N env vars."""
    users: dict[str, str] = {}
    for i in range(1, _MAX_USERS + 1):
        name = os.environ.get(f"USER_{i}", "").strip()
        secret = os.environ.get(f"TOTP_SECRET_{i}", "").strip()
        if name and secret:
            users[name] = secret
    return users


# ---------------------------------------------------------------------------
# Brute-force protection — in-process, per-username sliding window
# ---------------------------------------------------------------------------

_LOCKOUT_ATTEMPTS = 5
_LOCKOUT_SECONDS = 300  # 5 minutes

_failed_attempts: dict[str, list[float]] = defaultdict(list)


def _is_locked(username: str) -> bool:
    """Return True if the username is currently locked out."""
    now = time.monotonic()
    _failed_attempts[username] = [
        t for t in _failed_attempts[username] if now - t < _LOCKOUT_SECONDS
    ]
    return len(_failed_attempts[username]) >= _LOCKOUT_ATTEMPTS


def _record_failure(username: str) -> None:
    _failed_attempts[username].append(time.monotonic())


def _clear_failures(username: str) -> None:
    _failed_attempts.pop(username, None)


# ---------------------------------------------------------------------------
# TOTP replay protection — reject a code that was already accepted within the
# 90-second validity window (valid_window=1 covers t-1, t, t+1 intervals).
# ---------------------------------------------------------------------------

_REPLAY_WINDOW_SECONDS = 90

# (username, code) -> monotonic timestamp when the code was first accepted
_used_totp_codes: dict[tuple[str, str], float] = {}


def _is_code_replay(username: str, code: str) -> bool:
    """Return True if this (username, code) pair was already accepted recently."""
    now = time.monotonic()
    # Prune entries older than the replay window
    expired = [k for k, t in _used_totp_codes.items() if now - t > _REPLAY_WINDOW_SECONDS]
    for k in expired:
        del _used_totp_codes[k]
    return (username, code) in _used_totp_codes


def _mark_code_used(username: str, code: str) -> None:
    _used_totp_codes[(username, code)] = time.monotonic()


# ---------------------------------------------------------------------------
# Session helpers
# ---------------------------------------------------------------------------


def _make_csrf_token(session_token: str) -> str:
    """Derive a CSRF token from the session token using HMAC-SHA256.

    Binding the CSRF token to the session token means it is automatically
    invalidated when the session changes, with no extra storage required.
    """
    return hmac.new(
        _SECRET_KEY.encode(),
        (session_token + ":csrf").encode(),
        hashlib.sha256,
    ).hexdigest()[:32]


def _set_session_cookie(response: Response, username: str) -> None:
    token: str = _signer.sign(username).decode()
    csrf_token: str = _make_csrf_token(token)
    response.set_cookie(
        "vpal_session",
        token,
        httponly=True,
        secure=True,
        samesite="strict",
        max_age=_SESSION_TTL_SECONDS,
    )
    # vpal_csrf is intentionally NOT HttpOnly so JS can read it and inject
    # it into the logout form as a hidden field (double-submit cookie pattern).
    response.set_cookie(
        "vpal_csrf",
        csrf_token,
        httponly=False,
        secure=True,
        samesite="strict",
        max_age=_SESSION_TTL_SECONDS,
    )
    # vpal_user is NOT HttpOnly so JS can read the username for the profile
    # widget without an extra fetch.  The username is not a secret; this cookie
    # carries no authentication capability.
    response.set_cookie(
        "vpal_user",
        username,
        httponly=False,
        secure=True,
        samesite="strict",
        max_age=_SESSION_TTL_SECONDS,
    )


def _validate_session(request: Request) -> bool:
    """Return True when the request carries a valid, unexpired session cookie."""
    token = request.cookies.get("vpal_session", "")
    if not token:
        return False
    try:
        _signer.unsign(token, max_age=_SESSION_TTL_SECONDS)
        return True
    except (BadSignature, SignatureExpired):
        return False


# ---------------------------------------------------------------------------
# HTML rendering (no template engine — no extra dependency, no XSS surface
# because error strings are always the same static literal, never user input)
# ---------------------------------------------------------------------------

_ERROR_MSG = "Invalid username, code, or too many attempts."


def _login_html(error: str = "") -> str:
    error_block = f'<p class="error-msg">{error}</p>' if error else ""
    return f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Sign in — {_APP_TITLE}</title>
  <link rel="stylesheet" href="/auth/static/login.css">
</head>
<body>
  <div class="login-card">
    <div class="login-header">\U0001f916 {_APP_TITLE}</div>
    <p class="login-subtitle">Enter your username and authenticator code</p>
    {error_block}
    <form method="post" action="/auth/login" autocomplete="off">
      <label for="username">Username</label>
      <input id="username" name="username" type="text" required autofocus
             autocomplete="username" placeholder="your username">
      <label for="code">Authenticator Code</label>
      <input id="code" name="code" type="text" inputmode="numeric"
             pattern="[0-9]{{6}}" maxlength="6" required
             autocomplete="one-time-code" placeholder="6-digit code">
      <button type="submit">Sign in</button>
    </form>
  </div>
</body>
</html>"""


def _qr_svg(uri: str) -> str:
    """Return an inline SVG QR code for the given TOTP provisioning URI."""
    qr = segno.make_qr(uri)
    buf = io.BytesIO()
    qr.save(buf, kind="svg", scale=4, border=2)
    return buf.getvalue().decode("utf-8")


def _setup_html(users: dict[str, str]) -> str:
    cards: list[str] = []
    for username, secret in users.items():
        totp = pyotp.TOTP(secret)
        uri = totp.provisioning_uri(name=username, issuer_name=_APP_TITLE)
        svg = _qr_svg(uri)
        cards.append(f"""<div class="setup-card">
      <h3>{username}</h3>
      <p>Scan with Google Authenticator:</p>
      <div class="qr">{svg}</div>
      <p class="uri-label">Or copy the setup URI:</p>
      <code class="uri">{uri}</code>
      <p class="secret-label">TOTP Secret (keep private): <code>{secret}</code></p>
    </div>""")
    cards_html = "\n".join(cards)
    return f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Setup — {_APP_TITLE}</title>
  <link rel="stylesheet" href="/auth/static/login.css">
</head>
<body>
  <div class="setup-container">
    <div class="login-header">\U0001f511 {_APP_TITLE} — Authenticator Setup</div>
    <p class="login-subtitle">
      Scan each QR code with Google Authenticator.<br>
      Remove <code>SETUP_TOKEN</code> from <code>.env</code> when done.
    </p>
    {cards_html}
  </div>
</body>
</html>"""


# ---------------------------------------------------------------------------
# Application lifecycle
# ---------------------------------------------------------------------------


@asynccontextmanager
async def _lifespan(app: FastAPI) -> AsyncIterator[None]:
    if len(_SECRET_KEY) < 32:
        raise RuntimeError("SECRET_KEY must be at least 32 characters.")
    if not _load_users():
        raise RuntimeError("No users configured — set USER_1 / TOTP_SECRET_1 in .env.")
    yield


app = FastAPI(lifespan=_lifespan, docs_url=None, redoc_url=None, openapi_url=None)
app.mount("/auth/static", StaticFiles(directory="static"), name="auth-static")


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/auth/verify")
async def verify(request: Request) -> Response:
    """Sub-request endpoint called by Nginx auth_request.

    Returns 200 when the session cookie is valid, 401 otherwise.
    Must remain internal (Nginx enforces this via the ``internal`` directive).
    """
    if _validate_session(request):
        return Response(status_code=200)
    return Response(status_code=401)


@app.get("/auth/me")
async def me(request: Request) -> Response:
    """Return the authenticated user's username as JSON.

    Used by the profile widget when the non-HttpOnly ``vpal_user`` cookie is
    absent (e.g. sessions established before that cookie was introduced).
    Returns 401 for unauthenticated requests.
    """
    token = request.cookies.get("vpal_session", "")
    try:
        username = _signer.unsign(token, max_age=_SESSION_TTL_SECONDS).decode()
        return JSONResponse({"username": username})
    except (BadSignature, SignatureExpired):
        return Response(status_code=401)


@app.get("/auth/login", response_class=HTMLResponse)
async def login_page(request: Request) -> Response:
    if _validate_session(request):
        return RedirectResponse(url="/", status_code=302)
    return HTMLResponse(_login_html())


@app.post("/auth/login")
async def login(
    request: Request,
    username: Annotated[str, Form()],
    code: Annotated[str, Form()],
) -> Response:
    """Validate username + TOTP code; issue a session cookie on success."""
    username = username.strip()
    code = code.strip().replace(" ", "")

    users = _load_users()
    secret = users.get(username)
    locked = bool(secret) and _is_locked(username)

    # Always run a TOTP verify (real or dummy) to equalise response timing
    # and avoid leaking whether the username exists.
    candidate = secret if secret else pyotp.random_base32()
    valid = pyotp.TOTP(candidate).verify(code, valid_window=1)

    # Reject replayed codes even when the TOTP window still considers them valid.
    replay = bool(secret) and valid and _is_code_replay(username, code)

    if not secret or locked or not valid or replay:
        if secret and not locked and not valid:
            _record_failure(username)
        return HTMLResponse(_login_html(_ERROR_MSG), status_code=401)

    _clear_failures(username)
    _mark_code_used(username, code)
    resp: Response = RedirectResponse(url="/", status_code=302)
    _set_session_cookie(resp, username)
    return resp


@app.post("/auth/logout")
async def logout(
    request: Request,
    csrf_token: Annotated[str, Form()] = "",
) -> Response:
    """Sign the user out.

    Requires a CSRF token submitted as a hidden form field (double-submit
    cookie pattern).  The expected value is derived from the session token
    via HMAC so no server-side CSRF state is needed.
    """
    session_token = request.cookies.get("vpal_session", "")
    csrf_cookie = request.cookies.get("vpal_csrf", "")
    expected = _make_csrf_token(session_token) if session_token else ""

    # Both the submitted field and the cookie must match the expected HMAC.
    # hmac.compare_digest prevents timing-based attacks on the comparison.
    token_ok = bool(
        expected
        and hmac.compare_digest(csrf_token, expected)
        and hmac.compare_digest(csrf_cookie, expected)
    )

    if not token_ok:
        return Response(status_code=403)

    resp: Response = RedirectResponse(url="/auth/login", status_code=302)
    resp.delete_cookie("vpal_session", httponly=True, secure=True, samesite="strict")
    resp.delete_cookie("vpal_csrf", secure=True, samesite="strict")
    resp.delete_cookie("vpal_user", secure=True, samesite="strict")
    return resp


@app.get("/auth/setup", response_class=HTMLResponse)
async def setup(token: str = "") -> Response:
    """One-time QR-code setup page.

    Active only when the ``SETUP_TOKEN`` environment variable is set.
    Access: https://localhost/auth/setup?token=<SETUP_TOKEN>
    Disable after initial setup by removing SETUP_TOKEN from .env.
    """
    if not _SETUP_TOKEN or token != _SETUP_TOKEN:
        return Response(status_code=404)
    users = _load_users()
    if not users:
        return HTMLResponse(
            "No users configured. Set USER_1 / TOTP_SECRET_1 in .env.", status_code=500
        )
    return HTMLResponse(_setup_html(users))
