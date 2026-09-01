"""Per-user preference persistence service for VPAL.

Backs the consolidated Settings lightbox: stores each authenticated user's
global preferences and per-persona overrides in a small SQLite database
(stdlib ``sqlite3``, WAL mode — no ORM, no third-party driver, so it runs on
the Chainguard distroless runtime unchanged).

Identity comes from the ``X-Auth-User`` request header, which nginx injects
from the auth sub-request and overwrites on every request. The service still
validates it (``^[A-Za-z0-9_-]{1,64}$``) as defence-in-depth behind the nginx
``auth_request`` gate.

Defaults for the global keys come from ``VPAL_DEFAULT_*`` environment
variables with baked-in fallbacks; ``active_persona`` always defaults to
``englishEditor`` and is not env-configurable in v1.
"""

import contextlib
import json
import logging
import os
import re
import sqlite3
from collections.abc import AsyncIterator, Iterator
from typing import Any

from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse

logger = logging.getLogger("settings_service")

# ---------------------------------------------------------------------------
# Configuration (all values come from environment — never hardcoded)
# ---------------------------------------------------------------------------

_DEFAULT_DB_PATH = "/data/settings.db"

# The 10 persona keys — must match ``src/aia/scripts/config.js`` ``systemPrompts``
# minus ``englishEditorExplained``.
_PERSONA_KEYS: tuple[str, ...] = (
    "assistant",
    "casual",
    "creative",
    "englishEditor",
    "legal",
    "medical",
    "professional",
    "teacher",
    "technical",
    "transcriptai",
)

# Per-persona SVG icon, delivered read-only in the ``GET /settings`` ``personas``
# block (``_resolved_persona`` adds it after the stored-value merge, so it can
# never be PUT or reset). Inline line-icons: 24x24, ``stroke="currentColor"`` so
# they follow the UI theme; no hardcoded colours. The frontend sanitises the
# string through DOMPurify (svg profile) before it reaches innerHTML — same
# boundary as Mermaid output. ``src/aia/scripts/config.js`` ``personaIcons``
# mirrors this for the offline fallback; keep the two in sync.
_ICON_HEAD = (
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" '
    'stroke="currentColor" stroke-width="2" stroke-linecap="round" '
    'stroke-linejoin="round" aria-hidden="true">'
)
_PERSONA_ICONS: dict[str, str] = {
    "assistant": _ICON_HEAD
    + '<path d="M9.5 3 11 7.5 15.5 9 11 10.5 9.5 15 8 10.5 3.5 9 8 7.5z"/>'
    + '<path d="M18 13.5 18.8 16 21 16.8 18.8 17.5 18 20 17.2 17.5 15 16.8 17.2 16z"/></svg>',
    "casual": _ICON_HEAD
    + '<circle cx="12" cy="12" r="9"/><path d="M8 14s1.4 2 4 2 4-2 4-2"/>'
    + '<line x1="9" y1="9.5" x2="9.01" y2="9.5"/>'
    + '<line x1="15" y1="9.5" x2="15.01" y2="9.5"/></svg>',
    "creative": _ICON_HEAD
    + '<path d="M20.24 12.24a6 6 0 0 0-8.49-8.49L5 10.5V19h8.5z"/>'
    + '<line x1="16" y1="8" x2="2" y2="22"/><line x1="17.5" y1="15" x2="9" y2="15"/></svg>',
    "englishEditor": _ICON_HEAD
    + '<path d="m6 16 6-12 6 12"/><path d="M8.5 12h7"/>'
    + '<path d="m15 20 2 2 4-4"/></svg>',
    "legal": _ICON_HEAD
    + '<path d="M12 3v18"/><path d="M7 21h10"/><path d="M5 7h14"/>'
    + '<path d="M5 7 2 13a3 3 0 0 0 6 0z"/><path d="M19 7l-3 6a3 3 0 0 0 6 0z"/>'
    + '<path d="m9 4 6-1"/></svg>',
    "medical": _ICON_HEAD + '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>',
    "professional": _ICON_HEAD
    + '<rect x="2" y="7" width="20" height="14" rx="2"/>'
    + '<path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg>',
    "teacher": _ICON_HEAD
    + '<path d="M2 4h6a4 4 0 0 1 4 4v13a3 3 0 0 0-3-3H2z"/>'
    + '<path d="M22 4h-6a4 4 0 0 0-4 4v13a3 3 0 0 1 3-3h7z"/></svg>',
    "technical": _ICON_HEAD
    + '<polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>',
    "transcriptai": _ICON_HEAD
    + '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>'
    + '<polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/>'
    + '<line x1="16" y1="17" x2="8" y2="17"/><line x1="10" y1="9" x2="8" y2="9"/></svg>',
}

_GLOBAL_KEYS: tuple[str, ...] = (
    "chat_model",
    "vision_model",
    "tts_engine",
    "auto_speak",
    "stt_lang",
    "thinking_enabled",
    "thinking_depth",
    "nav_rail",
    "theme",
    "active_persona",
)

_PERSONA_OVERRIDE_KEYS: tuple[str, ...] = (
    "thinking_enabled",
    "thinking_depth",
    "tts_engine",
)

_TTS_ENGINES: tuple[str, ...] = ("piper", "voicebox")
_THINKING_DEPTHS: tuple[str, ...] = ("low", "medium", "high")
_EDITOR_MODES: tuple[str, ...] = ("clean", "changes", "explain")
_ANALYSIS_VIEWS: tuple[str, ...] = ("structured", "text")
_THEMES: tuple[str, ...] = ("system", "light", "dark")

_BOOL_GLOBAL_KEYS: frozenset[str] = frozenset({"auto_speak", "thinking_enabled", "nav_rail"})

_USER_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_STT_LANG_RE = re.compile(r"^[a-z]{2}(-[A-Za-z0-9]{2,8})*$")

_MAX_MODEL_CHARS = 200


class ValidationError(Exception):
    """Raised for a bad request body — mapped to 422 ``{"ok": false, ...}``."""


def _db_path() -> str:
    """Return the SQLite file path (read dynamically so tests can override it)."""
    return os.environ.get("SETTINGS_DB_PATH", _DEFAULT_DB_PATH)


def _as_bool(raw: str | None, fallback: bool) -> bool:
    """Coerce a ``VPAL_DEFAULT_*`` string to bool, falling back when unset."""
    if raw is None:
        return fallback
    return raw.strip().lower() in ("1", "true", "yes", "on")


def _env_defaults() -> dict[str, Any]:
    """Return the resolved global-key defaults from the environment.

    Read on every request so a test (or a container restart with a changed
    ``.env``) sees the current values without a code reload.
    """
    return {
        "chat_model": os.environ.get("VPAL_DEFAULT_CHAT_MODEL", "gemma4:e4b"),
        "vision_model": os.environ.get("VPAL_DEFAULT_VISION_MODEL", "gemma3:4b"),
        "tts_engine": os.environ.get("VPAL_DEFAULT_TTS_ENGINE", "piper"),
        "auto_speak": _as_bool(os.environ.get("VPAL_DEFAULT_AUTO_SPEAK"), False),
        "stt_lang": os.environ.get("VPAL_DEFAULT_STT_LANG", "en-US"),
        "thinking_enabled": _as_bool(os.environ.get("VPAL_DEFAULT_THINKING"), False),
        "thinking_depth": os.environ.get("VPAL_DEFAULT_THINKING_DEPTH", "medium"),
        "nav_rail": _as_bool(os.environ.get("VPAL_DEFAULT_NAV_RAIL"), True),
        "theme": os.environ.get("VPAL_DEFAULT_THEME", "system"),
        "active_persona": "englishEditor",
    }


def _persona_defaults() -> dict[str, Any]:
    """Return the reset target for a persona override block."""
    return {
        "thinking_enabled": None,
        "thinking_depth": None,
        "tts_engine": None,
        "editor_mode": "clean",
        "default_analysis_view": "structured",
    }


# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------

_SCHEMA = """
CREATE TABLE IF NOT EXISTS settings (
    username TEXT NOT NULL,
    scope    TEXT NOT NULL,
    key      TEXT NOT NULL,
    value    TEXT NOT NULL,
    PRIMARY KEY (username, scope, key)
)
"""


def _connect() -> sqlite3.Connection:
    """Open a fresh connection with WAL + foreign keys enabled."""
    conn = sqlite3.connect(_db_path(), timeout=5)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


@contextlib.contextmanager
def _db() -> Iterator[sqlite3.Connection]:
    """Yield a connection and always close it (use ``with conn:`` for writes)."""
    conn = _connect()
    try:
        yield conn
    finally:
        conn.close()


def _init_db() -> None:
    """Create the parent directory and the ``settings`` table (idempotent)."""
    parent = os.path.dirname(_db_path())
    if parent:
        os.makedirs(parent, exist_ok=True)
    with _db() as conn:
        with conn:
            conn.execute(_SCHEMA)


def _stored(conn: sqlite3.Connection, username: str, scope: str) -> dict[str, Any]:
    """Return ``{key: json-decoded value}`` for one user + scope."""
    rows = conn.execute(
        "SELECT key, value FROM settings WHERE username = ? AND scope = ?",
        (username, scope),
    ).fetchall()
    return {row["key"]: json.loads(row["value"]) for row in rows}


def _upsert(conn: sqlite3.Connection, username: str, scope: str, key: str, value: Any) -> None:
    """Insert or replace one setting row."""
    conn.execute(
        "INSERT INTO settings (username, scope, key, value) VALUES (?, ?, ?, ?) "
        "ON CONFLICT(username, scope, key) DO UPDATE SET value = excluded.value",
        (username, scope, key, json.dumps(value)),
    )


def _delete_row(conn: sqlite3.Connection, username: str, scope: str, key: str) -> None:
    """Delete one setting row (no-op if absent)."""
    conn.execute(
        "DELETE FROM settings WHERE username = ? AND scope = ? AND key = ?",
        (username, scope, key),
    )


# ---------------------------------------------------------------------------
# Resolution — env defaults overlaid with stored rows
# ---------------------------------------------------------------------------


def _resolved_global(conn: sqlite3.Connection, username: str) -> dict[str, Any]:
    """Return env defaults overlaid with the user's stored ``global`` rows."""
    resolved = _env_defaults()
    for key, value in _stored(conn, username, "global").items():
        if key in _GLOBAL_KEYS:
            resolved[key] = value
    # A stored active_persona for a since-removed persona (e.g.
    # ``claudePromptCompressor``) falls back to the house default.
    if resolved.get("active_persona") not in _PERSONA_KEYS:
        resolved["active_persona"] = _env_defaults()["active_persona"]
    return resolved


def _resolved_persona(conn: sqlite3.Connection, username: str, persona_key: str) -> dict[str, Any]:
    """Return the persona override block: every override key present.

    Unset override keys are ``null``; ``editor_mode`` appears (and defaults to
    ``"clean"``) only for ``englishEditor``; ``default_analysis_view`` appears
    (and defaults to ``"structured"``) only for ``professional``.
    """
    entry: dict[str, Any] = {key: None for key in _PERSONA_OVERRIDE_KEYS}
    if persona_key == "englishEditor":
        entry["editor_mode"] = "clean"
    if persona_key == "professional":
        entry["default_analysis_view"] = "structured"
    for key, value in _stored(conn, username, f"persona:{persona_key}").items():
        if key in entry:
            entry[key] = value
    # Read-only, set last so nothing stored can shadow it.
    entry["icon"] = _PERSONA_ICONS.get(persona_key, "")
    return entry


# ---------------------------------------------------------------------------
# Validation — strict per-key allowlist
# ---------------------------------------------------------------------------


def _require_non_empty_str(key: str, value: Any) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValidationError(f"{key} must be a non-empty string")
    if len(value) > _MAX_MODEL_CHARS:
        raise ValidationError(f"{key} must be at most {_MAX_MODEL_CHARS} characters")
    return value


def _require_bool(key: str, value: Any) -> bool:
    if not isinstance(value, bool):
        raise ValidationError(f"{key} must be a boolean")
    return value


def _require_choice(key: str, value: Any, choices: tuple[str, ...]) -> str:
    if value not in choices:
        raise ValidationError(f"{key} must be one of: {', '.join(choices)}")
    return value


def _validate_global(key: str, value: Any) -> Any:
    """Validate one ``PUT /settings/global`` key/value or raise ValidationError."""
    if key not in _GLOBAL_KEYS:
        raise ValidationError(f"unknown global setting: {key}")
    if value is None:
        raise ValidationError(f"{key} cannot be null")
    if key in ("chat_model", "vision_model"):
        return _require_non_empty_str(key, value)
    if key in _BOOL_GLOBAL_KEYS:
        return _require_bool(key, value)
    if key == "tts_engine":
        return _require_choice(key, value, _TTS_ENGINES)
    if key == "thinking_depth":
        return _require_choice(key, value, _THINKING_DEPTHS)
    if key == "theme":
        return _require_choice(key, value, _THEMES)
    if key == "stt_lang":
        if not isinstance(value, str) or not _STT_LANG_RE.match(value):
            raise ValidationError("stt_lang must be a BCP-47-style tag (e.g. en, en-US)")
        return value
    # active_persona
    return _require_choice(key, value, _PERSONA_KEYS)


def _validate_persona(persona_key: str, key: str, value: Any) -> Any:
    """Validate one ``PUT /settings/persona/{k}`` key/value or raise.

    ``value is None`` is legal for the nullable override keys (the caller
    turns it into a row delete); ``editor_mode`` is englishEditor-only and
    ``default_analysis_view`` is professional-only, and neither may be null.
    """
    if key == "editor_mode":
        if persona_key != "englishEditor":
            raise ValidationError("editor_mode is only valid for the englishEditor persona")
        if value is None:
            raise ValidationError("editor_mode cannot be null")
        return _require_choice(key, value, _EDITOR_MODES)

    if key == "default_analysis_view":
        if persona_key != "professional":
            raise ValidationError(
                "default_analysis_view is only valid for the professional persona"
            )
        if value is None:
            raise ValidationError("default_analysis_view cannot be null")
        return _require_choice(key, value, _ANALYSIS_VIEWS)

    if key not in _PERSONA_OVERRIDE_KEYS:
        raise ValidationError(f"unknown persona setting: {key}")
    if value is None:
        return None
    if key == "thinking_enabled":
        return _require_bool(key, value)
    if key == "thinking_depth":
        return _require_choice(key, value, _THINKING_DEPTHS)
    # tts_engine
    return _require_choice(key, value, _TTS_ENGINES)


def _parse_reset_scope(raw: Any) -> str:
    """Return a validated reset scope string or raise ValidationError."""
    if not isinstance(raw, str):
        raise ValidationError("scope is required")
    if raw in ("global", "all"):
        return raw
    if raw.startswith("persona:"):
        persona_key = raw.removeprefix("persona:")
        if persona_key not in _PERSONA_KEYS:
            raise ValidationError(f"unknown persona: {persona_key}")
        return raw
    raise ValidationError("scope must be 'global', 'all', or 'persona:<key>'")


# ---------------------------------------------------------------------------
# Request helpers
# ---------------------------------------------------------------------------


def require_user(request: Request) -> str:
    """Extract and validate the ``X-Auth-User`` header (401 on miss/malformed)."""
    username = request.headers.get("x-auth-user")
    if not username or not _USER_RE.match(username):
        raise HTTPException(status_code=401, detail="missing or malformed X-Auth-User header")
    return username


async def _json_object(request: Request) -> dict[str, Any]:
    """Parse the request body as a JSON object (``{}`` when the body is empty)."""
    raw = await request.body()
    if not raw:
        return {}
    try:
        parsed = json.loads(raw)
    except ValueError as exc:
        raise ValidationError("request body must be valid JSON") from exc
    if not isinstance(parsed, dict):
        raise ValidationError("request body must be a JSON object")
    return parsed


def _error(message: str, status_code: int) -> JSONResponse:
    return JSONResponse({"ok": False, "error": message}, status_code=status_code)


# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------


@contextlib.asynccontextmanager
async def _lifespan(_: FastAPI) -> AsyncIterator[None]:
    _init_db()
    logger.info("settings-service ready (db=%s)", _db_path())
    yield


app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None, lifespan=_lifespan)


@app.exception_handler(HTTPException)
async def _http_exception_handler(_: Request, exc: HTTPException) -> JSONResponse:
    """Render HTTPException as the service's ``{"ok": false, "error": ...}`` shape."""
    return _error(str(exc.detail), exc.status_code)


@app.exception_handler(ValidationError)
async def _validation_exception_handler(_: Request, exc: ValidationError) -> JSONResponse:
    return _error(str(exc), 422)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/settings")
async def get_settings(username: str = Depends(require_user)) -> JSONResponse:
    """Return the user's resolved global settings, persona overrides, and defaults."""
    with _db() as conn:
        resolved_global = _resolved_global(conn, username)
        personas = {
            persona_key: _resolved_persona(conn, username, persona_key)
            for persona_key in _PERSONA_KEYS
        }
    return JSONResponse(
        {
            "global": resolved_global,
            "personas": personas,
            "defaults": {
                "global": _env_defaults(),
                "persona": _persona_defaults(),
            },
        }
    )


@app.put("/settings/global")
async def put_global(request: Request, username: str = Depends(require_user)) -> JSONResponse:
    """Apply a partial update to the user's global settings."""
    body = await _json_object(request)
    cleaned = {key: _validate_global(key, value) for key, value in body.items()}
    with _db() as conn:
        with conn:
            for key, value in cleaned.items():
                _upsert(conn, username, "global", key, value)
        resolved = _resolved_global(conn, username)
    return JSONResponse({"ok": True, "global": resolved})


@app.put("/settings/persona/{persona_key}")
async def put_persona(
    persona_key: str,
    request: Request,
    username: str = Depends(require_user),
) -> JSONResponse:
    """Apply a partial update to one persona's overrides (``null`` deletes a row)."""
    if persona_key not in _PERSONA_KEYS:
        return _error(f"unknown persona: {persona_key}", 404)
    body = await _json_object(request)
    cleaned = {key: _validate_persona(persona_key, key, value) for key, value in body.items()}
    scope = f"persona:{persona_key}"
    with _db() as conn:
        with conn:
            for key, value in cleaned.items():
                if value is None:
                    _delete_row(conn, username, scope, key)
                else:
                    _upsert(conn, username, scope, key, value)
        resolved = _resolved_persona(conn, username, persona_key)
    return JSONResponse({"ok": True, "persona": resolved})


@app.post("/settings/reset")
async def reset_settings(request: Request, username: str = Depends(require_user)) -> JSONResponse:
    """Delete some or all of the user's stored rows in a scope."""
    body = await _json_object(request)
    scope = _parse_reset_scope(body.get("scope"))
    keys = body.get("keys")
    if keys is not None and (
        not isinstance(keys, list) or not all(isinstance(k, str) for k in keys)
    ):
        raise ValidationError("keys must be a list of strings")

    where = "username = ?"
    params: list[Any] = [username]
    if scope != "all":
        where += " AND scope = ?"
        params.append(scope)

    with _db() as conn:
        with conn:
            if keys is None:
                conn.execute(f"DELETE FROM settings WHERE {where}", params)
            elif keys:
                placeholders = ", ".join("?" for _ in keys)
                conn.execute(
                    f"DELETE FROM settings WHERE {where} AND key IN ({placeholders})",
                    (*params, *keys),
                )
            # An explicit empty ``keys`` list deletes nothing.
    return JSONResponse({"ok": True})
