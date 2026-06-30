# TODO

## Code Hygiene

- [x] Replace `notice.style.cssText` in `addContextTrimNotice()` with CSS class `.context-trim-notice`
- [x] Remove commented-out debug log in `speakText()` (`speech.js`)
- [x] Remove informational `console.log` calls in `chat.js` (`clearChat`, `saveChat`, `handleOpenFile`)
- [x] `__pycache__/`, `*.pyc`, `*.pyo`, `.pytest_cache/` added to `.gitignore`
- [x] `httpx` → `httpx2` in `auth/requirements-test.txt`
- [x] `white-space: pre-wrap` on `.user-message .message-content p` — Shift+Enter newlines now preserved in the displayed chat bubble
- [x] Guard `autoTTSBtn` localStorage restore behind `'speechSynthesis' in window` — prevents the button appearing green/active on browsers without Web Speech API TTS

## Security Improvements

- [x] Add file size validation in `handleOpenFile()` — 5 MB cap before `FileReader.readAsText()`
- [x] Pin vendored libraries to SRI hashes in `index.html` (`marked.min.js`, `dompurify.min.js`)
- [x] TOTP authentication — session-cookie auth via FastAPI + pyotp, gated by Nginx auth_request
- [x] TOTP replay protection — (username, code) pairs tracked in memory for 90 s; replayed codes rejected even within the valid TOTP window
- [x] Logout CSRF protection — HMAC-derived `vpal_csrf` cookie (non-HttpOnly); injected into logout form by `main.js`; verified server-side via double-submit cookie pattern
- [x] Nginx rate limiting on `/auth/login` — 20 req/min per IP, burst 5, returns 429; complements the in-process per-username lockout
- [x] Graceful session-expiry handling in `api.js` — `redirect: 'manual'` detects the nginx 302→login redirect; shows "Session expired — sign in again" with a link rather than silently failing
- [x] Copy/Speak buttons hidden until AI response fully and successfully completes — not shown on error, abort, or partial content
- [x] `microphone=(self)` added to nginx `Permissions-Policy` header
- [x] Chainguard base image digests pinned in `auth/Dockerfile` — both `FROM` lines use `@sha256:...` for reproducible, supply-chain-safe builds
- [x] Non-HttpOnly `vpal_user` cookie set at login for the JS profile widget; carries only the display username (no authentication capability); cleared on logout

## Testing

- [x] Pytest test suite for `auth/main.py` — 65 tests covering all route handlers, brute-force lockout, TOTP replay protection, CSRF token derivation, session validation, `vpal_user` cookie lifecycle, `/auth/me` endpoint, and security edge cases (`auth/tests/test_main.py`)

## Build / Operational

- [x] `.dockerignore` for auth build context — excludes `tests/`, `__pycache__/`, `.env`, `*.pyc`, and editor artefacts from the Docker build context (`auth/.dockerignore`)
- [x] GitHub Actions CI workflow (`.github/workflows/ci.yml`) — runs `black --check`, `flake8`, and `pytest -v` on every push and PR to `master`
- [x] ESLint for frontend JS — `eslint.config.js` with browser globals and cross-module names; `npm run lint:js` targets `src/aia/scripts/*.js` (excludes vendored `*.min.js`); zero violations on clean run
- [x] Frontend lint job added to CI — `frontend-lint` job in `.github/workflows/ci.yml` runs `npm ci` + `npm run lint:js` on every push and PR to `master`
- [x] Chainguard digest-check scheduled workflow — `.github/workflows/chainguard-digest-check.yml` pulls both `cgr.dev/chainguard/python` images monthly (1st of month, 09:00 UTC) and fails with remediation instructions if either digest differs from the pins in `auth/Dockerfile`; also supports `workflow_dispatch` for on-demand runs
- [x] nginx `auth_login` rate-limit zone renamed to `auth_api` — reflects that the zone covers both `/auth/login` (burst=5) and `/auth/me` (burst=10), not login alone
- [x] Version bumped to 1.4.0
- [x] ChatGPT-style input area redesign — flat flex row replaced with a rounded `.chat-input-container`; toolbar row holds mic/speaker icon buttons, Auto-speak toggle, char counter, and a circular send button (↑ arrow, dark when active, grey when empty) and stop-streaming button (■); `setStreamingUI` re-evaluates textarea content when streaming ends so send button state is always accurate; `aria-label` added to both icon-only buttons
- [x] HTMLHint for `src/aia/index.html` — `htmlhint` devDependency added; `.htmlhintrc` config; `npm run lint:html` targets `index.html`; `lint:html` step added to the `frontend-lint` CI job
- [x] Nginx config syntax check added to CI — `nginx-config-check` job generates dummy certs, mounts `nginx.conf` into `nginx:1-alpine`, and runs `nginx -t` on every push and PR to `master`
- [x] Version bumped to 1.5.0
- [x] Version bumped to 1.5.1

## Features / UX

- [x] Make speech recognition language configurable — `SPEECH_RECOGNITION_LANG` in `config.js`
- [x] Character counter on input field — appears when ≤ 500 chars remaining, warns at 200, red at 50
- [x] Persist `autoTTS` preference to `localStorage` across sessions
- [x] Auto-speak `<label>` checkbox replaced with a 🔊 icon toggle button (`autoTTSBtn`) — consistent toolbar style; `aria-pressed` tracks on/off state; `tts-on` CSS class shows green active state; localStorage key unchanged so existing preferences are preserved
- [x] Profile menu widget in chat header — 👤 icon + logged-in username (title-cased from `vpal_user` cookie, with `/auth/me` fallback for existing sessions); dropdown contains Save, Open, Clear, Close, Sign out; replaces standalone header buttons
- [x] `/auth/me` GET endpoint in auth service — validates session cookie, returns `{"username": "..."}` as JSON; used by profile widget when `vpal_user` cookie is absent
- [x] Persona dropdown — ▾ button next to "🤖 AI Assistant" opens a fixed-position panel with the persona select; selected persona name displayed as a subtitle beneath the heading; renamed from "System Prompt" to "Persona"; replaces the always-visible System Prompt bar
- [x] Persona toggle locked state — `personaToggleBtn` gains `.locked` class and updated tooltip when a conversation is active; panel shows an inline notice; `updateSystemPromptState()` owns all persona-widget visual state
- [x] Profile dropdown and persona panel close on window resize — prevents stale `position:fixed` coordinates after viewport dimensions change
- [x] User input upgraded to auto-growing `<textarea>` — expands up to 200 px as content grows; Shift+Enter inserts a newline, Enter sends; placeholder text communicates the Shift+Enter convention; voice dictation dispatches `input` events so the textarea resizes for speech too
- [x] `aria-pressed` on `micBtn` — updated in all five code paths that change recording state across `speech.js` and `chat.js`; initial `aria-pressed="false"` set in HTML
- [x] `saveChat` success toast — brief "Chat saved" notification shown after download via `showToast()` in `utils.js` (reuses existing `.toast` CSS class)
- [x] Save filename format changed to `YYYYMMDD-HHMMss-vpal-<Topic>.json` — `_chatTopic()` helper in `saveChat()` strips punctuation, filters ~45 English stopwords, takes the first 2–3 meaningful words from the opening user message, title-cases them, and joins with hyphens; falls back to `'Chat'` when no qualifying words are found
- [x] Copy and Speak action buttons redesigned to ChatGPT-style icon-only toggles — SVG icons (`COPY_ICON`, `CHECK_ICON`, `SPEAK_ICON`, `STOP_ICON`) defined as top-level constants in `chat.js`; `SPEAK_ICON`/`STOP_ICON` shared with `speech.js` for per-message button state updates; `.action-btn` base class with `.copy-btn`/`.speak-btn` secondary classes preserve `api.js` querySelector compatibility; all four icons declared in `eslint.config.js` crossModuleGlobals
- [x] `type="button"` added to all non-submit buttons in `index.html` — prevents implicit `type="submit"` default on toolbar, send, stop, and dropdown menu buttons
- [x] `:focus-visible` outlines added to all interactive controls — `.action-btn`, `.voice-btn`, `.toolbar-icon-btn`, `.send-btn`, `.stop-streaming-btn`, `.persona-toggle-btn`, `.profile-trigger`, and `.profile-dropdown button` now show keyboard focus indicators (white outline on dark header, purple on light backgrounds)
- [x] Version bumped to 1.5.2
- [x] `#chatMessages` annotated with `role="log"`, `aria-label="Chat messages"`, and explicit `aria-live="polite"` — screen readers now identify the chat transcript and announce new messages as they arrive
- [x] `#userInput` textarea given `aria-label="Message"` — replaces placeholder-only labelling, which is not a substitute for an accessible label
- [x] HTMLHint `tag-pair` rule enabled in `.htmlhintrc` — passes cleanly (SVG self-closing elements do not trigger false positives); now catches unclosed HTML structural tags
- [x] CI `nginx-config-check` job pinned from `nginx:1-alpine` to `nginx:1.27-alpine` — eliminates silent breakage risk from a future 1.x minor-version config-syntax change
- [x] `showToast` timer moved from DOM node property (`toast._timer`) to module-level variable (`_toastTimer`) in `utils.js`
- [x] Version bumped to 1.5.3
- [x] `role="menu"` and `role="menuitem"` removed from profile dropdown — the ARIA menu role requires arrow-key navigation and forbids intermediate `<form>` wrappers; plain buttons are semantically correct and keyboard-navigable via Tab
- [x] `#systemPromptSelect` given `aria-labelledby="personaPanelHeader"` — programmatically associates the "Persona" heading with the select element; `id="personaPanelHeader"` added to the heading div
- [x] Persona panel focus management — `openPersonaPanel()` moves focus to the select when it is not disabled; `closePersonaPanel()` returns focus to `personaToggleBtn` when the active element is inside the panel at close time
- [x] CLAUDE.md CI section updated from `nginx:1-alpine` to `nginx:1.27-alpine` to match the actual CI job
- [x] `.github/dependabot.yml` added — monthly Dependabot updates for both `npm` devDependencies and GitHub Actions workflow steps
- [x] Version bumped to 1.5.4

## Known Limitations (Accepted Trade-offs)

- **In-memory auth state** — brute-force lockout counters and TOTP replay protection are stored in process memory. Restarting `vpal-auth` clears this state, giving an attacker a fresh attempt window within the 90-second TOTP validity period. Accepted trade-off for a local 1–5-user deployment; documented in `README.md`. Mitigated by adding a persistent backing store (Redis, SQLite) if the threat model requires it.
