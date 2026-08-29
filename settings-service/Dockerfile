# Stage 1 — build: install dependencies using the dev image (has pip)
# Digest-pinned for reproducibility — update with: docker pull cgr.dev/chainguard/python:latest-dev
FROM cgr.dev/chainguard/python:latest-dev@sha256:d22879bdbaba0c4f5f20ab73f60408fa4b3924a46fdb9c2dd63a40ba63754e28 AS builder

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir --target=/app/packages -r requirements.txt

# Seed directory for the SQLite data dir. The Chainguard build stage runs as
# nonroot and can't mkdir at /, so create it under the writable WORKDIR; the
# runtime COPY (which runs as root) materialises it at /data with uid-65532
# ownership. Docker then initialises the empty `vpal-settings-data` named
# volume from that directory's contents *and* permissions on first mount — so
# uid 65532 can write settings.db + the WAL/SHM sidecars.
RUN mkdir -p /app/data_seed && : > /app/data_seed/.keep

# Stage 2 — runtime: distroless, no shell, no pip, non-root (uid=65532)
# ENTRYPOINT is /usr/bin/python (baked into the Chainguard image).
# CMD provides only the arguments that follow the python executable.
# Digest-pinned for reproducibility — update with: docker pull cgr.dev/chainguard/python:latest
FROM cgr.dev/chainguard/python:latest@sha256:5d24c87a044aa2597e12d2788751f138460653fe88a638eb456dd6b9b6a5499e

ENV PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app/packages

WORKDIR /app

COPY --from=builder /app/packages /app/packages
COPY --from=builder --chown=65532:65532 /app/data_seed/ /data/
COPY main.py .

EXPOSE 8005

# Exec form required — distroless image has no shell for shell-form HEALTHCHECK.
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD ["/usr/bin/python", "-c", \
       "import urllib.request; urllib.request.urlopen('http://localhost:8005/health')"]

CMD ["-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8005"]
