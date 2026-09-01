"""Tests for the settings-service."""

import json
import os
import sqlite3
from collections.abc import Iterator

import pytest
from fastapi.testclient import TestClient

import main
from main import app

_USER = "alice"
_HEADERS = {"X-Auth-User": _USER}


@pytest.fixture()
def client() -> Iterator[TestClient]:
    # ``with`` triggers the lifespan handler, which creates the table.
    with TestClient(app, raise_server_exceptions=True) as test_client:
        yield test_client


def _get(client: TestClient, user: str = _USER) -> dict:
    response = client.get("/settings", headers={"X-Auth-User": user})
    assert response.status_code == 200
    return response.json()


# ---------------------------------------------------------------------------
# /health + startup
# ---------------------------------------------------------------------------


class TestHealthAndStartup:
    def test_health_returns_ok_without_auth(self, client: TestClient) -> None:
        response = client.get("/health")
        assert response.status_code == 200
        assert response.json() == {"status": "ok"}

    def test_table_created_on_startup(self, client: TestClient) -> None:
        conn = sqlite3.connect(os.environ["SETTINGS_DB_PATH"])
        try:
            names = [
                row[0]
                for row in conn.execute(
                    "SELECT name FROM sqlite_master WHERE type = 'table'"
                ).fetchall()
            ]
        finally:
            conn.close()
        assert "settings" in names

    def test_wal_mode_enabled(self, client: TestClient) -> None:
        # A write must have happened for -wal to appear; force one first.
        client.put("/settings/global", headers=_HEADERS, json={"nav_rail": False})
        with main._db() as conn:
            mode = conn.execute("PRAGMA journal_mode").fetchone()[0]
        assert mode.lower() == "wal"


# ---------------------------------------------------------------------------
# GET /settings — fresh user
# ---------------------------------------------------------------------------


class TestGetSettingsFresh:
    def test_fresh_user_gets_all_env_defaults(self, client: TestClient) -> None:
        body = _get(client)
        assert body["global"] == {
            "chat_model": "gemma4:e4b",
            "vision_model": "gemma3:4b",
            "tts_engine": "piper",
            "auto_speak": False,
            "stt_lang": "en-US",
            "thinking_enabled": False,
            "thinking_depth": "medium",
            "nav_rail": True,
            "theme": "system",
            "active_persona": "englishEditor",
        }

    def test_fresh_user_persona_overrides_all_null(self, client: TestClient) -> None:
        body = _get(client)
        assert set(body["personas"]) == set(main._PERSONA_KEYS)
        entry = body["personas"]["assistant"]
        assert entry["thinking_enabled"] is None
        assert entry["thinking_depth"] is None
        assert entry["tts_engine"] is None

    def test_claude_prompt_compressor_persona_is_gone(self, client: TestClient) -> None:
        assert "claudePromptCompressor" not in main._PERSONA_KEYS
        assert "claudePromptCompressor" not in _get(client)["personas"]
        assert len(main._PERSONA_KEYS) == 10

    def test_every_persona_carries_a_read_only_svg_icon(self, client: TestClient) -> None:
        personas = _get(client)["personas"]
        for key in main._PERSONA_KEYS:
            icon = personas[key]["icon"]
            assert isinstance(icon, str) and icon.startswith("<svg") and icon.endswith("</svg>")
        # icon is not a writable override key
        r = client.put("/settings/persona/assistant", headers=_HEADERS, json={"icon": "<svg/>"})
        assert r.status_code == 422
        assert _get(client)["personas"]["assistant"]["icon"] == main._PERSONA_ICONS["assistant"]

    def test_english_editor_has_editor_mode_clean(self, client: TestClient) -> None:
        entry = _get(client)["personas"]["englishEditor"]
        assert entry["thinking_enabled"] is None
        assert entry["thinking_depth"] is None
        assert entry["tts_engine"] is None
        assert entry["editor_mode"] == "clean"

    def test_only_english_editor_has_editor_mode(self, client: TestClient) -> None:
        body = _get(client)
        for key, entry in body["personas"].items():
            if key != "englishEditor":
                assert "editor_mode" not in entry

    def test_removed_active_persona_falls_back_to_default(self, client: TestClient) -> None:
        # Simulate a row stored before the persona was removed.
        with main._db() as conn, conn:
            main._upsert(conn, _USER, "global", "active_persona", "claudePromptCompressor")
        assert _get(client)["global"]["active_persona"] == "englishEditor"

    def test_defaults_block_shape(self, client: TestClient) -> None:
        body = _get(client)
        assert body["defaults"]["global"] == body["global"]
        assert body["defaults"]["persona"] == {
            "thinking_enabled": None,
            "thinking_depth": None,
            "tts_engine": None,
            "editor_mode": "clean",
            "default_analysis_view": "structured",
        }

    def test_professional_has_default_analysis_view_structured(self, client: TestClient) -> None:
        entry = _get(client)["personas"]["professional"]
        assert entry["default_analysis_view"] == "structured"

    def test_only_professional_has_default_analysis_view(self, client: TestClient) -> None:
        body = _get(client)
        for key, entry in body["personas"].items():
            if key != "professional":
                assert "default_analysis_view" not in entry


# ---------------------------------------------------------------------------
# PUT /settings/global
# ---------------------------------------------------------------------------


class TestPutGlobal:
    def test_persists_and_get_reflects_it(self, client: TestClient) -> None:
        response = client.put(
            "/settings/global",
            headers=_HEADERS,
            json={"chat_model": "llama3:8b", "auto_speak": True},
        )
        assert response.status_code == 200
        body = response.json()
        assert body["ok"] is True
        assert body["global"]["chat_model"] == "llama3:8b"
        assert body["global"]["auto_speak"] is True

        after = _get(client)
        assert after["global"]["chat_model"] == "llama3:8b"
        assert after["global"]["auto_speak"] is True

    def test_partial_update_leaves_other_keys_at_default(self, client: TestClient) -> None:
        client.put("/settings/global", headers=_HEADERS, json={"thinking_depth": "high"})
        body = _get(client)
        assert body["global"]["thinking_depth"] == "high"
        # Everything else still default.
        assert body["global"]["chat_model"] == "gemma4:e4b"
        assert body["global"]["nav_rail"] is True

    def test_empty_body_is_a_noop(self, client: TestClient) -> None:
        response = client.put("/settings/global", headers=_HEADERS, content=b"")
        assert response.status_code == 200
        assert response.json()["global"] == _get(client)["global"]

    def test_all_global_keys_accepted(self, client: TestClient) -> None:
        payload = {
            "chat_model": "m1",
            "vision_model": "m2",
            "tts_engine": "voicebox",
            "auto_speak": True,
            "stt_lang": "fr-FR",
            "thinking_enabled": True,
            "thinking_depth": "low",
            "nav_rail": False,
            "theme": "dark",
            "active_persona": "legal",
        }
        response = client.put("/settings/global", headers=_HEADERS, json=payload)
        assert response.status_code == 200
        assert response.json()["global"] == payload

    @pytest.mark.parametrize("value", ["system", "light", "dark"])
    def test_theme_choices_accepted(self, client: TestClient, value: str) -> None:
        response = client.put("/settings/global", headers=_HEADERS, json={"theme": value})
        assert response.status_code == 200
        assert response.json()["global"]["theme"] == value
        assert _get(client)["global"]["theme"] == value


# ---------------------------------------------------------------------------
# Per-user isolation
# ---------------------------------------------------------------------------


class TestUserIsolation:
    def test_write_is_invisible_to_other_user(self, client: TestClient) -> None:
        client.put(
            "/settings/global",
            headers={"X-Auth-User": "alice"},
            json={"chat_model": "alice-model"},
        )
        bob = _get(client, user="bob")
        assert bob["global"]["chat_model"] == "gemma4:e4b"

        alice = _get(client, user="alice")
        assert alice["global"]["chat_model"] == "alice-model"

    def test_persona_override_isolated(self, client: TestClient) -> None:
        client.put(
            "/settings/persona/assistant",
            headers={"X-Auth-User": "alice"},
            json={"thinking_enabled": True},
        )
        bob = _get(client, user="bob")
        assert bob["personas"]["assistant"]["thinking_enabled"] is None


# ---------------------------------------------------------------------------
# PUT /settings/persona/{k}
# ---------------------------------------------------------------------------


class TestPutPersona:
    def test_english_editor_editor_mode_and_thinking(self, client: TestClient) -> None:
        response = client.put(
            "/settings/persona/englishEditor",
            headers=_HEADERS,
            json={"editor_mode": "changes", "thinking_enabled": True},
        )
        assert response.status_code == 200
        assert response.json()["persona"] == {
            "thinking_enabled": True,
            "thinking_depth": None,
            "tts_engine": None,
            "editor_mode": "changes",
            "icon": main._PERSONA_ICONS["englishEditor"],
        }
        assert _get(client)["personas"]["englishEditor"]["editor_mode"] == "changes"

    def test_null_deletes_an_override(self, client: TestClient) -> None:
        client.put(
            "/settings/persona/assistant",
            headers=_HEADERS,
            json={"thinking_enabled": True, "tts_engine": "voicebox"},
        )
        response = client.put(
            "/settings/persona/assistant",
            headers=_HEADERS,
            json={"thinking_enabled": None},
        )
        assert response.status_code == 200
        persona = response.json()["persona"]
        assert persona["thinking_enabled"] is None
        assert persona["tts_engine"] == "voicebox"

        with main._db() as conn:
            rows = main._stored(conn, _USER, "persona:assistant")
        assert "thinking_enabled" not in rows
        assert rows["tts_engine"] == "voicebox"

    def test_editor_mode_rejected_for_assistant(self, client: TestClient) -> None:
        response = client.put(
            "/settings/persona/assistant",
            headers=_HEADERS,
            json={"editor_mode": "clean"},
        )
        assert response.status_code == 422
        assert response.json()["ok"] is False

    def test_default_analysis_view_accepted_for_professional(self, client: TestClient) -> None:
        response = client.put(
            "/settings/persona/professional",
            headers=_HEADERS,
            json={"default_analysis_view": "text"},
        )
        assert response.status_code == 200
        assert response.json()["persona"]["default_analysis_view"] == "text"
        assert _get(client)["personas"]["professional"]["default_analysis_view"] == "text"

    def test_default_analysis_view_rejected_for_assistant(self, client: TestClient) -> None:
        response = client.put(
            "/settings/persona/assistant",
            headers=_HEADERS,
            json={"default_analysis_view": "text"},
        )
        assert response.status_code == 422

    def test_default_analysis_view_bad_value_rejected(self, client: TestClient) -> None:
        response = client.put(
            "/settings/persona/professional",
            headers=_HEADERS,
            json={"default_analysis_view": "grid"},
        )
        assert response.status_code == 422

    def test_default_analysis_view_null_rejected(self, client: TestClient) -> None:
        response = client.put(
            "/settings/persona/professional",
            headers=_HEADERS,
            json={"default_analysis_view": None},
        )
        assert response.status_code == 422

    def test_unknown_persona_is_404(self, client: TestClient) -> None:
        response = client.put(
            "/settings/persona/nope", headers=_HEADERS, json={"thinking_enabled": True}
        )
        assert response.status_code == 404
        assert response.json() == {"ok": False, "error": "unknown persona: nope"}

    def test_unknown_persona_key_in_body_is_422(self, client: TestClient) -> None:
        response = client.put(
            "/settings/persona/assistant",
            headers=_HEADERS,
            json={"chat_model": "x"},
        )
        assert response.status_code == 422


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------


class TestValidation:
    @pytest.mark.parametrize(
        "payload",
        [
            {"tts_engine": "festival"},
            {"thinking_depth": "extreme"},
            {"auto_speak": "true"},
            {"auto_speak": 1},
            {"chat_model": ""},
            {"chat_model": "   "},
            {"chat_model": "x" * 201},
            {"stt_lang": "english"},
            {"stt_lang": "EN-us"},
            {"nav_rail": None},
            {"theme": "solarized"},
            {"theme": None},
            {"active_persona": "wizard"},
            {"totally_unknown_key": "x"},
        ],
    )
    def test_bad_global_values_return_422(self, client: TestClient, payload: dict) -> None:
        response = client.put("/settings/global", headers=_HEADERS, json=payload)
        assert response.status_code == 422
        body = response.json()
        assert body["ok"] is False
        assert isinstance(body["error"], str) and body["error"]

    @pytest.mark.parametrize(
        "payload",
        [
            {"thinking_depth": "extreme"},
            {"tts_engine": "festival"},
            {"thinking_enabled": "yes"},
        ],
    )
    def test_bad_persona_values_return_422(self, client: TestClient, payload: dict) -> None:
        response = client.put("/settings/persona/creative", headers=_HEADERS, json=payload)
        assert response.status_code == 422

    def test_valid_stt_lang_variants_accepted(self, client: TestClient) -> None:
        for lang in ("en", "en-US", "fr-FR", "zh-Hans-CN", "de-DE-1996"):
            response = client.put("/settings/global", headers=_HEADERS, json={"stt_lang": lang})
            assert response.status_code == 200, lang

    def test_malformed_json_body_returns_422(self, client: TestClient) -> None:
        response = client.put("/settings/global", headers=_HEADERS, content=b"{not json")
        assert response.status_code == 422
        assert response.json()["ok"] is False

    def test_non_object_json_body_returns_422(self, client: TestClient) -> None:
        response = client.put("/settings/global", headers=_HEADERS, json=[1, 2, 3])
        assert response.status_code == 422

    def test_editor_mode_null_rejected(self, client: TestClient) -> None:
        response = client.put(
            "/settings/persona/englishEditor",
            headers=_HEADERS,
            json={"editor_mode": None},
        )
        assert response.status_code == 422


# ---------------------------------------------------------------------------
# POST /settings/reset
# ---------------------------------------------------------------------------


class TestReset:
    def _seed(self, client: TestClient) -> None:
        client.put(
            "/settings/global",
            headers=_HEADERS,
            json={"chat_model": "custom", "nav_rail": False, "auto_speak": True},
        )
        client.put(
            "/settings/persona/englishEditor",
            headers=_HEADERS,
            json={"editor_mode": "explain", "thinking_enabled": True},
        )

    def test_reset_global_whole_scope(self, client: TestClient) -> None:
        self._seed(client)
        response = client.post("/settings/reset", headers=_HEADERS, json={"scope": "global"})
        assert response.status_code == 200
        assert response.json() == {"ok": True}
        body = _get(client)
        assert body["global"]["chat_model"] == "gemma4:e4b"
        assert body["global"]["nav_rail"] is True
        # persona override untouched
        assert body["personas"]["englishEditor"]["editor_mode"] == "explain"

    def test_reset_global_key_subset(self, client: TestClient) -> None:
        self._seed(client)
        response = client.post(
            "/settings/reset",
            headers=_HEADERS,
            json={"scope": "global", "keys": ["chat_model"]},
        )
        assert response.status_code == 200
        body = _get(client)
        assert body["global"]["chat_model"] == "gemma4:e4b"
        # not in the keys list -> still customised
        assert body["global"]["nav_rail"] is False
        assert body["global"]["auto_speak"] is True

    def test_reset_persona_scope(self, client: TestClient) -> None:
        self._seed(client)
        response = client.post(
            "/settings/reset",
            headers=_HEADERS,
            json={"scope": "persona:englishEditor"},
        )
        assert response.status_code == 200
        body = _get(client)
        assert body["personas"]["englishEditor"] == {
            "thinking_enabled": None,
            "thinking_depth": None,
            "tts_engine": None,
            "editor_mode": "clean",
            "icon": main._PERSONA_ICONS["englishEditor"],
        }
        # global untouched
        assert body["global"]["chat_model"] == "custom"

    def test_reset_all(self, client: TestClient) -> None:
        self._seed(client)
        response = client.post("/settings/reset", headers=_HEADERS, json={"scope": "all"})
        assert response.status_code == 200
        with main._db() as conn:
            count = conn.execute(
                "SELECT COUNT(*) FROM settings WHERE username = ?", (_USER,)
            ).fetchone()[0]
        assert count == 0

    def test_reset_all_only_affects_the_caller(self, client: TestClient) -> None:
        self._seed(client)
        client.put(
            "/settings/global",
            headers={"X-Auth-User": "bob"},
            json={"chat_model": "bob-model"},
        )
        client.post("/settings/reset", headers=_HEADERS, json={"scope": "all"})
        assert _get(client, user="bob")["global"]["chat_model"] == "bob-model"

    def test_reset_empty_keys_list_deletes_nothing(self, client: TestClient) -> None:
        self._seed(client)
        client.post(
            "/settings/reset",
            headers=_HEADERS,
            json={"scope": "global", "keys": []},
        )
        assert _get(client)["global"]["chat_model"] == "custom"

    def test_reset_unknown_persona_scope_422(self, client: TestClient) -> None:
        response = client.post(
            "/settings/reset", headers=_HEADERS, json={"scope": "persona:ghost"}
        )
        assert response.status_code == 422

    def test_reset_bad_scope_422(self, client: TestClient) -> None:
        response = client.post("/settings/reset", headers=_HEADERS, json={"scope": "everything"})
        assert response.status_code == 422

    def test_reset_missing_scope_422(self, client: TestClient) -> None:
        response = client.post("/settings/reset", headers=_HEADERS, json={})
        assert response.status_code == 422

    def test_reset_bad_keys_type_422(self, client: TestClient) -> None:
        response = client.post(
            "/settings/reset",
            headers=_HEADERS,
            json={"scope": "global", "keys": "chat_model"},
        )
        assert response.status_code == 422


# ---------------------------------------------------------------------------
# Auth header
# ---------------------------------------------------------------------------


class TestAuthHeader:
    def test_missing_header_is_401(self, client: TestClient) -> None:
        response = client.get("/settings")
        assert response.status_code == 401
        assert response.json()["ok"] is False

    @pytest.mark.parametrize("bad", ["a b", "x" * 100, "bad/user", "a.b", "a:b"])
    def test_malformed_header_is_401(self, client: TestClient, bad: str) -> None:
        response = client.get("/settings", headers={"X-Auth-User": bad})
        assert response.status_code == 401

    def test_all_write_routes_require_auth(self, client: TestClient) -> None:
        assert client.put("/settings/global", json={}).status_code == 401
        assert client.put("/settings/persona/assistant", json={}).status_code == 401
        assert client.post("/settings/reset", json={"scope": "all"}).status_code == 401

    def test_valid_username_shapes_accepted(self, client: TestClient) -> None:
        for name in ("alice", "USER_1", "a-b-c", "x" * 64, "9"):
            response = client.get("/settings", headers={"X-Auth-User": name})
            assert response.status_code == 200, name


# ---------------------------------------------------------------------------
# Environment-driven defaults
# ---------------------------------------------------------------------------


class TestEnvDefaults:
    def test_chat_model_env_override_reflected_everywhere(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("VPAL_DEFAULT_CHAT_MODEL", "phi3:mini")
        body = _get(client)
        assert body["global"]["chat_model"] == "phi3:mini"
        assert body["defaults"]["global"]["chat_model"] == "phi3:mini"

    def test_bool_env_override_coerced(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("VPAL_DEFAULT_NAV_RAIL", "false")
        monkeypatch.setenv("VPAL_DEFAULT_THINKING", "1")
        body = _get(client)
        assert body["global"]["nav_rail"] is False
        assert body["global"]["thinking_enabled"] is True

    def test_stored_value_still_wins_over_env_default(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        client.put("/settings/global", headers=_HEADERS, json={"chat_model": "stored"})
        monkeypatch.setenv("VPAL_DEFAULT_CHAT_MODEL", "env-model")
        body = _get(client)
        assert body["global"]["chat_model"] == "stored"
        assert body["defaults"]["global"]["chat_model"] == "env-model"


# ---------------------------------------------------------------------------
# Storage round-trip
# ---------------------------------------------------------------------------


class TestStorageRoundTrip:
    def test_value_column_stores_json(self, client: TestClient) -> None:
        client.put(
            "/settings/global",
            headers=_HEADERS,
            json={"nav_rail": False, "chat_model": "m"},
        )
        conn = sqlite3.connect(os.environ["SETTINGS_DB_PATH"])
        try:
            rows = {
                key: value
                for key, value in conn.execute(
                    "SELECT key, value FROM settings WHERE scope = 'global'"
                ).fetchall()
            }
        finally:
            conn.close()
        assert json.loads(rows["nav_rail"]) is False
        assert json.loads(rows["chat_model"]) == "m"

    def test_types_round_trip_through_get(self, client: TestClient) -> None:
        client.put(
            "/settings/global",
            headers=_HEADERS,
            json={"auto_speak": True, "thinking_enabled": False},
        )
        body = _get(client)
        assert body["global"]["auto_speak"] is True
        assert body["global"]["thinking_enabled"] is False
