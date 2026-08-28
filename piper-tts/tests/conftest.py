"""Shared pytest configuration for the piper-tts test suite.

Adjusts sys.path so ``main`` resolves regardless of where pytest is invoked
from, matching the pattern used by ``doc-extract/tests/conftest.py``, and
disables the eager voice-model load so importing ``main`` (and using
``TestClient`` as a context manager) never touches the ~60 MB model.
"""

import os
import sys

os.environ.setdefault("PIPER_EAGER_LOAD", "0")

_service_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _service_dir)
