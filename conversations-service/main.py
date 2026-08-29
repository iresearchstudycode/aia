"""Per-user conversation history persistence service for VPAL.

Backs the Conversation History lightbox: stores each authenticated user's
past conversations in a small SQLite database (stdlib ``sqlite3``, WAL mode —
no ORM, no third-party driver, so it runs on the Chainguard distroless
runtime unchanged).

Identity comes from the ``X-Auth-User`` request header, which nginx injects
from the auth sub-request and overwrites on every request. The service still
validates it (``^[A-Za-z0-9_-]{1,64}$``) as defence-in-depth behind the nginx
``auth_request`` gate.
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

logger = logging.getLogger("conversations_service")

# ---------------------------------------------------------------------------
# Configuration (all values come from environment — never hardcoded)
# ---------------------------------------------------------------------------

_DEFAULT_DB_PATH = "/data/conversations.db"
_DEFAULT_MAX_PER_USER = 100
_MAX_BODY_BYTES = 1048576  # 1 MiB
_MAX_TITLE_CHARS = 200

# The 11 persona keys — must match ``src/aia/scripts/config.js`` ``systemPrompts``
# minus ``englishEditorExplained``.
_PERSONA_KEYS: tuple[str, ...] = (
    "assistant",
    "casual",
    "claudePromptCompressor",
    "creative",
    "englishEditor",
    "legal",
    "medical",
    "professional",
    "teacher",
    "technical",
    "transcriptai",
)

_USER_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")


class ValidationError(Exception):
    """Raised for a bad request body — mapped to 422 ``{"ok": false, ...}``."""


def _db_path() -> str:
    """Return the SQLite file path (read dynamically so tests can override it)."""
    return os.environ.get("CONVERSATIONS_DB_PATH", _DEFAULT_DB_PATH)


def _max_per_user() -> int:
    """Return the max conversations per user (read dynamically for tests)."""
    raw = os.environ.get("CONVERSATIONS_MAX_PER_USER")
    if raw:
        try:
            return int(raw)
        except ValueError:
            pass
    return _DEFAULT_MAX_PER_USER


# ---------------------------------------------------------------------------
# Database
# ---------------------------------------------------------------------------

_SCHEMA = """
CREATE TABLE IF NOT EXISTS conversations (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    persona_key TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    message_count INTEGER NOT NULL DEFAULT 0,
    body TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS idx_conv_user_updated ON conversations(username, updated_at);
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
    """Create the parent directory and the ``conversations`` table (idempotent)."""
    parent = os.path.dirname(_db_path())
    if parent:
        os.makedirs(parent, exist_ok=True)
    with _db() as conn:
        with conn:
            conn.executescript(_SCHEMA)


# ---------------------------------------------------------------------------
# Validation — strict per-field allowlist
# ---------------------------------------------------------------------------


def _validate_id(raw: str) -> str:
    """Validate and return a conversation id or raise ValidationError."""
    if not _ID_RE.match(raw):
        raise ValidationError("id must match ^[A-Za-z0-9_-]{1,64}$")
    return raw


def _validate_title(raw: Any) -> str:
    """Validate and return a title or raise ValidationError."""
    if not isinstance(raw, str):
        raise ValidationError("title must be a string")
    if len(raw) > _MAX_TITLE_CHARS:
        raise ValidationError(f"title must be at most {_MAX_TITLE_CHARS} characters")
    return raw


def _validate_persona_key(raw: Any) -> str:
    """Validate and return a persona key or raise ValidationError."""
    if not isinstance(raw, str):
        raise ValidationError("persona_key must be a string")
    # Allow empty string or one of the 11 persona keys
    if raw and raw not in _PERSONA_KEYS:
        raise ValidationError(f"persona_key must be empty or one of: {', '.join(_PERSONA_KEYS)}")
    return raw


def _validate_message_count(raw: Any) -> int:
    """Validate and return a message count or raise ValidationError."""
    if not isinstance(raw, int):
        raise ValidationError("message_count must be an integer")
    if raw < 0:
        raise ValidationError("message_count must be non-negative")
    return raw


def _validate_body(raw: Any) -> list[Any]:
    """Validate and return a body (history array) or raise ValidationError."""
    if not isinstance(raw, list):
        raise ValidationError("body must be an array")
    # Validate it serializes to within 1 MiB
    serialized = json.dumps(raw)
    if len(serialized.encode("utf-8")) > _MAX_BODY_BYTES:
        raise ValidationError("body exceeds 1 MiB when serialized")
    return raw


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


def _utc_now() -> str:
    """Return current UTC time as ISO-8601 string with Z suffix."""
    from datetime import datetime, timezone

    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------


@contextlib.asynccontextmanager
async def _lifespan(_: FastAPI) -> AsyncIterator[None]:
    _init_db()
    logger.info("conversations-service ready (db=%s)", _db_path())
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


@app.get("/conversations")
async def get_conversations(
    q: str = "",
    limit: int = 50,
    offset: int = 0,
    username: str = Depends(require_user),
) -> JSONResponse:
    """List user's conversations (metadata only, no body), newest-first."""
    # Validate limit
    if limit < 1 or limit > 200:
        limit = 50
    if offset < 0:
        offset = 0

    with _db() as conn:
        # Count total for this user (respecting the q filter if present)
        if q.strip():
            total = conn.execute(
                "SELECT COUNT(*) FROM conversations WHERE username = ? AND title LIKE ?",
                (username, f"%{q}%"),
            ).fetchone()[0]
        else:
            total = conn.execute(
                "SELECT COUNT(*) FROM conversations WHERE username = ?", (username,)
            ).fetchone()[0]

        # Fetch metadata (no body) — newest-first by updated_at DESC
        if q.strip():
            rows = conn.execute(
                """SELECT id, title, persona_key, created_at, updated_at, message_count
                   FROM conversations
                   WHERE username = ? AND title LIKE ?
                   ORDER BY updated_at DESC
                   LIMIT ? OFFSET ?""",
                (username, f"%{q}%", limit, offset),
            ).fetchall()
        else:
            rows = conn.execute(
                """SELECT id, title, persona_key, created_at, updated_at, message_count
                   FROM conversations
                   WHERE username = ?
                   ORDER BY updated_at DESC
                   LIMIT ? OFFSET ?""",
                (username, limit, offset),
            ).fetchall()

        conversations = [dict(row) for row in rows]
        cap = _max_per_user()

    return JSONResponse({"conversations": conversations, "total": total, "cap": cap})


@app.get("/conversations/search")
async def search_conversations(
    q: str = "",
    limit: int = 50,
    offset: int = 0,
    username: str = Depends(require_user),
) -> JSONResponse:
    """Search conversations by title and body text."""
    # q is required and must not be empty/whitespace
    if not q or not q.strip():
        return _error("q parameter is required and must not be empty", 400)

    # Validate limit
    if limit < 1 or limit > 200:
        limit = 50
    if offset < 0:
        offset = 0

    search_term = f"%{q}%"

    with _db() as conn:
        # Count total matching
        total = conn.execute(
            """SELECT COUNT(*) FROM conversations
               WHERE username = ? AND (title LIKE ? OR body LIKE ?)""",
            (username, search_term, search_term),
        ).fetchone()[0]

        # Fetch metadata (no body) — newest-first by updated_at DESC
        rows = conn.execute(
            """SELECT id, title, persona_key, created_at, updated_at, message_count
               FROM conversations
               WHERE username = ? AND (title LIKE ? OR body LIKE ?)
               ORDER BY updated_at DESC
               LIMIT ? OFFSET ?""",
            (username, search_term, search_term, limit, offset),
        ).fetchall()

        conversations = [dict(row) for row in rows]
        cap = _max_per_user()

    return JSONResponse({"conversations": conversations, "total": total, "cap": cap})


@app.get("/conversations/{conv_id}")
async def get_conversation(conv_id: str, username: str = Depends(require_user)) -> JSONResponse:
    """Get a full conversation by id (includes body)."""
    try:
        _validate_id(conv_id)
    except ValidationError as exc:
        raise HTTPException(status_code=422, detail=str(exc))

    with _db() as conn:
        row = conn.execute(
            "SELECT * FROM conversations WHERE id = ? AND username = ?", (conv_id, username)
        ).fetchone()

    if not row:
        return JSONResponse({"error": "not found"}, status_code=404)

    result = dict(row)
    # Parse body from JSON string back to a list
    result["body"] = json.loads(result["body"])
    return JSONResponse(result)


@app.put("/conversations/{conv_id}")
async def put_conversation(
    conv_id: str,
    request: Request,
    username: str = Depends(require_user),
) -> JSONResponse:
    """Upsert a conversation. On insert, evict oldest if at cap."""
    try:
        _validate_id(conv_id)
    except ValidationError as exc:
        raise HTTPException(status_code=422, detail=str(exc))

    body = await _json_object(request)

    # Validate required fields
    try:
        title = _validate_title(body.get("title", ""))
        persona_key = _validate_persona_key(body.get("persona_key", ""))
        message_count = _validate_message_count(body.get("message_count", 0))
        hist = _validate_body(body.get("body", []))
    except ValidationError as exc:
        # Check if this is a body size error and return 413
        if "1 MiB" in str(exc):
            return _error(str(exc), 413)
        raise

    # Check for unknown top-level keys
    allowed = {"title", "persona_key", "message_count", "body"}
    for key in body.keys():
        if key not in allowed:
            raise ValidationError(f"unknown key: {key}")

    with _db() as conn:
        with conn:
            # Check if row exists and belongs to this user
            existing = conn.execute(
                "SELECT created_at, username FROM conversations WHERE id = ?", (conv_id,)
            ).fetchone()

            if existing and existing["username"] != username:
                # Row exists but belongs to another user
                return JSONResponse({"error": "not found"}, status_code=404)

            now = _utc_now()
            body_json = json.dumps(hist)

            if existing:
                # Update: keep created_at, update updated_at
                created_at = existing["created_at"]
                conn.execute(
                    """UPDATE conversations
                       SET title = ?, persona_key = ?, message_count = ?,
                           body = ?, updated_at = ?
                       WHERE id = ? AND username = ?""",
                    (title, persona_key, message_count, body_json, now, conv_id, username),
                )
            else:
                # Insert: set both created_at and updated_at to now
                created_at = now
                conn.execute(
                    """INSERT INTO conversations
                       (id, username, title, persona_key, message_count, body,
                        created_at, updated_at)
                       VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
                    (
                        conv_id,
                        username,
                        title,
                        persona_key,
                        message_count,
                        body_json,
                        created_at,
                        now,
                    ),
                )

                # After insert, check if we're over cap and evict oldest
                cap = _max_per_user()
                count = conn.execute(
                    "SELECT COUNT(*) FROM conversations WHERE username = ?", (username,)
                ).fetchone()[0]

                while count > cap:
                    # Delete the oldest by updated_at for this user
                    oldest = conn.execute(
                        """SELECT id FROM conversations
                           WHERE username = ?
                           ORDER BY updated_at ASC
                           LIMIT 1""",
                        (username,),
                    ).fetchone()
                    if oldest:
                        conn.execute("DELETE FROM conversations WHERE id = ?", (oldest["id"],))
                        count -= 1
                    else:
                        break

    return JSONResponse({"ok": True, "id": conv_id, "created_at": created_at, "updated_at": now})


@app.delete("/conversations/{conv_id}")
async def delete_conversation(conv_id: str, username: str = Depends(require_user)) -> JSONResponse:
    """Delete a conversation. Idempotent — 200 even if not found or not the user's."""
    try:
        _validate_id(conv_id)
    except ValidationError:
        pass  # Idempotent for invalid ids too

    with _db() as conn:
        with conn:
            conn.execute(
                "DELETE FROM conversations WHERE id = ? AND username = ?", (conv_id, username)
            )

    return JSONResponse({"ok": True})
