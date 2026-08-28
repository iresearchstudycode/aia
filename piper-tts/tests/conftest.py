"""Shared pytest configuration for the piper-tts test suite.

Adjusts sys.path so ``main`` resolves regardless of where pytest is invoked
from, matching the pattern used by ``doc-extract/tests/conftest.py``.
"""

import os
import sys

_service_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _service_dir)
