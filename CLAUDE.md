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
- `.env` file in the project root with `SECRET_KEY`, `USER_1`, `TOTP_SECRET_1` (see `auth/main.py` for all supported vars)

## Testing

The auth service has a pytest suite. Run it from the `auth/` directory — `conftest.py` sets the required env vars and adjusts `sys.path` automatically.

```bash
# Install test dependencies (one-time)
pip install -r auth/requirements.txt -r auth/requirements-test.txt

# Run the full quality gate (mirrors CI exactly)
black auth/main.py auth/tests/ --check --line-length=99
flake8 auth/main.py auth/tests/ --max-line-length=99
cd auth && pytest tests/ -v

# Run a single test class or test
cd auth && pytest tests/ -v -k TestLogout
cd auth && pytest tests/test_main.py::TestBruteForce::test_locks_at_threshold -v
```

```bash
# Frontend JS lint (ESLint — run from repo root)
npm run lint:js

# Frontend HTML lint (HTMLHint — validates src/aia/index.html)
npm run lint:html
```

CI runs three jobs automatically on every push and PR to `master` (`.github/workflows/ci.yml`):
- `auth-lint-test` — black + flake8 + pytest
- `frontend-lint` — ESLint (`src/aia/scripts/*.js`) + HTMLHint (`src/aia/index.html`)
- `nginx-config-check` — generates dummy TLS certs, mounts `nginx.conf` into `nginx:1.27-alpine`, runs `nginx -t`

## Architecture

```
Browser → HTTPS (port 443) / HTTP (port 80 → redirects to HTTPS)
       → Nginx (Docker, cgr.dev/chainguard/nginx, uid=65532)
           ├── /auth/* → FastAPI auth service (cgr.dev/chainguard/python, uid=65532)
           │              POST /auth/login   — validates username + TOTP code, issues session cookie
           │              POST /auth/logout  — CSRF-verified, clears session
           │              GET  /auth/verify  — sub-request endpoint called by auth_request
           │              GET  /auth/setup   — one-time QR setup (requires SETUP_TOKEN env var)
           │              GET  /auth/me      — returns {"username":"..."} for the profile widget
           ├── auth_request /auth/verify (session gate applied to all routes below)
           ├── GET/HEAD /* → serves static files from src/aia/
           └── POST /ollama/api/chat (exact match) → reverse proxy → host.docker.internal:11434/api/chat
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
| `config.js` | `MODEL_NAME`, `OLLAMA_API_URL`, the 13 system prompt objects, and global mutable state (`conversationHistory[]`, `currentSystemPrompt`) |
| `utils.js` | `formatTimestamp()`, `escapeHtml()`, `showToast()` — pure helpers |
| `speech.js` | Web Speech API: continuous recognition with 3-second silence detection, TTS with voice preference ("Microsoft Catherine") |
| `chat.js` | Message rendering, chat save/load, system prompt state management; also defines `COPY_ICON`, `CHECK_ICON`, `SPEAK_ICON`, `STOP_ICON` as top-level SVG string constants — `speech.js` reads `SPEAK_ICON`/`STOP_ICON` to toggle per-message button state; all four are declared in `eslint.config.js` crossModuleGlobals |
| `api.js` | `streamOllamaResponse()` — streaming fetch, Gemma 4 thinking mode (dual-buffer: `thinkingBuffer` for native Ollama `message.thinking` tokens, `fullResponse` for `message.content`; inline `<|/think|>` token boundary also supported), live collapsible thinking block rendered via `<details>`, final answer and thinking both pass through `DOMPurify.sanitize(marked.parse(...))`, abort via `streamAbortController`; thinking content excluded from `conversationHistory`, copy, and TTS |
| `main.js` | `DOMContentLoaded` wiring — wires ALL button/input event listeners via `addEventListener` (no inline HTML handlers); initialises default persona from the HTML `selected` attribute |

**Global state lives in `config.js`** (`conversationHistory`, `currentSystemPrompt`) and is shared across modules via the window scope — there is no module bundler.

## Security Invariants

- All AI response content — both the final answer and thinking block content — passes through `DOMPurify.sanitize(marked.parse(...))` before being set as `innerHTML` — in `api.js` (streaming and final rebuild) and `chat.js` (`renderConversationHistory`).
- User-supplied text uses `escapeHtml()` before insertion into `innerHTML` (`addUserMessage`, `renderConversationHistory`).
- CSP has no `unsafe-inline` in either `script-src` or `style-src`. All event handlers are wired via `addEventListener` in `main.js`; all element visibility is controlled by CSS classes or `element.style.display` (programmatic — not subject to CSP).
- The streaming fetch in `api.js` is wired to a module-level `streamAbortController`; call `stopStreaming()` to cancel mid-stream. If tokens were received before abort, the partial response is saved to `conversationHistory`; the user message is only rolled back when nothing was generated.
- User input is capped at `MAX_INPUT_LENGTH` (4000) set programmatically on `#userInput` in `main.js`; Nginx enforces `client_max_body_size 1m` on the proxy endpoint.

## Key Configuration

All runtime configuration is in [src/aia/scripts/config.js](src/aia/scripts/config.js):

- `MODEL_NAME` — Ollama model to use (default: `gemma4:e4b`)
- `OLLAMA_API_URL` — proxied endpoint (default: `https://localhost/ollama/api/chat`)
- `MAX_HISTORY_MESSAGES` — maximum entries in `conversationHistory` before oldest pairs are trimmed (default: `40`, i.e. 20 exchanges). Tune this when switching to a model with a smaller or larger context window.
- `SPEECH_RECOGNITION_LANG` — BCP 47 language tag for the Web Speech API (default: `'en-US'`). Change to `'en-AU'`, `'fr-FR'`, etc. to match your locale.
- System prompts object — keys map to `<option value>` in the persona selector dropdown

To add a new persona: add a key to the system prompts object in `config.js` and a matching `<option>` in the `#systemPromptSelect` dropdown in `index.html`. The default selected persona is controlled by the `selected` attribute in `index.html` — `main.js` reads it on load and sets `currentSystemPrompt` accordingly.

## Auth Service

The FastAPI authentication service lives in `auth/`. Key files:

| File | Purpose |
|---|---|
| `auth/main.py` | All route handlers, TOTP logic, session/CSRF helpers |
| `auth/Dockerfile` | Multi-stage Chainguard build (digest-pinned) |
| `auth/requirements.txt` | Production dependencies |
| `auth/requirements-test.txt` | Test dependencies (`pytest`, `httpx2`, `flake8`, `black`) |
| `auth/tests/test_main.py` | 65 pytest tests covering all routes, security logic, cookie lifecycle, and `/auth/me` |
| `auth/static/login.css` | Login page stylesheet |

**Updating Chainguard base image digests** — the `FROM` lines in `auth/Dockerfile` are pinned to SHA256 digests. To update them after Chainguard releases a new image:

```powershell
docker pull cgr.dev/chainguard/python:latest-dev
docker pull cgr.dev/chainguard/python:latest
# Copy the "Digest: sha256:..." lines from the output and update both FROM lines in auth/Dockerfile.
# Then rebuild: docker-compose build auth
```

## Nginx Proxy

The proxy in [deploy/nginx/nginx.conf](deploy/nginx/nginx.conf) uses an **exact-match** location (`location = /ollama/api/chat`) that accepts `POST` only — all other methods and all other Ollama paths (e.g. `/api/tags`, `/api/delete`) are denied at the nginx layer. The rate limit zone allows 5 requests/min with a burst of 5 (`limit_req_zone`). `proxy_buffering off` and `proxy_read_timeout 300s` support streaming responses.

Security headers set on every response: `Strict-Transport-Security`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy` (no `unsafe-inline`), `Referrer-Policy: no-referrer`, `Permissions-Policy`.

If Ollama changes port or the model changes, update `deploy/nginx/nginx.conf` and `config.js` respectively, then restart the container.

Changes to `nginx.conf` are syntax-validated in CI via the `nginx-config-check` job (`nginx -t` inside `nginx:1-alpine`). To validate locally without Docker, reload the running container: `docker exec vpal-nginx /usr/sbin/nginx -s reload`.

## SSL Certificates

Self-signed certs are in `deploy/certs/` (generated via mkcert). Nginx is configured for TLS 1.2+. Regenerate with mkcert targeting `localhost` if they expire.

## Updating Vendored Libraries

`marked.min.js` and `dompurify.min.js` are pinned with SHA-256 SRI hashes in `index.html`. When upgrading either file, recompute the hash and update the `integrity=` attribute:

```powershell
$bytes = [IO.File]::ReadAllBytes('src\aia\scripts\<filename>.js')
"sha256-" + [Convert]::ToBase64String([Security.Cryptography.SHA256]::Create().ComputeHash($bytes))
```

Paste the output into the matching `integrity="..."` attribute in `index.html`. The browser will refuse to load the script if the hash does not match.
