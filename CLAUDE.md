# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

VPAL (Voice-Powered AI Local) is a static web application — a secure, local-only AI chat interface with voice input/output, streaming responses, and 13 AI personas. It requires no build step; changes to files under `src/aia/` take effect immediately on reload.

## Running the Application

```bash
# Start the application
docker-compose up

# Access in browser
https://localhost/

# Reload Nginx config without restarting (for nginx.conf changes only)
docker exec vpal-nginx /usr/sbin/nginx -s reload

# Check container health
docker inspect --format='{{.State.Health.Status}}' vpal-nginx
```

**Prerequisites:**
- Docker Desktop running
- Ollama running on the Windows host at `localhost:11434` with the `gemma4:e4b` model pulled

## Architecture

```
Browser → HTTPS (port 443) / HTTP (port 80 → redirects to HTTPS)
       → Nginx (Docker, cgr.dev/chainguard/nginx, uid=65532)
           ├── Serves static files from src/aia/
           └── /ollama/* → reverse proxy → host.docker.internal:11434 (Ollama API)
```

Nginx handles TLS termination, HTTP→HTTPS redirect, and security headers (HSTS, CSP, X-Frame-Options). The container runs as a non-root user (uid=65532), read-only filesystem, with capabilities restricted to `NET_BIND_SERVICE` only.

## Docker Container Details

**Image:** `cgr.dev/chainguard/nginx` — distroless (no shell, no wget/curl). The healthcheck uses `nginx -t` (config validation) since no HTTP client is available.

**Writable paths (tmpfs):** `/var/lib/nginx/tmp` and `/var/run`, both owned by uid=65532. The container root filesystem is otherwise read-only.

**Capabilities:** Only `NET_BIND_SERVICE` is granted (to bind port 443 as non-root). All other capabilities are dropped.

**`host.docker.internal`** resolves to the Windows host via `extra_hosts: host-gateway`, allowing the Nginx proxy to reach Ollama at `localhost:11434`.

## JavaScript Module Architecture

Scripts are loaded in dependency order in `index.html`:

| Module | Responsibility |
|---|---|
| `marked.min.js` | Markdown parser (vendored, third-party) |
| `dompurify.min.js` | HTML sanitizer (vendored, v3.4.11) — applied at every AI content → innerHTML boundary |
| `config.js` | `MODEL_NAME`, `OLLAMA_API_URL`, and the 13 system prompt objects |
| `utils.js` | `formatTimestamp()`, `escapeHtml()` — pure helpers |
| `speech.js` | Web Speech API: continuous recognition with 3-second silence detection, TTS with voice preference ("Microsoft Catherine") |
| `chat.js` | `conversationHistory[]` (global state), message rendering, chat save/load |
| `api.js` | `streamOllamaResponse()` — streaming fetch, real-time markdown rendering, abort via `streamAbortController` |
| `main.js` | `DOMContentLoaded` wiring, event listeners, initialises default persona from the HTML `selected` attribute |

**Global state lives in `chat.js`** (`conversationHistory`, `currentSystemPrompt`) and is shared across modules via the window scope — there is no module bundler.

## Security Invariants

- All AI response content passes through `DOMPurify.sanitize(marked.parse(...))` before being set as `innerHTML` — in `api.js` (streaming), `chat.js` (`addAIMessage`, `renderConversationHistory`).
- User-supplied text uses `escapeHtml()` before insertion into `innerHTML` (`addUserMessage`, `renderConversationHistory`).
- The streaming fetch in `api.js` is wired to a module-level `streamAbortController`; call `stopStreaming()` to cancel mid-stream. The user message is rolled back from `conversationHistory` on abort or error.

## Key Configuration

All runtime configuration is in [src/aia/scripts/config.js](src/aia/scripts/config.js):

- `MODEL_NAME` — Ollama model to use (default: `gemma4:e4b`)
- `OLLAMA_API_URL` — proxied endpoint (default: `https://localhost/ollama/api/chat`)
- `MAX_HISTORY_MESSAGES` — maximum entries in `conversationHistory` before oldest pairs are trimmed (default: `40`, i.e. 20 exchanges). Tune this when switching to a model with a smaller or larger context window.
- System prompts object — keys map to `<option value>` in the persona selector dropdown

To add a new persona: add a key to the system prompts object in `config.js` and a matching `<option>` in the `#systemPromptSelect` dropdown in `index.html`. The default selected persona is controlled by the `selected` attribute in `index.html` — `main.js` reads it on load and sets `currentSystemPrompt` accordingly.

## Nginx Proxy

The `/ollama/` location block in [deploy/nginx/nginx.conf](deploy/nginx/nginx.conf) strips the prefix via a trailing slash on `proxy_pass` and forwards to `http://host.docker.internal:11434`. `proxy_buffering off` and `proxy_read_timeout 300s` are set to support streaming responses. If Ollama changes port or the model changes, update `deploy/nginx/nginx.conf` and `config.js` respectively, then restart the container.

## SSL Certificates

Self-signed certs are in `deploy/certs/` (generated via mkcert). Nginx is configured for TLS 1.2+. Regenerate with mkcert targeting `localhost` if they expire.
