"""Pytest test suite for auth/main.py.

Coverage:
- Brute-force lockout: _is_locked, _record_failure, _clear_failures
- TOTP replay protection: _is_code_replay, _mark_code_used
- CSRF token derivation: _make_csrf_token
- User loading: _load_users
- Session validation: _validate_session
- Route handlers: /health, /auth/verify, /auth/login (GET+POST), /auth/logout, /auth/setup
"""

import time

import pyotp
import pytest
from fastapi.testclient import TestClient

import main
from main import (
    _LOCKOUT_ATTEMPTS,
    _LOCKOUT_SECONDS,
    _REPLAY_WINDOW_SECONDS,
    _clear_failures,
    _failed_attempts,
    _is_code_replay,
    _is_locked,
    _load_users,
    _make_csrf_token,
    _mark_code_used,
    _record_failure,
    _signer,
    _used_totp_codes,
    _validate_session,
    app,
)

_TEST_USER = "testuser"
_TEST_SECRET = "JBSWY3DPEHPK3PXP"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _valid_code() -> str:
    """Return the current TOTP code for the test user."""
    return pyotp.TOTP(_TEST_SECRET).now()


def _signed_session(username: str = _TEST_USER) -> str:
    """Return a freshly signed session token for ``username``."""
    return _signer.sign(username).decode()


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture
def client() -> TestClient:
    """A TestClient that runs the full FastAPI lifespan.

    base_url uses HTTPS so that cookies set with ``secure=True`` are included
    in subsequent requests — httpx only sends secure cookies to HTTPS URLs.
    The ASGI transport is in-process; no real TLS handshake occurs.
    """
    with TestClient(app, base_url="https://testserver", raise_server_exceptions=True) as c:
        yield c


# ---------------------------------------------------------------------------
# _load_users
# ---------------------------------------------------------------------------


class TestLoadUsers:
    def test_returns_configured_user(self) -> None:
        users = _load_users()
        assert _TEST_USER in users
        assert users[_TEST_USER] == _TEST_SECRET

    def test_ignores_incomplete_pairs(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("USER_2", "partial")
        # TOTP_SECRET_2 is absent — pair must be silently ignored
        users = _load_users()
        assert "partial" not in users

    def test_empty_env_returns_empty_dict(self, monkeypatch: pytest.MonkeyPatch) -> None:
        for i in range(1, 6):
            monkeypatch.delenv(f"USER_{i}", raising=False)
            monkeypatch.delenv(f"TOTP_SECRET_{i}", raising=False)
        assert _load_users() == {}

    def test_strips_whitespace_from_values(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("USER_3", "  spaceuser  ")
        monkeypatch.setenv("TOTP_SECRET_3", "  JBSWY3DPEHPK3PXP  ")
        users = _load_users()
        assert "spaceuser" in users
        assert users["spaceuser"] == "JBSWY3DPEHPK3PXP"


# ---------------------------------------------------------------------------
# Brute-force lockout
# ---------------------------------------------------------------------------


class TestBruteForce:
    def test_unlocked_initially(self) -> None:
        assert not _is_locked(_TEST_USER)

    def test_locks_at_threshold(self) -> None:
        for _ in range(_LOCKOUT_ATTEMPTS):
            _record_failure(_TEST_USER)
        assert _is_locked(_TEST_USER)

    def test_not_locked_below_threshold(self) -> None:
        for _ in range(_LOCKOUT_ATTEMPTS - 1):
            _record_failure(_TEST_USER)
        assert not _is_locked(_TEST_USER)

    def test_clear_failures_unlocks(self) -> None:
        for _ in range(_LOCKOUT_ATTEMPTS):
            _record_failure(_TEST_USER)
        _clear_failures(_TEST_USER)
        assert not _is_locked(_TEST_USER)

    def test_clear_failures_noop_for_unknown_user(self) -> None:
        _clear_failures("ghost")  # must not raise

    def test_expired_failures_do_not_count(self, monkeypatch: pytest.MonkeyPatch) -> None:
        # Inject old timestamps directly so no real sleep is needed.
        old_ts = time.monotonic() - _LOCKOUT_SECONDS - 1
        _failed_attempts[_TEST_USER] = [old_ts] * _LOCKOUT_ATTEMPTS
        assert not _is_locked(_TEST_USER)

    def test_login_locked_after_max_failures(self, client: TestClient) -> None:
        for _ in range(_LOCKOUT_ATTEMPTS):
            client.post("/auth/login", data={"username": _TEST_USER, "code": "000000"})
        resp = client.post("/auth/login", data={"username": _TEST_USER, "code": _valid_code()})
        assert resp.status_code == 401


# ---------------------------------------------------------------------------
# TOTP replay protection
# ---------------------------------------------------------------------------


class TestReplayProtection:
    def test_fresh_code_not_replay(self) -> None:
        assert not _is_code_replay(_TEST_USER, "123456")

    def test_marked_code_is_replay(self) -> None:
        _mark_code_used(_TEST_USER, "123456")
        assert _is_code_replay(_TEST_USER, "123456")

    def test_different_user_same_code_not_replay(self) -> None:
        _mark_code_used(_TEST_USER, "123456")
        assert not _is_code_replay("other", "123456")

    def test_different_code_same_user_not_replay(self) -> None:
        _mark_code_used(_TEST_USER, "123456")
        assert not _is_code_replay(_TEST_USER, "654321")

    def test_expired_entry_not_replay(self, monkeypatch: pytest.MonkeyPatch) -> None:
        # Insert an expired entry directly.
        old_ts = time.monotonic() - _REPLAY_WINDOW_SECONDS - 1
        _used_totp_codes[(_TEST_USER, "999999")] = old_ts
        assert not _is_code_replay(_TEST_USER, "999999")

    def test_expired_entry_pruned_after_check(self) -> None:
        old_ts = time.monotonic() - _REPLAY_WINDOW_SECONDS - 1
        _used_totp_codes[(_TEST_USER, "888888")] = old_ts
        _is_code_replay(_TEST_USER, "000000")
        assert (_TEST_USER, "888888") not in _used_totp_codes

    def test_login_rejects_replayed_code(self, client: TestClient) -> None:
        code = _valid_code()
        resp1 = client.post(
            "/auth/login",
            data={"username": _TEST_USER, "code": code},
            follow_redirects=False,
        )
        assert resp1.status_code == 302
        resp2 = client.post(
            "/auth/login",
            data={"username": _TEST_USER, "code": code},
            follow_redirects=False,
        )
        assert resp2.status_code == 401


# ---------------------------------------------------------------------------
# CSRF token derivation
# ---------------------------------------------------------------------------


class TestCsrfToken:
    def test_deterministic(self) -> None:
        assert _make_csrf_token("tok") == _make_csrf_token("tok")

    def test_different_inputs_differ(self) -> None:
        assert _make_csrf_token("tokenA") != _make_csrf_token("tokenB")

    def test_output_length_32(self) -> None:
        assert len(_make_csrf_token("any-session-token")) == 32

    def test_csrf_matches_session_after_login(self, client: TestClient) -> None:
        resp = client.post(
            "/auth/login",
            data={"username": _TEST_USER, "code": _valid_code()},
            follow_redirects=False,
        )
        assert resp.status_code == 302
        session_token = resp.cookies["vpal_session"]
        csrf_from_cookie = resp.cookies["vpal_csrf"]
        assert csrf_from_cookie == _make_csrf_token(session_token)


# ---------------------------------------------------------------------------
# Session validation
# ---------------------------------------------------------------------------


class TestValidateSession:
    def test_valid_cookie_returns_true(self) -> None:
        from starlette.requests import Request as StarletteRequest
        from starlette.datastructures import Headers

        scope = {
            "type": "http",
            "method": "GET",
            "path": "/",
            "query_string": b"",
            "headers": Headers(
                raw=[(b"cookie", f"vpal_session={_signed_session()}".encode())]
            ).raw,
        }
        request = StarletteRequest(scope)
        assert _validate_session(request)

    def test_missing_cookie_returns_false(self) -> None:
        from starlette.requests import Request as StarletteRequest
        from starlette.datastructures import Headers

        scope = {
            "type": "http",
            "method": "GET",
            "path": "/",
            "query_string": b"",
            "headers": Headers(raw=[]).raw,
        }
        request = StarletteRequest(scope)
        assert not _validate_session(request)

    def test_tampered_cookie_returns_false(self) -> None:
        from starlette.requests import Request as StarletteRequest
        from starlette.datastructures import Headers

        scope = {
            "type": "http",
            "method": "GET",
            "path": "/",
            "query_string": b"",
            "headers": Headers(raw=[(b"cookie", b"vpal_session=tampered.token.value")]).raw,
        }
        request = StarletteRequest(scope)
        assert not _validate_session(request)


# ---------------------------------------------------------------------------
# GET /health
# ---------------------------------------------------------------------------


class TestHealth:
    def test_returns_200_and_ok(self, client: TestClient) -> None:
        resp = client.get("/health")
        assert resp.status_code == 200
        assert resp.json() == {"status": "ok"}


# ---------------------------------------------------------------------------
# GET /auth/verify
# ---------------------------------------------------------------------------


class TestVerify:
    def test_no_cookie_returns_401(self, client: TestClient) -> None:
        resp = client.get("/auth/verify")
        assert resp.status_code == 401

    def test_valid_cookie_returns_200(self, client: TestClient) -> None:
        client.cookies.set("vpal_session", _signed_session())
        resp = client.get("/auth/verify")
        assert resp.status_code == 200

    def test_tampered_cookie_returns_401(self, client: TestClient) -> None:
        client.cookies.set("vpal_session", "bad.token.data")
        resp = client.get("/auth/verify")
        assert resp.status_code == 401

    def test_empty_cookie_returns_401(self, client: TestClient) -> None:
        client.cookies.set("vpal_session", "")
        resp = client.get("/auth/verify")
        assert resp.status_code == 401


# ---------------------------------------------------------------------------
# GET /auth/login
# ---------------------------------------------------------------------------


class TestLoginPage:
    def test_unauthenticated_returns_200_html(self, client: TestClient) -> None:
        resp = client.get("/auth/login", follow_redirects=False)
        assert resp.status_code == 200
        assert "text/html" in resp.headers["content-type"]

    def test_contains_login_form(self, client: TestClient) -> None:
        resp = client.get("/auth/login", follow_redirects=False)
        assert 'action="/auth/login"' in resp.text
        assert 'name="username"' in resp.text
        assert 'name="code"' in resp.text

    def test_authenticated_redirects_to_root(self, client: TestClient) -> None:
        client.cookies.set("vpal_session", _signed_session())
        resp = client.get("/auth/login", follow_redirects=False)
        assert resp.status_code == 302
        assert resp.headers["location"] == "/"


# ---------------------------------------------------------------------------
# POST /auth/login
# ---------------------------------------------------------------------------


class TestLoginPost:
    def test_valid_credentials_returns_302(self, client: TestClient) -> None:
        resp = client.post(
            "/auth/login",
            data={"username": _TEST_USER, "code": _valid_code()},
            follow_redirects=False,
        )
        assert resp.status_code == 302

    def test_valid_login_redirects_to_root(self, client: TestClient) -> None:
        resp = client.post(
            "/auth/login",
            data={"username": _TEST_USER, "code": _valid_code()},
            follow_redirects=False,
        )
        assert resp.headers["location"] == "/"

    def test_valid_login_sets_session_cookie(self, client: TestClient) -> None:
        resp = client.post(
            "/auth/login",
            data={"username": _TEST_USER, "code": _valid_code()},
            follow_redirects=False,
        )
        assert "vpal_session" in resp.cookies

    def test_valid_login_sets_csrf_cookie(self, client: TestClient) -> None:
        resp = client.post(
            "/auth/login",
            data={"username": _TEST_USER, "code": _valid_code()},
            follow_redirects=False,
        )
        assert "vpal_csrf" in resp.cookies

    def test_wrong_username_returns_401(self, client: TestClient) -> None:
        resp = client.post(
            "/auth/login",
            data={"username": "nobody", "code": _valid_code()},
        )
        assert resp.status_code == 401

    def test_wrong_code_returns_401(self, client: TestClient) -> None:
        resp = client.post(
            "/auth/login",
            data={"username": _TEST_USER, "code": "000000"},
        )
        assert resp.status_code == 401

    def test_wrong_code_records_failure(self, client: TestClient) -> None:
        client.post("/auth/login", data={"username": _TEST_USER, "code": "000000"})
        assert len(_failed_attempts[_TEST_USER]) == 1

    def test_correct_login_clears_prior_failures(self, client: TestClient) -> None:
        _record_failure(_TEST_USER)
        client.post(
            "/auth/login",
            data={"username": _TEST_USER, "code": _valid_code()},
            follow_redirects=False,
        )
        assert _TEST_USER not in _failed_attempts

    def test_unknown_username_does_not_increment_failures(self, client: TestClient) -> None:
        client.post("/auth/login", data={"username": "ghost", "code": "000000"})
        # Unknown user has no secret — lockout counter must NOT be incremented
        # to prevent DoS via pre-locking real accounts.
        assert "ghost" not in _failed_attempts

    def test_code_with_spaces_is_accepted(self, client: TestClient) -> None:
        raw_code = _valid_code()
        spaced = raw_code[:3] + " " + raw_code[3:]
        resp = client.post(
            "/auth/login",
            data={"username": _TEST_USER, "code": spaced},
            follow_redirects=False,
        )
        assert resp.status_code == 302

    def test_error_page_contains_generic_message(self, client: TestClient) -> None:
        resp = client.post(
            "/auth/login",
            data={"username": _TEST_USER, "code": "000000"},
        )
        # Error message must never reveal which field was wrong.
        assert "Invalid username, code, or too many attempts." in resp.text

    def test_error_page_does_not_reveal_username_existence(self, client: TestClient) -> None:
        resp_known = client.post("/auth/login", data={"username": _TEST_USER, "code": "000000"})
        resp_unknown = client.post("/auth/login", data={"username": "nobody", "code": "000000"})
        assert resp_known.text == resp_unknown.text


# ---------------------------------------------------------------------------
# POST /auth/logout
# ---------------------------------------------------------------------------


class TestLogout:
    def _login(self, client: TestClient) -> tuple[str, str]:
        """Return (session_token, csrf_token) after a successful login."""
        resp = client.post(
            "/auth/login",
            data={"username": _TEST_USER, "code": _valid_code()},
            follow_redirects=False,
        )
        assert resp.status_code == 302, "Login precondition failed"
        return resp.cookies["vpal_session"], resp.cookies["vpal_csrf"]

    def test_valid_csrf_returns_302(self, client: TestClient) -> None:
        _, csrf = self._login(client)
        resp = client.post("/auth/logout", data={"csrf_token": csrf}, follow_redirects=False)
        assert resp.status_code == 302

    def test_valid_csrf_redirects_to_login(self, client: TestClient) -> None:
        _, csrf = self._login(client)
        resp = client.post("/auth/logout", data={"csrf_token": csrf}, follow_redirects=False)
        assert resp.headers["location"] == "/auth/login"

    def test_missing_csrf_returns_403(self, client: TestClient) -> None:
        self._login(client)
        resp = client.post("/auth/logout", data={}, follow_redirects=False)
        assert resp.status_code == 403

    def test_wrong_csrf_returns_403(self, client: TestClient) -> None:
        self._login(client)
        resp = client.post("/auth/logout", data={"csrf_token": "a" * 32}, follow_redirects=False)
        assert resp.status_code == 403

    def test_no_session_cookie_returns_403(self, client: TestClient) -> None:
        resp = client.post("/auth/logout", data={"csrf_token": "anything"}, follow_redirects=False)
        assert resp.status_code == 403

    def test_csrf_mismatch_returns_403(self, client: TestClient) -> None:
        session_token, _ = self._login(client)
        # Craft a CSRF token for a *different* session.
        wrong_csrf = _make_csrf_token("different-session-token")
        resp = client.post("/auth/logout", data={"csrf_token": wrong_csrf}, follow_redirects=False)
        assert resp.status_code == 403


# ---------------------------------------------------------------------------
# GET /auth/setup
# ---------------------------------------------------------------------------


class TestSetup:
    def test_no_setup_token_env_returns_404(self, client: TestClient) -> None:
        # SETUP_TOKEN is not set in our test environment (_SETUP_TOKEN == "")
        resp = client.get("/auth/setup?token=anything")
        assert resp.status_code == 404

    def test_wrong_token_returns_404(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(main, "_SETUP_TOKEN", "correct-token")
        resp = client.get("/auth/setup?token=wrong-token")
        assert resp.status_code == 404

    def test_empty_token_returns_404(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(main, "_SETUP_TOKEN", "correct-token")
        resp = client.get("/auth/setup")
        assert resp.status_code == 404

    def test_correct_token_returns_200_html(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(main, "_SETUP_TOKEN", "correct-token")
        resp = client.get("/auth/setup?token=correct-token")
        assert resp.status_code == 200
        assert "text/html" in resp.headers["content-type"]

    def test_setup_page_contains_username(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(main, "_SETUP_TOKEN", "correct-token")
        resp = client.get("/auth/setup?token=correct-token")
        assert _TEST_USER in resp.text

    def test_setup_page_contains_qr_svg(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(main, "_SETUP_TOKEN", "correct-token")
        resp = client.get("/auth/setup?token=correct-token")
        assert "<svg" in resp.text
