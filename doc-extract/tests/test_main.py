"""Tests for the doc-extract service."""

from unittest.mock import MagicMock

import pytest
from fastapi.testclient import TestClient

import main
from main import ExtractionError, _extract_text, app


@pytest.fixture()
def client() -> TestClient:
    return TestClient(app, raise_server_exceptions=True)


class _FakePage:
    def __init__(self, text: str) -> None:
        self._text = text

    def extract_text(self) -> str:
        return self._text


class _FakeReader:
    def __init__(self, pages: list[_FakePage], is_encrypted: bool = False) -> None:
        self.pages = pages
        self.is_encrypted = is_encrypted


# ---------------------------------------------------------------------------
# /health
# ---------------------------------------------------------------------------


class TestHealth:
    def test_returns_ok(self, client: TestClient) -> None:
        response = client.get("/health")
        assert response.status_code == 200
        assert response.json() == {"status": "ok"}


# ---------------------------------------------------------------------------
# _extract_text — pure(ish) orchestration logic, pypdf.PdfReader mocked
# ---------------------------------------------------------------------------


class TestExtractText:
    def test_joins_page_text_with_blank_line(self, monkeypatch: pytest.MonkeyPatch) -> None:
        reader = _FakeReader([_FakePage("Page one."), _FakePage("Page two.")])
        monkeypatch.setattr(main.pypdf, "PdfReader", MagicMock(return_value=reader))

        text, pages = _extract_text(b"irrelevant-bytes")

        assert text == "Page one.\n\nPage two."
        assert pages == 2

    def test_skips_blank_pages(self, monkeypatch: pytest.MonkeyPatch) -> None:
        reader = _FakeReader([_FakePage("Real text."), _FakePage(""), _FakePage("   ")])
        monkeypatch.setattr(main.pypdf, "PdfReader", MagicMock(return_value=reader))

        text, pages = _extract_text(b"irrelevant-bytes")

        assert text == "Real text."
        assert pages == 3

    def test_none_extract_text_treated_as_empty(self, monkeypatch: pytest.MonkeyPatch) -> None:
        # pypdf's extract_text() can return None for some malformed content streams.
        reader = _FakeReader([_FakePage(None)])
        monkeypatch.setattr(main.pypdf, "PdfReader", MagicMock(return_value=reader))

        text, pages = _extract_text(b"irrelevant-bytes")

        assert text == ""
        assert pages == 1

    def test_all_blank_pages_returns_empty_string(self, monkeypatch: pytest.MonkeyPatch) -> None:
        reader = _FakeReader([_FakePage(""), _FakePage("")])
        monkeypatch.setattr(main.pypdf, "PdfReader", MagicMock(return_value=reader))

        text, pages = _extract_text(b"irrelevant-bytes")

        assert text == ""
        assert pages == 2

    def test_raises_on_encrypted_pdf(self, monkeypatch: pytest.MonkeyPatch) -> None:
        reader = _FakeReader([], is_encrypted=True)
        monkeypatch.setattr(main.pypdf, "PdfReader", MagicMock(return_value=reader))

        with pytest.raises(ExtractionError, match="Encrypted"):
            _extract_text(b"irrelevant-bytes")

    def test_raises_on_parse_failure(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr(
            main.pypdf, "PdfReader", MagicMock(side_effect=RuntimeError("malformed PDF"))
        )

        with pytest.raises(ExtractionError, match="Could not read"):
            _extract_text(b"irrelevant-bytes")

    def test_genuinely_invalid_bytes_raise_via_real_pypdf(self) -> None:
        """No mocking — proves the real pypdf integration rejects garbage input."""
        with pytest.raises(ExtractionError):
            _extract_text(b"this is not a pdf file at all")


# ---------------------------------------------------------------------------
# POST /doc-extract/extract — route-level behaviour
# ---------------------------------------------------------------------------


class TestExtractRoute:
    def test_rejects_non_pdf_extension_and_content_type(self, client: TestClient) -> None:
        response = client.post(
            "/doc-extract/extract",
            files={"file": ("notes.txt", b"hello", "text/plain")},
        )
        assert response.status_code == 400
        assert response.json()["ok"] is False

    def test_accepts_pdf_extension_with_generic_content_type(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        # Some browsers send application/octet-stream for a .pdf file; the
        # filename extension is the fallback check.
        monkeypatch.setattr(main, "_extract_text", MagicMock(return_value=("hello", 1)))
        response = client.post(
            "/doc-extract/extract",
            files={"file": ("notes.pdf", b"%PDF-fake", "application/octet-stream")},
        )
        assert response.status_code == 200

    def test_rejects_empty_file(self, client: TestClient) -> None:
        response = client.post(
            "/doc-extract/extract",
            files={"file": ("notes.pdf", b"", "application/pdf")},
        )
        assert response.status_code == 400

    def test_rejects_file_over_size_limit(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(main, "_MAX_UPLOAD_BYTES", 10)
        response = client.post(
            "/doc-extract/extract",
            files={"file": ("notes.pdf", b"x" * 11, "application/pdf")},
        )
        assert response.status_code == 413

    def test_successful_extraction(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(main, "_extract_text", MagicMock(return_value=("Hello world.", 2)))
        response = client.post(
            "/doc-extract/extract",
            files={"file": ("notes.pdf", b"%PDF-fake-bytes", "application/pdf")},
        )
        assert response.status_code == 200
        assert response.json() == {
            "ok": True,
            "text": "Hello world.",
            "pages": 2,
            "truncated": False,
        }

    def test_returns_422_on_extraction_error(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(
            main,
            "_extract_text",
            MagicMock(side_effect=ExtractionError("Could not read this PDF.")),
        )
        response = client.post(
            "/doc-extract/extract",
            files={"file": ("notes.pdf", b"%PDF-fake-bytes", "application/pdf")},
        )
        assert response.status_code == 422
        assert response.json() == {"ok": False, "error": "Could not read this PDF."}

    def test_truncates_text_over_max_chars(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(main, "_MAX_TEXT_CHARS", 5)
        monkeypatch.setattr(main, "_extract_text", MagicMock(return_value=("abcdefghij", 1)))
        response = client.post(
            "/doc-extract/extract",
            files={"file": ("notes.pdf", b"%PDF-fake-bytes", "application/pdf")},
        )
        body = response.json()
        assert response.status_code == 200
        assert body == {"ok": True, "text": "abcde", "pages": 1, "truncated": True}

    def test_full_end_to_end_with_invalid_pdf_bytes(self, client: TestClient) -> None:
        """No mocking anywhere — exercises the real route + real pypdf together."""
        response = client.post(
            "/doc-extract/extract",
            files={"file": ("garbage.pdf", b"not a real pdf", "application/pdf")},
        )
        assert response.status_code == 422
        assert response.json()["ok"] is False
