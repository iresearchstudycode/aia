# TODO

## Code Hygiene

- [x] Replace `notice.style.cssText` in `addContextTrimNotice()` with CSS class `.context-trim-notice`
- [x] Remove commented-out debug log in `speakText()` (`speech.js`)
- [x] Remove informational `console.log` calls in `chat.js` (`clearChat`, `saveChat`, `handleOpenFile`)

## Security Improvements

- [x] Add file size validation in `handleOpenFile()` — 5 MB cap before `FileReader.readAsText()`
- [x] Pin vendored libraries to SRI hashes in `index.html` (`marked.min.js`, `dompurify.min.js`)
- [x] TOTP authentication — session-cookie auth via FastAPI + pyotp, gated by Nginx auth_request
- [ ] TOTP replay protection — track used codes per-user to prevent reuse within the 90-second window
- [ ] Logout CSRF protection — add a signed anti-CSRF token to the logout form
- [ ] Graceful session-expiry handling in `api.js` — detect 302→login redirect on streaming fetch and show a "Session expired — please refresh" message instead of a silent JSON parse error

## Features / UX

- [x] Make speech recognition language configurable — `SPEECH_RECOGNITION_LANG` in `config.js`
- [x] Character counter on input field — appears when ≤ 500 chars remaining, warns at 200, red at 50
- [x] Persist `autoTTS` checkbox state to `localStorage` across sessions
