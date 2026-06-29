# Stage 1 — build: install dependencies using the dev image (has pip)
FROM cgr.dev/chainguard/python:latest-dev AS builder

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir --target=/app/packages -r requirements.txt

# Stage 2 — runtime: distroless, no shell, no pip, non-root (uid=65532)
# ENTRYPOINT is /usr/bin/python (baked into the Chainguard image).
# CMD provides only the arguments that follow the python executable.
FROM cgr.dev/chainguard/python:latest

ENV PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app/packages

WORKDIR /app

COPY --from=builder /app/packages /app/packages
COPY main.py .
COPY static/ static/

EXPOSE 9000

# Exec form required — distroless image has no shell for shell-form HEALTHCHECK.
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD ["/usr/bin/python", "-c", \
       "import urllib.request; urllib.request.urlopen('http://localhost:9000/health')"]

CMD ["-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "9000"]
