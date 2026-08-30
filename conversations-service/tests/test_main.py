"""Tests for the conversations-service."""

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


def _get_conversations(
    client: TestClient, user: str = _USER, q: str = "", limit: int = 50, offset: int = 0
) -> dict:
    """Helper to GET /conversations."""
    response = client.get(
        "/conversations",
        params={"q": q, "limit": limit, "offset": offset},
        headers={"X-Auth-User": user},
    )
    assert response.status_code == 200
    return response.json()


def _put_conversation(
    client: TestClient,
    conv_id: str,
    title: str = "Test",
    persona_key: str = "",
    message_count: int = 0,
    body: list = None,
    user: str = _USER,
) -> dict:
    """Helper to PUT a conversation."""
    if body is None:
        body = []
    response = client.put(
        f"/conversations/{conv_id}",
        headers={"X-Auth-User": user},
        json={
            "title": title,
            "persona_key": persona_key,
            "message_count": message_count,
            "body": body,
        },
    )
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
        conn = sqlite3.connect(os.environ["CONVERSATIONS_DB_PATH"])
        try:
            names = [
                row[0]
                for row in conn.execute(
                    "SELECT name FROM sqlite_master WHERE type = 'table'"
                ).fetchall()
            ]
        finally:
            conn.close()
        assert "conversations" in names

    def test_wal_mode_enabled(self, client: TestClient) -> None:
        # A write must have happened for -wal to appear; force one first.
        _put_conversation(client, "c-test-1")
        with main._db() as conn:
            mode = conn.execute("PRAGMA journal_mode").fetchone()[0]
        assert mode.lower() == "wal"


# ---------------------------------------------------------------------------
# GET /conversations — empty and fresh user
# ---------------------------------------------------------------------------


class TestGetConversationsFresh:
    def test_fresh_user_empty(self, client: TestClient) -> None:
        body = _get_conversations(client)
        assert body == {"conversations": [], "total": 0, "cap": 100}

    def test_fresh_user_cap_value(self, client: TestClient) -> None:
        body = _get_conversations(client)
        # Default cap should be 100
        assert body["cap"] == 100


# ---------------------------------------------------------------------------
# PUT and GET — basic CRUD
# ---------------------------------------------------------------------------


class TestBasicCrud:
    def test_put_new_creates_with_timestamps(self, client: TestClient) -> None:
        response = _put_conversation(client, "c-1", title="My Chat", persona_key="assistant")
        assert response["ok"] is True
        assert response["id"] == "c-1"
        assert "created_at" in response
        assert "updated_at" in response
        assert response["created_at"] == response["updated_at"]

    def test_get_full_conversation(self, client: TestClient) -> None:
        _put_conversation(client, "c-1", title="Test", body=[{"role": "user", "content": "hi"}])
        response = client.get("/conversations/c-1", headers=_HEADERS)
        assert response.status_code == 200
        data = response.json()
        assert data["id"] == "c-1"
        assert data["title"] == "Test"
        assert data["body"] == [{"role": "user", "content": "hi"}]
        assert "created_at" in data
        assert "updated_at" in data

    def test_get_conversations_list_has_no_body(self, client: TestClient) -> None:
        _put_conversation(client, "c-1", body=[{"role": "user"}])
        body = _get_conversations(client)
        assert len(body["conversations"]) == 1
        assert "body" not in body["conversations"][0]
        assert body["conversations"][0]["id"] == "c-1"

    def test_put_existing_updates_updated_at(self, client: TestClient) -> None:
        result1 = _put_conversation(client, "c-1", title="First")
        created_at_1 = result1["created_at"]
        updated_at_1 = result1["updated_at"]

        # Wait a bit and update
        import time

        time.sleep(0.01)

        result2 = _put_conversation(client, "c-1", title="Updated")
        created_at_2 = result2["created_at"]
        updated_at_2 = result2["updated_at"]

        # created_at should stay the same, updated_at should advance
        assert created_at_2 == created_at_1
        assert updated_at_2 > updated_at_1

    def test_put_existing_keeps_created_at(self, client: TestClient) -> None:
        result1 = _put_conversation(client, "c-1")
        created_at = result1["created_at"]

        result2 = _put_conversation(client, "c-1", title="Updated")
        assert result2["created_at"] == created_at

    def test_delete_existing_returns_ok(self, client: TestClient) -> None:
        _put_conversation(client, "c-1")
        response = client.delete("/conversations/c-1", headers=_HEADERS)
        assert response.status_code == 200
        assert response.json() == {"ok": True}

    def test_get_deleted_returns_404(self, client: TestClient) -> None:
        _put_conversation(client, "c-1")
        client.delete("/conversations/c-1", headers=_HEADERS)
        response = client.get("/conversations/c-1", headers=_HEADERS)
        assert response.status_code == 404


# ---------------------------------------------------------------------------
# Ordering and listing
# ---------------------------------------------------------------------------


class TestOrdering:
    def test_newest_first_by_updated_at(self, client: TestClient) -> None:
        import time

        _put_conversation(client, "c-1", title="First")
        time.sleep(0.01)
        _put_conversation(client, "c-2", title="Second")
        time.sleep(0.01)
        _put_conversation(client, "c-3", title="Third")

        body = _get_conversations(client)
        ids = [c["id"] for c in body["conversations"]]
        assert ids == ["c-3", "c-2", "c-1"]

    def test_update_bumps_to_newest(self, client: TestClient) -> None:
        import time

        _put_conversation(client, "c-1", title="First")
        time.sleep(0.01)
        _put_conversation(client, "c-2", title="Second")
        time.sleep(0.01)
        # Update c-1, should bump it to the top
        _put_conversation(client, "c-1", title="Updated")

        body = _get_conversations(client)
        ids = [c["id"] for c in body["conversations"]]
        assert ids == ["c-1", "c-2"]

    def test_pagination_limit_and_offset(self, client: TestClient) -> None:
        for i in range(10):
            _put_conversation(client, f"c-{i}")

        page1 = _get_conversations(client, limit=3, offset=0)
        assert len(page1["conversations"]) == 3
        assert page1["total"] == 10

        page2 = _get_conversations(client, limit=3, offset=3)
        assert len(page2["conversations"]) == 3

        # Make sure they're different
        ids1 = [c["id"] for c in page1["conversations"]]
        ids2 = [c["id"] for c in page2["conversations"]]
        assert ids1 != ids2


# ---------------------------------------------------------------------------
# Per-user isolation
# ---------------------------------------------------------------------------


class TestUserIsolation:
    def test_put_invisible_to_other_user(self, client: TestClient) -> None:
        _put_conversation(client, "c-1", title="Alice's chat", user="alice")
        bob_list = _get_conversations(client, user="bob")
        assert bob_list["total"] == 0

    def test_get_other_users_conversation_404(self, client: TestClient) -> None:
        _put_conversation(client, "c-1", user="alice")
        response = client.get("/conversations/c-1", headers={"X-Auth-User": "bob"})
        assert response.status_code == 404

    def test_put_other_users_conversation_404(self, client: TestClient) -> None:
        _put_conversation(client, "c-1", user="alice")
        response = client.put(
            "/conversations/c-1",
            headers={"X-Auth-User": "bob"},
            json={"title": "Hijack", "persona_key": "", "message_count": 0, "body": []},
        )
        assert response.status_code == 404  # Because the row belongs to another user
        # Verify alice's conversation is unchanged
        data = client.get("/conversations/c-1", headers={"X-Auth-User": "alice"}).json()
        assert data["title"] == "Test"  # The default title from _put_conversation

    def test_delete_other_users_conversation_200_noop(self, client: TestClient) -> None:
        _put_conversation(client, "c-1", user="alice")
        # Delete as bob (should be idempotent noop)
        response = client.delete("/conversations/c-1", headers={"X-Auth-User": "bob"})
        assert response.status_code == 200
        # Verify alice's still there
        data = client.get("/conversations/c-1", headers={"X-Auth-User": "alice"})
        assert data.status_code == 200

    def test_alice_isolation_not_affected_by_bob(self, client: TestClient) -> None:
        _put_conversation(client, "c-a", user="alice")
        _put_conversation(client, "c-b", user="bob")
        alice = _get_conversations(client, user="alice")
        assert alice["total"] == 1
        assert alice["conversations"][0]["id"] == "c-a"


# ---------------------------------------------------------------------------
# Filtering with q parameter
# ---------------------------------------------------------------------------


class TestFiltering:
    def test_q_filters_title_case_insensitive(self, client: TestClient) -> None:
        _put_conversation(client, "c-1", title="Python Help")
        _put_conversation(client, "c-2", title="JavaScript Tips")
        _put_conversation(client, "c-3", title="Python Advanced")

        result = _get_conversations(client, q="python")
        assert result["total"] == 2
        ids = [c["id"] for c in result["conversations"]]
        assert set(ids) == {"c-1", "c-3"}

    def test_q_empty_returns_all(self, client: TestClient) -> None:
        _put_conversation(client, "c-1", title="A")
        _put_conversation(client, "c-2", title="B")
        result = _get_conversations(client, q="")
        assert result["total"] == 2

    def test_q_partial_match(self, client: TestClient) -> None:
        _put_conversation(client, "c-1", title="Debugging Strategies")
        result = _get_conversations(client, q="bug")
        assert result["total"] == 1


# ---------------------------------------------------------------------------
# Message count and body
# ---------------------------------------------------------------------------


class TestMessageCountAndBody:
    def test_message_count_stored_and_returned(self, client: TestClient) -> None:
        _put_conversation(client, "c-1", message_count=5)
        result = _get_conversations(client)
        assert result["conversations"][0]["message_count"] == 5

    def test_body_with_complex_structure(self, client: TestClient) -> None:
        history = [
            {"role": "user", "content": "What is 2+2?"},
            {"role": "assistant", "content": "4", "thinking": "Simple math."},
        ]
        _put_conversation(client, "c-1", body=history)
        data = client.get("/conversations/c-1", headers=_HEADERS).json()
        assert data["body"] == history

    def test_empty_body_default(self, client: TestClient) -> None:
        _put_conversation(client, "c-1")
        # Fetch it
        data = client.get("/conversations/c-1", headers=_HEADERS).json()
        assert data["body"] == []


# ---------------------------------------------------------------------------
# Persona key validation
# ---------------------------------------------------------------------------


class TestPersonaKey:
    def test_persona_key_empty_string_allowed(self, client: TestClient) -> None:
        response = _put_conversation(client, "c-1", persona_key="")
        assert response["ok"] is True

    def test_persona_key_valid_values(self, client: TestClient) -> None:
        for persona in [
            "assistant",
            "creative",
            "englishEditor",
            "legal",
        ]:
            response = _put_conversation(client, f"c-{persona}", persona_key=persona)
            assert response["ok"] is True

    def test_persona_key_invalid_rejected(self, client: TestClient) -> None:
        response = client.put(
            "/conversations/c-1",
            headers=_HEADERS,
            json={
                "title": "Test",
                "persona_key": "invalid_persona",
                "message_count": 0,
                "body": [],
            },
        )
        assert response.status_code == 422

    def test_all_11_personas_accepted(self, client: TestClient) -> None:
        for persona in main._PERSONA_KEYS:
            response = _put_conversation(client, f"c-{persona}", persona_key=persona)
            assert response["ok"] is True


# ---------------------------------------------------------------------------
# Validation — title
# ---------------------------------------------------------------------------


class TestTitleValidation:
    def test_title_max_length(self, client: TestClient) -> None:
        long_title = "x" * 200
        response = _put_conversation(client, "c-1", title=long_title)
        assert response["ok"] is True

    def test_title_exceeds_max_rejected(self, client: TestClient) -> None:
        too_long = "x" * 201
        response = client.put(
            "/conversations/c-1",
            headers=_HEADERS,
            json={
                "title": too_long,
                "persona_key": "",
                "message_count": 0,
                "body": [],
            },
        )
        assert response.status_code == 422

    def test_title_non_string_rejected(self, client: TestClient) -> None:
        response = client.put(
            "/conversations/c-1",
            headers=_HEADERS,
            json={
                "title": 123,
                "persona_key": "",
                "message_count": 0,
                "body": [],
            },
        )
        assert response.status_code == 422


# ---------------------------------------------------------------------------
# Validation — message_count
# ---------------------------------------------------------------------------


class TestMessageCountValidation:
    def test_message_count_non_negative(self, client: TestClient) -> None:
        response = client.put(
            "/conversations/c-1",
            headers=_HEADERS,
            json={
                "title": "Test",
                "persona_key": "",
                "message_count": -1,
                "body": [],
            },
        )
        assert response.status_code == 422

    def test_message_count_non_integer_rejected(self, client: TestClient) -> None:
        response = client.put(
            "/conversations/c-1",
            headers=_HEADERS,
            json={
                "title": "Test",
                "persona_key": "",
                "message_count": "five",
                "body": [],
            },
        )
        assert response.status_code == 422


# ---------------------------------------------------------------------------
# Validation — body size (1 MiB limit)
# ---------------------------------------------------------------------------


class TestBodySizeValidation:
    def test_body_1mib_limit(self, client: TestClient) -> None:
        # Create a body just under 1 MiB
        # 1 MiB = 1048576 bytes. Let's create a list with many messages.
        large_text = "x" * 50000  # 50K chars per message
        body = [{"role": "user", "content": large_text} for _ in range(20)]  # ~1 MB
        serialized = json.dumps(body)
        if len(serialized.encode("utf-8")) <= 1048576:
            response = _put_conversation(client, "c-1", body=body)
            assert response["ok"] is True

    def test_body_exceeds_1mib_rejected(self, client: TestClient) -> None:
        # Create a body that definitely exceeds 1 MiB when serialized
        large_text = "x" * 1000000  # 1M chars
        body = [{"role": "user", "content": large_text} for _ in range(2)]  # > 2 MB
        response = client.put(
            "/conversations/c-1",
            headers=_HEADERS,
            json={
                "title": "Test",
                "persona_key": "",
                "message_count": 0,
                "body": body,
            },
        )
        assert response.status_code == 413


# ---------------------------------------------------------------------------
# Validation — unknown keys
# ---------------------------------------------------------------------------


class TestUnknownKeys:
    def test_unknown_top_level_key_rejected(self, client: TestClient) -> None:
        response = client.put(
            "/conversations/c-1",
            headers=_HEADERS,
            json={
                "title": "Test",
                "persona_key": "",
                "message_count": 0,
                "body": [],
                "extra_field": "not allowed",
            },
        )
        assert response.status_code == 422


# ---------------------------------------------------------------------------
# Validation — ID format
# ---------------------------------------------------------------------------


class TestIdValidation:
    def test_id_valid_format(self, client: TestClient) -> None:
        for valid_id in ["c-abc123", "c-test-1", "c_underscore", "id-with-dashes"]:
            response = _put_conversation(client, valid_id)
            assert response["ok"] is True

    def test_id_too_long_rejected(self, client: TestClient) -> None:
        bad_id = "x" * 65
        response = client.put(
            f"/conversations/{bad_id}",
            headers=_HEADERS,
            json={"title": "Test", "persona_key": "", "message_count": 0, "body": []},
        )
        assert response.status_code == 422

    def test_id_invalid_chars_rejected(self, client: TestClient) -> None:
        # IDs with invalid characters should return 422
        # Note: "/" in URL path doesn't match the /{conv_id} route, so returns 404
        for bad_id in ["c.bad", "c@id"]:
            response = client.put(
                f"/conversations/{bad_id}",
                headers=_HEADERS,
                json={"title": "Test", "persona_key": "", "message_count": 0, "body": []},
            )
            assert (
                response.status_code == 422
            ), f"Expected 422 for id {bad_id}, got {response.status_code}"


# ---------------------------------------------------------------------------
# Auth header validation
# ---------------------------------------------------------------------------


class TestAuthHeader:
    def test_missing_header_is_401(self, client: TestClient) -> None:
        response = client.get("/conversations")
        assert response.status_code == 401

    def test_malformed_header_is_401(self, client: TestClient) -> None:
        for bad in ["a b", "x" * 100, "bad/user", "a.b", "a:b"]:
            response = client.get("/conversations", headers={"X-Auth-User": bad})
            assert response.status_code == 401

    def test_valid_usernames_accepted(self, client: TestClient) -> None:
        for name in ["alice", "USER_1", "a-b-c", "x" * 64, "9"]:
            response = client.get("/conversations", headers={"X-Auth-User": name})
            assert response.status_code == 200, name


# ---------------------------------------------------------------------------
# Eviction — cap enforcement
# ---------------------------------------------------------------------------


class TestEviction:
    def test_eviction_on_cap_exceeded(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Monkeypatch max to 3
        monkeypatch.setenv("CONVERSATIONS_MAX_PER_USER", "3")
        import time

        # Add 3 conversations
        _put_conversation(client, "c-1")
        time.sleep(0.01)
        _put_conversation(client, "c-2")
        time.sleep(0.01)
        _put_conversation(client, "c-3")

        # Verify all 3 exist
        result = _get_conversations(client)
        assert result["total"] == 3

        # Add 4th — should evict oldest (c-1)
        time.sleep(0.01)
        _put_conversation(client, "c-4")

        result = _get_conversations(client)
        assert result["total"] == 3
        ids = [c["id"] for c in result["conversations"]]
        assert "c-1" not in ids
        assert set(ids) == {"c-2", "c-3", "c-4"}

    def test_eviction_only_affects_caller(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setenv("CONVERSATIONS_MAX_PER_USER", "2")
        import time

        # Alice adds 3
        _put_conversation(client, "c-a1", user="alice")
        time.sleep(0.01)
        _put_conversation(client, "c-a2", user="alice")
        time.sleep(0.01)
        _put_conversation(client, "c-a3", user="alice")

        # Bob adds 1
        _put_conversation(client, "c-b1", user="bob")

        # Alice should have 2, Bob should have 1
        alice = _get_conversations(client, user="alice")
        bob = _get_conversations(client, user="bob")
        assert alice["total"] == 2
        assert bob["total"] == 1


# ---------------------------------------------------------------------------
# Search
# ---------------------------------------------------------------------------


class TestSearch:
    def test_search_empty_q_400(self, client: TestClient) -> None:
        response = client.get("/conversations/search", params={"q": ""}, headers=_HEADERS)
        assert response.status_code == 400

    def test_search_whitespace_q_400(self, client: TestClient) -> None:
        response = client.get("/conversations/search", params={"q": "   "}, headers=_HEADERS)
        assert response.status_code == 400

    def test_search_missing_q_400(self, client: TestClient) -> None:
        response = client.get("/conversations/search", headers=_HEADERS)
        assert response.status_code == 400

    def test_search_title_match(self, client: TestClient) -> None:
        _put_conversation(client, "c-1", title="Python Help")
        _put_conversation(client, "c-2", title="JavaScript Tips")
        result = client.get(
            "/conversations/search", params={"q": "Python"}, headers=_HEADERS
        ).json()
        assert result["total"] == 1
        assert result["conversations"][0]["id"] == "c-1"

    def test_search_body_match(self, client: TestClient) -> None:
        body1 = [{"role": "user", "content": "How do I use decorators?"}]
        body2 = [{"role": "user", "content": "What is OOP?"}]
        _put_conversation(client, "c-1", body=body1)
        _put_conversation(client, "c-2", body=body2)

        result = client.get(
            "/conversations/search", params={"q": "decorators"}, headers=_HEADERS
        ).json()
        assert result["total"] == 1
        assert result["conversations"][0]["id"] == "c-1"

    def test_search_title_or_body(self, client: TestClient) -> None:
        _put_conversation(client, "c-1", title="Python", body=[])
        _put_conversation(client, "c-2", title="Other", body=[{"content": "Python code"}])
        result = client.get(
            "/conversations/search", params={"q": "Python"}, headers=_HEADERS
        ).json()
        assert result["total"] == 2

    def test_search_respects_limit_offset(self, client: TestClient) -> None:
        for i in range(5):
            _put_conversation(client, f"c-{i}", body=[{"content": "test"}])

        result = client.get(
            "/conversations/search",
            params={"q": "test", "limit": 2, "offset": 0},
            headers=_HEADERS,
        ).json()
        assert len(result["conversations"]) == 2
        assert result["total"] == 5

    def test_search_newest_first(self, client: TestClient) -> None:
        import time

        for i in range(3):
            _put_conversation(client, f"c-{i}", body=[{"content": "match"}])
            time.sleep(0.01)

        result = client.get(
            "/conversations/search", params={"q": "match"}, headers=_HEADERS
        ).json()
        ids = [c["id"] for c in result["conversations"]]
        # Should be newest first
        assert ids == ["c-2", "c-1", "c-0"]


# ---------------------------------------------------------------------------
# Idempotency
# ---------------------------------------------------------------------------


class TestIdempotency:
    def test_delete_nonexistent_200(self, client: TestClient) -> None:
        response = client.delete("/conversations/c-nonexistent", headers=_HEADERS)
        assert response.status_code == 200
        assert response.json() == {"ok": True}

    def test_delete_twice_both_200(self, client: TestClient) -> None:
        _put_conversation(client, "c-1")
        response1 = client.delete("/conversations/c-1", headers=_HEADERS)
        response2 = client.delete("/conversations/c-1", headers=_HEADERS)
        assert response1.status_code == 200
        assert response2.status_code == 200
