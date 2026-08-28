"""Piper text-to-speech microservice for VPAL.

Synthesises speech from text entirely offline using a local Piper voice model
(ONNX + espeak-ng phonemisation, both bundled in the ``piper-tts`` wheel and
the voice model baked into the image at build time). The single route returns
raw ``audio/wav`` bytes — the browser plays them through an ``<audio>``
element, so unlike the VoiceBox path there is no host dependency, no cache,
and no second endpoint.
"""

import io
import logging
import os
import wave

from fastapi import FastAPI
from fastapi.responses import JSONResponse, Response
from piper import PiperVoice, SynthesisConfig
from pydantic import BaseModel

logger = logging.getLogger("piper_tts")

# ---------------------------------------------------------------------------
# Configuration (all values come from environment — never hardcoded)
# ---------------------------------------------------------------------------

_MODEL_DIR: str = os.environ.get("PIPER_MODEL_DIR", "/app/voices")
_VOICE: str = os.environ.get("PIPER_VOICE", "en_US-lessac-medium")
_LENGTH_SCALE: float = float(os.environ.get("PIPER_LENGTH_SCALE", "1.0"))
_MAX_TEXT_CHARS: int = int(os.environ.get("PIPER_MAX_TEXT_CHARS", "6000"))

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
# Piper voice — loaded lazily and cached for the process lifetime. Kept out
# of import time so the test suite never needs the ~60 MB model on disk.
# ---------------------------------------------------------------------------

_voice: PiperVoice | None = None


def _get_voice() -> PiperVoice:
    """Return the cached PiperVoice, loading it from PIPER_MODEL_DIR on first use."""
    global _voice
    if _voice is None:
        onnx_path = os.path.join(_MODEL_DIR, f"{_VOICE}.onnx")
        _voice = PiperVoice.load(onnx_path)
    return _voice


def _synthesize(text: str) -> bytes:
    """Return WAV bytes for ``text``, or raise SynthesisError."""
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

app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)


class SpeakRequest(BaseModel):
    """Request body for POST /piper/speak."""

    text: str


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/piper/speak")
async def speak(request: SpeakRequest) -> Response:
    """Synthesise ``text`` and return raw audio/wav bytes."""
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
