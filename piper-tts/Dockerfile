# ---------------------------------------------------------------------------
# Base image divergence — this service uses python:3.12-slim, NOT the
# cgr.dev/chainguard/python distroless image every other VPAL service uses.
#
# Why: Piper pulls in onnxruntime, whose manylinux wheel segfaults (SIGSEGV)
# on `import onnxruntime` under the Chainguard distroless runtime image — it
# links against libstdc++/libgomp that the distroless image does not ship,
# and there is no shell/package manager there to add them. The Chainguard
# *-dev* image imports it fine, confirming the missing runtime libraries.
# python:3.12-slim runs the full synth pipeline cleanly. The user's global
# engineering standards explicitly permit `python:slim` + non-root, which is
# what this file does: multi-stage, digest-pinned, non-root uid 65532.
# ---------------------------------------------------------------------------

# Stage 1 — build: install dependencies and download + verify the voice model.
# Digest-pinned for reproducibility — update with: docker pull python:3.12-slim
FROM python:3.12-slim@sha256:09f7da3bc104798d0afb40bc08d23ab2da20a76130cec1f2ef170848f5d85217 AS builder

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir --target=/app/packages -r requirements.txt

# Piper voice model + config, pinned to rhasspy/piper-voices @ v1.0.0. NOT
# committed to git (~60 MB). `ADD --checksum` fails the build on any hash
# mismatch — the supply-chain equivalent of the Chainguard digest pins above.
ADD --checksum=sha256:5efe09e69902187827af646e1a6e9d269dee769f9877d17b16b1b46eeaaf019f \
    https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_US/lessac/medium/en_US-lessac-medium.onnx \
    /app/voices/en_US-lessac-medium.onnx
ADD --checksum=sha256:efe19c417bed055f2d69908248c6ba650fa135bc868b0e6abb3da181dab690a0 \
    https://huggingface.co/rhasspy/piper-voices/resolve/v1.0.0/en/en_US/lessac/medium/en_US-lessac-medium.onnx.json \
    /app/voices/en_US-lessac-medium.onnx.json

# ADD fetches remote files mode 0600 root-owned — make them world-readable so
# the non-root runtime user can load the model.
RUN chmod -R a+rX /app/voices

# Stage 2 — runtime: slim, non-root (uid 65532 to match the other services).
FROM python:3.12-slim@sha256:09f7da3bc104798d0afb40bc08d23ab2da20a76130cec1f2ef170848f5d85217

ENV PYTHONUNBUFFERED=1 \
    PYTHONPATH=/app/packages \
    PIPER_MODEL_DIR=/app/voices

WORKDIR /app

# Non-root user — uid/gid 65532 mirrors the Chainguard default the rest of
# the stack runs as, so docker-compose's tmpfs uid options stay consistent.
RUN groupadd --gid 65532 nonroot \
    && useradd --uid 65532 --gid 65532 --no-create-home --shell /usr/sbin/nologin nonroot

COPY --from=builder /app/packages /app/packages
COPY --from=builder /app/voices /app/voices
COPY main.py .

USER 65532

EXPOSE 8004

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD ["python", "-c", \
       "import urllib.request; urllib.request.urlopen('http://localhost:8004/health')"]

CMD ["python", "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8004"]
