"""Shared pytest configuration for the auth service test suite.

Must run before any import of ``main`` because ``main.py`` reads
``SECRET_KEY`` from the environment at module load time.  The ``os.chdir``
call is required so that ``StaticFiles(directory="static")`` inside
``main.py`` resolves to ``auth/static/`` regardless of where pytest is
invoked from.
"""

import os
import sys

# Change CWD to the auth/ package root so StaticFiles("static") resolves correctly.
_auth_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
os.chdir(_auth_dir)
sys.path.insert(0, _auth_dir)

# Set required env vars before main.py is imported (module-level reads).
os.environ.setdefault("SECRET_KEY", "a" * 32)
os.environ.setdefault("USER_1", "testuser")
os.environ.setdefault("TOTP_SECRET_1", "JBSWY3DPEHPK3PXP")

import pytest

from main import _failed_attempts, _used_totp_codes  # noqa: E402 — must follow env setup


@pytest.fixture(autouse=True)
def _reset_auth_state() -> None:
    """Clear in-memory brute-force and replay state between every test."""
    _failed_attempts.clear()
    _used_totp_codes.clear()
    yield
    _failed_attempts.clear()
    _used_totp_codes.clear()
