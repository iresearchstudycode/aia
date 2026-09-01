# 🤖 AI Assistant (Local) - Web Application
A secure, voice-enabled AI chat interface that runs entirely on your local machine using Ollama for AI model inference. Access is restricted to authenticated users via time-based one-time passwords (TOTP) compatible with Google Authenticator.

## 📋 Overview

This web application provides a ChatGPT-style chat interface — near-monochrome design, Inter font, **System / Light / Dark themes** — with voice input/output, a single "+" attach menu for image attachment (multimodal vision queries) and document attachment (.txt/.md/.pdf Q&A), LaTeX math rendering via KaTeX, syntax-highlighted code blocks (highlight.js) and Mermaid diagram rendering, a conversation navigator rail, and a live collapsible thinking block for reasoning-capable models. Every preference (models, voice, reasoning, interface/theme, personas) is edited in one Settings lightbox and persisted per user server-side, and every conversation is auto-saved to a searchable, per-user history. It connects to locally-hosted AI models through Ollama's REST API with no external dependencies — protected by TOTP authentication for up to five users.

## 🏗️ Architecture

### System Context

```text
  ┌─────────┐
  │  User   │  keyboard / voice
  └────┬────┘
       │ ▲  reads / hears
       │ │
┌──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┐
│      │ │                                                  Host Machine                                                       │
│      ▼ │                                                                                                                     │
│  ┌──────────┐  HTTPS (127.0.0.1:443)  ┌──────────────────────────────────┐  auth_request    ┌──────────────────────────────┐ │
│  │          ├────────────────────────►│       Docker: vpal-nginx         ├─────────────────►│    Docker: vpal-auth         │ │
│  │ Browser  │                         │  cgr.dev/chainguard/nginx        │    HTTP/REST     │    cgr.dev/chainguard/python │ │
│  │          │◄────────────────────────│  uid=65532  ·  read-only FS      │  (Docker net)    │    uid=65532                 │ │
│  └──────────┘                         │                                  │                  │    FastAPI + pyotp           │ │
│                                       │  GET/HEAD /*  →  static files    │                  │                              │ │
│                                       │  POST /api/chat · GET /api/tags  │                  │    /auth/verify              │ │
│                                       └────────────────┬─────────────────┘                  │    /auth/login               │ │
│                                                        │                                    │    /auth/logout              │ │
│                              HTTP/REST · streaming     │                                    │    /auth/setup               │ │
│                            host.docker.internal:11434  │                                    │    /auth/me                  │ │
│                                                        │                                    └──────────────────────────────┘ │
│                                                        ▼                                                                     │
│                                       ┌──────────────────────────────────┐                                                   │
│                                       │          Ollama API              │                                                   │
│                                       │       localhost:11434            │                                                   │
│                                       └────────────────┬─────────────────┘                                                   │
│                                                        │                                                                     │
│                                                internal inference                                                            │
│                                                        │                                                                     │
│                                                        ▼                                                                     │
│                                       ┌──────────────────────────────────┐                                                   │
│                                       │       Local AI Models            │                                                   │
│                                       │  gemma4:e4b  (text + thinking)   │                                                   │
│                                       │  gemma3:4b   (vision)            │                                                   │
│                                       └──────────────────────────────────┘                                                   │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

Every request to Nginx triggers an internal sub-request to the auth service (`auth_request`). If the session cookie is missing or expired, Nginx redirects the browser to the login page — no unauthenticated request ever reaches the static application or Ollama proxy.

### Piper TTS Path (built-in)

AI responses are spoken aloud by **Piper**, a fully-offline neural TTS engine running as its own service. The Nginx container proxies one route to it, gated by the identical `auth_request` session check:

```text
                 ┌─────────┐
                 │ Browser │
                 └─────────┘
                      │
            HTTPS (127.0.0.1:443)
             POST /piper/speak
                      ▼
┌────────────────────────────────────────────┐
│                Host Machine                │
│   ┌───────────────────────────────────┐    │
│   │ Docker: vpal-nginx                │    │
│   │ auth_request /auth/verify — same  │    │
│   │ session gate as every other route │    │
│   └───────────────────────────────────┘    │
│                     │                      │
│         HTTP/REST (Docker network)         │
│                     ▼                      │
│  ┌──────────────────────────────────────┐  │
│  │ Docker: vpal-piper-tts               │  │
│  │ python:3.12-slim, uid=65532          │  │
│  │ FastAPI + piper-tts (onnxruntime)    │  │
│  │ voice model baked into the image     │  │
│  │ self-contained — no host dependency  │  │
│  └──────────────────────────────────────┘  │
└────────────────────────────────────────────┘
```

`POST /piper/speak` takes `{"text": "..."}` and returns raw `audio/wav`, which the browser plays through an `<audio>` element (so it has a working stop button). It's entirely local and self-contained — the ONNX voice model (`en_US-lessac-medium`) is downloaded and SHA256-verified at image build time, never committed to git, and there is no external app or `host.docker.internal` dependency. The route is a synchronous handler (blocking ONNX inference runs in a worker thread, never on the event loop), onnxruntime is pinned to a single-thread pool (`OMP_NUM_THREADS=1` + a capped `SessionOptions`), and the voice model is warmed at container startup. Piper is the default TTS engine; **VoiceBox** (below) is an optional alternative selectable from the toolbar.

> **Base-image note:** `vpal-piper-tts` is the one service that uses `python:3.12-slim` rather than the distroless `cgr.dev/chainguard/python` image the rest of the stack runs on — `onnxruntime` (pulled in by `piper-tts`) segfaults on import under the Chainguard distroless runtime, which lacks `libstdc++`/`libgomp` and has no package manager to add them. It still runs multi-stage, digest-pinned, and non-root (uid 65532).

### VoiceBox Path (optional)

The same Nginx container also proxies two more routes, gated by the identical `auth_request` session check, to an additional service:

```text
                 ┌─────────┐
                 │ Browser │
                 └─────────┘
                      │
            HTTPS (127.0.0.1:443)
POST /voicebox/speak, GET /voicebox/audio/{id}
                      ▼
┌────────────────────────────────────────────┐
│                Host Machine                │
│   ┌───────────────────────────────────┐    │
│   │ Docker: vpal-nginx                │    │
│   │ (same instance as the main flow)  │    │
│   │ auth_request /auth/verify — same  │    │
│   │ session gate as every other route │    │
│   └───────────────────────────────────┘    │
│                     │                      │
│         HTTP/REST (Docker network)         │
│                     ▼                      │
│  ┌──────────────────────────────────────┐  │
│  │ Docker: vpal-voicebox-proxy          │  │
│  │ cgr.dev/chainguard/python, uid=65532 │  │
│  │ FastAPI + httpx                      │  │
│  │ in-memory generation cache           │  │
│  └──────────────────────────────────────┘  │
│                     │                      │
│   HTTP/REST · host.docker.internal:17493   │
│                     ▼                      │
│     ┌────────────────────────────────┐     │
│     │ Voicebox (local desktop app)   │     │
│     │ POST /speak                    │     │
│     │ GET  /generate/{id}/status     │     │
│     │ GET  /audio/{id}               │     │
│     │ plays a fresh clip through the │     │
│     │ host's speakers directly       │     │
│     └────────────────────────────────┘     │
└────────────────────────────────────────────┘
```

This lets AI responses be spoken through VoiceBox as an alternative to the built-in Piper engine — with one extra Piper doesn't have: repeat text is served from `vpal-voicebox-proxy`'s in-memory cache instead of being re-synthesized (and re-spoken) from scratch. It's entirely optional — the app works fully without Voicebox running; selecting the VoiceBox engine while it's unreachable just shows a toast error.

### Document Attachment Path

A third route, gated the same way, extracts text from an attached PDF so the model can answer questions about it:

```text
                 ┌─────────┐
                 │ Browser │
                 └─────────┘
                      │
            HTTPS (127.0.0.1:443)
          POST /doc-extract/extract
                      ▼
┌────────────────────────────────────────────┐
│                Host Machine                │
│   ┌───────────────────────────────────┐    │
│   │ Docker: vpal-nginx                │    │
│   │ (same instance as the main flow)  │    │
│   │ auth_request /auth/verify — same  │    │
│   │ session gate as every other route │    │
│   └───────────────────────────────────┘    │
│                     │                      │
│         HTTP/REST (Docker network)         │
│                     ▼                      │
│  ┌──────────────────────────────────────┐  │
│  │ Docker: vpal-doc-extract             │  │
│  │ cgr.dev/chainguard/python, uid=65532 │  │
│  │ FastAPI + pypdf                      │  │
│  │ self-contained — no host dependency  │  │
│  └──────────────────────────────────────┘  │
└────────────────────────────────────────────┘
```

Unlike the VoiceBox path, this one is entirely self-contained — no local desktop app, no `host.docker.internal`. `.txt` and `.md` files never reach this service at all: they're read directly in the browser (`file.text()`), since only PDF needs a real parser. The extracted text is folded into the chat message itself (there's no separate "documents" field the way there is `images` for vision), so it's automatically included in every subsequent turn via normal conversation history — no special handling needed for follow-up questions.

### Technology Stack

| Layer | Technology |
|---|---|
| Frontend | HTML5, CSS3, ES6+ JavaScript |
| Voice input | Web Speech API (continuous recognition, where the browser supports it) |
| Voice output | Piper neural TTS (`piper-tts` + `onnxruntime`, self-hosted, default) or VoiceBox (optional) |
| AI integration | Fetch API → Nginx reverse proxy → Ollama REST API |
| Markdown | Marked.js (vendored, SRI-pinned) |
| HTML sanitisation | DOMPurify v3.4.11 (vendored, SRI-pinned) |
| Math typesetting | KaTeX v0.18.1 + auto-render extension (vendored, SRI-pinned) |
| Syntax highlighting | highlight.js v11.11.1, "common" build (vendored, SRI-pinned); hljs output re-sanitised through DOMPurify |
| Diagrams | Mermaid v10.9.3 UMD bundle (vendored, SRI-pinned); `securityLevel: 'strict'` + `htmlLabels: false` (plain-SVG labels survive DOMPurify's SVG profile), Rational Rose-style `themeVariables`, SVG output DOMPurify-sanitised, flowchart nodes colour-coded by shape |
| Web server | Nginx (`cgr.dev/chainguard/nginx`, distroless, uid=65532) |
| Auth service | FastAPI + pyotp + itsdangerous (`cgr.dev/chainguard/python:latest`, uid=65532) |
| Piper TTS service | FastAPI + `piper-tts` (`onnxruntime`) on `python:3.12-slim`, uid=65532 — self-contained neural speech synthesis; `en_US-lessac-medium` ONNX voice model SHA256-pinned, fetched at build time |
| VoiceBox proxy (optional) | FastAPI + httpx (`cgr.dev/chainguard/python:latest`, uid=65532) — bridges to a local Voicebox app's REST API; in-memory generation cache |
| Document text extraction | FastAPI + pypdf (`cgr.dev/chainguard/python:latest`, uid=65532) — self-contained PDF text extraction; `.txt`/`.md` handled entirely client-side |
| Settings service | FastAPI + stdlib `sqlite3` (WAL) (`cgr.dev/chainguard/python:latest`, uid=65532) — per-user preferences on the `vpal-settings-data` volume; identity via the `X-Auth-User` header nginx forwards from `/auth/verify` |
| Conversations service | FastAPI + stdlib `sqlite3` (WAL) (`cgr.dev/chainguard/python:latest`, uid=65532) — auto-saved per-user conversation history on the `vpal-conversations-data` volume; same `X-Auth-User` identity model; per-user cap with oldest-first eviction |
| Session | HMAC-signed cookie (`itsdangerous.TimestampSigner`), 8-hour TTL |
| TOTP | RFC 6238 via `pyotp`, compatible with Google Authenticator |
| Container | Docker, read-only filesystems, minimal capability sets |

## 🚀 Quick Start

### Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) installed and running
- [Ollama](https://ollama.ai) installed and running on the host machine
- Models pulled: `ollama pull gemma4:e4b` (text + thinking) and `ollama pull gemma3:4b` (vision)
- TLS certificates generated with [mkcert](https://github.com/FiloSottile/mkcert) and placed in `deploy/certs/`
- A modern web browser (Chrome, Edge, Firefox, Safari 14.1+) — voice *input* uses the Web Speech API where available; voice *output* is handled server-side by the built-in Piper service and needs nothing extra
- (Optional) The Voicebox desktop app running on the host if you want the VoiceBox TTS engine instead of Piper — the app works fully without it

### Installation

1. Clone or download this repository.

2. Generate TLS certificates:
   ```powershell
   mkcert -install
   mkcert -cert-file deploy/certs/localhost.pem -key-file deploy/certs/localhost-key.pem localhost
   ```

3. Create the secrets file from the template:
   ```powershell
   copy .env.example .env
   ```
   Then edit `.env` — see [Authentication Setup](#authentication-setup) below.

4. Build and start the stack:
   ```powershell
   docker-compose up --build
   ```

5. Open the QR-code setup page and scan with Google Authenticator:
   ```
   https://localhost/auth/setup?token=<your SETUP_TOKEN from .env>
   ```

6. After all users have scanned, remove `SETUP_TOKEN` from `.env` and restart the auth container:
   ```powershell
   docker-compose restart auth
   ```

7. Browse to `https://localhost/` — you will be prompted to sign in.

## 🔐 Authentication Setup

VPAL uses TOTP (Time-based One-Time Passwords) for authentication. Up to five users can be configured. All secrets live in `.env` which is gitignored and never committed.

### Generating secrets

```powershell
# Session signing key — run once, store in .env as SECRET_KEY
python -c "import secrets; print(secrets.token_hex(32))"

# Setup token — used to access the QR-code page; remove after setup
python -c "import secrets; print(secrets.token_urlsafe(24))"

# TOTP secret — one per user; store in .env as TOTP_SECRET_N
python -c "import pyotp; print(pyotp.random_base32())"
```

### `.env` structure

```ini
SECRET_KEY=<64-char hex>          # signs session cookies
SESSION_TTL_HOURS=8               # session lifetime (default: 8 hours)
SETUP_TOKEN=<random token>        # remove after initial QR setup

USER_1=yourname
TOTP_SECRET_1=<base32 secret>

# USER_2=second
# TOTP_SECRET_2=<base32 secret>
```

### Adding a user

1. Generate a TOTP secret:
   ```powershell
   python -c "import pyotp; print(pyotp.random_base32())"
   ```
2. Add `USER_N=<name>` and `TOTP_SECRET_N=<secret>` to `.env`.
3. Set `SETUP_TOKEN` to any random string.
4. Restart the auth container: `docker-compose restart auth`
5. Visit `https://localhost/auth/setup?token=<SETUP_TOKEN>` and scan the new user's QR code with Google Authenticator.
6. Remove `SETUP_TOKEN` from `.env` and restart again.

### Login flow

1. Visit `https://localhost/` — unauthenticated requests redirect to `/auth/login`.
2. Enter your username and the current 6-digit code from Google Authenticator.
3. On success, a signed session cookie is set (8-hour TTL by default).
4. Click the user block at the bottom-left of the sidebar, then **Sign out** to end the session.

### Setup page security

The QR-code setup page (`/auth/setup`) is only active when `SETUP_TOKEN` is set in `.env`. Remove it after initial setup to disable the page entirely. The page is served over HTTPS and requires the exact token as a query parameter.

## 📁 Project Structure

```
vpal/
├── auth/                           # TOTP authentication service
│   ├── main.py                     # FastAPI app (verify, login, logout, setup)
│   ├── requirements.txt
│   ├── requirements-test.txt       # pytest, flake8, black, httpx2
│   ├── Dockerfile                  # Multi-stage Chainguard build (digest-pinned)
│   ├── pytest.ini
│   ├── tests/
│   │   ├── conftest.py             # Env setup, shared fixtures
│   │   └── test_main.py            # 65 pytest tests
│   └── static/
│       └── login.css               # Login page styles
├── voicebox-proxy/                 # VoiceBox TTS proxy service (optional)
│   ├── main.py                     # FastAPI app + Voicebox REST client + generation cache
│   ├── requirements.txt
│   ├── requirements-test.txt       # pytest, flake8, black, httpx
│   ├── Dockerfile                  # Multi-stage Chainguard build (digest-pinned)
│   ├── pytest.ini
│   └── tests/
│       ├── conftest.py             # sys.path setup
│       └── test_main.py            # 31 pytest tests
├── doc-extract/                    # PDF text extraction service (self-contained)
│   ├── main.py                     # FastAPI app + pypdf extraction
│   ├── requirements.txt
│   ├── requirements-test.txt       # pytest, flake8, black, httpx
│   ├── Dockerfile                  # Multi-stage Chainguard build (digest-pinned)
│   ├── pytest.ini
│   └── tests/
│       ├── conftest.py             # sys.path setup
│       └── test_main.py            # 16 pytest tests
├── piper-tts/                      # Piper neural TTS service (self-contained, default engine)
│   ├── main.py                     # FastAPI app — POST /piper/speak → audio/wav
│   ├── requirements.txt            # fastapi, uvicorn, piper-tts
│   ├── requirements-test.txt       # pytest, flake8, black, httpx
│   ├── Dockerfile                  # Multi-stage python:3.12-slim build (digest-pinned); ADD --checksum voice model
│   ├── pytest.ini
│   └── tests/
│       ├── conftest.py             # sys.path setup
│       └── test_main.py            # 13 pytest tests (synthesis mocked)
├── settings-service/               # Per-user preferences service (self-contained, SQLite/WAL)
│   ├── main.py                     # FastAPI app — GET/PUT/POST /settings/* + /health
│   ├── requirements.txt            # fastapi, uvicorn
│   ├── requirements-test.txt       # pytest, flake8, black, httpx
│   ├── Dockerfile                  # Multi-stage Chainguard build (digest-pinned); seeds /data as uid 65532
│   ├── pytest.ini
│   └── tests/
│       ├── conftest.py             # per-test tmp SETTINGS_DB_PATH
│       └── test_main.py            # 61 pytest tests (real SQLite)
├── conversations-service/          # Per-user conversation history service (self-contained, SQLite/WAL)
│   ├── main.py                     # FastAPI app — GET/PUT/DELETE /conversations/* + /conversations/search + /health
│   ├── requirements.txt            # fastapi, uvicorn
│   ├── requirements-test.txt       # pytest, flake8, black, httpx
│   ├── Dockerfile                  # Multi-stage Chainguard build (digest-pinned); seeds /data as uid 65532
│   ├── pytest.ini
│   └── tests/
│       ├── conftest.py             # per-test tmp CONVERSATIONS_DB_PATH
│       └── test_main.py            # pytest tests (real SQLite)
├── src/
│   └── aia/                        # Web application source
│       ├── index.html              # Main HTML structure
│       ├── css/
│       │   ├── style.css           # Application styling
│       │   ├── katex.min.css       # KaTeX math styling (vendored)
│       │   ├── highlight.min.css   # highlight.js dark theme (vendored, atom-one-dark)
│       │   └── fonts/              # KaTeX math fonts + Inter UI font (vendored)
│       ├── scripts/
│       │   ├── theme-boot.js        # No-FOUC theme stamp (runs before style.css)
│       │   ├── config.js           # Constants, system prompts, preference globals
│       │   ├── utils.js            # Utility functions
│       │   ├── speech.js           # Voice input (Web Speech recognition) + TTS routing (Piper / VoiceBox)
│       │   ├── chat.js             # Chat UI management
│       │   ├── api.js              # Ollama API client
│       │   ├── nav-rail.js         # Conversation navigator rail
│       │   ├── settings.js         # Settings lightbox + server-preference resolution + settings backup
│       │   ├── history.js          # Conversation history lightbox + per-turn auto-save
│       │   ├── main.js             # Application initialisation, settings hydration + migration
│       │   ├── marked.min.js       # Markdown parser (vendored)
│       │   ├── dompurify.min.js    # HTML sanitiser (vendored)
│       │   ├── highlight.min.js    # Syntax highlighting (vendored, highlight.js v11)
│       │   ├── katex.min.js        # Math typesetting (vendored)
│       │   ├── katex-auto-render.min.js  # KaTeX delimiter scanner (vendored)
│       │   ├── diff-match-patch.js # Word-level diff for the English Editor (vendored)
│       │   └── mermaid.min.js      # Diagram rendering (vendored, Mermaid v10.9.x)
│       └── images/
│           └── icon.ico
├── deploy/
│   ├── nginx/
│   │   └── nginx.conf              # Nginx config (auth_request, proxy, CSP)
│   └── certs/                      # TLS certificates — gitignored
│       ├── localhost.pem
│       └── localhost-key.pem
├── .env                            # Runtime secrets — gitignored, never commit
├── .env.example                    # Template for .env
├── .htmlhintrc                     # HTMLHint rules for index.html linting
├── docker-compose.yml
└── README.md
```

## 🔧 Configuration

### Settings service

Every *user preference* — chat model, vision model, TTS engine, auto-speak, speech-recognition language, thinking mode + depth, navigator rail, per-persona overrides, editor mode, active persona — is edited in the in-app **Settings** lightbox and stored per user by the `settings-service` (SQLite on the `vpal-settings-data` Docker volume). The house **defaults** are set with optional environment variables in `.env` (all have baked-in fallbacks):

| env var | fallback |
|---|---|
| `VPAL_DEFAULT_CHAT_MODEL` | `gemma4:e4b` |
| `VPAL_DEFAULT_VISION_MODEL` | `gemma3:4b` |
| `VPAL_DEFAULT_TTS_ENGINE` | `piper` |
| `VPAL_DEFAULT_AUTO_SPEAK` | `false` |
| `VPAL_DEFAULT_STT_LANG` | `en-US` |
| `VPAL_DEFAULT_THINKING` | `false` |
| `VPAL_DEFAULT_THINKING_DEPTH` | `medium` |
| `VPAL_DEFAULT_NAV_RAIL` | `true` |
| `VPAL_DEFAULT_THEME` | `system` (`system` \| `light` \| `dark`) |

"Reset to defaults" in the dialog reverts a value to its env default. `SETTINGS_DB_PATH` (default `/data/settings.db`) sets the SQLite location. Existing `localStorage` preferences migrate to the service automatically on first load after upgrade.

### Ollama settings

- **Models**: chosen in Settings → Models from your installed models (`ollama list` / `GET /api/tags`); `MODEL_NAME` / `VISION_MODEL_NAME` in `config.js` are only the offline fallbacks. `gemma4:e4b` has no vision encoder, so a separate vision model is required.
- **API URLs**: `OLLAMA_API_URL` (chat, default `https://localhost/ollama/api/chat`) and `OLLAMA_TAGS_URL` (model list, default `https://localhost/ollama/api/tags`) in `config.js`
- **Context length**: `OLLAMA_NUM_CTX` in `config.js` (default: `16384`) is a **fallback**. The `num_ctx` actually sent is the selected model's **full advertised context window** when it reports one via `GET /api/tags` (e.g. `qwen3:4b` → 262144, `deepseek-r1:8b` → 131072); models that don't report one (the gemma line) fall back to `OLLAMA_NUM_CTX`. This means `num_ctx` can be much larger than 16384 — the **real cap is your Ollama server's `OLLAMA_CONTEXT_LENGTH`** (env var, or `PARAMETER num_ctx` in the Modelfile), so set that to the largest KV cache the host can afford. `MAX_HISTORY_MESSAGES` in `config.js` (default: `40`, i.e. 20 exchanges) additionally bounds how many past messages are kept regardless of their token cost

### Voice settings

- **Language**: Settings → Voice (`stt_lang`, BCP 47, default `en-US`); `SPEECH_RECOGNITION_LANG` in `config.js` is the offline fallback
- **Silence detection**: `SILENCE_TIMEOUT_MS` in `config.js` (default: `3000` ms)
- **TTS engine**: Settings → Voice — "Piper" (self-hosted neural TTS, default; via `PIPER_SPEAK_URL` in `config.js`, default: `https://localhost/piper/speak`) or "VoiceBox" (optional local Voicebox app; via `VOICEBOX_SPEAK_URL`, default: `https://localhost/voicebox/speak`), with per-persona overrides. Both engines show a spinner on the speak button while audio is being generated and play through an `<audio>` element with a working stop button; VoiceBox additionally serves repeat text from its in-memory cache. If Voicebox isn't running, stay on Piper or VoiceBox will show an unavailable toast on speak.

### Auth settings

All auth settings live in `.env`:

| Variable | Default | Description |
|---|---|---|
| `SECRET_KEY` | — | **Required.** Session signing key, ≥ 32 characters |
| `SESSION_TTL_HOURS` | `8` | Session lifetime in hours |
| `SETUP_TOKEN` | — | Enables QR setup page when set; remove after setup |
| `USER_N` / `TOTP_SECRET_N` | — | Username and TOTP secret for user N (N = 1–5) |

### Piper TTS settings (optional)

Piper is the default speech-synthesis engine and needs no configuration — sensible defaults are baked in. Override in `.env` only if you want a different voice or speed:

| Variable | Default | Description |
|---|---|---|
| `PIPER_VOICE` | `en_US-lessac-medium` | Voice model basename (must match the `.onnx` baked into the image) |
| `PIPER_LENGTH_SCALE` | `1.0` | Speech speed — lower is faster |
| `PIPER_MAX_TEXT_CHARS` | `6000` | Longest text `/piper/speak` will synthesise |
| `PIPER_MODEL_DIR` | `/app/voices` | Where the `.onnx` + `.onnx.json` live inside the container |

### VoiceBox settings (optional)

All optional and only needed if you run the Voicebox desktop app locally and want the VoiceBox TTS engine instead of Piper. Set in `.env`; the app works fully without them:

| Variable | Default | Description |
|---|---|---|
| `VOICEBOX_URL` | `http://host.docker.internal:17493` | Base URL of the local Voicebox app's REST API |
| `VOICEBOX_CLIENT_ID` | `vpal` | Client identifier sent to Voicebox (not a secret — Voicebox has no auth of its own) |
| `VOICEBOX_TIMEOUT_SECONDS` | `60` | Timeout for both starting and awaiting a voice generation — must cover your slowest expected synthesis |

### Document upload settings (optional)

Self-contained — no external app to configure, and these only bound worst-case behavior server-side (see [Document Attachment Path](#document-attachment-path) for the frontend setting that actually governs how much extracted text gets used):

| Variable | Default | Description |
|---|---|---|
| `MAX_UPLOAD_BYTES` | `15728640` (15 MB) | Largest PDF `doc-extract` will accept |
| `MAX_TEXT_CHARS` | `200000` | Sanity cap on extracted text length returned to the browser — independent of, and much larger than, the frontend's own truncation budget |

- **Client-side** (`src/aia/scripts/config.js`): `MAX_DOCUMENT_UPLOAD_BYTES` (default `15728640`, matches `MAX_UPLOAD_BYTES` above) and `MAX_DOCUMENT_TEXT_CHARS` (default `28000`, ≈7K tokens at ~4 chars/token) — the character budget actually folded into a chat message. Sized against the 16384-token `OLLAMA_NUM_CTX` fallback (see [Ollama settings](#ollama-settings)) so it stays safe on a small-context model: a document at this budget leaves roughly half that context free for the system prompt, conversation history, thinking budget, and the response. A model with a larger advertised window just has more headroom. Raising this past ~7K tokens still risks Ollama truncating context on a 16K-fallback model, so keep it conservative.

## 🛡️ Security

### Implemented measures

| Layer | Controls |
|---|---|
| **Authentication** | TOTP (RFC 6238) via Google Authenticator; signed session cookie (HMAC-SHA1, 8-hour TTL); brute-force lockout after 5 failed attempts per username (5-minute window) |
| **Session** | `HttpOnly`, `Secure`, `SameSite=Strict` cookie; Nginx `auth_request` gates every route before serving content |
| **Transport** | HTTPS only (TLS 1.2/1.3), HSTS, HTTP→HTTPS redirect |
| **Browser** | CSP: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; form-action 'self'`; `X-Frame-Options: DENY`; `X-Content-Type-Options: nosniff`; `Referrer-Policy: no-referrer`; `Permissions-Policy`. `script-src` has no inline/eval exception anywhere; `style-src`'s `'unsafe-inline'` exists solely for KaTeX, which positions glyphs via computed inline `style` attributes with no CSS-class-only alternative; `media-src`'s `blob:` lets the page play the Piper TTS audio it generates client-side via `URL.createObjectURL` (own blobs only, no external load) — all bounded by the rest of the policy (no external hosts allowed anywhere), so none can be used to exfiltrate data |
| **XSS prevention** | All AI/user response content sanitised with DOMPurify (SRI-pinned) before rendering; your own message text — including a folded-in document attachment — is inserted via `.textContent`, never parsed as HTML; KaTeX only ever runs on the already-sanitized DOM with `trust: false` (its default), which disables `\href`/`\url`/`\includegraphics`/`\html*` — the only way a LaTeX source string could otherwise make it emit attacker-chosen HTML |
| **Proxy** | Ollama API locked to exact-match `POST /ollama/api/chat` and GET-only `/ollama/api/tags` (installed-model list for the model selector — read-only metadata, no generation) — all other Ollama paths and methods denied; `/api/chat` rate-limited to 5 req/min burst 5, `/api/tags` to 12 req/min burst 3. Piper TTS locked to `POST /piper/speak` only; auth-gated; rate-limited to 10 req/min with burst of 3. VoiceBox proxy locked to `POST /voicebox/speak` and `GET /voicebox/audio/{id}` only; also auth-gated (Voicebox itself has no authentication of its own); both rate-limited to 10 req/min with burst of 3. Doc-extract proxy locked to `POST /doc-extract/extract` only; auth-gated; rate-limited to 10 req/min with burst of 3 |
| **Containers** | All five containers: read-only filesystem, non-root user (uid 65532), `cap_drop: ALL`, `no-new-privileges`; Nginx adds `NET_BIND_SERVICE` only. `vpal-piper-tts` runs on `python:3.12-slim` (digest-pinned) rather than Chainguard distroless — `onnxruntime` segfaults under distroless — but keeps every other hardening property |
| **Network** | Loopback-only binding (`127.0.0.1`); auth service port not published to the host (Docker-internal only) |
| **Secrets** | All credentials in `.env` (gitignored); no hardcoded keys, tokens, or passwords anywhere in source |
| **Input** | User messages capped at 4,000 characters; Nginx enforces 1 MB request body limit globally, `20 MB` on `/ollama/api/chat`, and `15 MB` on `/doc-extract/extract`; uploaded chat files capped at 5 MB; extracted document text capped at 28,000 characters before being folded into a chat message |
| **Supply chain** | `marked.min.js`, `dompurify.min.js`, `highlight.min.js`, `katex.min.js`, `katex-auto-render.min.js`, `diff-match-patch.js`, `mermaid.min.js`, `katex.min.css`, and `highlight.min.css` all pinned with SHA-256 SRI hashes; `npm run check:sri` (also a CI gate) re-verifies every pin on a clean checkout. All service Docker base images pinned by SHA256 digest. The Piper voice model (`en_US-lessac-medium.onnx` + `.onnx.json`, from `rhasspy/piper-voices` @ `v1.0.0`) is fetched at build time via `ADD --checksum=sha256:…`, so a tampered download fails the build |

### Known limitations

- **In-memory auth state** — brute-force lockout counters and TOTP replay protection are stored in process memory. Restarting the `vpal-auth` container (`docker-compose restart auth`) clears this state, giving an attacker a fresh attempt window within the 90-second TOTP validity period. For a local-only, 1–5-user deployment this is an accepted trade-off; adding a persistent backing store (Redis, SQLite) would close the gap if the threat model requires it.
- **`num_ctx` = the model's full advertised window** — since v1.31.3 the `num_ctx` sent is the selected model's advertised `context_length` from `GET /api/tags` (qwen3:4b → 262144), *not* capped to `OLLAMA_NUM_CTX`. The **Ollama server's `OLLAMA_CONTEXT_LENGTH` is the effective cap** — if that isn't set high enough, or the host can't afford the KV cache, a large-window model still needs a manual `OLLAMA_CONTEXT_LENGTH`. Models that report no `context_length` (the gemma line) fall back to `OLLAMA_NUM_CTX` (16384). `MAX_DOCUMENT_TEXT_CHARS` is sized against the 16384 fallback, so it stays safe on a small-context model.

## 🎯 Features

- **TOTP Authentication**: Google Authenticator login for up to five users
- **ChatGPT-style layout**: A full-viewport two-column shell — a dark left **sidebar** (New chat, an inline searchable conversation-history list, and a locked logged-in-user block at the bottom) and a light main pane with a slim header. Sky-blue user message bubbles (right-aligned), clean card AI responses; all controls use inline SVG line icons with no emoji. The sidebar collapses on desktop (`Ctrl`/`Cmd` + `B`, persisted) and becomes a swipe-in drawer on narrow screens
- **Account menu**: The bottom-left user block opens a small menu with **Settings** and **Sign out**. The file operations (Save chat, Export MD, Open file, Close window) live in a **"⋯" overflow menu** on the chat header
- **Settings**: One lightbox (opened from the account menu, `Ctrl`/`Cmd` + `,`, or either toolbar badge) holds every preference, in a two-pane layout — categories on the left (Models / Voice / Reasoning / Interface / Personas), the selected category's fields on the right, each category with its own Save / Cancel / Reset, plus a whole-dialog "Reset all" and a per-field reset for any value that differs from its default. Models: the text/thinking model **and** the vision model are both selectable from your installed Ollama models. Personas: the detail view — per-persona overrides for thinking mode/depth and TTS engine ("Inherit" falls back to the global default) and, for English Editor, the output mode (Clean / Show changes / Explain); everyday persona switching is the ▾ picker in the header. **Preferences persist server-side, per user** (a small `settings-service` backed by SQLite), so they follow you across devices and survive restarts; defaults come from `VPAL_DEFAULT_*` environment variables. Existing `localStorage` preferences are migrated automatically on first load. If the settings service is unreachable the app still runs on the built-in defaults
- **Chat Input**: Auto-growing textarea (up to 6 lines); Enter sends, Shift+Enter inserts a newline; circular sky-blue send button activates only when text or an image is pending
- **Keyboard Shortcuts**: `Ctrl`/`Cmd` + `,` opens Settings; `Ctrl`/`Cmd` + `B` toggles the sidebar; `Ctrl`/`Cmd` + `Shift` + `O` starts a new chat (the current conversation is archived to history first, so there's no confirm); `Escape` cancels an in-flight response, then closes the mobile drawer, then any open popup, then returns focus to the composer
- **Voice Input/Output**: Continuous speech recognition with 3-second silence detection (Web Speech API); speech synthesis via the self-hosted **Piper** engine (default) or **VoiceBox** (optional, chosen in Settings → Voice), with per-message speak buttons and a working stop control; the toolbar keeps only the mic and stop-speaking icons. Recognition is paused while TTS plays so the mic doesn't capture the synthesised audio
- **Attach Menu**: A single ChatGPT-style "+" button in the toolbar opens a popup with "Add photos" and "Add files" options; Tab focus trap and Escape to close, matching the account / overflow menus
- **Image Attachment**: "Add photos" in the "+" attach menu opens a file picker; images are resized to ≤ 1024 px before being sent; vision requests are automatically routed to `gemma3:4b`; in-session thumbnails shown in user bubbles; saved chats show an SVG camera icon placeholder where the image was
- **Document Attachment**: "Add files" in the "+" attach menu attaches a `.txt`, `.md`, or `.pdf` file to ask questions about; `.txt`/`.md` are read directly in the browser, `.pdf` is extracted server-side (see [Document Attachment Path](#document-attachment-path)); the chat bubble shows a compact filename chip and your question, not the full extracted text; follow-up questions work automatically since the extracted text is part of normal conversation history
- **Thinking Mode**: Toggled in Settings → Reasoning (on/off + reasoning effort Low / Medium / High), with per-persona overrides; a `#thinkingBadge` in the toolbar shows the current state and opens Settings on click; live reasoning displayed in a collapsible `<details>` block (with a running elapsed-time / token count while it reasons) that collapses when the final answer arrives; thinking content excluded from history, copy, and speech. Ollama exposes no true "thinking budget", so Low / Medium apply a generous total-token ceiling (`num_predict` 4096 / 8192) that only bites on a runaway reasoner; High is uncapped. A large model being loaded shows a "Loading model…" note since its first reply can take 30–60 s
- **Model Selection**: Both the text/thinking model and the vision model are chosen in Settings → Models from the list of models installed locally (Ollama's `GET /api/tags`); a `#modelBadge` in the toolbar shows the active model and opens Settings on click. Changes apply to the next and all subsequent messages with no conversation reset. Falls back to the default with a toast if Ollama's model list can't be loaded
- **Themes**: **System / Light / Dark**, chosen in Settings → Interface (default: match your OS). ChatGPT-style near-monochrome palette, Inter font (self-hosted, offline). Applies instantly with no reload; the choice is stored per user server-side and mirrored to `localStorage` so a dark-theme reload never flashes light. `VPAL_DEFAULT_THEME` sets the house default. The login page follows the OS preference
- **Conversation Navigator Rail**: A thin strip of markers down the right edge of the chat, one per completed question. Hover a marker for a preview card (the question + a short snippet of the reply); click it to jump that turn to the top of the view and briefly flash it. The marker for the turn you're looking at stays highlighted as you scroll. Toggled in Settings → Interface (default on); hidden on narrow screens. Mouse-only, and it's purely a view over the current conversation — nothing is added to saved chats
- **Dual-model Routing**: Text/thinking requests use the chosen chat model (default `gemma4:e4b`, streaming, thinking-capable); image requests and vision follow-ups use the chosen vision model (default `gemma3:4b`); `think: false` sent explicitly to suppress native reasoning when thinking is OFF
- **Real-time Streaming**: Live token-by-token response display with a stop button
- **Multiple Personas**: 10 pre-configured AI personalities, each with its own SVG icon (served per-persona by the settings-service). Switch with the **▾ next to "AI Assistant"** — an `icon · name` list (not the full Settings). Locked once a conversation is underway; **loading a past conversation restores the persona it was created with** so follow-ups stay in context. Every persona replies in **Australian English**. Per-persona detail (thinking/TTS overrides, editor mode, analysis view) lives in Settings → Personas
- **Persona affordance templates**: some personas turn a reply into an interactive artifact.
  - **Professional Consultant** — a "Templates" button in the composer offers **SWOT analysis**, **Pros & cons**, and a **Decision matrix**: a colour-coded 2×2 SWOT quadrant grid, a two-column pros/cons layout, or a scored table with a **weight slider (0–5) per criterion** that recomputes the weighted totals and highlights the winning option live. Every one has a **Structured / Text** switch; artifact type / view / matrix weights persist through reload and JSON save/open. Default view is per-persona in Settings → Personas.
  - **Patient Teacher** — after any explanation, **"Quiz me"** and **"Flashcards"** buttons appear on the reply. Quiz me sends a 5-question multiple-choice quiz you answer inline (click an option → the correct one lights up green, wrong picks red, with a one-line explanation). Flashcards renders a grid of cards that flip on click (term → definition). Quiz/flip state is per-session; the artifact persists.
- **Per-message Actions**: Copy and speak SVG icon buttons appear on successful AI responses only; target the final answer (thinking content excluded). A separate **"copy markdown"** button pinned to the top-right of each rendered AI message (visible on hover) copies the raw markdown source verbatim
- **Chat History**: Save/load conversation history as JSON; filename format `YYYYMMDD-HHMMss-vpal-<Topic>.json`; base64 image data stripped on save (preserves `hasImage` flag for routing and placeholder display)
- **Conversation History**: Every conversation is auto-saved to a per-user, server-side history (`conversations-service`, SQLite on the `vpal-conversations-data` volume) after each completed turn and on tab close. The list lives in the left sidebar, **grouped into collapsible sections by the persona each thread was created with** (most-recently-used persona first, an "Unassigned" section for older threads); collapsed sections are remembered. Search by title or full message text, click to reopen (the active one is highlighted, its section always expanded), ✕ to delete; the list refreshes itself after each turn. "New chat" archives the current conversation before resetting, so nothing is lost. Bounded per user (default 100, oldest evicted first); the manual JSON Save/Export/Open still work unchanged, and chat never blocks on the history service
- **Settings Backup**: The Settings lightbox footer has **Export settings** (downloads the full per-user settings JSON) and **Import settings** (restores one), for moving preferences between deployments or keeping an offline copy
- **Character Counter**: Remaining count shown as you approach the 4,000-character limit, with warning and danger colour states
- **Auto-Speak**: Settings → Voice toggles automatic TTS after each AI response; works with either engine regardless of browser Web Speech support
- **Markdown Support**: Rich text formatting in AI responses and thinking blocks via Marked.js + DOMPurify
- **Math Rendering**: LaTeX expressions typeset via KaTeX — inline (`$...$`, `\(...\)`) and display (`$$...$$`, `\[...\]`, plus `\begin{equation}`/`\begin{align}`/etc.) — in AI responses, thinking blocks, and your own messages; a malformed expression falls back to showing its raw source rather than breaking the rest of the message; math inside code blocks is left alone
- **Code Highlighting**: Fenced code blocks in AI responses are syntax-highlighted via highlight.js (vendored, ~40 common languages, dark theme matched to the app's slate `<pre>` background); highlight.js output is re-sanitised through DOMPurify; an unrecognised language falls back to plain monospace
- **Diagram Rendering**: A ` ```mermaid ` fenced block in an AI response renders as an SVG diagram via Mermaid (vendored v10.9.x, `securityLevel: 'strict'` + `htmlLabels: false`; SVG output DOMPurify-sanitised). Styled **Rational Rose-style** — a light "paper" canvas, cornsilk boxes, crisp dark borders, near-black text (held in both light and dark app themes), with flowchart nodes **colour-coded by shape**: decisions amber, start/end terminators sage green, everything else cornsilk. Local models often emit unquoted `()`/`[]`/`{}` in flowchart node labels, which Mermaid can't parse — a failed diagram is retried once with an auto-repair that double-quotes those labels before it falls back to showing the raw code block; a diagram that's still unparseable leaves the code block visible rather than breaking the message

## 🔍 System Requirements

- **Browser**: Chrome 25+, Firefox 44+, Safari 14.1+, Edge 79+
- **RAM**: 4 GB minimum (8 GB recommended for larger models)
- **Storage**: 2 GB+ for AI models
- **Network**: Local loopback only (`127.0.0.1`)

## 🔄 Refreshing After a Code Change

What "picking up a change" requires depends on what changed — there is no single "restart everything" step:

| You changed | What to do |
|---|---|
| `src/aia/**` (HTML, CSS, JS — including this feature's vendored KaTeX files) | Nothing on the server side — `vpal-nginx` bind-mounts `src/aia/` straight from disk. Just reload the page (hard-refresh with Ctrl+Shift+R if the browser cached an old script/CSS file) |
| `deploy/nginx/nginx.conf` (routing, CSP headers, rate limits) | `docker exec vpal-nginx /usr/sbin/nginx -s reload` — nginx reads the file fresh from disk on reload, but keeps running the *old* config in memory until you do this |
| `auth/**`, `voicebox-proxy/**`, `doc-extract/**`, or `piper-tts/**` (Python backend code) | `docker-compose up -d --build auth` (or `voicebox-proxy` / `doc-extract` / `piper-tts`) — these are baked into their Docker image at build time, so a plain restart isn't enough |
| `docker-compose.yml` | `docker-compose up -d --build` (rebuilds/recreates whatever changed) |

## 🐛 Troubleshooting

| Symptom | Fix |
|---|---|
| Login page shown on every visit | Session cookie expired or browser blocking cookies for `localhost` — check browser cookie settings |
| "Invalid username, code, or too many attempts" | Verify username matches exactly what is in `.env`; check phone clock is synced; wait 5 minutes if locked out |
| Setup page returns 404 | `SETUP_TOKEN` is not set in `.env`, or the token in the URL does not match |
| Auth container won't start | `SECRET_KEY` is missing or under 32 characters, or no `USER_N` / `TOTP_SECRET_N` pairs are set |
| Voice not working | Check browser microphone permissions |
| Ollama connection failed | Ensure Ollama is running: `ollama serve` |
| Text model not found | Run `ollama pull gemma4:e4b` |
| Vision/image not working | Run `ollama pull gemma3:4b`; vision uses a separate model from the text model |
| Image sends but gets no response | Image may exceed context window — the app resizes to ≤ 1024 px automatically, but very complex images can still overload `gemma3:4b` |
| "VoiceBox is unavailable" toast | The Voicebox desktop app isn't running on the host, or `VOICEBOX_URL` in `.env` doesn't match its port — switch the toolbar TTS engine back to "Piper" (the default) as a workaround |
| "Piper TTS is unavailable" toast | `vpal-piper-tts` isn't healthy — check `docker logs vpal-piper-tts`; if the image is missing the voice model or failed to build, `docker-compose up -d --build piper-tts` |
| LaTeX shows as raw `$...$`/`\(...\)` text, not typeset | Check the browser console for an error loading `katex.min.js`/`katex-auto-render.min.js` (SRI mismatch after an incomplete upgrade, or the container serving a stale copy — see [Refreshing After a Code Change](#refreshing-after-a-code-change)). If only *one* expression in an otherwise-working message shows as raw text, that's expected — a malformed expression falls back to its raw source rather than breaking the rest of the message |
| "Could not extract text from this PDF" | The PDF is encrypted (not supported) or scanned/image-only (no extractable text — pypdf can't OCR). Try a different PDF, or copy the text into a `.txt`/`.md` file instead |
| Document attachment shows "Extracting text…" indefinitely | Check `docker logs vpal-doc-extract`; if the container isn't healthy, `docker-compose up -d --build doc-extract` |
| Document Q&A gives a generic/unrelated answer | The document was likely truncated (a toast appears when this happens) — a very long PDF only has its first `MAX_DOCUMENT_TEXT_CHARS` (28,000 by default) characters included |

### Debug mode

Open browser developer tools (F12) → **Console**. For container logs:
```powershell
docker logs vpal-auth
docker logs vpal-nginx
docker logs vpal-voicebox-proxy
docker logs vpal-doc-extract
docker logs vpal-piper-tts
docker logs vpal-settings
docker logs vpal-conversations
```

## 📄 License

This project is provided as-is for local AI experimentation. Please ensure compliance with Ollama's licensing terms and any applicable AI model licenses.

## ⚠️ Disclaimer

This application is for personal use only. AI-generated content may not always be accurate or appropriate. Users should exercise discretion when using AI responses, especially for sensitive topics or decision-making.

---

*Built with modern web technologies for secure, local AI interaction*
