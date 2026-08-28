"""Tests for the piper-tts service.

The Piper voice model is never present in CI (~60 MB, baked into the Docker
image only), so every test mocks the synthesis layer — either ``_get_voice``
(exercising the real ``wave``/``SynthesisConfig`` plumbing in ``_synthesize``)
or ``_synthesize`` itself (exercising the route layer).
"""

from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

import main
from main import SynthesisError, _sanitize, _synthesize, app


@pytest.fixture()
def client() -> TestClient:
    return TestClient(app, raise_server_exceptions=True)


# ---------------------------------------------------------------------------
# /health
# ---------------------------------------------------------------------------


class TestHealth:
    def test_returns_ok(self, client: TestClient) -> None:
        response = client.get("/health")
        assert response.status_code == 200
        assert response.json() == {"status": "ok"}


# ---------------------------------------------------------------------------
# _sanitize — control-character stripping
# ---------------------------------------------------------------------------


class TestSanitize:
    def test_strips_ascii_control_chars(self) -> None:
        assert _sanitize("a\x00b\x07c\x1fd\x7fe") == "abcde"

    def test_keeps_tab_newline_carriage_return(self) -> None:
        assert _sanitize("a\tb\nc\rd") == "a\tb\nc\rd"

    def test_leaves_plain_text_unchanged(self) -> None:
        assert _sanitize("Hello, world!") == "Hello, world!"


# ---------------------------------------------------------------------------
# _synthesize — real wave/SynthesisConfig plumbing, PiperVoice mocked
# ---------------------------------------------------------------------------


class TestSynthesize:
    def test_produces_a_wav_container(self, monkeypatch: pytest.MonkeyPatch) -> None:
        # The real synthesize_wav() sets the WAV format and writes frames; the
        # fake stands in for that so wave.open() can close a valid container.
        def fake_synthesize_wav(text: str, wav_file, syn_config=None) -> None:
            wav_file.setnchannels(1)
            wav_file.setsampwidth(2)
            wav_file.setframerate(22050)
            wav_file.writeframes(b"\x00\x00" * 8)

        fake_voice = MagicMock()
        fake_voice.synthesize_wav.side_effect = fake_synthesize_wav
        monkeypatch.setattr(main, "_get_voice", lambda: fake_voice)

        out = _synthesize("Hello there.")

        assert out[:4] == b"RIFF"
        assert out[8:12] == b"WAVE"
        assert len(out) > 44  # header + at least one frame
        fake_voice.synthesize_wav.assert_called_once()

    def test_wraps_voice_failure_in_synthesis_error(self, monkeypatch: pytest.MonkeyPatch) -> None:
        fake_voice = MagicMock()
        fake_voice.synthesize_wav.side_effect = RuntimeError("onnx blew up")
        monkeypatch.setattr(main, "_get_voice", lambda: fake_voice)

        with pytest.raises(SynthesisError, match="Speech synthesis failed"):
            _synthesize("Hello there.")


# ---------------------------------------------------------------------------
# POST /piper/speak — route-level behaviour
# ---------------------------------------------------------------------------


class TestSpeakRoute:
    def test_valid_text_returns_wav_bytes(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(
            main, "_synthesize", MagicMock(return_value=b"RIFF\x00\x00\x00\x00WAVEfmt ")
        )
        response = client.post("/piper/speak", json={"text": "Hello world."})
        assert response.status_code == 200
        assert response.headers["content-type"] == "audio/wav"
        assert response.content == b"RIFF\x00\x00\x00\x00WAVEfmt "

    def test_strips_control_chars_before_synthesis(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        synth = MagicMock(return_value=b"RIFF....WAVE")
        monkeypatch.setattr(main, "_synthesize", synth)
        response = client.post("/piper/speak", json={"text": "cl\x07ean\x00 text"})
        assert response.status_code == 200
        synth.assert_called_once_with("clean text")

    def test_rejects_empty_text(self, client: TestClient) -> None:
        response = client.post("/piper/speak", json={"text": ""})
        assert response.status_code == 400
        assert response.json()["ok"] is False

    def test_rejects_whitespace_only_text(self, client: TestClient) -> None:
        response = client.post("/piper/speak", json={"text": "   \n\t  "})
        assert response.status_code == 400
        assert response.json()["ok"] is False

    def test_rejects_text_over_the_limit(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(main, "_MAX_TEXT_CHARS", 10)
        response = client.post("/piper/speak", json={"text": "x" * 11})
        assert response.status_code == 413
        assert response.json()["ok"] is False

    def test_missing_text_field_is_422(self, client: TestClient) -> None:
        response = client.post("/piper/speak", json={})
        assert response.status_code == 422

    def test_synthesis_failure_returns_500(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(
            main,
            "_synthesize",
            MagicMock(side_effect=SynthesisError("Speech synthesis failed.")),
        )
        response = client.post("/piper/speak", json={"text": "Hello world."})
        assert response.status_code == 500
        assert response.json() == {"ok": False, "error": "Speech synthesis failed."}
