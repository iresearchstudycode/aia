"""Tests for the voicebox-proxy service."""

import asyncio
from typing import Any
from unittest.mock import AsyncMock, Mock

import httpx
import pytest
from fastapi.testclient import TestClient

import main
from main import VoiceboxError, _await_completion, _cache_key, _speak, _start_generation, app


@pytest.fixture()
def client() -> TestClient:
    return TestClient(app, raise_server_exceptions=True)


@pytest.fixture(autouse=True)
def _clear_cache() -> None:
    main._generation_cache.clear()
    yield
    main._generation_cache.clear()


def _json_response(payload: dict[str, Any], status_code: int = 200) -> httpx.Response:
    request = httpx.Request("POST", "http://voicebox.test/speak")
    return httpx.Response(status_code, json=payload, request=request)


class _FakeStreamResponse:
    def __init__(self, lines: list[str], status_code: int = 200) -> None:
        self._lines = lines
        self.status_code = status_code

    def raise_for_status(self) -> None:
        if self.status_code >= 400:
            request = httpx.Request("GET", "http://voicebox.test/status")
            response = httpx.Response(self.status_code, request=request)
            raise httpx.HTTPStatusError("error", request=request, response=response)

    async def aiter_lines(self):
        for line in self._lines:
            yield line


class _FakeStreamContext:
    def __init__(self, response: _FakeStreamResponse) -> None:
        self._response = response

    async def __aenter__(self) -> _FakeStreamResponse:
        return self._response

    async def __aexit__(self, exc_type, exc, tb) -> bool:
        return False


def _mock_stream(lines: list[str], status_code: int = 200) -> Mock:
    return Mock(return_value=_FakeStreamContext(_FakeStreamResponse(lines, status_code)))


# ---------------------------------------------------------------------------
# /health
# ---------------------------------------------------------------------------


class TestHealth:
    def test_returns_ok(self, client: TestClient) -> None:
        response = client.get("/health")
        assert response.status_code == 200
        assert response.json() == {"status": "ok"}


# ---------------------------------------------------------------------------
# _cache_key
# ---------------------------------------------------------------------------


class TestCacheKey:
    def test_same_text_and_profile_produce_same_key(self) -> None:
        assert _cache_key("hello", "Kitt") == _cache_key("hello", "Kitt")

    def test_different_text_produces_different_key(self) -> None:
        assert _cache_key("hello", None) != _cache_key("goodbye", None)

    def test_different_profile_produces_different_key(self) -> None:
        assert _cache_key("hello", "Kitt") != _cache_key("hello", "Aussie")

    def test_none_and_empty_profile_are_equivalent(self) -> None:
        assert _cache_key("hello", None) == _cache_key("hello", "")


# ---------------------------------------------------------------------------
# _start_generation
# ---------------------------------------------------------------------------


class TestStartGeneration:
    def test_returns_generation_id(self, monkeypatch: pytest.MonkeyPatch) -> None:
        mock_post = AsyncMock(return_value=_json_response({"id": "gen-1", "status": "generating"}))
        monkeypatch.setattr(httpx.AsyncClient, "post", mock_post)

        async def _run() -> str:
            async with httpx.AsyncClient() as client:
                return await _start_generation(client, "hello", None)

        assert asyncio.run(_run()) == "gen-1"
        call = mock_post.call_args
        assert call.args[0] == f"{main._VOICEBOX_BASE_URL}/speak"
        assert call.kwargs["json"] == {"text": "hello"}

    def test_includes_profile_when_given(self, monkeypatch: pytest.MonkeyPatch) -> None:
        mock_post = AsyncMock(return_value=_json_response({"id": "gen-1"}))
        monkeypatch.setattr(httpx.AsyncClient, "post", mock_post)

        async def _run() -> str:
            async with httpx.AsyncClient() as client:
                return await _start_generation(client, "hi", "Kitt")

        asyncio.run(_run())
        assert mock_post.call_args.kwargs["json"] == {"text": "hi", "profile": "Kitt"}

    def test_raises_when_no_id_returned(self, monkeypatch: pytest.MonkeyPatch) -> None:
        mock_post = AsyncMock(return_value=_json_response({"status": "generating"}))
        monkeypatch.setattr(httpx.AsyncClient, "post", mock_post)

        async def _run() -> str:
            async with httpx.AsyncClient() as client:
                return await _start_generation(client, "hi", None)

        with pytest.raises(VoiceboxError, match="generation id"):
            asyncio.run(_run())


# ---------------------------------------------------------------------------
# _await_completion
# ---------------------------------------------------------------------------


class TestAwaitCompletion:
    def test_resolves_on_completed_status(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(
            httpx.AsyncClient,
            "stream",
            _mock_stream(['data: {"id": "gen-1", "status": "completed"}']),
        )

        async def _run() -> None:
            async with httpx.AsyncClient() as client:
                await _await_completion(client, "gen-1")

        asyncio.run(_run())  # no exception

    def test_stops_at_first_terminal_status_among_several(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(
            httpx.AsyncClient,
            "stream",
            _mock_stream(
                [
                    'data: {"id": "gen-1", "status": "generating"}',
                    'data: {"id": "gen-1", "status": "completed"}',
                ]
            ),
        )

        async def _run() -> None:
            async with httpx.AsyncClient() as client:
                await _await_completion(client, "gen-1")

        asyncio.run(_run())  # no exception

    def test_raises_on_error_status(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(
            httpx.AsyncClient,
            "stream",
            _mock_stream(['data: {"id": "gen-1", "status": "error", "error": "boom"}']),
        )

        async def _run() -> None:
            async with httpx.AsyncClient() as client:
                await _await_completion(client, "gen-1")

        with pytest.raises(VoiceboxError, match="boom"):
            asyncio.run(_run())

    def test_raises_when_stream_ends_without_terminal_status(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(
            httpx.AsyncClient,
            "stream",
            _mock_stream(['data: {"id": "gen-1", "status": "generating"}']),
        )

        async def _run() -> None:
            async with httpx.AsyncClient() as client:
                await _await_completion(client, "gen-1")

        with pytest.raises(VoiceboxError, match="did not complete"):
            asyncio.run(_run())

    def test_raises_when_stream_has_no_data_lines(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(httpx.AsyncClient, "stream", _mock_stream(["event: ping"]))

        async def _run() -> None:
            async with httpx.AsyncClient() as client:
                await _await_completion(client, "gen-1")

        with pytest.raises(VoiceboxError, match="no status"):
            asyncio.run(_run())

    def test_ignores_malformed_data_lines(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(
            httpx.AsyncClient,
            "stream",
            _mock_stream(["data: not-json", 'data: {"id": "gen-1", "status": "completed"}']),
        )

        async def _run() -> None:
            async with httpx.AsyncClient() as client:
                await _await_completion(client, "gen-1")

        asyncio.run(_run())  # no exception


# ---------------------------------------------------------------------------
# _speak — cache orchestration
# ---------------------------------------------------------------------------


class TestSpeak:
    def test_cache_miss_generates_and_caches(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(
            httpx.AsyncClient, "post", AsyncMock(return_value=_json_response({"id": "gen-1"}))
        )
        monkeypatch.setattr(
            httpx.AsyncClient,
            "stream",
            _mock_stream(['data: {"id": "gen-1", "status": "completed"}']),
        )

        result = asyncio.run(_speak("hello", None))

        assert result == {"cached": False, "generation_id": "gen-1"}
        assert main._cache_get(_cache_key("hello", None)) == "gen-1"

    def test_cache_hit_skips_voicebox_entirely(self, monkeypatch: pytest.MonkeyPatch) -> None:
        main._cache_put(_cache_key("hello", None), "gen-cached")
        mock_post = AsyncMock()
        mock_stream = Mock()
        monkeypatch.setattr(httpx.AsyncClient, "post", mock_post)
        monkeypatch.setattr(httpx.AsyncClient, "stream", mock_stream)

        result = asyncio.run(_speak("hello", None))

        assert result == {"cached": True, "generation_id": "gen-cached"}
        mock_post.assert_not_called()
        mock_stream.assert_not_called()

    def test_failed_generation_is_not_cached(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(
            httpx.AsyncClient, "post", AsyncMock(return_value=_json_response({"id": "gen-1"}))
        )
        monkeypatch.setattr(
            httpx.AsyncClient,
            "stream",
            _mock_stream(['data: {"id": "gen-1", "status": "error", "error": "boom"}']),
        )

        with pytest.raises(VoiceboxError):
            asyncio.run(_speak("hello", None))

        assert main._cache_get(_cache_key("hello", None)) is None


# ---------------------------------------------------------------------------
# Cache eviction
# ---------------------------------------------------------------------------


class TestCacheEviction:
    def test_evicts_oldest_entry_beyond_max_size(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(main, "_CACHE_MAX_ENTRIES", 2)
        main._cache_put("a", "gen-a")
        main._cache_put("b", "gen-b")
        main._cache_put("c", "gen-c")

        assert main._cache_get("a") is None
        assert main._cache_get("b") == "gen-b"
        assert main._cache_get("c") == "gen-c"

    def test_get_refreshes_recency(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(main, "_CACHE_MAX_ENTRIES", 2)
        main._cache_put("a", "gen-a")
        main._cache_put("b", "gen-b")
        main._cache_get("a")  # touch "a" so "b" becomes the oldest
        main._cache_put("c", "gen-c")

        assert main._cache_get("a") == "gen-a"
        assert main._cache_get("b") is None


# ---------------------------------------------------------------------------
# POST /voicebox/speak — route-level behaviour, _speak mocked
# ---------------------------------------------------------------------------


class TestSpeakRoute:
    def test_success_fresh_generation(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(
            main, "_speak", AsyncMock(return_value={"cached": False, "generation_id": "gen-1"})
        )
        response = client.post("/voicebox/speak", json={"text": "hello"})
        assert response.status_code == 200
        assert response.json() == {
            "ok": True,
            "cached": False,
            "generation_id": "gen-1",
            "audio_url": "/voicebox/audio/gen-1",
        }

    def test_success_cache_hit(self, client: TestClient, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(
            main, "_speak", AsyncMock(return_value={"cached": True, "generation_id": "gen-1"})
        )
        response = client.post("/voicebox/speak", json={"text": "hello"})
        assert response.json()["cached"] is True

    def test_rejects_empty_text(self, client: TestClient) -> None:
        response = client.post("/voicebox/speak", json={"text": ""})
        assert response.status_code == 422

    def test_rejects_missing_text(self, client: TestClient) -> None:
        response = client.post("/voicebox/speak", json={})
        assert response.status_code == 422

    def test_rejects_text_over_max_length(self, client: TestClient) -> None:
        response = client.post("/voicebox/speak", json={"text": "a" * 8001})
        assert response.status_code == 422

    def test_returns_502_when_voicebox_unreachable(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(
            main, "_speak", AsyncMock(side_effect=httpx.ConnectError("connection refused"))
        )
        response = client.post("/voicebox/speak", json={"text": "hello"})
        assert response.status_code == 502
        assert response.json()["ok"] is False

    def test_returns_502_on_voicebox_error(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(main, "_speak", AsyncMock(side_effect=VoiceboxError("boom")))
        response = client.post("/voicebox/speak", json={"text": "hello"})
        assert response.status_code == 502

    def test_passes_profile_through(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        mock_speak = AsyncMock(return_value={"cached": False, "generation_id": "gen-1"})
        monkeypatch.setattr(main, "_speak", mock_speak)
        client.post("/voicebox/speak", json={"text": "hello", "profile": "Kitt"})
        mock_speak.assert_awaited_once_with("hello", "Kitt")


# ---------------------------------------------------------------------------
# GET /voicebox/audio/{generation_id}
# ---------------------------------------------------------------------------


class TestAudioRoute:
    def test_streams_audio_bytes(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        request = httpx.Request("GET", "http://voicebox.test/audio/gen-1")
        upstream = httpx.Response(200, content=b"RIFF....WAVEfmt ", request=request)
        monkeypatch.setattr(httpx.AsyncClient, "get", AsyncMock(return_value=upstream))

        response = client.get("/voicebox/audio/gen-1")

        assert response.status_code == 200
        assert response.headers["content-type"] == "audio/wav"
        assert response.content == b"RIFF....WAVEfmt "

    def test_rejects_invalid_generation_id(self, client: TestClient) -> None:
        response = client.get("/voicebox/audio/invalid$id!")
        assert response.status_code == 400

    def test_returns_404_when_upstream_404s(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        request = httpx.Request("GET", "http://voicebox.test/audio/missing")
        upstream = httpx.Response(404, request=request)
        monkeypatch.setattr(httpx.AsyncClient, "get", AsyncMock(return_value=upstream))

        response = client.get("/voicebox/audio/missing-id")

        assert response.status_code == 404

    def test_returns_502_when_voicebox_unreachable(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(
            httpx.AsyncClient, "get", AsyncMock(side_effect=httpx.ConnectError("refused"))
        )

        response = client.get("/voicebox/audio/gen-1")

        assert response.status_code == 502
