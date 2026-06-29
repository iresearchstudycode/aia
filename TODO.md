# TODO

## Code Hygiene

- [x] Replace `notice.style.cssText` in `addContextTrimNotice()` with CSS class `.context-trim-notice`
- [x] Remove commented-out debug log in `speakText()` (`speech.js`)
- [x] Remove informational `console.log` calls in `chat.js` (`clearChat`, `saveChat`, `handleOpenFile`)

## Security Improvements

- [x] Add file size validation in `handleOpenFile()` — 5 MB cap before `FileReader.readAsText()`
- [x] Pin vendored libraries to SRI hashes in `index.html` (`marked.min.js`, `dompurify.min.js`)

## Features / UX

- [ ] Make speech recognition language (`recognition.lang`) configurable via `config.js` — currently hardcoded to `en-US`
- [ ] Surface a character counter near the input field to reflect the `maxlength="4000"` cap
- [ ] Consider persisting `autoTTS` checkbox state to `localStorage` across sessions
