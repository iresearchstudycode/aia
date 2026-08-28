// chat.js - Chat message handling functions

// SVG icons for action buttons — defined here so speech.js can reference them
// when toggling the speak button between idle and active states.
const COPY_ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>';
const CHECK_ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>';
const SPEAK_ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"/><path d="M15.54 8.46a5 5 0 0 1 0 7.07"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14"/></svg>';
const STOP_ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>';
const SPINNER_ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M12 2a10 10 0 0 1 10 10"/></svg>';
const DOCUMENT_ICON = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>';

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

// Markdown-parse + sanitize a message's raw text, with LaTeX delimiters
// protected from CommonMark's backslash-escape rule (see protectLatexDelimiters
// in utils.js) — the one function every AI/user content -> innerHTML boundary
// in api.js and chat.js should go through, so the protect/restore step can
// never be forgotten at a new call site.
function renderMarkdownToHtml(text) {
  const html = marked.parse(protectLatexDelimiters(text));
  return DOMPurify.sanitize(restoreLatexBackslashes(html));
}

function createSpeakButton(content) {
  // VoiceBox does not depend on the browser's Web Speech API, so the button
  // is created even when speechSynthesis is absent — speakText() itself
  // no-ops for the 'browser' engine on unsupported browsers.
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

function updateSystemPromptState() {
  const locked = conversationHistory.length > 0;

  document.getElementById('systemPromptSelect').disabled = locked;

  const toggleBtn = document.getElementById('personaToggleBtn');
  if (toggleBtn) {
    toggleBtn.classList.toggle('locked', locked);
    toggleBtn.title = locked ? 'Clear the conversation to switch persona' : 'Choose persona';
  }

  const notice = document.getElementById('personaPanelNotice');
  if (notice) notice.style.display = locked ? '' : 'none';
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
    renderMathIn(contentDiv);
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

// Clear chat function
function clearChat() {
  if (confirm('Are you sure you want to clear the chat history?')) {
    stopSpeaking(); // Stop any ongoing speech (this will resume recognition if needed)
    conversationHistory = [];
    document.getElementById('chatMessages').innerHTML = '';
    clearImagePreview();
    clearDocumentPreview();
    updateSystemPromptState(); // Re-enable system prompt selector
  }
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

// Resolve the option value to the actual prompt text. `englishEditor` has two
// variants — the silent/output-only one and the "Explain changes" one — chosen
// by the #editorExplainToggle checkbox in the persona panel.
function _resolveSystemPrompt(optionValue) {
  if (optionValue === 'englishEditor') {
    const explain = document.getElementById('editorExplainToggle');
    return explain && explain.checked
      ? systemPrompts.englishEditorExplained
      : systemPrompts.englishEditor;
  }
  return systemPrompts[optionValue];
}

// Update system prompt
function updateSystemPrompt() {
  const select = document.getElementById('systemPromptSelect');
  currentSystemPrompt = _resolveSystemPrompt(select.value);

  // If conversation has started, warn user
  if (conversationHistory.length > 0) {
    if (confirm('Changing the system prompt will reset the conversation. Continue?')) {
      conversationHistory = [];
      document.getElementById('chatMessages').innerHTML = '';
      updateSystemPromptState(); // Update state after clearing
    } else {
      // Revert selection. Both editor variants map back to the single
      // `englishEditor` option — a raw key lookup would yield
      // `englishEditorExplained`, which is not a valid <option> value and would
      // silently blank the select.
      if (
        currentSystemPrompt === systemPrompts.englishEditor ||
        currentSystemPrompt === systemPrompts.englishEditorExplained
      ) {
        select.value = 'englishEditor';
      } else {
        select.value = Object.keys(systemPrompts).find(key => systemPrompts[key] === currentSystemPrompt);
      }
    }
  }
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

    addUserMessage(message, imageDataUrl);

    const aiMessageDiv = addAIMessagePlaceholder();
    await streamOllamaResponse(message, aiMessageDiv, imageBase64, imageDataUrl);
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

    addUserMessage(message, imageDataUrl);
    input.value = '';
    input.dispatchEvent(new Event('input'));

    const aiMessageDiv = addAIMessagePlaceholder();
    await streamOllamaResponse(message, aiMessageDiv, imageBase64, imageDataUrl);
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
  const exportData = conversationHistory.map(({ role, content, timestamp, hasImage }) => {
    const entry = { role, content, timestamp };
    if (hasImage) entry.hasImage = true;
    return entry;
  });
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

  const sel = document.getElementById('systemPromptSelect');
  const personaName = sel.options[sel.selectedIndex].text;
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

  conversationHistory.forEach(msg => {
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
        renderMathIn(contentDiv);
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
        <div class="message-content">${renderMarkdownToHtml(msg.content)}</div>
        <div class="message-timestamp">${escapeHtml(formatted)}</div>
      `;
      renderMathIn(messageDiv.querySelector('.message-content'));
      const actionsDiv = document.createElement('div');
      actionsDiv.className = 'message-actions';
      actionsDiv.appendChild(createCopyButton(msg.content));
      const speakBtnH = createSpeakButton(msg.content);
      if (speakBtnH) actionsDiv.appendChild(speakBtnH);
      messageDiv.appendChild(actionsDiv);
    }

    messagesDiv.appendChild(messageDiv);
  });

  messagesDiv.scrollTop = messagesDiv.scrollHeight;

  // Update system prompt state after rendering
  updateSystemPromptState();
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
