FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

# Non-root user — uid 1001, no home directory needed
RUN useradd --system --no-create-home --uid 1001 authuser

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt && \
    rm -rf /root/.cache

COPY main.py .
COPY static/ static/

USER 1001

EXPOSE 9000

HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD python -c \
    "import urllib.request; urllib.request.urlopen('http://localhost:9000/health')" \
    || exit 1

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "9000"]
