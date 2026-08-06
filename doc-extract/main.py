"""Document text extraction service for VPAL.

Extracts plain text from an uploaded PDF so it can be embedded as context in
a chat message ("ask questions about this document"). .txt and .md files are
simple enough to be read directly by the browser and never reach this
service — PDF is the one format that needs a real parser.
"""

import io
import logging
import os

import pypdf
from fastapi import FastAPI, File, UploadFile
from fastapi.responses import JSONResponse

logger = logging.getLogger("doc_extract")

# ---------------------------------------------------------------------------
# Configuration (all values come from environment — never hardcoded)
# ---------------------------------------------------------------------------

_MAX_UPLOAD_BYTES: int = int(os.environ.get("MAX_UPLOAD_BYTES", str(15 * 1024 * 1024)))
# Sanity cap on extracted text — independent of (and much larger than) the
# frontend's own truncation budget for what actually gets sent to the model;
# this just bounds worst-case memory/response size for a pathological PDF.
_MAX_TEXT_CHARS: int = int(os.environ.get("MAX_TEXT_CHARS", "200000"))


class ExtractionError(Exception):
    """Raised when a PDF can't be read at all (corrupt, encrypted, scanned-image-only)."""


def _extract_text(data: bytes) -> tuple[str, int]:
    """Return (text, page_count) for a PDF's bytes, or raise ExtractionError."""
    try:
        reader = pypdf.PdfReader(io.BytesIO(data))
        if reader.is_encrypted:
            raise ExtractionError("Encrypted PDFs are not supported.")
        page_texts = [page.extract_text() or "" for page in reader.pages]
    except ExtractionError:
        raise
    except Exception as exc:
        logger.warning("PDF extraction failed: %s", exc)
        raise ExtractionError(
            "Could not read this PDF — it may be corrupted or scanned/image-only."
        ) from exc

    text = "\n\n".join(page.strip() for page in page_texts if page.strip())
    return text, len(page_texts)


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)


@app.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@app.post("/doc-extract/extract")
async def extract(file: UploadFile = File(...)) -> JSONResponse:
    """Extract text from an uploaded PDF."""
    filename = file.filename or ""
    is_pdf = file.content_type in (
        "application/pdf",
        "application/x-pdf",
    ) or filename.lower().endswith(".pdf")
    if not is_pdf:
        return JSONResponse(
            {"ok": False, "error": "Only PDF files are accepted."}, status_code=400
        )

    data = await file.read(_MAX_UPLOAD_BYTES + 1)
    if len(data) > _MAX_UPLOAD_BYTES:
        return JSONResponse(
            {
                "ok": False,
                "error": f"File exceeds the {_MAX_UPLOAD_BYTES // (1024 * 1024)} MB limit.",
            },
            status_code=413,
        )
    if not data:
        return JSONResponse({"ok": False, "error": "The uploaded file is empty."}, status_code=400)

    try:
        text, page_count = _extract_text(data)
    except ExtractionError as exc:
        return JSONResponse({"ok": False, "error": str(exc)}, status_code=422)

    truncated = len(text) > _MAX_TEXT_CHARS
    if truncated:
        text = text[:_MAX_TEXT_CHARS]

    return JSONResponse({"ok": True, "text": text, "pages": page_count, "truncated": truncated})
