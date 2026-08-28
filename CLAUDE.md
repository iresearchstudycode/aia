# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

VPAL (Voice-Powered AI Local) is a static web application — a secure, local-only AI chat interface with voice input/output, streaming responses, and 11 AI personas. It requires no build step; changes to files under `src/aia/` take effect immediately on reload.

## Running the Application

```bash
# Start the application
docker-compose up

# Access in browser
https://localhost/

# Reload Nginx config without restarting (for nginx.conf changes only)
docker exec vpal-nginx /usr/sbin/nginx -s reload

# Check container health
docker inspect --format='{{.State.Health.Status}}' vpal-nginx
```

**Prerequisites:**
- Docker Desktop running
- Ollama running on the Windows host at `localhost:11434` with both models pulled:
  - `ollama pull gemma4:e4b` — text + thinking model
  - `ollama pull gemma3:4b` — vision model (used automatically when an image is attached)
- `.env` file in the project root with `SECRET_KEY`, `USER_1`, `TOTP_SECRET_1` (see `auth/main.py` for all supported vars)
- Nothing extra for text-to-speech: the default **Piper** engine (`vpal-piper-tts`) is part of the compose stack and fully offline (the voice model is fetched + SHA256-verified during `docker-compose build`, so the first build needs network)
- (Optional) Voicebox running on the Windows host at its default port (`17493`) if you want the VoiceBox text-to-speech engine instead of Piper — the app works fully without it; selecting VoiceBox while it's unreachable just shows a toast error

## Testing

The auth, voicebox-proxy, doc-extract, and piper-tts services each have a pytest suite. Run them from their own directory — `conftest.py` adjusts `sys.path` (and, for `auth/`, sets required env vars) automatically.

```bash
# Install test dependencies (one-time)
pip install -r auth/requirements.txt -r auth/requirements-test.txt
pip install -r voicebox-proxy/requirements.txt -r voicebox-proxy/requirements-test.txt
pip install -r doc-extract/requirements.txt -r doc-extract/requirements-test.txt
pip install -r piper-tts/requirements.txt -r piper-tts/requirements-test.txt

# Run the full quality gate (mirrors CI exactly)
black auth/main.py auth/tests/ --check --line-length=99
flake8 auth/main.py auth/tests/ --max-line-length=99
cd auth && pytest tests/ -v

black voicebox-proxy/main.py voicebox-proxy/tests/ --check --line-length=99
flake8 voicebox-proxy/main.py voicebox-proxy/tests/ --max-line-length=99
cd voicebox-proxy && pytest tests/ -v

black doc-extract/main.py doc-extract/tests/ --check --line-length=99
flake8 doc-extract/main.py doc-extract/tests/ --max-line-length=99
cd doc-extract && pytest tests/ -v

black piper-tts/main.py piper-tts/tests/ --check --line-length=99
flake8 piper-tts/main.py piper-tts/tests/ --max-line-length=99
cd piper-tts && pytest tests/ -v   # synthesis is mocked — the ~60 MB voice model is never needed

# Run a single test class or test
cd auth && pytest tests/ -v -k TestLogout
cd auth && pytest tests/test_main.py::TestBruteForce::test_locks_at_threshold -v
```

```bash
# Frontend JS lint (ESLint — run from repo root)
npm run lint:js

# Frontend HTML lint (HTMLHint — validates src/aia/index.html)
npm run lint:html

# Frontend JS unit tests (Jest)
npx jest --testPathPatterns="tests/js"
```

CI runs six jobs automatically on every push and PR to `master` (`.github/workflows/ci.yml`):
- `auth-lint-test` — black + flake8 + pytest for `auth/`
- `voicebox-proxy-lint-test` — black + flake8 + pytest for `voicebox-proxy/`
- `doc-extract-lint-test` — black + flake8 + pytest for `doc-extract/`
- `piper-tts-lint-test` — black + flake8 + pytest for `piper-tts/` (synthesis mocked; no model download)
- `frontend-lint` — ESLint (`src/aia/scripts/`) + HTMLHint (`src/aia/index.html`) + Jest (`tests/js/`)
- `nginx-config-check` — generates dummy TLS certs, mounts `nginx.conf` into `nginx:1.27-alpine`, runs `nginx -t`

## Branching & Release Workflow

Two long-lived branches: **`dev`** (integration) and **`master`** (released — the default branch; CI's `push`/`pull_request` triggers fire only here, and `auth-lint-test`, `frontend-lint`, and `nginx-config-check` are required status checks).

- **All PRs target `dev`** — feature work and Dependabot version updates alike (`.github/dependabot.yml` sets `target-branch: dev`). `master` then only ever moves through a release PR, so `dev` stays strictly ahead of it.
- **A release is one PR `dev` → `master`, merged with "Create a merge commit"** — never *Squash* or *Rebase*. Those rewrite the commits, orphaning `dev`'s history so that `dev` has to be `git reset --hard origin/master`'d after every release (this is what happened with [#17]). A merge commit leaves `dev`'s commits reachable from `master` and lets the next step be a fast-forward.
- **Right after merging, fast-forward `dev` up to `master`** so the two never drift:
  ```bash
  git checkout dev && git fetch origin && git merge --ff-only origin/master && git push origin dev
  ```
  This pulls in only the release merge commit — no force-push, because `dev` was already its ancestor. If `--ff-only` is rejected, a Dependabot *security* PR (which ignores `target-branch` and lands on `master` directly) got in; drop `--ff-only` to make an ordinary merge commit on `dev` and carry on.
- Bump the `VERSION` file (semver) and add the `- [x]` line(s) to `TODO.md` in the same PR that ships the change.

## Architecture

```
Browser → HTTPS (port 443) / HTTP (port 80 → redirects to HTTPS)
       → Nginx (Docker, cgr.dev/chainguard/nginx, uid=65532)
           ├── /auth/* → FastAPI auth service (cgr.dev/chainguard/python, uid=65532)
           │              POST /auth/login   — validates username + TOTP code, issues session cookie
           │              POST /auth/logout  — CSRF-verified, clears session
           │              GET  /auth/verify  — sub-request endpoint called by auth_request
           │              GET  /auth/setup   — one-time QR setup (requires SETUP_TOKEN env var)
           │              GET  /auth/me      — returns {"username":"..."} for the profile widget
           ├── auth_request /auth/verify (session gate applied to all routes below)
           ├── GET/HEAD /* → serves static files from src/aia/
           ├── POST /ollama/api/chat (exact match) → reverse proxy → host.docker.internal:11434/api/chat
           ├── piper-tts service (python:3.12-slim, uid=65532) — self-contained, voice model baked into the image
           │              POST /piper/speak          — text → raw audio/wav (offline neural TTS; default engine)
           ├── voicebox-proxy service (cgr.dev/chainguard/python, uid=65532) → host.docker.internal:17493 (local Voicebox app REST API)
           │              POST /voicebox/speak       — synthesize (or resolve from cache) + play; blocks until done
           │              GET  /voicebox/audio/{id}  — fetch a past generation's audio, for cache-hit replay
           └── doc-extract service (cgr.dev/chainguard/python, uid=65532) — self-contained, no host dependency
                          POST /doc-extract/extract  — PDF upload → extracted text (.txt/.md are read client-side, never reach this)
```

Nginx handles TLS termination, HTTP→HTTPS redirect, and security headers (HSTS, CSP, X-Frame-Options). The container runs as a non-root user (uid=65532), read-only filesystem, with capabilities restricted to `NET_BIND_SERVICE` only.

## Docker Container Details

**Image:** `cgr.dev/chainguard/nginx` — distroless (no shell, no wget/curl). The healthcheck uses `nginx -t` (config validation) since no HTTP client is available.

**Writable paths (tmpfs):** `/var/lib/nginx/tmp` and `/var/run`, both owned by uid=65532. The container root filesystem is otherwise read-only.

**Capabilities:** Only `NET_BIND_SERVICE` is granted (to bind port 443 as non-root). All other capabilities are dropped.

**`host.docker.internal`** resolves to the Windows host via `extra_hosts: host-gateway`, allowing the Nginx proxy to reach Ollama at `localhost:11434`, and the `voicebox-proxy` service (which also sets `extra_hosts`) to reach the local Voicebox app at `localhost:17493`.

## JavaScript Module Architecture

Scripts are loaded in dependency order in `index.html`:

| Module | Responsibility |
|---|---|
| `marked.min.js` | Markdown parser (vendored, third-party) |
| `dompurify.min.js` | HTML sanitizer (vendored, v3.4.11) — applied at every AI content → innerHTML boundary |
| `highlight.min.js` | Syntax highlighting (vendored, highlight.js v11.11.1, "common" ~40-language build) — provides the `hljs` global, wrapped by `highlightCodeIn()` in `chat.js`. SRI-pinned, `binary` in `.gitattributes`, ESLint-ignored (`**/*.min.js`). See [Code Highlighting (highlight.js)](#code-highlighting-highlightjs) |
| `katex.min.js` + `katex-auto-render.min.js` | Math typesetting (vendored, KaTeX v0.18.1) — `katex-auto-render` provides `renderMathInElement()`, wrapped by `renderMathIn()` in `chat.js` |
| `diff-match-patch.js` | Google diff-match-patch — official uncompressed build, vendored verbatim, SRI-pinned, ESLint-ignored. Provides the browser `diff_match_patch` global (constructor + `DIFF_*` constants) via its `this[...]` export trick, which doubles as a CommonJS export under Jest (`this === module.exports` in Node). Used only by `diffWords()` in `utils.js` |
| `mermaid.min.js` | Diagram rendering (vendored, Mermaid v10.9.3 UMD single-file bundle — ~2.8 MB, an accepted tradeoff for a local app; v11 restructured away from a clean UMD). Provides the `mermaid` global, wrapped by `renderMermaidIn()` in `chat.js`. SRI-pinned, `binary` in `.gitattributes`, ESLint-ignored. Loaded last of the vendored scripts. See [Diagrams (Mermaid)](#diagrams-mermaid) |
| `config.js` | `MODEL_NAME`, `VISION_MODEL_NAME`, `OLLAMA_API_URL`, `PIPER_SPEAK_URL`, `VOICEBOX_SPEAK_URL`, `DOC_EXTRACT_URL`, `PERSONA_PREFS_KEY`, `EDITOR_MODE_KEY`, the system prompt objects (11 dropdown personas + the non-dropdown `englishEditorExplained` variant), and global mutable state (`conversationHistory[]`, `currentSystemPrompt`, `pendingImageDataUrl`, `pendingImageBase64`, `currentThinkingMode`, `currentTTSEngine`, `currentEditorMode`, `pendingDocumentText`, `pendingDocumentName`, `pendingDocumentTruncated`) |
| `utils.js` | `formatTimestamp()`, `escapeHtml()`, `showToast()`, `splitThinkingContent()`, `calcResizeDims()`, `detectVisionContext()`, `stripMarkdownForSpeech()`, `protectLatexDelimiters()` / `restoreLatexBackslashes()`, `truncateDocumentText()`, `buildDocumentMessageContent()` / `parseDocumentMessageContent()` (inverse pair — the latter recovers `{ documentName, question }` from a message's `content` for display), `readPersonaPref()` / `writePersonaPref()` (pure accessors over the `personaPrefs` JSON string — malformed-JSON-safe, value-validated; power per-persona settings memory), `migrateEditorModeValue()` (one-time `editorExplainChanges` boolean → `editorMode` string migration), `diffWords(original, revised)` (word-level tracked-changes diff — diff-match-patch word-mode recipe: whitespace-boundary tokens → unique-char mapping → `diff_main`/`diff_cleanupSemantic` → token-run expansion; returns `{op:-1|0|1, text}` segments) — pure helpers; Node.js compat export enables Jest unit tests |
| `speech.js` | **Voice input** — Web Speech API (`webkitSpeechRecognition`): continuous recognition with 3-second silence detection, mic button, "stop listening" phrase. Untouched by the Piper migration. **Voice output** — `speakText()` routes to `speakTextViaPiper()` (default) or `speakTextViaVoicebox()` based on `currentTTSEngine`; there is **no browser Web Speech *synthesis*** any more (`speakTextViaBrowser`, `SpeechSynthesisUtterance`, the "Microsoft Catherine" voice pick, `loadVoices` — all removed). `speakTextViaPiper()` POSTs to `PIPER_SPEAK_URL`, gets a WAV `Blob`, and plays it via the shared lazily-created `ttsAudio` `<audio>` element (`getTtsAudio()` / `onTtsAudioFinished()`), tracking the object URL in `_ttsObjectUrl` so `stopSpeaking()` and the `ended`/`error` handlers can `URL.revokeObjectURL` it. The pending fetch doubles as the "generating" spinner (speak button, or `#speakerBtn` for auto-TTS). Recognition is paused for the speaking duration via `_pauseRecognitionForSpeech()` / `_resumeRecognitionAfterSpeech()`. `speakTextViaVoicebox()` is unchanged: a **fresh** VoiceBox generation plays on the host speakers (no stop control); a **cached** repeat is replayed by this page via `playVoiceboxAudio()` through the same `ttsAudio` element, which *does* support `stopSpeaking()`. Node compat `module.exports` added (mirrors `utils.js`/`chat.js`/`api.js`) for the Jest suite |
| `chat.js` | Message rendering, chat save/load, system prompt state management; `updateSystemPrompt()` resolves the selected `<option>` to a prompt via `_resolveSystemPrompt()` — for `englishEditor` it returns the `englishEditorExplained` prompt iff `currentEditorMode === 'explain'` (else the silent one), and its revert-on-cancel branch maps either variant back to the single `englishEditor` option value; `renderEditorReply(container, originalText, revisedText, view)` + `_buildEditorViewSwitch()` render an English Editor reply in one of three views (`original` plain-text / `changes` word-level `<del>`/`<ins>` diff built purely via `createElement`/`textContent` / `clean` normal markdown) with a per-message `<select>` that flips the view in place with no re-send; `renderConversationHistory` uses this path for any assistant entry tagged `editorExchange === true`, diffing `entry.content` against the nearest preceding user turn (`_precedingUserText()`); `saveChat`/`handleOpenFile` carry `editorExchange`/`editorView` through the JSON round trip; `addUserMessage(text, imageDataUrl)` renders image thumbnails in user bubbles; `renderConversationHistory` handles both in-session images and SVG-icon `hasImage` placeholders from loaded files; `saveChat` strips `imageBase64`/`imageDataUrl` from the JSON export (preserves `hasImage` flag); `clearChat()` and `handleOpenFile()` both call `clearImagePreview()`/`clearDocumentPreview()` to prevent stale attachment state; `renderMarkdownToHtml(text)` — the one function every AI/user content → `innerHTML` boundary goes through — combines `marked.parse()`, `protectLatexDelimiters()`/`restoreLatexBackslashes()`, and `DOMPurify.sanitize()`; `renderMathIn(element)` wraps KaTeX's `renderMathInElement()`, called after content is in the DOM; `highlightCodeIn(element)` runs highlight.js over `pre code` blocks (skipping `language-mermaid`, re-sanitising hljs output through DOMPurify, idempotent via `data-hljs-done`) and `renderMermaidIn(element)` (async, fire-and-forget) replaces `pre code.language-mermaid` blocks with DOMPurify-sanitised Mermaid SVG; **`enrichRenderedContent(element)` = `renderMathIn` + `highlightCodeIn` + `renderMermaidIn` in one call — every terminal render site in `api.js`/`chat.js` calls this, not `renderMathIn` directly**; `hljs.configure()` / `mermaid.initialize({ securityLevel: 'strict' })` run once at file load; `_composeOutgoingMessage(rawMessage)` folds a pending document attachment (via `buildDocumentMessageContent()`) into the text actually sent to the model and stored in `conversationHistory`, while `addUserMessage`/`renderConversationHistory` separately call `parseDocumentMessageContent()` on that same stored content to display a compact filename chip (`_appendDocumentChip()`) + just the question — see [Document Text Extraction](#document-text-extraction-doc-extract); also defines `COPY_ICON`, `CHECK_ICON`, `SPEAK_ICON`, `STOP_ICON`, `SPINNER_ICON`, `DOCUMENT_ICON` as top-level SVG string constants |
| `api.js` | `streamOllamaResponse(userMessage, messageDiv, imageBase64, imageDataUrl)` — builds request via `_buildRequestBody(imageBase64, history, systemPrompt, modelName, visionModelName, thinkingMode, numCtx)` (pure, unit-tested; `numCtx` defaults to 16384 for tests that omit it, but the real call site always passes `OLLAMA_NUM_CTX` explicitly so config.js stays the single tunable source); streaming fetch with multimodal image support; dual-model routing (`gemma4:e4b` text/thinking, `gemma3:4b` vision); `think: false` sent explicitly when thinking is OFF; `options.num_ctx` sent on every text/thinking request and every multi-turn-vision follow-up (never on the initial vision turn, which sends no `options` at all — matches a known-working Ollama sample); dual-buffer thinking mode (`thinkingBuffer` + `fullResponse`); live collapsible `<details>` thinking block; `thinkingActive` flag guards all three `splitThinkingContent` call sites; every render site uses `renderMarkdownToHtml()` (`chat.js`); `enrichRenderedContent()` (KaTeX + highlight.js + Mermaid, `chat.js`) is called once per message at each *terminal* render point only (final answer, vision result, abort-with-partial-content) — not on every live-streamed token, to avoid re-typesetting/re-highlighting the whole message on each chunk; a completed (non-aborted, non-thinking) streaming reply on an `englishEditor` turn with `currentEditorMode` `clean`/`changes` and no attachment is tagged `editorExchange: true` + `editorView` on the pushed assistant entry and rendered via the `chat.js` editor path (`renderEditorReply` + `_buildEditorViewSwitch`, diffed against the `userMessage` argument) — the raw model output is still stored verbatim; the diff is always derived, never stored; copy/speak still read the clean revised text |
| `main.js` | `DOMContentLoaded` wiring — all event listeners via `addEventListener`; `_trapFocus(panel, e)` defined at top level for Tab/Shift-Tab focus trapping in persona panel, profile dropdown, and attach menu; thinking mode on/off + depth persisted to `localStorage` and restored on load (mirrors `autoTTS`); `_setThinkingUI(isOn, depth)` / `_setTTSUI(engine)` are the single source of truth for those controls' DOM+global state, shared by the toggle handlers, the global session restore, and the per-persona restore; **"Editor output" mode selector** (`#editorModeSelect` in `#editorModeRow`, shown only when `#systemPromptSelect` is `englishEditor` via `_updateEditorModeVisibility()`) — 3 modes `clean` / `changes` / `explain`, default `clean`; sets `currentEditorMode`, persists to `localStorage['editorMode']`, and re-resolves `currentSystemPrompt` via `_resolveSystemPrompt('englishEditor')` when that persona is active. On load, `migrateEditorModeValue()` folds the pre-1.18.0 `localStorage['editorExplainChanges']` boolean into `editorMode` once, then removes the legacy key; **per-persona settings memory** — `_activePersonaKey` tracks the persona being switched away from (the `change` event fires after `select.value` has changed); on `change`, `_persistPersonaPref(_snapshotPersonaSettings())` saves the old persona's thinking/TTS state to the `personaPrefs` store and `_applyPersonaSettings(readPersonaPref(...))` restores the new one's (no-op when absent); thinking/depth/TTS handlers write both the existing global keys AND `_persistPersonaPref(...)`; `clearImagePreview()`/`clearDocumentPreview()` defined at top level (called cross-module by `chat.js`), both delegating to `_updateAttachMenuActiveState()` to toggle `#attachMenuBtn`'s active indicator; a single ChatGPT-style "+" trigger (`#attachMenuBtn`/`#attachMenuDropdown`, opened upward via `openAttachMenu()`/`closeAttachMenu()` — mirrors `openProfileDropdown()`/`closeProfileDropdown()`) replaces the old separate image/document toolbar buttons, offering "Add photos" and "Add files" menu items that each trigger their respective hidden `<input type="file">` then close the menu; the `documentInput` change handler validates extension/size, extracts text (`.txt`/`.md`/`.markdown` via `file.text()`; `.pdf` via a `POST` to `DOC_EXTRACT_URL`), applies `truncateDocumentText()`, and populates the preview strip |

**Global state lives in `config.js`** (`conversationHistory`, `currentSystemPrompt`) and is shared across modules via the window scope — there is no module bundler.

## Security Invariants

- All AI response content — both the final answer and thinking block content — passes through `renderMarkdownToHtml()` (`marked.parse()` → `DOMPurify.sanitize()`) before being set as `innerHTML` — in `api.js` (streaming and final rebuild) and `chat.js` (`renderConversationHistory`).
- User-supplied message text is inserted via `.textContent` (`addUserMessage`, `renderConversationHistory`'s user branch) — never parsed as HTML or Markdown, so it needs no separate escaping. `escapeHtml()` is used elsewhere for values interpolated into an HTML *template string* before it becomes `innerHTML` — timestamps and the error-message path in `api.js`.
- KaTeX (`renderMathIn()` in `chat.js`) always runs *after* `renderMarkdownToHtml()`, on the already-sanitized DOM — it never receives a raw HTML string, only already-inserted text nodes. `trust` is left at KaTeX's default of `false`, which disables `\href`, `\url`, `\includegraphics`, and the `\html*` macros — the only way a LaTeX source string could otherwise make KaTeX emit attacker-chosen HTML. Do not pass `trust: true` without re-reviewing this.
- highlight.js (`highlightCodeIn()` in `chat.js`) runs *after* `renderMarkdownToHtml()`, on the already-sanitized DOM. It emits only class-annotated `<span>`s (no attributes, no URLs), but its output is fed straight back through `DOMPurify.sanitize()` anyway — so the "every AI content → `innerHTML` boundary is sanitised" invariant holds with no special-casing for hljs. A block that throws is left as its plain (already-sanitised) text.
- Mermaid (`renderMermaidIn()` in `chat.js`) runs *after* `renderMarkdownToHtml()`. It is initialised once at load with `securityLevel: 'strict'` (HTML labels off, no click handlers, no external resource fetches) and its generated SVG string is passed through `DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } })` before it reaches `innerHTML`. A diagram whose source fails to parse keeps its raw (already-sanitised) `<pre>` visible, marked `.mermaid-error` — it never blanks the message. Do not lower `securityLevel` without re-reviewing this.
- CSP: `script-src 'self'` has no `unsafe-inline`/`unsafe-eval` and is **unchanged** by the highlight.js / Mermaid / Piper work — none of them needs an inline or `eval`/`Function` execution path in the browser (Mermaid's bundled lodash contains `Function("return this")` only as a global-object fallback that short-circuits on `self` before it is ever evaluated). All event handlers are wired via `addEventListener` in `main.js`. `style-src 'self' 'unsafe-inline'` is the one deliberate exception — KaTeX positions glyphs via computed inline `style` attributes on the spans it generates (Mermaid also injects a `<style>` element, already covered by the same exception), with no CSS-class-only way to do that. `media-src 'self' blob:` is the other narrow allowance — `speakTextViaPiper()` fetches a WAV from `/piper/speak` and plays it via `URL.createObjectURL(blob)`; `blob:` in `media-src` only permits the page's own client-generated blobs (no external load, no exfil path), and without it `<audio src="blob:…">` falls through to `default-src 'self'`, which the browser rejects ("Media load rejected by URL safety check"). VoiceBox's cached-clip replay uses a same-origin `/voicebox/audio/{id}` URL, covered by the `'self'` part. The residual risk is bounded by the rest of the policy (`default-src 'self'`, `connect-src 'self'`, no external hosts in `img-src`), so an inline style still can't exfiltrate data or load an external resource. All other element visibility is controlled by CSS classes or `element.style.display` (unaffected either way — CSP only governs the `style` *attribute's contents*, not whether JS can set `element.style.display`).
- The streaming fetch in `api.js` is wired to a module-level `streamAbortController`; call `stopStreaming()` to cancel mid-stream. If tokens were received before abort, the partial response is saved to `conversationHistory`; the user message is only rolled back when nothing was generated.
- User input is capped at `MAX_INPUT_LENGTH` (4000) set programmatically on `#userInput` in `main.js`; Nginx enforces `client_max_body_size 1m` globally and `20m` on the `/ollama/api/chat` location to accommodate base64-encoded image payloads.
- `/voicebox/speak` is gated by the same `auth_request /auth/verify` session check as every other application route, and rate-limited (`voicebox_speak` zone, 10 req/min, burst 3) — Voicebox itself has no authentication of its own, so this endpoint is the only thing standing between an unauthenticated request and the host's speakers.
- `/piper/speak` is gated by the same `auth_request /auth/verify` session check and rate-limited (`piper_speak` zone, 10 req/min, burst 3). Piper is fully offline and self-contained — no host dependency, no `host.docker.internal` — so unlike VoiceBox it exposes nothing on the host; the input is validated server-side (non-empty, ≤ `PIPER_MAX_TEXT_CHARS`, ASCII control chars stripped) and the response is inert `audio/wav` bytes.
- A document attachment's extracted text is folded into the same `content` string as the user's typed question (`buildDocumentMessageContent()`) and flows through the exact same `.textContent`-insertion path as any other user message — there is no separate code path, and therefore no separate injection surface, for document-derived text vs. typed text. `/doc-extract/extract` is gated the same way as every other route (`auth_request`) and rate-limited (`doc_extract` zone, 10 req/min, burst 3).
- The English Editor "changes" diff view (`renderEditorReply()` in `chat.js`) is assembled entirely with `document.createElement` / `document.createTextNode` / `.textContent` — never `innerHTML` or string concatenation — so it adds no new sanitisation-boundary surface (`<ins>` / `<del>` are in DOMPurify's default allowlist regardless). The "clean" view reuses `renderMarkdownToHtml()`, the same sanitised boundary every other reply goes through. The diff is always derived client-side from the verbatim stored model output — nothing diff-related is ever sent to or stored from the model.

## Key Configuration

All runtime configuration is in [src/aia/scripts/config.js](src/aia/scripts/config.js):

- `MODEL_NAME` — text + thinking model (default: `gemma4:e4b`)
- `VISION_MODEL_NAME` — vision-capable model for image requests (default: `gemma3:4b`); `gemma4:e4b` has no vision encoder in its GGUF so a separate model is required
- `OLLAMA_API_URL` — proxied endpoint (default: `https://localhost/ollama/api/chat`)
- `OLLAMA_NUM_CTX` — must match the Ollama server's actual configured context length (default: `16384`; set via `OLLAMA_CONTEXT_LENGTH` env var or `PARAMETER num_ctx` in the model's Modelfile). Passed as `_buildRequestBody`'s `numCtx` parameter (`api.js`) and sent as `options.num_ctx` on every text/thinking request and every multi-turn-vision follow-up — never omitted, so behavior doesn't silently depend on Ollama's own default. `MAX_DOCUMENT_TEXT_CHARS` (below) is sized against this value; raise them together, never one without the other.
- `PIPER_SPEAK_URL` — proxied endpoint for the (default) Piper TTS engine (default: `https://localhost/piper/speak`)
- `VOICEBOX_SPEAK_URL` — proxied endpoint for the optional VoiceBox TTS engine (default: `https://localhost/voicebox/speak`)
- `MAX_HISTORY_MESSAGES` — maximum entries in `conversationHistory` before oldest pairs are trimmed (default: `40`, i.e. 20 exchanges). Tune this when switching to a model with a smaller or larger context window.
- `SPEECH_RECOGNITION_LANG` — BCP 47 language tag for the Web Speech API (default: `'en-US'`). Change to `'en-AU'`, `'fr-FR'`, etc. to match your locale.
- `currentThinkingMode` — runtime global (`'off' | 'low' | 'medium' | 'high'`); set by the lightbulb toolbar button in `main.js`; persisted to `localStorage` as `thinkingOn` + `thinkingDepth` and restored on page load
- `currentTTSEngine` — runtime global (`'piper' | 'voicebox'`, default `'piper'`); set by the `#ttsEngineSelect` dropdown in `main.js`; persisted to `localStorage` as `ttsEngine` and restored on page load; applies to both auto-TTS and the per-message speak button. `normalizeTtsEngine()` (`utils.js`) maps a stale stored value — notably the removed `'browser'` engine — back to `'piper'` on load, and `main.js` writes the migrated value back to `localStorage`
- `PERSONA_PREFS_KEY` — `localStorage` key (`'personaPrefs'`) for per-persona settings memory: a JSON map of `{ personaKey: { thinkingOn, thinkingDepth, ttsEngine } }`. Switching persona (only possible from an empty conversation) snapshots the outgoing persona's thinking/TTS control state into this store and restores the incoming persona's. `readPersonaPref()` / `writePersonaPref()` (`utils.js`) are the pure accessors. The global `thinkingOn` / `thinkingDepth` / `ttsEngine` keys are still written too and act as the fallback when a persona has no stored entry.
- `currentEditorMode` / `EDITOR_MODE_KEY` — runtime global (`'clean' | 'changes' | 'explain'`, default `'clean'`) and its `localStorage` key (`'editorMode'`), backing the persona panel's "Editor output" selector (`#editorModeSelect`), which only applies to the `englishEditor` persona. `explain` selects `systemPrompts.englishEditorExplained` (prose + revision); `clean` and `changes` both use the silent `systemPrompts.englishEditor` and differ only in how the reply is *displayed* — `clean` as normal markdown, `changes` as a word-level `<del>`/`<ins>` tracked-changes diff against the submitted text (computed client-side by `diffWords()`, never round-tripped through the model). Every `clean`/`changes` editor reply also carries a per-message Original/Changes/Clean view switch. Migrated once from the pre-1.18.0 `editorExplainChanges` boolean key via `migrateEditorModeValue()`.
- System prompts object — keys map to `<option value>` in the persona selector dropdown

To add a new persona: add a key to the system prompts object in `config.js` and a matching `<option>` in the `#systemPromptSelect` dropdown in `index.html` (keep the `<option>` list alphabetical by label). The default selected persona is controlled by the `selected` attribute in `index.html` — `main.js` reads it on load and sets `currentSystemPrompt` accordingly (currently `englishEditor`). The 11 dropdown personas are `assistant`, `casual`, `claudePromptCompressor`, `creative`, `englishEditor`, `legal`, `medical`, `teacher`, `professional`, `technical`, `transcriptai`; `englishEditorExplained` is a 12th key with no `<option>` — reached only via the "Explain" option of the `#editorModeSelect` selector while `englishEditor` is active. A persona with two prompt variants selected by a control (like `englishEditor`) needs `updateSystemPrompt()` in `chat.js` (`_resolveSystemPrompt()` + the revert-branch mapping) taught about it.

## Auth Service

The FastAPI authentication service lives in `auth/`. Key files:

| File | Purpose |
|---|---|
| `auth/main.py` | All route handlers, TOTP logic, session/CSRF helpers |
| `auth/Dockerfile` | Multi-stage Chainguard build (digest-pinned) |
| `auth/requirements.txt` | Production dependencies |
| `auth/requirements-test.txt` | Test dependencies (`pytest`, `httpx2`, `flake8`, `black`) |
| `auth/tests/test_main.py` | 65 pytest tests covering all routes, security logic, cookie lifecycle, and `/auth/me` |
| `auth/static/login.css` | Login page stylesheet |

**Updating Chainguard base image digests** — the `FROM` lines in `auth/Dockerfile`, `voicebox-proxy/Dockerfile`, and `doc-extract/Dockerfile` are pinned to SHA256 digests (all currently pinned to the same Chainguard Python image). To update them after Chainguard releases a new image:

```powershell
docker pull cgr.dev/chainguard/python:latest-dev
docker pull cgr.dev/chainguard/python:latest
# Copy the "Digest: sha256:..." lines from the output and update the FROM lines in
# auth/Dockerfile, voicebox-proxy/Dockerfile, and doc-extract/Dockerfile.
# Then rebuild: docker-compose build auth voicebox-proxy doc-extract
```

**`piper-tts/Dockerfile` is the exception** — it is pinned to `python:3.12-slim` by digest, *not* the Chainguard image. `onnxruntime` (pulled in by `piper-tts`) segfaults on `import` under the Chainguard distroless runtime, which ships no `libstdc++`/`libgomp` and has no package manager to add them (the `-dev` image imports it fine, confirming the missing libs). Update it with `docker pull python:3.12-slim` and copy the new `Digest: sha256:...` into both `FROM` lines. See the **Piper TTS** section for the full rationale.

## VoiceBox Proxy

The FastAPI VoiceBox proxy lives in `voicebox-proxy/`. It bridges the browser to a local Voicebox desktop app's plain REST API (typically at `127.0.0.1:17493` on the Windows host — Voicebox also exposes an MCP server, but the REST surface is simpler and is what exposes generation status and past-audio retrieval, which MCP alone doesn't) so AI responses can optionally be spoken through VoiceBox instead of the default Piper engine.

| File | Purpose |
|---|---|
| `voicebox-proxy/main.py` | FastAPI app. `_speak()`: on a cache hit, returns the cached generation id immediately; on a miss, `_start_generation()` (`POST /speak`) then `_await_completion()` (streams `GET /generate/{id}/status` until a terminal status) — Voicebox auto-plays the finished clip through the host's speakers as a side effect of this flow, with no way to opt out. `GET /voicebox/audio/{id}` proxies Voicebox's `GET /audio/{id}` so the browser can replay a cache hit itself (Voicebox does *not* auto-play for a lookup of a past generation) |
| `voicebox-proxy/Dockerfile` | Multi-stage Chainguard build (digest-pinned), mirrors `auth/Dockerfile` |
| `voicebox-proxy/requirements.txt` | Production dependencies (`fastapi`, `uvicorn`, `httpx`) |
| `voicebox-proxy/requirements-test.txt` | Test dependencies (`pytest`, `httpx`, `flake8`, `black`) |
| `voicebox-proxy/tests/test_main.py` | 31 pytest tests covering the generation cache, status-stream parsing, and route-level success/validation/failure cases |

**Generation cache** — `_generation_cache` is an in-memory `{sha256(profile + text) -> generation_id}` map, capped at 200 entries (oldest evicted first) and cleared on restart; same trade-off as the auth service's in-memory brute-force state, acceptable for a local single-user tool. A cache hit means *identical* text (and profile) only — no fuzzy matching.

Voicebox itself has no authentication of its own (any `X-Voicebox-Client-Id` header is accepted), so `VOICEBOX_CLIENT_ID` (default: `vpal`) is just an identifier, not a secret — the real access control is the Nginx `auth_request` gate in front of both `/voicebox/speak` and `/voicebox/audio/`.

Configurable via env vars (all optional, sensible defaults baked in): `VOICEBOX_URL` (base URL, no path suffix), `VOICEBOX_CLIENT_ID`, `VOICEBOX_TIMEOUT_SECONDS` (default `60` — must cover the slowest expected synthesis) — see `.env.example`.

## Math Rendering (KaTeX)

Purely client-side — no backend or Nginx routing involved beyond the existing static-file serving. `katex.min.js` + `katex-auto-render.min.js` are vendored (see [Updating Vendored Libraries](#updating-vendored-libraries)); `renderMathIn(element)` in `chat.js` wraps `renderMathInElement()` with the app's delimiter set and is called once per message at each terminal render point in `api.js`/`chat.js` (never on every live-streamed token — see the `api.js` row in [JavaScript Module Architecture](#javascript-module-architecture)).

**Delimiters supported:** `$$...$$` and `\[...\]` (display), `$...$` and `\(...\)` (inline), plus the AMS environments (`\begin{equation}`, `\begin{align}`, etc.). `$...$` is *not* one of `renderMathInElement`'s own defaults (it can clash with literal currency amounts) but is added explicitly since it's the form models emit most often — it's listed last in the delimiters array, which matters: `$` must come after `$$` or it would match `$$`'s first `$` instead.

**The markdown-mangling bug (and why `protectLatexDelimiters` exists):** `marked.parse()` always runs before KaTeX ever sees the text, and CommonMark's backslash-escape rule strips a backslash immediately before ASCII punctuation — silently turning `\(` into `(`, `\[` into `[`, `\{` into `{`, and `\\` into `\`. That destroys the `\(...\)`/`\[...\]` delimiters and matrix row separators before KaTeX gets a chance to match them (`\frac`, `\sqrt`, `\alpha` etc. are unaffected — backslash followed by a *letter* isn't in CommonMark's escape set). `protectLatexDelimiters()`/`restoreLatexBackslashes()` in `utils.js` swap the backslash for a `U+E000` placeholder before `marked.parse()` and swap it back afterward; `renderMarkdownToHtml()` in `chat.js` is the one function that does this consistently — **always route new AI/user content → `innerHTML` sites through it, never call `marked.parse()`/`DOMPurify.sanitize()` directly.** Regression tests: `tests/js/latex-protect.test.js`.

**Error handling:** a malformed expression (e.g. an unclosed brace) doesn't throw or blank out the message — `katex-auto-render.min.js` catches `ParseError` per-expression internally and falls back to rendering that one expression's raw source as plain text, leaving the rest of the message (and any other math in it) untouched.

**CSS:** `.message-content .katex-display` gets `overflow-x: auto` in `style.css` — KaTeX's own CSS sets `white-space: nowrap` on display-mode blocks, so a wide equation (long matrix, long sum) needs its own horizontal scrollbar rather than overflowing the chat bubble, mirroring how `.message-content pre` already handles wide code blocks.

## Code Highlighting (highlight.js)

Purely client-side, modelled on the KaTeX integration. `highlight.min.js` is vendored (highlight.js v11.11.1, the "common" ~40-language build; see [Updating Vendored Libraries](#updating-vendored-libraries)) and provides the `hljs` global. `highlightCodeIn(element)` in `chat.js` is folded into `enrichRenderedContent()` alongside `renderMathIn` and called once per message at each terminal render point in `api.js`/`chat.js` (never per live-streamed token).

**How it runs:** `marked.parse()` turns a ` ```js … ``` ` fence into `<pre><code class="language-js">…</code></pre>`. After that HTML is sanitised and inserted into the DOM, `highlightCodeIn()` walks each `pre code`, skips any `language-mermaid` block (Mermaid owns those) and any block already carrying `data-hljs-done`, then calls `hljs.highlightElement(block)`. `hljs.configure({ ignoreUnescapedHTML: true })` runs once at load to silence a benign console warning (we only ever feed it already-sanitised DOM).

**Security:** highlight.js emits only class-annotated `<span>`s, but its output is re-run through `DOMPurify.sanitize()` immediately (`block.innerHTML = DOMPurify.sanitize(block.innerHTML)`) so the "every `innerHTML` boundary goes through DOMPurify" invariant holds with no hljs carve-out. A block that throws is left as its plain (already-sanitised) text — `try { … } catch { /* leave as plain text */ }`.

**CSS:** `.message-content .hljs` overrides the vendored atom-one-dark theme's `#282c34` background to the app's existing `#1e293b` slate `<pre>` ground; token colours are left as the theme ships them.

## Diagrams (Mermaid)

Purely client-side, modelled on the KaTeX integration. `mermaid.min.js` is vendored (Mermaid **v10.9.3** UMD single-file bundle — ~2.8 MB, an accepted tradeoff for a local app; v11 restructured away from a clean UMD; see [Updating Vendored Libraries](#updating-vendored-libraries)) and provides the `mermaid` global, loaded last of the vendored scripts. `mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'dark' })` runs once at load. `renderMermaidIn(element)` in `chat.js` is folded into `enrichRenderedContent()`.

**How it runs:** a ` ```mermaid … ``` ` fence survives `renderMarkdownToHtml()` as `<pre><code class="language-mermaid">…</code></pre>` (highlight.js skips it). `renderMermaidIn()` is `async` (Mermaid v10's `mermaid.render()` returns a Promise) and is called **fire-and-forget** — not awaited — at the render sites, so the diagram pops in a moment after the text, the same way KaTeX/highlight are non-blocking. For each `pre code.language-mermaid` it reads `code.textContent`, renders to an SVG string with a random id, wraps it in `<div class="mermaid-diagram">`, and `replaceWith()`s the `<pre>`. A `data-mermaid-done` flag on the `<pre>` guards against a double render during the async gap.

**Security:** `securityLevel: 'strict'` disables HTML labels, click handlers, and external resource fetches. The generated SVG is still passed through `DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true } })` before it reaches `innerHTML`. A diagram whose source fails to parse keeps its raw `<pre>` visible with a `.mermaid-error` class rather than blanking the message.

**CSP:** unchanged. `script-src 'self'` (no `unsafe-inline`/`unsafe-eval`) still holds — Mermaid v10.9 needs no inline/`eval`/`Function` execution path in the browser (the `Function("return this")` in its bundled lodash is a global-object fallback that short-circuits on `self` before evaluation). Mermaid's injected `<style>` element is covered by the `style-src 'unsafe-inline'` exception KaTeX already required. **If a future Mermaid bump reintroduces a `script-src`/`unsafe-eval` violation under this CSP, do not weaken the CSP** — pin back, or move to an SVG-only server-side render.

**CSS:** `.mermaid-diagram` gets `overflow-x: auto` (wide diagrams scroll in their own container, mirroring `.katex-display` / `.message-content pre`); `.mermaid-diagram svg` is `max-width: 100%`.

## Document Text Extraction (doc-extract)

Lets a user attach a `.txt`, `.md`, or `.pdf` file and ask questions about it. `.txt`/`.md`/`.markdown` are read entirely client-side (`file.text()`) and never reach a backend — only `.pdf` needs a real parser, handled by a new `doc-extract/` FastAPI service (`pypdf`).

| File | Purpose |
|---|---|
| `doc-extract/main.py` | FastAPI app. `_extract_text()` reads every page via `pypdf.PdfReader`, joins non-blank pages with a blank line, and raises `ExtractionError` for encrypted or unparseable PDFs; the route layer additionally validates content-type/extension, upload size, and applies a generous server-side sanity cap on returned text length |
| `doc-extract/Dockerfile` | Multi-stage Chainguard build (digest-pinned), mirrors `auth/Dockerfile` |
| `doc-extract/requirements.txt` | Production dependencies (`fastapi`, `uvicorn`, `python-multipart`, `pypdf`) |
| `doc-extract/requirements-test.txt` | Test dependencies (`pytest`, `httpx`, `flake8`, `black`) |
| `doc-extract/tests/test_main.py` | 16 pytest tests covering text-joining/blank-page/encrypted/malformed-PDF cases (mostly `pypdf.PdfReader` mocked) plus two full end-to-end tests against the real `pypdf` with genuinely invalid bytes |

Unlike `auth`/`voicebox-proxy`, `doc-extract` needs no `extra_hosts`/`host.docker.internal` — it's entirely self-contained, with no external app or host service to reach.

**Why there's no separate "documents" field:** Ollama's chat API has a first-class `images` array for vision, but nothing equivalent for arbitrary text attachments. The extracted text has to be folded directly into the message's own `content` string. `buildDocumentMessageContent(name, text, truncated, question)` (`utils.js`) wraps it in a delimited block followed by the question (or a default prompt if none was typed):

```
--- Attached file: notes.pdf ---
<extracted text>
--- End of notes.pdf ---

<question>
```

This is what's actually sent to Ollama *and* what's stored in `conversationHistory` — meaning it's automatically resent on every subsequent turn along with the rest of the history, which is what makes follow-up questions about an already-attached document work with no special-casing.

**Display vs. storage — `parseDocumentMessageContent()`:** showing that full block in the chat bubble would be a poor experience for a 28,000-character document, so `addUserMessage()`/`renderConversationHistory()` call `parseDocumentMessageContent()` (the inverse of `buildDocumentMessageContent()`, matched via a regex with a backreference so the header/footer filename must agree) on the *same* stored `content` to recover `{ documentName, question }` for display — a filename chip (`_appendDocumentChip()`) plus just the question. Nothing is duplicated or stored differently; the split is purely a display-time parse of the one canonical string.

**Truncation:** extracted text is capped at `MAX_DOCUMENT_TEXT_CHARS` (28,000 — `truncateDocumentText()` in `utils.js`, applied uniformly to all three file types in `main.js`) before being folded into the message, independent of doc-extract's own much larger 200,000-char server-side sanity cap (`_MAX_TEXT_CHARS` in `doc-extract/main.py`) — the frontend constant is the one that actually governs context-budget behavior; the backend one just bounds worst-case response size for a pathological PDF. The whole conversation history (including this text) is resent to Ollama on every turn, so an unbounded document would make every subsequent message more expensive, not just this one. 28,000 chars is ≈7K tokens at ~4 chars/token, sized against `OLLAMA_NUM_CTX` (16384 — see [Key Configuration](#key-configuration) and [Nginx Proxy](#nginx-proxy)) to leave roughly half the context free for the system prompt, conversation history, thinking budget, and the response itself; raising it without also raising `OLLAMA_NUM_CTX` risks Ollama silently truncating context (dropping the oldest tokens, which can be the system prompt or the start of the document itself) rather than erroring.

**Validation:** extension-based on the frontend (`.txt`/`.md`/`.markdown`/`.pdf`) and both content-type *and* filename-extension based on `doc-extract` (some browsers send `application/octet-stream` for a `.pdf`). Encrypted and scanned/image-only PDFs are rejected — pypdf can open the former but VPAL treats it as a hard error rather than prompting for a password; the latter parses successfully but yields no extractable text, which `main.js` detects and reports as an error rather than silently attaching an empty document.

## Piper TTS

The FastAPI Piper TTS service lives in `piper-tts/`. It synthesises speech from text entirely offline with a local [Piper](https://github.com/OHF-Voice/piper1-gpl) neural voice (ONNX model + bundled espeak-ng phonemisation) and is the **default** speech-synthesis engine — VoiceBox is the optional alternative. Modelled on `doc-extract/` (self-contained, non-root uid 65532, `/health` endpoint) but see the base-image divergence below.

| File | Purpose |
|---|---|
| `piper-tts/main.py` | FastAPI app. `POST /piper/speak` — JSON `{"text": "..."}` → raw `audio/wav` (`Response(media_type="audio/wav")`). `_sanitize()` strips ASCII control chars (keeps `\t`/`\n`/`\r`); the route rejects empty/whitespace text (400) and text over `PIPER_MAX_TEXT_CHARS` (413). `_get_voice()` loads and caches the `PiperVoice` (kept out of import time so tests never need the model; wrapped in `_capped_session_options()` — see concurrency notes below); `_synthesize()` writes a WAV into an in-memory buffer via `wave` + `PiperVoice.synthesize_wav(...)`, wrapping any failure as `SynthesisError` → 500. `_lifespan` warms the model at startup when `PIPER_EAGER_LOAD` != `0`. No storage, no cache, no second endpoint — v1 is deliberately minimal |
| `piper-tts/Dockerfile` | Multi-stage **`python:3.12-slim`** build (digest-pinned), non-root uid 65532. Builder stage `ADD --checksum=sha256:…`s the voice model + config from `huggingface.co/rhasspy/piper-voices` @ `v1.0.0` (the checksum flag fails the build on any mismatch — the supply-chain equivalent of the Chainguard digest pins) then `chmod`s them world-readable; runtime stage copies packages + `voices/` + `main.py` |
| `piper-tts/requirements.txt` | Production dependencies (`fastapi`, `uvicorn`, `piper-tts`) |
| `piper-tts/requirements-test.txt` | Test dependencies (`pytest`, `httpx`, `flake8`, `black`) |
| `piper-tts/tests/test_main.py` | 17 pytest tests — `_sanitize`, `/health`, every `/piper/speak` branch (valid → 200 + `audio/wav`, empty/whitespace → 400, over-length → 413, missing field → 422, synthesis failure → 500), the route being a non-coroutine, `/health` staying responsive during a slow synth, and `_capped_session_options()` capping + restoring. **Synthesis is always mocked** (`_get_voice` / `_synthesize` via `monkeypatch`) and `conftest.py` sets `PIPER_EAGER_LOAD=0`, so CI never downloads the ~60 MB model |

**Base-image divergence (why not Chainguard):** `piper-tts` pulls in `onnxruntime`, whose manylinux wheel **segfaults (SIGSEGV) on `import onnxruntime`** under the `cgr.dev/chainguard/python:latest` distroless runtime — it links against `libstdc++`/`libgomp` that the distroless image does not ship, and there is no shell or package manager there to add them. The Chainguard `-dev` image imports it fine (confirming the missing runtime libs), and a full synth pipeline runs cleanly on `python:3.12-slim`. Per the global engineering standards' explicit allowance for `python:slim` + non-root, this one service uses `python:3.12-slim` — still multi-stage, digest-pinned, non-root uid 65532, read-only root FS. Every other service stays on Chainguard distroless.

**Voice model:** `en_US-lessac-medium` (`.onnx` ≈60 MB + `.onnx.json`). **Not committed to git** — fetched and SHA256-verified at image build time. Expected hashes are hard-coded in `piper-tts/Dockerfile`:
- `en_US-lessac-medium.onnx` → `sha256:5efe09e69902187827af646e1a6e9d269dee769f9877d17b16b1b46eeaaf019f`
- `en_US-lessac-medium.onnx.json` → `sha256:efe19c417bed055f2d69908248c6ba650fa135bc868b0e6abb3da181dab690a0`

To switch voices: change the `ADD` URLs + `--checksum` values in the Dockerfile and set `PIPER_VOICE` to the new basename (`docker-compose build piper-tts`).

**Config** (env vars, all optional — defaults baked in; documented in `.env.example`): `PIPER_VOICE` (default `en_US-lessac-medium`), `PIPER_LENGTH_SCALE` (speed, lower = faster, default `1.0`), `PIPER_MAX_TEXT_CHARS` (default `6000`), `PIPER_MODEL_DIR` (default `/app/voices`). Operational knobs, set in `piper-tts/Dockerfile` + `docker-compose.yml`, not usually touched: `PIPER_ORT_THREADS` / `OMP_NUM_THREADS` / `ORT_NUM_THREADS` etc. (all `1`), `PIPER_EAGER_LOAD` (`1`; `conftest.py` sets `0`).

**Concurrency / resource notes (PR #30 — a hang found in live compose verification):** the service works standalone but *wedged* under the compose CPU/PID limits until three things were fixed. (1) `POST /piper/speak` is a **sync `def`** route — ONNX inference is blocking CPU work, and in an `async` route it stalls the entire single-threaded event loop (so one slow synth kills `/health` and every other request); FastAPI runs sync routes in a worker threadpool. (2) onnxruntime is pinned to a **1-thread pool** via `_capped_session_options()` (a scoped monkeypatch of `onnxruntime.SessionOptions` around `PiperVoice.load()`, since piper exposes no thread config) *plus* `OMP_NUM_THREADS=1` & friends in the Dockerfile/compose — left unbounded it sizes the intra-op pool to the *host* core count, which under `cpus`/`pids` limits deadlocks during pool creation (the request never even reaches a log line). (3) `pids` was raised `30 → 128` and `memory` `512M → 768M` (measured peak RSS ≈ 220 MB). The model is loaded eagerly at startup so a broken model fails the healthcheck at boot, not mid-request. Live-verified in the running stack: `/piper/speak` returns a valid WAV in ~0.5 s, `/health` answers in 3 ms *during* a synth, concurrent requests don't wedge.

**Frontend:** `speakTextViaPiper(text, sourceBtn)` in `speech.js` `POST`s to `PIPER_SPEAK_URL` (`config.js`, default `https://localhost/piper/speak`), gets a `Blob`, plays it via the shared `ttsAudio` `<audio>` element through `_playTtsBlob()` — so Piper has a real stop control (`stopSpeaking()` pauses playback and `URL.revokeObjectURL`s the tracked blob URL). Recognition is paused for the duration (`_pauseRecognitionForSpeech()` / `_resumeRecognitionAfterSpeech()`) so the mic doesn't capture the audio. The pending fetch doubles as the "generating" spinner, exactly like the VoiceBox path.

## Nginx Proxy

The proxy in [deploy/nginx/nginx.conf](deploy/nginx/nginx.conf) uses **exact-match** or narrow prefix locations (`location = /ollama/api/chat`, `location = /piper/speak`, `location = /voicebox/speak`, `location ^~ /voicebox/audio/`, `location = /doc-extract/extract`) that accept only the HTTP methods each route needs — all other methods and all other Ollama paths (e.g. `/api/tags`, `/api/delete`) are denied at the nginx layer. The `ollama_chat` rate limit zone allows 5 requests/min with a burst of 5; `piper_speak` allows 10 requests/min with a burst of 3; `voicebox_speak` (shared by both VoiceBox locations) allows 10 requests/min with a burst of 3; `doc_extract` allows 10 requests/min with a burst of 3 (`limit_req_zone`). `proxy_buffering off` and `proxy_read_timeout 300s` on the Ollama location support streaming responses; `/piper/speak` sets `proxy_read_timeout 60s` (CPU synthesis of a few sentences takes at most a few seconds; the small buffered WAV response needs no `proxy_buffering off` and the tiny JSON request body needs no `client_max_body_size` bump); `/voicebox/speak` sets `proxy_read_timeout 90s` since it blocks on voicebox-proxy for the full synthesis duration (whose own httpx timeout is 60s); `/doc-extract/extract` raises `client_max_body_size` to `15m` to match doc-extract's own upload limit.

Security headers set on every response: `Strict-Transport-Security`, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Content-Security-Policy`, `Referrer-Policy: no-referrer`, `Permissions-Policy`. The CSP is `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; form-action 'self'` — `script-src` has no inline/eval; `style-src 'unsafe-inline'` is for KaTeX only; `media-src … blob:` lets the page play the Piper TTS WAV it fetches from `/piper/speak` (see Security Invariants).

### `nginx.conf` is generated from a template

`deploy/nginx/nginx.conf` is **not hand-edited** — it is generated from `deploy/nginx/nginx.conf.template` by `deploy/nginx/render-nginx-conf.sh` (POSIX `sh` + `envsubst` with an explicit variable allowlist, so nginx's own `$host` / `$binary_remote_addr` / etc. are left untouched). The committed `nginx.conf` is the local-default render; the 8 deployment values below become `${...}` placeholders in the template:

| Env var | Default (reproduces the committed file) | Replaces |
|---|---|---|
| `AUTH_UPSTREAM` | `auth:9000` | `upstream auth_service` server |
| `VOICEBOX_PROXY_UPSTREAM` | `voicebox-proxy:8002` | `upstream voicebox_service` server |
| `DOC_EXTRACT_UPSTREAM` | `doc-extract:8003` | `upstream doc_extract_service` server |
| `PIPER_UPSTREAM` | `piper-tts:8004` | `upstream piper_service` server |
| `OLLAMA_UPSTREAM` | `host.docker.internal:11434` | `proxy_pass` host:port in `location = /ollama/api/chat` |
| `SERVER_NAME` | `localhost` | `server_name` in both `server {}` blocks |
| `SSL_CERT_PATH` | `/etc/nginx/ssl/localhost.pem` | `ssl_certificate` |
| `SSL_KEY_PATH` | `/etc/nginx/ssl/localhost-key.pem` | `ssl_certificate_key` |

**To change any of these, edit `nginx.conf.template`, then regenerate and commit both files:**

```bash
sh deploy/nginx/render-nginx-conf.sh > deploy/nginx/nginx.conf   # envsubst via `gettext`; or run it inside nginx:1.27-alpine
```

CI's `nginx-config-check` job enforces that the committed `nginx.conf` is exactly the default render (drift guard) and that a cloud-value render leaves no `${...}` placeholder unsubstituted, in addition to the existing `nginx -t`. `docker-compose` still mounts the committed `nginx.conf` (the local-default render) directly; full runtime/init-container templating for a non-local deployment is a deferred follow-up (see `docs/cloud-hardening-plan.md` Finding E).

If Ollama or Voicebox changes port, or the model changes, update `deploy/nginx/nginx.conf.template` (then regenerate) and/or `config.js` respectively, then restart the container.

Changes to `nginx.conf` are syntax-validated in CI via the `nginx-config-check` job (`nginx -t` inside `nginx:1.27-alpine`). To validate locally without Docker, reload the running container: `docker exec vpal-nginx /usr/sbin/nginx -s reload`.

## SSL Certificates

Self-signed certs are in `deploy/certs/` (generated via mkcert). Nginx is configured for TLS 1.2+. Regenerate with mkcert targeting `localhost` if they expire.

## Updating Vendored Libraries

`marked.min.js`, `dompurify.min.js`, `katex.min.js`, `katex-auto-render.min.js`, `diff-match-patch.js`, and `css/katex.min.css` are all pinned with SHA-256 SRI hashes in `index.html`.

The docker-compose bind mount serves the working-copy bytes straight to the browser, so the served file must hash to exactly the `integrity=` value — a line-ending conversion between commit and checkout would be enough to break it. **All six assets are marked `binary` in `.gitattributes`**, so git applies no clean/smudge filter: the working copy, the committed blob, and every fresh checkout are byte-identical on any platform and under any `core.autocrlf` setting. Recompute the hash straight from the file and update the corresponding `integrity=` attribute:

```powershell
$bytes = [IO.File]::ReadAllBytes('src\aia\scripts\<filename>.js')   # or src\aia\css\<filename>.css
"sha256-" + [Convert]::ToBase64String([Security.Cryptography.SHA256]::Create().ComputeHash($bytes))
```

`npm run check:sri` (`scripts/check-sri.mjs`) re-hashes every `integrity=`-pinned file referenced from `index.html` and fails on any mismatch; CI runs it in the `frontend-lint` job on the clean Linux checkout, so a stale hash — or a re-vendored file whose `integrity=` wasn't updated — is caught before it can reach a browser. Run it locally after changing any vendored asset.

If you see a browser SRI error, run `npm run check:sri`; for each mismatch it prints the `integrity=` value from `index.html` alongside the freshly computed hash (and flags any CR bytes in the file) so you can see what disagrees.

KaTeX's font files (`src/aia/css/fonts/`) are referenced by `katex.min.css` via relative `url(fonts/...)` and are **not** individually SRI-pinned — SRI only covers the top-level `<script>`/`<link>` tag it's attached to, not resources that tag's content goes on to fetch. To re-vendor KaTeX from scratch (e.g. to bump its version): `npm pack katex@<version>` in a scratch directory, then copy `dist/katex.min.js` → `scripts/katex.min.js`, `dist/contrib/auto-render.min.js` → `scripts/katex-auto-render.min.js`, `dist/katex.min.css` → `css/katex.min.css`, and the entire `dist/fonts/` directory → `css/fonts/`.

**diff-match-patch** — source: <https://github.com/google/diff-match-patch>, file `javascript/diff_match_patch_uncompressed.js` (the official *uncompressed* build). Vendored **verbatim** as `src/aia/scripts/diff-match-patch.js` (do not edit it — it is ESLint-ignored via `eslint.config.js`, not renamed to `*.min.js`). It ships no `module.exports` block, but its trailing `this['diff_match_patch'] = …` / `this['DIFF_*'] = …` lines resolve to `window` in a classic browser script *and* to `module.exports` under Node/Jest (`this === module.exports` in a CommonJS module), so it serves as both the browser global and the Jest import with no modification. To re-vendor: `curl -sSL -o src/aia/scripts/diff-match-patch.js https://raw.githubusercontent.com/google/diff-match-patch/master/javascript/diff_match_patch_uncompressed.js`, recompute the SRI hash with the snippet above, update `index.html`.

**highlight.js** — currently **v11.11.1**, "common" languages build (~40 languages). Script source: <https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/highlight.min.js> (identical to `@highlightjs/cdn-assets`'s `highlight.min.js`). Dark theme: <https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.11.1/styles/atom-one-dark.min.css> → `src/aia/css/highlight.min.css` (vendored verbatim; the `#282c34` → `#1e293b` background match is done in `style.css`, not by editing this file). Both are `binary` in `.gitattributes` and SRI-pinned. To bump: download both files at the new version, recompute both SRI hashes with the snippet above, update `index.html`.

**Mermaid** — currently **v10.9.3**. Source: the `mermaid` npm package's `dist/mermaid.min.js` (UMD single-file bundle) — `npm pack mermaid@10.9.3` in a scratch dir, then `tar -xzf mermaid-10.9.3.tgz package/dist/mermaid.min.js` and copy to `src/aia/scripts/mermaid.min.js`. **Stay on the 10.9.x line** — Mermaid v11 restructured away from a clean UMD build. `binary` in `.gitattributes`, SRI-pinned. To bump within 10.9.x: re-pack, recompute the SRI hash, update `index.html`; then re-run the CSP gate (see [Diagrams (Mermaid)](#diagrams-mermaid)) — a browser check for `script-src`/`unsafe-eval` violations, not just `nginx -t`.

Paste the output into the matching `integrity="..."` attribute in `index.html`. The browser will refuse to load the script if the hash does not match.
