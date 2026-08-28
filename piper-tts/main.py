"""Piper text-to-speech microservice for VPAL.

Synthesises speech from text entirely offline using a local Piper voice model
(ONNX + espeak-ng phonemisation, both bundled in the ``piper-tts`` wheel and
the voice model baked into the image at build time). The single route returns
raw ``audio/wav`` bytes — the browser plays them through an ``<audio>``
element, so unlike the VoiceBox path there is no host dependency, no cache,
and no second endpoint.

Concurrency notes (learned the hard way — see PR #30):
  * ``POST /piper/speak`` is a **sync** ``def`` route. ONNX inference is
    blocking CPU-bound work; in an ``async`` route it would block the whole
    single-threaded event loop, so ``/health`` (and every other request)
    would stall behind one slow synthesis. FastAPI runs sync routes in a
    worker threadpool, keeping the loop free.
  * onnxruntime is told to use a **fixed, tiny thread pool**
    (``PIPER_ORT_THREADS``, default 1). Left to itself it sizes the intra-op
    pool to the host core count, which under a container's CPU quota + PID
    ceiling can deadlock during thread-pool creation (the request never even
    reaches a log line). ``OMP_NUM_THREADS`` etc. are also pinned in the
    Dockerfile / compose file as defence in depth.
  * The voice model is loaded eagerly at startup (``PIPER_EAGER_LOAD``,
    default on) so the first real request isn't a cold load and a broken
    model fails the healthcheck at boot instead of hanging a request.
"""

import contextlib
import io
import logging
import os
import wave
from contextlib import asynccontextmanager
from typing import Iterator

import onnxruntime
from fastapi import FastAPI
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse, Response
from piper import PiperVoice, SynthesisConfig
from pydantic import BaseModel

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("piper_tts")

# ---------------------------------------------------------------------------
# Configuration (all values come from environment — never hardcoded)
# ---------------------------------------------------------------------------

_MODEL_DIR: str = os.environ.get("PIPER_MODEL_DIR", "/app/voices")
_VOICE: str = os.environ.get("PIPER_VOICE", "en_US-lessac-medium")
_LENGTH_SCALE: float = float(os.environ.get("PIPER_LENGTH_SCALE", "1.0"))
_MAX_TEXT_CHARS: int = int(os.environ.get("PIPER_MAX_TEXT_CHARS", "6000"))
_ORT_THREADS: int = max(1, int(os.environ.get("PIPER_ORT_THREADS", "1")))
_EAGER_LOAD: bool = os.environ.get("PIPER_EAGER_LOAD", "1") != "0"

# ASCII control characters to strip before synthesis (everything below 0x20
# plus DEL), keeping the three whitespace characters that carry meaning.
_ALLOWED_CONTROL = {"\t", "\n", "\r"}
_CONTROL_CHARS = {chr(c) for c in list(range(0x20)) + [0x7F]} - _ALLOWED_CONTROL
_CONTROL_TRANSLATION = {ord(ch): None for ch in _CONTROL_CHARS}


class SynthesisError(Exception):
    """Raised when the Piper voice fails to synthesise the given text."""


def _sanitize(text: str) -> str:
    """Strip ASCII control characters (keeping tab/newline/carriage return)."""
    return text.translate(_CONTROL_TRANSLATION)


# ---------------------------------------------------------------------------
# Piper voice — loaded once and cached for the process lifetime. Kept out of
# import time so the test suite never needs the ~60 MB model on disk.
# ---------------------------------------------------------------------------

_voice: "PiperVoice | None" = None


@contextlib.contextmanager
def _capped_session_options() -> Iterator[None]:
    """Force onnxruntime's thread pools to a small fixed size for the duration
    of ``PiperVoice.load()``.

    ``PiperVoice.load()`` hands onnxruntime a bare ``SessionOptions()``. Under
    a container CPU quota + PID ceiling, letting onnxruntime size its intra-op
    pool to the host core count can hang during pool creation, so we
    monkeypatch the factory to return a pre-capped instance while the session
    is built, then restore it.
    """
    original = onnxruntime.SessionOptions

    def _factory() -> "onnxruntime.SessionOptions":
        opts = original()
        opts.intra_op_num_threads = _ORT_THREADS
        opts.inter_op_num_threads = 1
        opts.execution_mode = onnxruntime.ExecutionMode.ORT_SEQUENTIAL
        return opts

    onnxruntime.SessionOptions = _factory
    try:
        yield
    finally:
        onnxruntime.SessionOptions = original


def _get_voice() -> PiperVoice:
    """Return the cached PiperVoice, loading it from PIPER_MODEL_DIR on first use."""
    global _voice
    if _voice is None:
        onnx_path = os.path.join(_MODEL_DIR, f"{_VOICE}.onnx")
        logger.info("Loading Piper voice %r from %s", _VOICE, onnx_path)
        with _capped_session_options():
            _voice = PiperVoice.load(onnx_path)
        logger.info("Piper voice %r loaded (ONNX threads=%d)", _VOICE, _ORT_THREADS)
    return _voice


def _synthesize(text: str) -> bytes:
    """Return WAV bytes for ``text``, or raise SynthesisError. Blocking / CPU-bound."""
    try:
        voice = _get_voice()
        syn_config = SynthesisConfig(length_scale=_LENGTH_SCALE)
        buffer = io.BytesIO()
        with wave.open(buffer, "wb") as wav_file:
            voice.synthesize_wav(text, wav_file, syn_config=syn_config)
        return buffer.getvalue()
    except Exception as exc:
        # Any failure in the ONNX/espeak pipeline becomes a 500 for the caller.
        logger.warning("Piper synthesis failed: %s", exc)
        raise SynthesisError("Speech synthesis failed.") from exc


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------


@asynccontextmanager
async def _lifespan(_app: FastAPI):
    """Warm the voice model at startup so the first request isn't a cold load
    and a broken model fails the healthcheck instead of hanging a request."""
    if _EAGER_LOAD:
        await run_in_threadpool(_get_voice)
    yield


app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None, lifespan=_lifespan)


class SpeakRequest(BaseModel):
    """Request body for POST /piper/speak."""

    text: str


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/piper/speak")
def speak(request: SpeakRequest) -> Response:
    """Synthesise ``text`` and return raw audio/wav bytes.

    Sync ``def`` on purpose — FastAPI runs it in a worker thread so the
    blocking ONNX inference never touches the event loop.
    """
    text = _sanitize(request.text)
    if not text.strip():
        return JSONResponse({"ok": False, "error": "Text must not be empty."}, status_code=400)
    if len(text) > _MAX_TEXT_CHARS:
        return JSONResponse(
            {
                "ok": False,
                "error": f"Text exceeds the {_MAX_TEXT_CHARS}-character limit.",
            },
            status_code=413,
        )

    try:
        wav_bytes = _synthesize(text)
    except SynthesisError as exc:
        return JSONResponse({"ok": False, "error": str(exc)}, status_code=500)

    return Response(content=wav_bytes, media_type="audio/wav")
