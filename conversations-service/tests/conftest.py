"""Shared pytest configuration for the conversations-service test suite.

Adjusts ``sys.path`` so ``main`` resolves regardless of where pytest is
invoked from (matching ``settings-service/tests/conftest.py``) and points every
test at a throwaway SQLite file so no test can touch the real ``/data``
volume.
"""

import os
import sys

import pytest

_service_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _service_dir not in sys.path:
    sys.path.insert(0, _service_dir)


@pytest.fixture(autouse=True)
def _isolated_conversations_db(tmp_path, monkeypatch):
    """Give every test its own empty SQLite database."""
    monkeypatch.setenv("CONVERSATIONS_DB_PATH", str(tmp_path / "conversations.db"))
