"""Voicebox proxy for VPAL.

Bridges the browser to the local Voicebox desktop app's REST API (a local
voice I/O tool running on the Windows host) so AI responses can be spoken
through VoiceBox as an alternative to the browser's own Web Speech API.
Keeping this server-side lets the browser make a plain same-origin call
instead of talking to Voicebox directly, mirroring how Nginx proxies Ollama
for the chat feature.

Generation flow for POST /voicebox/speak:
  1. POST /speak on Voicebox — starts synthesis, returns a generation id.
  2. Stream GET /generate/{id}/status until it reaches a terminal state.
     Voicebox auto-plays the finished clip through the host's speakers as
     a side effect of this flow — there is no way to opt out of that.
  3. Cache {text, profile} -> generation_id (in-memory) so a repeat of the
     exact same text skips steps 1-2 entirely.

On a cache hit we do *not* call Voicebox again — nothing would play through
the host speakers automatically, since that only happens for a fresh
generation. Instead we return the cached generation id and the browser
fetches GET /voicebox/audio/{generation_id} (proxying Voicebox's own
GET /audio/{id}) and plays the clip itself via an <audio> element.
"""

import hashlib
import json
import logging
import os
import re
from collections import OrderedDict
from typing import Any

import httpx
from fastapi import FastAPI
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel, Field

logger = logging.getLogger("voicebox_proxy")

# ---------------------------------------------------------------------------
# Configuration (all values come from environment — never hardcoded)
# ---------------------------------------------------------------------------

_VOICEBOX_BASE_URL: str = os.environ.get(
    "VOICEBOX_URL", "http://host.docker.internal:17493"
).rstrip("/")
_VOICEBOX_CLIENT_ID: str = os.environ.get("VOICEBOX_CLIENT_ID", "vpal")
_VOICEBOX_TIMEOUT_SECONDS: float = float(os.environ.get("VOICEBOX_TIMEOUT_SECONDS", "60"))
_MAX_TEXT_LENGTH = 8000
_CACHE_MAX_ENTRIES = 200
_GENERATION_ID_RE = re.compile(r"[A-Za-z0-9_-]{1,128}")
_TERMINAL_STATUSES = {"completed", "error", "failed", "cancelled"}


class SpeakRequest(BaseModel):
    """Request body for POST /voicebox/speak."""

    text: str = Field(min_length=1, max_length=_MAX_TEXT_LENGTH)
    profile: str | None = Field(default=None, max_length=200)


class VoiceboxError(Exception):
    """Raised when Voicebox reports a generation failure or is unreachable."""


# ---------------------------------------------------------------------------
# Generation cache — text/profile -> Voicebox generation id. In-memory only
# (cleared on restart) and capped to bound memory growth on a long-running
# process; acceptable for a local, single-user tool.
# ---------------------------------------------------------------------------

_generation_cache: "OrderedDict[str, str]" = OrderedDict()


def _cache_key(text: str, profile: str | None) -> str:
    raw = f"{profile or ''}\x00{text}"
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _cache_get(key: str) -> str | None:
    generation_id = _generation_cache.get(key)
    if generation_id is not None:
        _generation_cache.move_to_end(key)
    return generation_id


def _cache_put(key: str, generation_id: str) -> None:
    _generation_cache[key] = generation_id
    _generation_cache.move_to_end(key)
    while len(_generation_cache) > _CACHE_MAX_ENTRIES:
        _generation_cache.popitem(last=False)


# ---------------------------------------------------------------------------
# Voicebox REST client — just the three endpoints this proxy needs
# ---------------------------------------------------------------------------


def _voicebox_headers() -> dict[str, str]:
    return {"X-Voicebox-Client-Id": _VOICEBOX_CLIENT_ID}


async def _start_generation(client: httpx.AsyncClient, text: str, profile: str | None) -> str:
    """POST /speak on Voicebox and return the new generation id."""
    body: dict[str, Any] = {"text": text}
    if profile:
        body["profile"] = profile
    response = await client.post(
        f"{_VOICEBOX_BASE_URL}/speak", json=body, headers=_voicebox_headers()
    )
    response.raise_for_status()
    generation_id = response.json().get("id")
    if not generation_id:
        raise VoiceboxError("Voicebox did not return a generation id")
    return generation_id


async def _await_completion(client: httpx.AsyncClient, generation_id: str) -> None:
    """Stream /generate/{id}/status until it reaches a terminal state."""
    url = f"{_VOICEBOX_BASE_URL}/generate/{generation_id}/status"
    last_status: dict[str, Any] | None = None
    async with client.stream("GET", url, headers=_voicebox_headers()) as response:
        response.raise_for_status()
        async for line in response.aiter_lines():
            if not line.startswith("data:"):
                continue
            try:
                last_status = json.loads(line.removeprefix("data:").strip())
            except json.JSONDecodeError:
                continue
            if last_status.get("status") in _TERMINAL_STATUSES:
                break
    if last_status is None:
        raise VoiceboxError("Voicebox status stream ended with no status")
    if last_status.get("status") != "completed":
        raise VoiceboxError(
            f"Voicebox generation did not complete: "
            f"{last_status.get('error') or last_status.get('status')}"
        )


async def _speak(text: str, profile: str | None) -> dict[str, Any]:
    """Return {"cached": bool, "generation_id": str} for the given text."""
    key = _cache_key(text, profile)
    cached_id = _cache_get(key)
    if cached_id:
        return {"cached": True, "generation_id": cached_id}

    async with httpx.AsyncClient(timeout=_VOICEBOX_TIMEOUT_SECONDS) as client:
        generation_id = await _start_generation(client, text, profile)
        await _await_completion(client, generation_id)

    _cache_put(key, generation_id)
    return {"cached": False, "generation_id": generation_id}


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/voicebox/speak")
async def speak(request: SpeakRequest) -> JSONResponse:
    """Speak text through VoiceBox, or resolve instantly on a cache hit."""
    try:
        result = await _speak(request.text, request.profile)
    except (httpx.HTTPError, VoiceboxError) as exc:
        logger.warning("Voicebox speak request failed: %s", exc)
        return JSONResponse({"ok": False, "error": "Voicebox is unavailable."}, status_code=502)
    return JSONResponse(
        {
            "ok": True,
            "cached": result["cached"],
            "generation_id": result["generation_id"],
            "audio_url": f"/voicebox/audio/{result['generation_id']}",
        }
    )


@app.get("/voicebox/audio/{generation_id}")
async def audio(generation_id: str) -> Response:
    """Fetch a previously generated clip's audio — used to replay cache hits."""
    if not _GENERATION_ID_RE.fullmatch(generation_id):
        return JSONResponse({"ok": False, "error": "Invalid generation id."}, status_code=400)

    try:
        async with httpx.AsyncClient(timeout=_VOICEBOX_TIMEOUT_SECONDS) as client:
            upstream = await client.get(
                f"{_VOICEBOX_BASE_URL}/audio/{generation_id}", headers=_voicebox_headers()
            )
    except httpx.HTTPError as exc:
        logger.warning("Voicebox audio fetch failed: %s", exc)
        return JSONResponse({"ok": False, "error": "Voicebox is unavailable."}, status_code=502)

    if upstream.status_code != 200:
        return JSONResponse({"ok": False, "error": "Audio not found."}, status_code=404)
    return Response(content=upstream.content, media_type="audio/wav")
