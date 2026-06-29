# 🤖 AI Assistant (Local) - Web Application

A modern, voice-enabled AI chat interface that runs entirely on your local machine using Ollama for AI model inference.

## 📋 Overview

This web application provides a chat interface with voice input/output capabilities, connecting to locally-hosted AI models through Ollama's REST API. The application features a responsive design, real-time streaming responses, and multiple AI personas.

## 🏗️ Architecture

### System Context
The application runs entirely locally on the user's machine with three main components:
- **Web Interface**: HTML/CSS/JavaScript application served by Nginx inside a Docker container
- **AI Inference**: Ollama server running directly on the host machine at localhost:11434
- **Voice Features**: Browser-based speech recognition and text-to-speech

```
┌────────────────────────────────────────────────────────────────────────────┐
│                              Host Machine                                  │
│                                                                            │
│  ┌─────────┐                                                               │
│  │  User   │  keyboard / voice                                             │
│  └────┬────┘                                                               │
│       │ ▲  reads / hears                                                   │
│       ▼ │                                                                  │
│  ┌─────────┐     HTTPS (127.0.0.1:443)                                     │
│  │         │ ─────────────────────────►  ┌──────────────────────────────┐  │
│  │ Browser │                             │      Docker Container        │  │
│  │         │ ◄─────────────────────────  │                              │  │
│  └─────────┘                             │  cgr.dev/chainguard/nginx    │  │
│       │                                  │  (uid=65532)                 │  │
│  Web Speech                              │                              │  │
│    API (local)                           │  src/aia/  HTML / JS / CSS   │  │
│                                          └──────────────┬───────────────┘  │
│                                                         │                  │
│                                             HTTP/REST   │  streaming       │
│                                       host.docker.internal:11434           │
│                                                         ▼                  │
│                                           ┌───────────────────────────┐    │
│                                           │       Ollama API          │    │
│                                           │    localhost:11434        │    │
│                                           └──────────────┬────────────┘    │
│                                                        │                   │
│                                               internal │  inference        │
│                                                        ▼                   │
│                                           ┌───────────────────────────┐    │
│                                           │     Local AI Models       │    │
│                                           │  gemma4, llama, mistral…  │    │
│                                           └───────────────────────────┘    │
└────────────────────────────────────────────────────────────────────────────┘
```

### Technology Stack
- **Frontend**: HTML5, CSS3, ES6+ JavaScript
- **Voice**: Web Speech API (recognition & synthesis)
- **AI Integration**: Fetch API → Nginx reverse proxy → Ollama REST API
- **Markdown Rendering**: Marked.js (vendored)
- **HTML Sanitization**: DOMPurify (vendored)
- **Web Server**: Nginx (`cgr.dev/chainguard/nginx`, distroless, uid=65532)
- **Container**: Docker with read-only filesystem and minimal capability set



## 🚀 Quick Start

### Prerequisites
- [Docker Desktop](https://www.docker.com/products/docker-desktop/) installed and running
- [Ollama](https://ollama.ai) installed and running on the host machine
- The default model pulled: `ollama pull gemma4:e4b`
- TLS certificates generated with [mkcert](https://github.com/FiloSottile/mkcert) and placed in `deploy/certs/`
- A modern web browser with Web Speech API support (Chrome, Edge, Firefox, Safari 14.1+)

### Installation
1. Clone or download this repository
2. Generate and install local TLS certificates:
   ```bash
   mkcert -install
   mkcert -cert-file deploy/certs/localhost.pem -key-file deploy/certs/localhost-key.pem localhost
   ```
3. Start the application:
   ```bash
   docker-compose up
   ```
4. Open `https://localhost/` in your browser (accept the self-signed certificate on first visit)

### Usage
1. Select an AI persona from the dropdown
2. Click the microphone button to enable voice input
3. Type or speak your message
4. The AI will respond with streaming text and optional voice output

## 📁 Project Structure

```
vpal/
├── src/
│   └── aia/                        # Web application source
│       ├── index.html              # Main HTML structure
│       ├── css/
│       │   └── style.css           # Application styling
│       ├── scripts/
│       │   ├── config.js           # Configuration & prompts
│       │   ├── utils.js            # Utility functions
│       │   ├── speech.js           # Voice features
│       │   ├── chat.js             # Chat UI management
│       │   ├── api.js              # Ollama API client
│       │   ├── main.js             # Application initialization
│       │   ├── marked.min.js       # Markdown parser (vendored)
│       │   └── dompurify.min.js    # HTML sanitizer (vendored)
│       └── images/
│           └── icon.ico            # Application icon
├── deploy/                         # Deployment configuration
│   ├── nginx/
│   │   └── nginx.conf              # Nginx web server config
│   └── certs/                      # TLS certificates (mkcert)
│       ├── localhost.pem
│       └── localhost-key.pem
├── docker-compose.yml
└── README.md
```

## 🔧 Configuration

### Ollama Settings
- **API URL**: `https://localhost/ollama/api/chat` (proxied through Nginx — configured in `config.js`)
- **Direct Ollama address**: `http://localhost:11434` (host only, not called by the browser directly)
- **Model**: Configurable via `MODEL_NAME` in `config.js` (default: `gemma4:e4b`)
- **Streaming**: Enabled for real-time responses

### Voice Settings
- **Recognition**: Continuous speech-to-text
- **Synthesis**: Text-to-speech with voice selection
- **Languages**: Browser-dependent

## 🛡️ Security

### Implemented Measures

| Layer | Controls |
|---|---|
| **Transport** | HTTPS only (TLS 1.2/1.3), HSTS, HTTP→HTTPS redirect |
| **Browser** | CSP with no `unsafe-inline` in any directive (`script-src 'self'`, `style-src 'self'`), `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `Permissions-Policy` |
| **XSS prevention** | All AI response content sanitized with DOMPurify (SRI-pinned) before rendering; user input escaped with `escapeHtml` before DOM insertion |
| **Proxy** | Ollama API locked to exact-match `POST /ollama/api/chat` only — all other paths and methods denied; rate-limited to 5 req/min with burst of 5 |
| **Container** | Read-only filesystem, non-root user (uid=65532), `cap_drop: ALL` + `NET_BIND_SERVICE` only, `no-new-privileges`, `restart: unless-stopped` |
| **Network** | Loopback-only binding (`127.0.0.1`) — not accessible from LAN |
| **Input** | User messages capped at 4,000 characters; Nginx enforces 1 MB request body limit; uploaded chat files capped at 5 MB |
| **Supply chain** | `marked.min.js` and `dompurify.min.js` pinned with SHA-256 SRI hashes — browser refuses to load either if tampered |

### Scope Limitation

This application is designed for **single-user local use only**. It has no authentication layer and assumes a trusted local environment. It is not suitable for multi-user or public deployment without significant additional hardening.

## 🎯 Features

- **Voice Input/Output**: Full speech recognition and synthesis
- **Real-time Streaming**: Live AI response streaming with stop control
- **Multiple Personas**: 13 pre-configured AI personalities
- **Chat History**: Save/load conversation history as JSON
- **Character Counter**: Remaining character count shown as you approach the 4,000-character limit
- **Auto-Speak Persistence**: Auto-speak preference saved across browser sessions
- **Responsive Design**: Mobile-friendly interface
- **Markdown Support**: Rich text formatting in responses
- **Local AI**: No external API dependencies

## 🔍 System Requirements

- **Browser**: Chrome 25+, Firefox 44+, Safari 14.1+, Edge 79+
- **RAM**: 4GB minimum (8GB recommended for larger models)
- **Storage**: 2GB+ for AI models
- **Network**: Local network access to Ollama server

## 🐛 Troubleshooting

### Common Issues
- **Voice not working**: Check browser permissions for microphone access
- **Ollama connection failed**: Ensure Ollama is running on port 11434
- **Model not found**: Run `ollama pull <model_name>` to download models
- **Slow responses**: Consider using smaller models or upgrading hardware

### Debug Mode
Open browser developer tools (F12) and check the **Console** tab. Errors from the Ollama API, speech recognition, and TTS are written with `console.error`. For deeper debugging, add temporary `console.log` calls to the relevant module in `src/aia/scripts/` and reload the page.

## 🤝 Contributing

This is a local AI assistant project. Contributions are welcome for:
- Additional AI personas
- UI/UX improvements
- Performance optimizations
- Security enhancements
- Cross-platform compatibility

## 📄 License

This project is provided as-is for local AI experimentation. Please ensure compliance with Ollama's licensing terms and any applicable AI model licenses.

## ⚠️ Disclaimer

This application is for educational and personal use only. AI-generated content may not always be accurate or appropriate. Users should exercise discretion when using AI responses, especially for sensitive topics or decision-making.

---

*Built with modern web technologies for local AI interaction*