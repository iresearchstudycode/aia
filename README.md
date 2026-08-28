# 🤖 AI Assistant (Local) - Web Application
A secure, voice-enabled AI chat interface that runs entirely on your local machine using Ollama for AI model inference. Access is restricted to authenticated users via time-based one-time passwords (TOTP) compatible with Google Authenticator.

## 📋 Overview

This web application provides a ChatGPT-style chat interface (dark navy header, sky-blue user bubbles, clean card AI responses) with voice input/output, a single "+" attach menu for image attachment (multimodal vision queries) and document attachment (.txt/.md/.pdf Q&A), LaTeX math rendering via KaTeX, and a live collapsible thinking block for reasoning-capable models. It connects to locally-hosted AI models through Ollama's REST API with no external dependencies — protected by TOTP authentication for up to five users.

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
│                                       │  POST /ollama/api/chat           │                  │    /auth/verify              │ │
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

This lets AI responses be spoken through VoiceBox as an alternative to the browser's own Web Speech API — with two extras the browser engine doesn't have: repeat text is served from `vpal-voicebox-proxy`'s in-memory cache instead of being re-synthesized (and re-spoken) from scratch, and the toolbar shows a real "generating" spinner for the full synthesis duration on a cache miss. It's entirely optional — the app works fully without Voicebox running; selecting the VoiceBox engine while it's unreachable just shows a toast error.

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
| Voice | Web Speech API (recognition & synthesis) |
| AI integration | Fetch API → Nginx reverse proxy → Ollama REST API |
| Markdown | Marked.js (vendored, SRI-pinned) |
| HTML sanitisation | DOMPurify v3.4.11 (vendored, SRI-pinned) |
| Math typesetting | KaTeX v0.18.1 + auto-render extension (vendored, SRI-pinned) |
| Web server | Nginx (`cgr.dev/chainguard/nginx`, distroless, uid=65532) |
| Auth service | FastAPI + pyotp + itsdangerous (`cgr.dev/chainguard/python:latest`, uid=65532) |
| VoiceBox proxy (optional) | FastAPI + httpx (`cgr.dev/chainguard/python:latest`, uid=65532) — bridges to a local Voicebox app's REST API; in-memory generation cache |
| Document text extraction | FastAPI + pypdf (`cgr.dev/chainguard/python:latest`, uid=65532) — self-contained PDF text extraction; `.txt`/`.md` handled entirely client-side |
| Session | HMAC-signed cookie (`itsdangerous.TimestampSigner`), 8-hour TTL |
| TOTP | RFC 6238 via `pyotp`, compatible with Google Authenticator |
| Container | Docker, read-only filesystems, minimal capability sets |

## 🚀 Quick Start

### Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) installed and running
- [Ollama](https://ollama.ai) installed and running on the host machine
- Models pulled: `ollama pull gemma4:e4b` (text + thinking) and `ollama pull gemma3:4b` (vision)
- TLS certificates generated with [mkcert](https://github.com/FiloSottile/mkcert) and placed in `deploy/certs/`
- A modern web browser with Web Speech API support (Chrome, Edge, Firefox, Safari 14.1+)
- (Optional) The Voicebox desktop app running on the host if you want the VoiceBox TTS engine — the app works fully without it

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
4. Click the profile menu (user icon + username) in the header, then **Sign out** to end the session.

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
├── src/
│   └── aia/                        # Web application source
│       ├── index.html              # Main HTML structure
│       ├── css/
│       │   ├── style.css           # Application styling
│       │   ├── katex.min.css       # KaTeX math styling (vendored)
│       │   └── fonts/              # KaTeX math fonts (vendored)
│       ├── scripts/
│       │   ├── config.js           # Configuration & system prompts
│       │   ├── utils.js            # Utility functions
│       │   ├── speech.js           # Voice features
│       │   ├── chat.js             # Chat UI management
│       │   ├── api.js              # Ollama API client
│       │   ├── main.js             # Application initialisation
│       │   ├── marked.min.js       # Markdown parser (vendored)
│       │   ├── dompurify.min.js    # HTML sanitiser (vendored)
│       │   ├── katex.min.js        # Math typesetting (vendored)
│       │   └── katex-auto-render.min.js  # KaTeX delimiter scanner (vendored)
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

### Ollama settings

- **Text + thinking model**: `MODEL_NAME` in `config.js` (default: `gemma4:e4b`)
- **Vision model**: `VISION_MODEL_NAME` in `config.js` (default: `gemma3:4b`) — used automatically when an image is attached; `gemma4:e4b` has no vision encoder
- **API URL**: `OLLAMA_API_URL` in `config.js` (default: `https://localhost/ollama/api/chat`)
- **Context length**: `OLLAMA_NUM_CTX` in `config.js` (default: `16384`) — must match the Ollama server's actual configured context length (`OLLAMA_CONTEXT_LENGTH` env var, or `PARAMETER num_ctx` in the model's Modelfile); sent explicitly as `num_ctx` on every text/thinking and multi-turn-vision request so behavior never silently depends on Ollama's own default. `MAX_HISTORY_MESSAGES` in `config.js` (default: `40`, i.e. 20 exchanges) additionally bounds how many past messages are kept regardless of their token cost

### Voice settings

- **Language**: `SPEECH_RECOGNITION_LANG` in `config.js` (BCP 47, default: `en-US`)
- **Silence detection**: `SILENCE_TIMEOUT_MS` in `config.js` (default: `3000` ms)
- **TTS engine**: Toolbar dropdown next to the auto-speak button — "VoiceBox" (local Voicebox app, default; via `VOICEBOX_SPEAK_URL` in `config.js`, default: `https://localhost/voicebox/speak`) or "Browser" (Web Speech API); choice persisted to `localStorage`. If Voicebox isn't running, switch to "Browser" or it'll show an unavailable toast on speak. VoiceBox shows a spinner on the speak button while a new line is being synthesized; repeating the exact same text skips synthesis entirely and instantly replays the cached clip (with a working stop button, unlike a fresh generation).

### Auth settings

All auth settings live in `.env`:

| Variable | Default | Description |
|---|---|---|
| `SECRET_KEY` | — | **Required.** Session signing key, ≥ 32 characters |
| `SESSION_TTL_HOURS` | `8` | Session lifetime in hours |
| `SETUP_TOKEN` | — | Enables QR setup page when set; remove after setup |
| `USER_N` / `TOTP_SECRET_N` | — | Username and TOTP secret for user N (N = 1–5) |

### VoiceBox settings (optional)

All optional and only needed if you run the Voicebox desktop app locally and want the VoiceBox TTS engine. Set in `.env`; the app works fully without them:

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

- **Client-side** (`src/aia/scripts/config.js`): `MAX_DOCUMENT_UPLOAD_BYTES` (default `15728640`, matches `MAX_UPLOAD_BYTES` above) and `MAX_DOCUMENT_TEXT_CHARS` (default `28000`, ≈7K tokens at ~4 chars/token) — the character budget actually folded into a chat message. Sized against `OLLAMA_NUM_CTX` (16384 tokens, see [Ollama settings](#ollama-settings)): a document at this budget leaves roughly half the context free for the system prompt, conversation history, thinking budget, and the response itself. Raising this without also raising `OLLAMA_NUM_CTX` risks Ollama silently truncating context on longer or thinking-enabled conversations rather than erroring.

## 🛡️ Security

### Implemented measures

| Layer | Controls |
|---|---|
| **Authentication** | TOTP (RFC 6238) via Google Authenticator; signed session cookie (HMAC-SHA1, 8-hour TTL); brute-force lockout after 5 failed attempts per username (5-minute window) |
| **Session** | `HttpOnly`, `Secure`, `SameSite=Strict` cookie; Nginx `auth_request` gates every route before serving content |
| **Transport** | HTTPS only (TLS 1.2/1.3), HSTS, HTTP→HTTPS redirect |
| **Browser** | CSP: `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; form-action 'self'`; `X-Frame-Options: DENY`; `X-Content-Type-Options: nosniff`; `Referrer-Policy: no-referrer`; `Permissions-Policy`. `script-src` has no inline/eval exception anywhere; `style-src`'s `'unsafe-inline'` exists solely for KaTeX, which positions glyphs via computed inline `style` attributes with no CSS-class-only alternative — bounded by the rest of the policy (no external hosts allowed anywhere), so it can't be used to exfiltrate data |
| **XSS prevention** | All AI/user response content sanitised with DOMPurify (SRI-pinned) before rendering; your own message text — including a folded-in document attachment — is inserted via `.textContent`, never parsed as HTML; KaTeX only ever runs on the already-sanitized DOM with `trust: false` (its default), which disables `\href`/`\url`/`\includegraphics`/`\html*` — the only way a LaTeX source string could otherwise make it emit attacker-chosen HTML |
| **Proxy** | Ollama API locked to exact-match `POST /ollama/api/chat` only — all other paths and methods denied; rate-limited to 5 req/min with burst of 5. VoiceBox proxy locked to `POST /voicebox/speak` and `GET /voicebox/audio/{id}` only; also auth-gated (Voicebox itself has no authentication of its own); both rate-limited to 10 req/min with burst of 3. Doc-extract proxy locked to `POST /doc-extract/extract` only; auth-gated; rate-limited to 10 req/min with burst of 3 |
| **Containers** | All four containers: read-only filesystem, non-root user, `cap_drop: ALL`, `no-new-privileges`; Nginx adds `NET_BIND_SERVICE` only |
| **Network** | Loopback-only binding (`127.0.0.1`); auth service port not published to the host (Docker-internal only) |
| **Secrets** | All credentials in `.env` (gitignored); no hardcoded keys, tokens, or passwords anywhere in source |
| **Input** | User messages capped at 4,000 characters; Nginx enforces 1 MB request body limit globally, `20 MB` on `/ollama/api/chat`, and `15 MB` on `/doc-extract/extract`; uploaded chat files capped at 5 MB; extracted document text capped at 28,000 characters before being folded into a chat message |
| **Supply chain** | `marked.min.js`, `dompurify.min.js`, `katex.min.js`, `katex-auto-render.min.js`, and `katex.min.css` all pinned with SHA-256 SRI hashes |

### Known limitations

- **In-memory auth state** — brute-force lockout counters and TOTP replay protection are stored in process memory. Restarting the `vpal-auth` container (`docker-compose restart auth`) clears this state, giving an attacker a fresh attempt window within the 90-second TOTP validity period. For a local-only, 1–5-user deployment this is an accepted trade-off; adding a persistent backing store (Redis, SQLite) would close the gap if the threat model requires it.

## 🎯 Features

- **TOTP Authentication**: Google Authenticator login for up to five users
- **ChatGPT-style UI**: Dark navy header, sky-blue user message bubbles (right-aligned), clean card AI responses; all controls use inline SVG line icons with no emoji
- **Profile Menu**: SVG user icon + logged-in username in the header; dropdown (Save, Open, Clear, Close, Sign out) opens as a fixed overlay with Tab focus trap and Escape to close
- **Persona Selector**: Chevron button next to the heading opens a panel to switch AI personas; selected persona shown as a subtitle; locked during an active conversation; Tab focus trap and Escape to close. The English Editor persona has an "Explain changes" checkbox (shown only for that persona) that swaps between the silent output-only prompt and one that explains its edits, persisted to `localStorage`. Switching persona also restores that persona's last-used thinking on/off + depth and TTS engine (per-persona settings memory, `localStorage` key `personaPrefs`)
- **Chat Input**: Auto-growing textarea (up to 6 lines); Enter sends, Shift+Enter inserts a newline; circular sky-blue send button activates only when text or an image is pending
- **Voice Input/Output**: Continuous speech recognition with 3-second silence detection; text-to-speech synthesis with per-message speak buttons; toolbar: mic → auto-speak → TTS engine (Browser / VoiceBox) → stop speaking
- **Attach Menu**: A single ChatGPT-style "+" button in the toolbar opens a popup with "Add photos" and "Add files" options, consolidating what were previously two separate toolbar buttons; Tab focus trap and Escape to close, matching the profile dropdown and persona panel
- **Image Attachment**: "Add photos" in the "+" attach menu opens a file picker; images are resized to ≤ 1024 px before being sent; vision requests are automatically routed to `gemma3:4b`; in-session thumbnails shown in user bubbles; saved chats show an SVG camera icon placeholder where the image was
- **Document Attachment**: "Add files" in the "+" attach menu attaches a `.txt`, `.md`, or `.pdf` file to ask questions about; `.txt`/`.md` are read directly in the browser, `.pdf` is extracted server-side (see [Document Attachment Path](#document-attachment-path)); the chat bubble shows a compact filename chip and your question, not the full extracted text; follow-up questions work automatically since the extracted text is part of normal conversation history
- **Thinking Mode**: Lightbulb toolbar button toggles reasoning ON/OFF; depth selector (Low / Medium / High) appears inline when enabled; live reasoning displayed in a collapsible `<details>` block; collapses when the final answer arrives; thinking content excluded from history, copy, and speech; mode and depth saved to `localStorage` and restored on reload
- **Dual-model Routing**: Text requests use `gemma4:e4b` (streaming, thinking-capable); image requests and vision follow-ups use `gemma3:4b`; `think: false` sent explicitly to suppress native reasoning when thinking is OFF
- **Real-time Streaming**: Live token-by-token response display with a stop button
- **Multiple Personas**: 11 pre-configured AI personalities
- **Per-message Actions**: Copy and speak SVG icon buttons appear on successful AI responses only; target the final answer (thinking content excluded)
- **Chat History**: Save/load conversation history as JSON; filename format `YYYYMMDD-HHMMss-vpal-<Topic>.json`; base64 image data stripped on save (preserves `hasImage` flag for routing and placeholder display)
- **Character Counter**: Remaining count shown as you approach the 4,000-character limit, with warning and danger colour states
- **Auto-Speak**: Toolbar icon toggles automatic TTS after each AI response; preference saved to `localStorage`
- **Markdown Support**: Rich text formatting in AI responses and thinking blocks via Marked.js + DOMPurify
- **Math Rendering**: LaTeX expressions typeset via KaTeX — inline (`$...$`, `\(...\)`) and display (`$$...$$`, `\[...\]`, plus `\begin{equation}`/`\begin{align}`/etc.) — in AI responses, thinking blocks, and your own messages; a malformed expression falls back to showing its raw source rather than breaking the rest of the message; math inside code blocks is left alone

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
| `auth/**`, `voicebox-proxy/**`, or `doc-extract/**` (Python backend code) | `docker-compose up -d --build auth` (or `voicebox-proxy` / `doc-extract`) — these are baked into their Docker image at build time, so a plain restart isn't enough |
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
| "VoiceBox is unavailable" toast | The Voicebox desktop app isn't running on the host, or `VOICEBOX_URL` in `.env` doesn't match its port — switch the toolbar TTS engine back to "Browser" as a workaround |
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
```

## 📄 License

This project is provided as-is for local AI experimentation. Please ensure compliance with Ollama's licensing terms and any applicable AI model licenses.

## ⚠️ Disclaimer

This application is for personal use only. AI-generated content may not always be accurate or appropriate. Users should exercise discretion when using AI responses, especially for sensitive topics or decision-making.

---

*Built with modern web technologies for secure, local AI interaction*
