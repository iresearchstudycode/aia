"""Tests for the piper-tts service.

The Piper voice model is never present in CI (~60 MB, baked into the Docker
image only), so every test mocks the synthesis layer — either ``_get_voice``
(exercising the real ``wave``/``SynthesisConfig`` plumbing in ``_synthesize``)
or ``_synthesize`` itself (exercising the route layer).
"""

from unittest.mock import MagicMock

import onnxruntime
import pytest
from fastapi.testclient import TestClient

import main
from main import SynthesisError, _capped_session_options, _sanitize, _synthesize, app


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

    def test_speak_route_is_sync_so_it_runs_off_the_event_loop(self) -> None:
        # A blocking sync route must NOT be registered as a coroutine, or one
        # slow synthesis would stall /health and every other request.
        import inspect

        route = next(r for r in app.routes if getattr(r, "path", None) == "/piper/speak")
        assert not inspect.iscoroutinefunction(route.endpoint)

    def test_health_stays_responsive_during_a_slow_synthesis(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Prove the event loop isn't blocked: a synth that sleeps 1s in its
        # worker thread must not delay a concurrent /health call.
        import threading
        import time

        def _slow_synth(_text: str) -> bytes:
            time.sleep(1.0)
            return b"RIFF\x00\x00\x00\x00WAVE"

        monkeypatch.setattr(main, "_synthesize", _slow_synth)

        results: dict[str, float] = {}

        def _fire_speak() -> None:
            start = time.monotonic()
            client.post("/piper/speak", json={"text": "slow one"})
            results["speak"] = time.monotonic() - start

        t = threading.Thread(target=_fire_speak)
        t.start()
        time.sleep(0.1)  # let the synth get going

        health_start = time.monotonic()
        assert client.get("/health").status_code == 200
        results["health"] = time.monotonic() - health_start

        t.join()
        assert results["health"] < 0.5  # health returned well before the 1s synth
        assert results["speak"] >= 1.0


# ---------------------------------------------------------------------------
# _capped_session_options — onnxruntime thread-pool cap
# ---------------------------------------------------------------------------


class TestCappedSessionOptions:
    def test_hands_out_capped_options_then_restores_the_factory(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(main, "_ORT_THREADS", 1)
        original = onnxruntime.SessionOptions

        with _capped_session_options():
            opts = onnxruntime.SessionOptions()
            assert opts.intra_op_num_threads == 1
            assert opts.inter_op_num_threads == 1
            assert opts.execution_mode == onnxruntime.ExecutionMode.ORT_SEQUENTIAL

        assert onnxruntime.SessionOptions is original

    def test_factory_is_restored_even_on_error(self) -> None:
        original = onnxruntime.SessionOptions
        with pytest.raises(RuntimeError):
            with _capped_session_options():
                raise RuntimeError("boom")
        assert onnxruntime.SessionOptions is original
