# 🤖 AI Assistant (Local) - Web Application
A secure, voice-enabled AI chat interface that runs entirely on your local machine using Ollama for AI model inference. Access is restricted to authenticated users via time-based one-time passwords (TOTP) compatible with Google Authenticator.

## 📋 Overview

This web application provides a chat interface with voice input/output capabilities, connecting to locally-hosted AI models through Ollama's REST API. The application features a responsive design, real-time streaming responses, and multiple AI personas — protected by TOTP authentication for up to five users.

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
│                            host.docker.internal:11434  │                                    └──────────────────────────────┘ │
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
│                                       │           (gemma4)               │                                                   │
│                                       └──────────────────────────────────┘                                                   │
└──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────┘
```

Every request to Nginx triggers an internal sub-request to the auth service (`auth_request`). If the session cookie is missing or expired, Nginx redirects the browser to the login page — no unauthenticated request ever reaches the static application or Ollama proxy.

### Technology Stack

| Layer | Technology |
|---|---|
| Frontend | HTML5, CSS3, ES6+ JavaScript |
| Voice | Web Speech API (recognition & synthesis) |
| AI integration | Fetch API → Nginx reverse proxy → Ollama REST API |
| Markdown | Marked.js (vendored, SRI-pinned) |
| HTML sanitisation | DOMPurify v3.4.11 (vendored, SRI-pinned) |
| Web server | Nginx (`cgr.dev/chainguard/nginx`, distroless, uid=65532) |
| Auth service | FastAPI + pyotp + itsdangerous (`cgr.dev/chainguard/python:latest`, uid=65532) |
| Session | HMAC-signed cookie (`itsdangerous.TimestampSigner`), 8-hour TTL |
| TOTP | RFC 6238 via `pyotp`, compatible with Google Authenticator |
| Container | Docker, read-only filesystems, minimal capability sets |

## 🚀 Quick Start

### Prerequisites

- [Docker Desktop](https://www.docker.com/products/docker-desktop/) installed and running
- [Ollama](https://ollama.ai) installed and running on the host machine
- The default model pulled: `ollama pull gemma4:e4b`
- TLS certificates generated with [mkcert](https://github.com/FiloSottile/mkcert) and placed in `deploy/certs/`
- A modern web browser with Web Speech API support (Chrome, Edge, Firefox, Safari 14.1+)

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
4. Click **🔒 Sign out** in the header to end the session.

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
│   │   └── test_main.py            # 57 pytest tests
│   └── static/
│       └── login.css               # Login page styles
├── src/
│   └── aia/                        # Web application source
│       ├── index.html              # Main HTML structure
│       ├── css/
│       │   └── style.css           # Application styling
│       ├── scripts/
│       │   ├── config.js           # Configuration & system prompts
│       │   ├── utils.js            # Utility functions
│       │   ├── speech.js           # Voice features
│       │   ├── chat.js             # Chat UI management
│       │   ├── api.js              # Ollama API client
│       │   ├── main.js             # Application initialisation
│       │   ├── marked.min.js       # Markdown parser (vendored)
│       │   └── dompurify.min.js    # HTML sanitiser (vendored)
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
├── docker-compose.yml
└── README.md
```

## 🔧 Configuration

### Ollama settings

- **Model**: `MODEL_NAME` in `config.js` (default: `gemma4:e4b`)
- **API URL**: `OLLAMA_API_URL` in `config.js` (default: `https://localhost/ollama/api/chat`)
- **Context length**: `MAX_HISTORY_MESSAGES` in `config.js` (default: `40`, i.e. 20 exchanges)

### Voice settings

- **Language**: `SPEECH_RECOGNITION_LANG` in `config.js` (BCP 47, default: `en-US`)
- **Silence detection**: `SILENCE_TIMEOUT_MS` in `config.js` (default: `3000` ms)

### Auth settings

All auth settings live in `.env`:

| Variable | Default | Description |
|---|---|---|
| `SECRET_KEY` | — | **Required.** Session signing key, ≥ 32 characters |
| `SESSION_TTL_HOURS` | `8` | Session lifetime in hours |
| `SETUP_TOKEN` | — | Enables QR setup page when set; remove after setup |
| `USER_N` / `TOTP_SECRET_N` | — | Username and TOTP secret for user N (N = 1–5) |

## 🛡️ Security

### Implemented measures

| Layer | Controls |
|---|---|
| **Authentication** | TOTP (RFC 6238) via Google Authenticator; signed session cookie (HMAC-SHA1, 8-hour TTL); brute-force lockout after 5 failed attempts per username (5-minute window) |
| **Session** | `HttpOnly`, `Secure`, `SameSite=Strict` cookie; Nginx `auth_request` gates every route before serving content |
| **Transport** | HTTPS only (TLS 1.2/1.3), HSTS, HTTP→HTTPS redirect |
| **Browser** | CSP: `default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; form-action 'self'`; `X-Frame-Options: DENY`; `X-Content-Type-Options: nosniff`; `Referrer-Policy: no-referrer`; `Permissions-Policy` |
| **XSS prevention** | All AI response content sanitised with DOMPurify (SRI-pinned) before rendering; user input escaped with `escapeHtml` before DOM insertion |
| **Proxy** | Ollama API locked to exact-match `POST /ollama/api/chat` only — all other paths and methods denied; rate-limited to 5 req/min with burst of 5 |
| **Containers** | Both containers: read-only filesystem, non-root user, `cap_drop: ALL`, `no-new-privileges`; Nginx adds `NET_BIND_SERVICE` only |
| **Network** | Loopback-only binding (`127.0.0.1`); auth service port not published to the host (Docker-internal only) |
| **Secrets** | All credentials in `.env` (gitignored); no hardcoded keys, tokens, or passwords anywhere in source |
| **Input** | User messages capped at 4,000 characters; Nginx enforces 1 MB request body limit; uploaded chat files capped at 5 MB |
| **Supply chain** | `marked.min.js` and `dompurify.min.js` pinned with SHA-256 SRI hashes |

### Known limitations

- **In-memory auth state** — brute-force lockout counters and TOTP replay protection are stored in process memory. Restarting the `vpal-auth` container (`docker-compose restart auth`) clears this state, giving an attacker a fresh attempt window within the 90-second TOTP validity period. For a local-only, 1–5-user deployment this is an accepted trade-off; adding a persistent backing store (Redis, SQLite) would close the gap if the threat model requires it.

## 🎯 Features

- **TOTP Authentication**: Google Authenticator login for up to five users
- **Voice Input/Output**: Continuous speech recognition and text-to-speech synthesis
- **Real-time Streaming**: Live AI response streaming with stop control
- **Multiple Personas**: 13 pre-configured AI personalities
- **Per-message Actions**: Copy to clipboard and speak buttons on every AI response
- **Chat History**: Save/load conversation history as JSON
- **Character Counter**: Remaining character count shown as you approach the 4,000-character limit
- **Auto-Speak Persistence**: Auto-speak preference saved across browser sessions
- **Markdown Support**: Rich text formatting in AI responses

## 🔍 System Requirements

- **Browser**: Chrome 25+, Firefox 44+, Safari 14.1+, Edge 79+
- **RAM**: 4 GB minimum (8 GB recommended for larger models)
- **Storage**: 2 GB+ for AI models
- **Network**: Local loopback only (`127.0.0.1`)

## 🐛 Troubleshooting

| Symptom | Fix |
|---|---|
| Login page shown on every visit | Session cookie expired or browser blocking cookies for `localhost` — check browser cookie settings |
| "Invalid username, code, or too many attempts" | Verify username matches exactly what is in `.env`; check phone clock is synced; wait 5 minutes if locked out |
| Setup page returns 404 | `SETUP_TOKEN` is not set in `.env`, or the token in the URL does not match |
| Auth container won't start | `SECRET_KEY` is missing or under 32 characters, or no `USER_N` / `TOTP_SECRET_N` pairs are set |
| Voice not working | Check browser microphone permissions |
| Ollama connection failed | Ensure Ollama is running: `ollama serve` |
| Model not found | Run `ollama pull gemma4:e4b` |

### Debug mode

Open browser developer tools (F12) → **Console**. For auth container logs:
```powershell
docker logs vpal-auth
docker logs vpal-nginx
```

## 📄 License

This project is provided as-is for local AI experimentation. Please ensure compliance with Ollama's licensing terms and any applicable AI model licenses.

## ⚠️ Disclaimer

This application is for personal use only. AI-generated content may not always be accurate or appropriate. Users should exercise discretion when using AI responses, especially for sensitive topics or decision-making.

---

*Built with modern web technologies for secure, local AI interaction*