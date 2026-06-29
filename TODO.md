# TODO

## Code Hygiene

- [ ] Replace `notice.style.cssText` in `addContextTrimNotice()` (`chat.js:51`) with a CSS class — currently programmatic so not a CSP issue, but inconsistent with the CSS-class approach used everywhere else
- [ ] Remove commented-out debug log `// console.log('Using voice:', ...)` in `speakText()` (`speech.js:193`)
- [ ] Remove informational `console.log` calls in `chat.js` (`clearChat`, `saveChat`, `handleOpenFile`) or replace with a configurable debug flag

## Security Improvements

- [ ] Add file size validation in `handleOpenFile()` before `FileReader.readAsText()` — currently no cap on loaded JSON file size
- [ ] Evaluate pinning vendored library versions (`marked.min.js`, `dompurify.min.js`) to a subresource integrity (SRI) hash in `index.html`

## Features / UX

- [ ] Make speech recognition language (`recognition.lang`) configurable via `config.js` — currently hardcoded to `en-US`
- [ ] Surface a character counter near the input field to reflect the `maxlength="4000"` cap
- [ ] Consider persisting `autoTTS` checkbox state to `localStorage` across sessions
