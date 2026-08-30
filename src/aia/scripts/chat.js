// chat.js - Chat message handling functions

// SVG icons for action buttons — defined here so speech.js can reference them
// when toggling the speak button between idle and active states.
const COPY_ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const CHECK_ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
const SPEAK_ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>';
const STOP_ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>';
const SPINNER_ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 2a10 10 0 0 1 10 10"/></svg>';
const DOCUMENT_ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>';
// Rewind controls (Chat UX essentials). No width/height — `.action-btn svg` in
// style.css sizes them, the same as the copy/speak icons above.
const REGEN_ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>';
const EDIT_ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5z"/></svg>';

// Render $...$, $$...$$, \(...\), \[...\] and AMS environments (\begin{equation}
// etc.) as typeset math via KaTeX, in place, within the given element. Called
// after a message's markdown has already been parsed and DOMPurify-sanitized
// into the DOM — it only ever walks already-inserted text nodes (skipping
// <pre>/<code>, per auto-render's own default ignoredTags) and never touches
// raw HTML strings.
//
// SECURITY: `trust` is intentionally left at KaTeX's default of `false`. That
// disables \href, \url, \includegraphics, and the \html* macros — the only
// mechanisms by which a LaTeX source string could otherwise make KaTeX emit
// attacker-chosen HTML (e.g. an arbitrary href). Do not pass `trust: true` (or
// a permissive trust function) here without re-reviewing that decision. A
// malformed expression falls back to rendering its raw source as plain text
// rather than throwing — see katex-auto-render.min.js's own per-expression
// try/catch — so one bad expression can't blank out the rest of a message.
function renderMathIn(element) {
  if (typeof renderMathInElement !== 'function') return;
  renderMathInElement(element, {
    delimiters: [
      { left: '$$', right: '$$', display: true },
      { left: '\\(', right: '\\)', display: false },
      { left: '\\begin{equation}', right: '\\end{equation}', display: true },
      { left: '\\begin{align}', right: '\\end{align}', display: true },
      { left: '\\begin{alignat}', right: '\\end{alignat}', display: true },
      { left: '\\begin{gather}', right: '\\end{gather}', display: true },
      { left: '\\begin{CD}', right: '\\end{CD}', display: true },
      { left: '\\[', right: '\\]', display: true },
      // Single-dollar inline math — not in KaTeX's own defaults (it can clash
      // with literal currency amounts), but the most common form AI models
      // emit. Must stay after '$$' — '$' would otherwise match its first '$'.
      { left: '$', right: '$', display: false }
    ],
    throwOnError: false
  });
}

// Syntax-highlight fenced code blocks in place, within the given element, via
// highlight.js. Runs after a message's markdown has been parsed and
// DOMPurify-sanitized into the DOM: marked turns ```js ... ``` into
// <pre><code class="language-js">…</code></pre>, and highlight.js then replaces
// that block's innerHTML with class-only <span> tokens.
//
// SECURITY: highlight.js emits only class-annotated <span>s (no attributes, no
// URLs), but its output is fed straight back through DOMPurify.sanitize() anyway
// so the "every AI content -> innerHTML boundary is sanitized" invariant holds
// with no special-casing. A block that throws is left as the plain (already
// sanitized) text it was. ```mermaid``` blocks are skipped here — renderMermaidIn
// owns them.
function highlightCodeIn(element) {
  if (typeof hljs === 'undefined') return;
  element.querySelectorAll('pre code').forEach((block) => {
    if (block.classList.contains('language-mermaid')) return;
    if (block.dataset.hljsDone) return;
    try {
      hljs.highlightElement(block);
      block.innerHTML = DOMPurify.sanitize(block.innerHTML);
      block.dataset.hljsDone = '1';
    } catch { /* leave the block as plain text */ }
  });
}

// Render ```mermaid``` fenced blocks as SVG diagrams in place, within the given
// element. mermaid.render() returns a Promise in v10, so this is async and is
// called fire-and-forget at the render sites (the diagram pops in a moment
// later) — the same non-blocking treatment renderMathIn / highlightCodeIn get.
//
// SECURITY: mermaid runs at securityLevel: 'strict' (HTML labels off, no click
// handlers, no external resource fetches — see the initialize() call at the
// bottom of this file), and its generated SVG string is still passed through
// DOMPurify.sanitize() with the SVG profile before it reaches innerHTML. A block
// that fails to parse keeps its raw (already sanitized) source visible and is
// marked .mermaid-error rather than blanking the message.
async function renderMermaidIn(element) {
  if (typeof mermaid === 'undefined') return;
  const blocks = element.querySelectorAll('pre code.language-mermaid');
  for (const code of blocks) {
    const pre = code.closest('pre');
    if (!pre || pre.dataset.mermaidDone) continue;
    pre.dataset.mermaidDone = '1';
    const src = code.textContent;
    const id = 'mmd-' + Math.random().toString(36).slice(2);
    try {
      const { svg } = await mermaid.render(id, src);
      const wrapper = document.createElement('div');
      wrapper.className = 'mermaid-diagram';
      wrapper.innerHTML = DOMPurify.sanitize(svg, {
        USE_PROFILES: { svg: true, svgFilters: true }
      });
      pre.replaceWith(wrapper);
    } catch {
      pre.classList.add('mermaid-error');
    }
  }
}

// Every post-render enrichment pass in one place, so a new render site in
// api.js / chat.js can't silently forget one. renderMathIn and highlightCodeIn
// are synchronous; renderMermaidIn is async and deliberately not awaited.
function enrichRenderedContent(element) {
  renderMathIn(element);
  highlightCodeIn(element);
  renderMermaidIn(element);
}

// Markdown-parse + sanitize a message's raw text, with LaTeX delimiters
// protected from CommonMark's backslash-escape rule (see protectLatexDelimiters
// in utils.js) — the one function every AI/user content -> innerHTML boundary
// in api.js and chat.js should go through, so the protect/restore step can
// never be forgotten at a new call site.
function renderMarkdownToHtml(text) {
  const html = marked.parse(protectLatexDelimiters(text));
  return DOMPurify.sanitize(restoreLatexBackslashes(html));
}

// English Editor replies: the model returns just the polished text, and the
// reader can view it three ways — 'original' (their submitted text, verbatim),
// 'changes' (a word-level tracked-changes diff), or 'clean' (the polished text
// rendered like any other reply). `revisedText` is the raw model output stored
// in conversationHistory; the diff is always derived here, never stored.
//
// SECURITY: the 'changes' view is assembled entirely with createElement /
// createTextNode / textContent — no innerHTML, no string concatenation — so it
// introduces no new sanitisation boundary. (<ins>/<del> are in DOMPurify's
// default allowlist regardless.) The 'clean' view reuses renderMarkdownToHtml(),
// the same sanitised boundary every other reply goes through.
const EDITOR_VIEW_LABELS = { original: 'Original', changes: 'Changes', clean: 'Clean' };

function renderEditorReply(container, originalText, revisedText, view) {
  container.classList.remove('editor-diff');
  container.innerHTML = '';

  if (view === 'original') {
    container.textContent = originalText;
    return;
  }

  if (view === 'changes') {
    container.classList.add('editor-diff');
    diffWords(originalText, revisedText).forEach((seg) => {
      if (seg.op === 0) {
        container.appendChild(document.createTextNode(seg.text));
        return;
      }
      const el = document.createElement(seg.op === -1 ? 'del' : 'ins');
      el.textContent = seg.text;
      container.appendChild(el);
    });
    return;
  }

  // 'clean' — render the polished text like a normal reply.
  container.innerHTML = renderMarkdownToHtml(revisedText);
  enrichRenderedContent(container);
}

// Build the small Original/Changes/Clean selector shown alongside an editor
// reply's copy/speak actions. Mutates `entry.editorView` on change (so the
// choice persists into conversationHistory and the saved-chat JSON) and
// re-renders `container` in place — no re-send.
function _buildEditorViewSwitch(entry, container, originalText, revisedText) {
  const select = document.createElement('select');
  select.className = 'editor-view-switch';
  select.setAttribute('aria-label', 'Editor reply view');
  ['original', 'changes', 'clean'].forEach((v) => {
    const opt = document.createElement('option');
    opt.value = v;
    opt.textContent = EDITOR_VIEW_LABELS[v];
    select.appendChild(opt);
  });
  select.value = entry.editorView || 'clean';
  select.addEventListener('change', function () {
    entry.editorView = this.value;
    renderEditorReply(container, originalText, revisedText, this.value);
  });
  return select;
}

// The user turn an editor reply revised — the nearest preceding 'user' entry.
// Returns null when there is none (shouldn't happen for a tagged exchange).
function _precedingUserText(history, idx) {
  for (let i = idx - 1; i >= 0; i--) {
    if (history[i].role === 'user') return history[i].content;
  }
  return null;
}

function createSpeakButton(content) {
  // Both TTS engines (Piper, VoiceBox) run through same-origin proxies and
  // don't depend on any browser speech API, so the button is always functional.
  const btn = document.createElement('button');
  btn.className = 'action-btn speak-btn';
  btn.title = 'Speak this response';
  btn.setAttribute('aria-label', 'Speak this response');
  btn.setAttribute('aria-pressed', 'false');
  btn.innerHTML = SPEAK_ICON;
  if (content) btn.dataset.content = content;
  btn.addEventListener('click', () => toggleMessageSpeak(btn));
  return btn;
}

function toggleMessageSpeak(button) {
  if (button.classList.contains('speaking')) {
    stopSpeaking();
  } else {
    const content = button.dataset.content;
    if (content) speakText(content, button);
  }
}

function createCopyButton(content) {
  const btn = document.createElement('button');
  btn.className = 'action-btn copy-btn';
  btn.title = 'Copy response to clipboard';
  btn.setAttribute('aria-label', 'Copy response to clipboard');
  btn.innerHTML = COPY_ICON;
  if (content) btn.dataset.content = content;
  btn.addEventListener('click', () => copyMessageToClipboard(btn));
  return btn;
}

function copyMessageToClipboard(button) {
  const content = button.dataset.content;
  if (!content) return;
  navigator.clipboard.writeText(content).then(() => {
    button.innerHTML = CHECK_ICON;
    button.classList.add('copied');
    setTimeout(() => {
      button.innerHTML = COPY_ICON;
      button.classList.remove('copied');
    }, 2000);
  }).catch(() => {
    alert('Copy failed — please select and copy the text manually.');
  });
}

// ---------------------------------------------------------------------------
// Rewind controls — Regenerate the last AI reply, or edit & resend the last
// user turn. The array bookkeeping is factored into pure helpers so it can be
// unit-tested without a DOM (see tests/js/chat-ux.test.js).
// ---------------------------------------------------------------------------

// Indices of the last user turn and of the assistant reply immediately after
// it — `-1` for either when absent. Pure; tolerates non-array / empty input.
function _lastExchangeIndices(history) {
  const none = { userIdx: -1, assistantIdx: -1 };
  if (!Array.isArray(history)) return none;
  let userIdx = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i] && history[i].role === 'user') {
      userIdx = i;
      break;
    }
  }
  if (userIdx === -1) return none;
  let assistantIdx = -1;
  for (let i = userIdx + 1; i < history.length; i++) {
    if (history[i] && history[i].role === 'assistant') {
      assistantIdx = i;
      break;
    }
  }
  return { userIdx, assistantIdx };
}

// Given a stored user history entry, the plain text to reload into the composer
// when rewinding to edit it, plus whether an attachment was dropped. A document
// block is unwrapped to just its question; an image can't be rehydrated so only
// its text is recovered. Pure (delegates to parseDocumentMessageContent).
function _editableTextFor(entry) {
  const content = (entry && entry.content) || '';
  const parsed = parseDocumentMessageContent(content);
  if (parsed.hasDocument) return { text: parsed.question, lostAttachment: true };
  if (entry && (entry.imageBase64 || entry.hasImage)) {
    return { text: content, lostAttachment: true };
  }
  return { text: content, lostAttachment: false };
}

// True while a streamed reply is still arriving — the Stop button is shown
// (setStreamingUI() in api.js). Used to suppress the rewind controls mid-stream.
function _streamInProgress() {
  const stopBtn = document.getElementById('stopBtn');
  return !!(stopBtn && stopBtn.style && stopBtn.style.display === 'flex');
}

// Shared tail of every send path: render the user bubble, add the AI
// placeholder, stream the reply. streamOllamaResponse() re-pushes the user
// entry to conversationHistory itself, so callers must not.
async function _dispatchSend(message, imageBase64, imageDataUrl) {
  addUserMessage(message, imageDataUrl);
  const aiMessageDiv = addAIMessagePlaceholder();
  await streamOllamaResponse(message, aiMessageDiv, imageBase64, imageDataUrl);
}

// Regenerate the most recent AI reply: drop the trailing user+assistant pair
// (streamOllamaResponse re-pushes the user turn) and re-run the send path with
// the same text/image. No-op mid-stream or when there is no completed reply.
async function regenerateLastResponse() {
  if (_streamInProgress()) return;
  const { userIdx, assistantIdx } = _lastExchangeIndices(conversationHistory);
  if (userIdx === -1 || assistantIdx === -1) return;
  // Only ever regenerate the reply that is actually last in the history.
  if (assistantIdx !== conversationHistory.length - 1) return;

  const src = conversationHistory[userIdx];
  const message = src.content;
  const imageBase64 = src.imageBase64 || null;
  const imageDataUrl = src.imageDataUrl || null;

  conversationHistory.splice(assistantIdx, 1);
  conversationHistory.splice(userIdx, 1);

  renderConversationHistory();
  await _dispatchSend(message, imageBase64, imageDataUrl);
}

// Rewind to just before the last user turn: pop that turn (and its reply, if
// any) off history, drop them from the DOM, and load the text back into the
// composer for editing. No-op mid-stream or with no user turn.
function editLastUserTurn() {
  if (_streamInProgress()) return;
  const { userIdx, assistantIdx } = _lastExchangeIndices(conversationHistory);
  if (userIdx === -1) return;

  const { text, lostAttachment } = _editableTextFor(conversationHistory[userIdx]);

  // assistantIdx (when present) is always after userIdx — splice it first so
  // userIdx stays valid.
  if (assistantIdx !== -1) conversationHistory.splice(assistantIdx, 1);
  conversationHistory.splice(userIdx, 1);

  renderConversationHistory();

  if (lostAttachment) showToast('Attachment not carried over — re-attach if needed');

  const input = document.getElementById('userInput');
  if (input) {
    input.value = text;
    input.dispatchEvent(new Event('input'));
    input.focus();
  }
}

function _makeTurnControl(className, label, icon, handler) {
  const btn = document.createElement('button');
  btn.className = 'action-btn ' + className;
  btn.title = label;
  btn.setAttribute('aria-label', label);
  btn.innerHTML = icon;
  btn.addEventListener('click', handler);
  return btn;
}

// (Re)attach the per-turn rewind controls: a Regenerate button on the last AI
// reply, an Edit & resend button on the last user message. Idempotent — clears
// any existing pair first — so it is safe to call after every render and at the
// end of a stream. Skips both when the DOM and conversationHistory disagree
// (e.g. a failed turn whose user entry was rolled back).
function _refreshTurnControls() {
  document
    .querySelectorAll('.msg-regen-btn, .msg-edit-btn')
    .forEach((btn) => btn.remove());

  if (typeof conversationHistory === 'undefined' || !Array.isArray(conversationHistory)) {
    return;
  }

  const domUserCount = document.querySelectorAll('.message.user-message').length;
  const histUserCount = conversationHistory.filter((m) => m.role === 'user').length;
  const inSync = domUserCount === histUserCount;
  if (!inSync) return;

  const endsWithAssistant =
    conversationHistory.length > 0 &&
    conversationHistory[conversationHistory.length - 1].role === 'assistant';

  if (endsWithAssistant) {
    const aiMessages = document.querySelectorAll('.message.ai-message');
    const lastAi = aiMessages[aiMessages.length - 1];
    const actions = lastAi && lastAi.querySelector('.message-actions');
    if (actions && actions.style.display !== 'none') {
      actions.appendChild(
        _makeTurnControl('msg-regen-btn', 'Regenerate response', REGEN_ICON, regenerateLastResponse)
      );
    }
  }

  if (!_streamInProgress()) {
    const userMessages = document.querySelectorAll('.message.user-message');
    const lastUser = userMessages[userMessages.length - 1];
    if (lastUser) {
      let actions = lastUser.querySelector('.message-actions');
      if (!actions) {
        actions = document.createElement('div');
        actions.className = 'message-actions';
        lastUser.appendChild(actions);
      }
      actions.appendChild(
        _makeTurnControl('msg-edit-btn', 'Edit & resend', EDIT_ICON, editLastUserTurn)
      );
    }
  }
}

// The persona key currently in effect. The Settings lightbox is the only thing
// that changes it (writing window.vpalSettings.global.active_persona and calling
// applyResolvedSettings()); everything here just reads it, falling back to the
// englishEditor default before settings have hydrated.
function _currentPersonaKey() {
  const g = window.vpalSettings && window.vpalSettings.global;
  return (g && g.active_persona) || 'englishEditor';
}

function updateSystemPromptState() {
  const locked = conversationHistory.length > 0;

  const toggleBtn = document.getElementById('personaToggleBtn');
  if (toggleBtn) {
    toggleBtn.classList.toggle('locked', locked);
    toggleBtn.title = locked
      ? 'Clear the conversation to switch persona'
      : 'Open Settings to choose a persona';
  }

  const label = document.getElementById('currentPersonaLabel');
  if (label) label.textContent = personaLabels[_currentPersonaKey()] || '';
}

// Add a user message bubble. imageDataUrl is a data: URL from FileReader for display.
// Appends the filename chip shown above a folded-in document question — the
// full extracted text sent to the model isn't re-displayed here, only the
// name of what was attached. Shared by addUserMessage and renderConversationHistory.
function _appendDocumentChip(contentDiv, documentName) {
  const chip = document.createElement('div');
  chip.className = 'user-message-document';
  chip.innerHTML = DOCUMENT_ICON;
  const nameSpan = document.createElement('span');
  nameSpan.textContent = documentName;
  chip.appendChild(nameSpan);
  contentDiv.appendChild(chip);
}

function addUserMessage(text, imageDataUrl = null) {
  const messagesDiv = document.getElementById('chatMessages');
  const timestamp = formatTimestamp(new Date());
  const messageDiv = document.createElement('div');
  messageDiv.className = 'message user-message';

  const labelDiv = document.createElement('div');
  labelDiv.className = 'message-label';
  labelDiv.textContent = 'You';

  const contentDiv = document.createElement('div');
  contentDiv.className = 'message-content';

  if (imageDataUrl) {
    const img = document.createElement('img');
    img.className = 'user-message-image';
    img.src = imageDataUrl;
    img.alt = 'Attached image';
    contentDiv.appendChild(img);
  }
  if (text) {
    const parsed = parseDocumentMessageContent(text);
    if (parsed.hasDocument) _appendDocumentChip(contentDiv, parsed.documentName);
    const p = document.createElement('p');
    p.textContent = parsed.hasDocument ? parsed.question : text;
    contentDiv.appendChild(p);
    enrichRenderedContent(contentDiv);
  }

  const tsDiv = document.createElement('div');
  tsDiv.className = 'message-timestamp';
  tsDiv.textContent = timestamp;

  messageDiv.appendChild(labelDiv);
  messageDiv.appendChild(contentDiv);
  messageDiv.appendChild(tsDiv);
  messagesDiv.appendChild(messageDiv);
  messagesDiv.scrollTop = messagesDiv.scrollHeight;
}

function addAIMessagePlaceholder() {
  const messagesDiv = document.getElementById('chatMessages');
  const timestamp = formatTimestamp(new Date());
  const messageDiv = document.createElement('div');
  messageDiv.className = 'message ai-message';
  messageDiv.innerHTML = `
      <div class="message-label">AI Assistant</div>
      <div class="message-content">
        <p class="status-muted">Working…</p>
      </div>
      <div class="message-timestamp">${escapeHtml(timestamp)}</div>
    `;
  const actionsDiv = document.createElement('div');
  actionsDiv.className = 'message-actions';
  actionsDiv.style.display = 'none';
  actionsDiv.appendChild(createCopyButton(''));
  const speakBtn = createSpeakButton('');
  if (speakBtn) actionsDiv.appendChild(speakBtn);
  messageDiv.appendChild(actionsDiv);
  messagesDiv.appendChild(messageDiv);
  messagesDiv.scrollTop = messagesDiv.scrollHeight;

  return messageDiv;
}


function addContextTrimNotice() {
  const messagesDiv = document.getElementById('chatMessages');
  const notice = document.createElement('div');
  notice.className = 'context-trim-notice';
  notice.textContent = 'Earlier messages removed from context window';
  messagesDiv.appendChild(notice);
  messagesDiv.scrollTop = messagesDiv.scrollHeight;
}

// "New chat" — archive the current conversation to the history service first,
// then reset. Nothing is lost, so there is no destructive confirm any more.
// hcArchiveCurrent() PUTs a snapshot of the still-populated conversationHistory;
// it is awaited so the snapshot is sent before the array is wiped below.
async function clearChat() {
  if (typeof hcArchiveCurrent === 'function') {
    await hcArchiveCurrent();
  }
  stopSpeaking(); // Stop any ongoing speech (this will resume recognition if needed)
  conversationHistory = [];
  document.getElementById('chatMessages').innerHTML = '';
  clearImagePreview();
  clearDocumentPreview();
  updateSystemPromptState(); // Re-enable persona switching
  if (typeof hcNewConversationId === 'function') hcNewConversationId();
}

// Close window function
function closeWindow() {
  if (confirm('Are you sure you want to close this window?')) {
    // Stop any ongoing speech and recognition
    stopSpeaking();
    if (isRecording) {
      recognition.stop();
      isRecording = false;
    }

    // Attempt to close the window
    window.close();

    // If window.close() doesn't work (some browsers block it), show a message
    setTimeout(() => {
      alert('Please close this window manually using your browser controls.');
    }, 100);
  }
}

// Resolve a persona key to the actual system-prompt text. `englishEditor` has
// two prompt variants — the silent/output-only one and the change-explaining
// one — chosen by that persona's `editor_mode`: 'explain' uses the explaining
// prompt, 'clean'/'changes' use the silent one (the 'changes' diff view is
// derived client-side from that silent output).
//
// The editor mode and (when no key is passed) the active persona are read from
// window.vpalSettings, falling back to the `currentEditorMode` /
// `currentSystemPrompt`-implied defaults before settings have hydrated.
function _resolveSystemPrompt(personaKey) {
  const key = personaKey || _currentPersonaKey();
  if (key === 'englishEditor') {
    const p = window.vpalSettings
      && window.vpalSettings.personas
      && window.vpalSettings.personas.englishEditor;
    const mode = (p && p.editor_mode) || currentEditorMode;
    return mode === 'explain'
      ? systemPrompts.englishEditorExplained
      : systemPrompts.englishEditor;
  }
  return systemPrompts[key];
}

// Send message and continue listening (for voice mode)
// Folds a pending document attachment into the outgoing message text — there
// is no separate "documents" field in Ollama's chat API the way there is
// `images` for vision, so the extracted text has to be part of the message
// itself. Returns rawMessage unchanged when no document is pending.
function _composeOutgoingMessage(rawMessage) {
  if (!pendingDocumentText) return rawMessage;
  return buildDocumentMessageContent(
    pendingDocumentName, pendingDocumentText, pendingDocumentTruncated, rawMessage
  );
}

async function sendMessageAndContinueListening() {
  const input = document.getElementById('userInput');
  const rawMessage = input.value.trim();
  const hasContent = rawMessage || pendingImageBase64 || pendingDocumentText;

  if (hasContent) {
    accumulatedTranscript = '';

    const imageDataUrl = pendingImageDataUrl;
    const imageBase64 = pendingImageBase64;
    const message = _composeOutgoingMessage(rawMessage);
    clearImagePreview();
    clearDocumentPreview();

    input.value = '';
    input.dispatchEvent(new Event('input'));

    await _dispatchSend(message, imageBase64, imageDataUrl);
  }
}

// Send message function
async function sendMessage() {
  const input = document.getElementById('userInput');
  const rawMessage = input.value.trim();
  const hasContent = rawMessage || pendingImageBase64 || pendingDocumentText;

  if (hasContent) {
    // If triggered manually (not by voice), stop recording if active
    if (isRecording) {
      recognition.stop();
      isRecording = false;
      document.getElementById('micBtn').classList.remove('recording');
      document.getElementById('micBtn').classList.remove('paused');
      document.getElementById('micBtn').setAttribute('aria-pressed', 'false');
      if (silenceTimer) {
        clearTimeout(silenceTimer);
        silenceTimer = null;
      }
      accumulatedTranscript = '';
    }

    const imageDataUrl = pendingImageDataUrl;
    const imageBase64 = pendingImageBase64;
    const message = _composeOutgoingMessage(rawMessage);
    clearImagePreview();
    clearDocumentPreview();

    input.value = '';
    input.dispatchEvent(new Event('input'));

    await _dispatchSend(message, imageBase64, imageDataUrl);
  }
}

// Derive a short topic slug from the first user message — used in export filenames.
function _chatTopic() {
  const stopwords = new Set([
    'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
    'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
    'should', 'may', 'might', 'shall', 'can', 'to', 'of', 'in', 'on',
    'at', 'by', 'for', 'with', 'about', 'from', 'and', 'but', 'or', 'nor',
    'so', 'yet', 'i', 'me', 'my', 'we', 'our', 'you', 'your', 'it', 'its',
    'this', 'that', 'what', 'which', 'who', 'how', 'when', 'where', 'why',
    'not', 'no', 'if', 'as', 'just', 'please', 'help', 'tell', 'make',
    'write', 'explain', 'give', 'show', 'get', 'use', 'need', 'want',
  ]);
  const firstUser = conversationHistory.find(m => m.role === 'user');
  if (!firstUser || !firstUser.content) return 'Chat';
  const words = firstUser.content
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !stopwords.has(w));
  const topic = words.slice(0, 3)
    .map(w => w.charAt(0).toUpperCase() + w.slice(1))
    .join('-');
  return topic || 'Chat';
}

// Save chat function
function saveChat() {
  if (conversationHistory.length === 0) {
    alert('No conversation to save!');
    return;
  }

  // Export conversationHistory as JSON — strip in-memory image data (imageBase64,
  // imageDataUrl) to keep files small; preserve hasImage so loaded history can show
  // a placeholder where an image was attached.
  const exportData = conversationHistory.map(
    ({ role, content, timestamp, hasImage, editorExchange, editorView }) => {
      const entry = { role, content, timestamp };
      if (hasImage) entry.hasImage = true;
      if (editorExchange) entry.editorExchange = true;
      if (editorView) entry.editorView = editorView;
      return entry;
    }
  );
  const json = JSON.stringify(exportData, null, 2);

  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;

  // Generate filename: YYYYMMDD-HHMMss-vpal-<Topic>
  const now = new Date();
  const yyyy = now.getFullYear();
  const mo = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const mi = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  a.download = `${yyyy}${mo}${dd}-${hh}${mi}${ss}-vpal-${_chatTopic()}.json`;

  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast('Chat saved');
}

// Export chat as a human-readable Markdown file
function exportChatAsMarkdown() {
  if (conversationHistory.length === 0) {
    alert('No conversation to export!');
    return;
  }

  const personaName = personaLabels[_currentPersonaKey()] || 'AI Assistant';
  const headerDate = formatTimestamp(new Date());

  const lines = [
    '# VPAL Chat Export',
    '',
    `**Date:** ${headerDate}`,
    `**Persona:** ${personaName}`,
    '',
    '---',
  ];

  conversationHistory.forEach(msg => {
    const formatted = msg.formattedTimestamp || formatTimestamp(new Date(msg.timestamp || Date.now()));

    if (msg.role === 'user') {
      lines.push('', `## You — ${formatted}`, '');
      if (msg.imageDataUrl || msg.hasImage) {
        lines.push('📎 *Image attached (not available in export)*', '');
      }
      if (msg.content) lines.push(msg.content);
    } else {
      lines.push('', `## AI Assistant (${personaName}) — ${formatted}`, '');
      lines.push(msg.content || '');
    }

    lines.push('', '---');
  });

  const markdown = lines.join('\n');
  const blob = new Blob([markdown], { type: 'text/markdown' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;

  const now = new Date();
  const yyyy = now.getFullYear();
  const mo = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const mi = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  a.download = `${yyyy}${mo}${dd}-${hh}${mi}${ss}-vpal-${_chatTopic()}.md`;

  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  showToast('Chat exported as Markdown');
}

// Trigger file chooser for opening JSON chat
function openChat() {
  document.getElementById('openInput').click();
}

// Render conversationHistory into the chat messages area
function renderConversationHistory() {
  const messagesDiv = document.getElementById('chatMessages');
  messagesDiv.innerHTML = '';

  conversationHistory.forEach((msg, idx) => {
    const roleClass = msg.role === 'user' ? 'user-message' : 'ai-message';
    const label = msg.role === 'user' ? 'You' : 'AI Assistant';
    const formatted = msg.formattedTimestamp || formatTimestamp(new Date(msg.timestamp || Date.now()));

    const messageDiv = document.createElement('div');
    messageDiv.className = `message ${roleClass}`;

    if (msg.role === 'user') {
      const labelDiv = document.createElement('div');
      labelDiv.className = 'message-label';
      labelDiv.textContent = label;

      const contentDiv = document.createElement('div');
      contentDiv.className = 'message-content';

      if (msg.imageDataUrl) {
        // In-memory session: show the actual image thumbnail
        const img = document.createElement('img');
        img.className = 'user-message-image';
        img.src = msg.imageDataUrl;
        img.alt = 'Attached image';
        contentDiv.appendChild(img);
      } else if (msg.hasImage) {
        // Loaded from saved file: base64 was stripped on save; show labelled icon.
        const p = document.createElement('p');
        p.className = 'image-placeholder';
        p.innerHTML =
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" ' +
          'stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
          'stroke-linejoin="round" aria-hidden="true">' +
          '<rect x="3" y="3" width="18" height="18" rx="2"/>' +
          '<circle cx="8.5" cy="8.5" r="1.5"/>' +
          '<polyline points="21 15 16 10 5 21"/>' +
          '</svg>Image not available in saved file';
        contentDiv.appendChild(p);
      }
      if (msg.content) {
        const parsed = parseDocumentMessageContent(msg.content);
        if (parsed.hasDocument) _appendDocumentChip(contentDiv, parsed.documentName);
        const p = document.createElement('p');
        p.textContent = parsed.hasDocument ? parsed.question : msg.content;
        contentDiv.appendChild(p);
        enrichRenderedContent(contentDiv);
      }

      const tsDiv = document.createElement('div');
      tsDiv.className = 'message-timestamp';
      tsDiv.textContent = formatted;

      messageDiv.appendChild(labelDiv);
      messageDiv.appendChild(contentDiv);
      messageDiv.appendChild(tsDiv);
    } else {
      messageDiv.innerHTML = `
        <div class="message-label">${label}</div>
        <div class="message-content"></div>
        <div class="message-timestamp">${escapeHtml(formatted)}</div>
      `;
      const contentEl = messageDiv.querySelector('.message-content');

      // An English Editor exchange (tagged in api.js, or loaded from a saved
      // chat) renders as the polished text with an Original/Changes/Clean view
      // switch, diffed against the user turn it revised — instead of the plain
      // markdown render. Falls back to normal rendering if the paired user turn
      // is somehow missing.
      const editorOriginal =
        msg.editorExchange === true ? _precedingUserText(conversationHistory, idx) : null;

      if (msg.editorExchange === true && editorOriginal !== null) {
        if (!msg.editorView) msg.editorView = 'clean';
        renderEditorReply(contentEl, editorOriginal, msg.content, msg.editorView);
      } else {
        contentEl.innerHTML = renderMarkdownToHtml(msg.content);
        enrichRenderedContent(contentEl);
      }

      const actionsDiv = document.createElement('div');
      actionsDiv.className = 'message-actions';
      actionsDiv.appendChild(createCopyButton(msg.content));
      const speakBtnH = createSpeakButton(msg.content);
      if (speakBtnH) actionsDiv.appendChild(speakBtnH);
      if (msg.editorExchange === true && editorOriginal !== null) {
        actionsDiv.appendChild(
          _buildEditorViewSwitch(msg, contentEl, editorOriginal, msg.content)
        );
      }
      messageDiv.appendChild(actionsDiv);
    }

    messagesDiv.appendChild(messageDiv);
  });

  messagesDiv.scrollTop = messagesDiv.scrollHeight;

  // Update system prompt state after rendering
  updateSystemPromptState();

  // Attach the Regenerate / Edit & resend controls to the last turn.
  _refreshTurnControls();
}

// Handle chosen JSON file and open into conversationHistory
function handleOpenFile(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;

  if (file.size > MAX_UPLOAD_FILE_BYTES) {
    alert(`File too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Maximum is 5 MB.`);
    event.target.value = '';
    return;
  }

  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const data = JSON.parse(e.target.result);
      if (!Array.isArray(data)) throw new Error('Invalid file format: expected an array');

      // Validate and normalize entries
      conversationHistory = data.map((item, index) => {
        if (!['user', 'assistant'].includes(item.role)) {
          throw new Error(`Entry ${index}: invalid role "${item.role}"`);
        }
        if (typeof item.content !== 'string') {
          throw new Error(`Entry ${index}: content must be a string`);
        }
        if (item.content.length === 0 && !item.hasImage) {
          throw new Error(`Entry ${index}: content must be non-empty`);
        }
        const ts = item.timestamp || new Date().toISOString();
        const tsDate = new Date(ts);
        if (isNaN(tsDate.getTime())) {
          throw new Error(`Entry ${index}: invalid timestamp "${item.timestamp}"`);
        }
        const entry = {
          role: item.role,
          content: item.content,
          timestamp: ts,
          formattedTimestamp: formatTimestamp(tsDate)
        };
        if (item.hasImage) entry.hasImage = true;
        if (item.editorExchange === true) entry.editorExchange = true;
        if (typeof item.editorView === 'string') entry.editorView = item.editorView;
        return entry;
      });

      renderConversationHistory();
      clearImagePreview();
      clearDocumentPreview();
      // updateSystemPromptState() is now called inside renderConversationHistory()
    } catch (err) {
      alert('Failed to open chat: ' + err.message);
      console.error(err);
    } finally {
      // reset input so same file can be selected again
      event.target.value = '';
    }
  };

  reader.readAsText(file);
}

// One-time load configuration for the vendored render libraries (loaded as
// classic <script>s before this file). Guarded so this file can also be
// CommonJS-required in Jest without either global present.
if (typeof hljs !== 'undefined') {
  // We only ever hand highlight.js already-sanitized DOM, so silence its
  // "unescaped HTML" console warning.
  hljs.configure({ ignoreUnescapedHTML: true });
}
if (typeof mermaid !== 'undefined') {
  // strict: HTML labels off, no click handlers, no external resource fetches.
  mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'dark' });
}

// Node.js compat — lets Jest import the render helpers for unit tests; no-op in
// the browser (module is undefined there). Mirrors utils.js / api.js.
if (typeof module !== 'undefined') {
  module.exports = {
    renderMathIn,
    highlightCodeIn,
    renderMermaidIn,
    enrichRenderedContent,
    renderMarkdownToHtml,
    _lastExchangeIndices,
    _editableTextFor,
    regenerateLastResponse,
    editLastUserTurn,
    _refreshTurnControls
  };
}
