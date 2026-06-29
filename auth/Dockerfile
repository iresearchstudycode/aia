# Stage 1 — build: install dependencies using the dev image (has pip)
FROM cgr.dev/chainguard/python:3.12-dev AS builder

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir --prefix=/install -r requirements.txt

# Stage 2 — runtime: distroless, no shell, no pip, non-root (uid=65532)
FROM cgr.dev/chainguard/python:3.12

ENV PYTHONUNBUFFERED=1

WORKDIR /app

# Copy installed packages and console scripts from the build stage
COPY --from=builder /install/lib /usr/lib
COPY --from=builder /install/bin /usr/bin

COPY main.py .
COPY static/ static/

EXPOSE 9000

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD python -c \
    "import urllib.request; urllib.request.urlopen('http://localhost:9000/health')" \
    || exit 1

CMD ["python", "-m", "uvicorn", "main:app", "--host", "0.0.0.0", "--port", "9000"]
