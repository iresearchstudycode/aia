# TODO

## Code Hygiene

- [x] Replace `notice.style.cssText` in `addContextTrimNotice()` with CSS class `.context-trim-notice`
- [x] Remove commented-out debug log in `speakText()` (`speech.js`)
- [x] Remove informational `console.log` calls in `chat.js` (`clearChat`, `saveChat`, `handleOpenFile`)

## Security Improvements

- [x] Add file size validation in `handleOpenFile()` — 5 MB cap before `FileReader.readAsText()`
- [x] Pin vendored libraries to SRI hashes in `index.html` (`marked.min.js`, `dompurify.min.js`)
- [x] TOTP authentication — session-cookie auth via FastAPI + pyotp, gated by Nginx auth_request
- [x] TOTP replay protection — (username, code) pairs tracked in memory for 90 s; replayed codes rejected even within the valid TOTP window
- [x] Logout CSRF protection — HMAC-derived `vpal_csrf` cookie (non-HttpOnly); injected into logout form by `main.js`; verified server-side via double-submit cookie pattern
- [x] Nginx rate limiting on `/auth/login` — 20 req/min per IP, burst 5, returns 429; complements the in-process per-username lockout
- [x] Graceful session-expiry handling in `api.js` — `redirect: 'manual'` detects the nginx 302→login redirect; shows "Session expired — sign in again" with a link rather than silently failing

## Features / UX

- [x] Make speech recognition language configurable — `SPEECH_RECOGNITION_LANG` in `config.js`
- [x] Character counter on input field — appears when ≤ 500 chars remaining, warns at 200, red at 50
- [x] Persist `autoTTS` checkbox state to `localStorage` across sessions
