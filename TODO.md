# TODO

## Code Hygiene

- [x] Replace `notice.style.cssText` in `addContextTrimNotice()` with CSS class `.context-trim-notice`
- [x] Remove commented-out debug log in `speakText()` (`speech.js`)
- [x] Remove informational `console.log` calls in `chat.js` (`clearChat`, `saveChat`, `handleOpenFile`)

## Security Improvements

- [ ] Add file size validation in `handleOpenFile()` before `FileReader.readAsText()` — currently no cap on loaded JSON file size
- [ ] Evaluate pinning vendored library versions (`marked.min.js`, `dompurify.min.js`) to a subresource integrity (SRI) hash in `index.html`

## Features / UX

- [ ] Make speech recognition language (`recognition.lang`) configurable via `config.js` — currently hardcoded to `en-US`
- [ ] Surface a character counter near the input field to reflect the `maxlength="4000"` cap
- [ ] Consider persisting `autoTTS` checkbox state to `localStorage` across sessions
