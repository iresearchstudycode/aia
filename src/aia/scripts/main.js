// main.js - Initialization and event handlers

// Trap Tab/Shift-Tab focus inside an open panel so keyboard users cannot
// accidentally tab to elements behind the overlay.
function _trapFocus(panel, e) {
  const focusable = Array.from(
    panel.querySelectorAll('button:not(:disabled), select:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])')
  ).filter(el => el.offsetParent !== null);
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (e.shiftKey) {
    if (document.activeElement === first) { e.preventDefault(); last.focus(); }
  } else {
    if (document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
}

function _getCookie(name) {
  const match = document.cookie.match(new RegExp('(?:^|; )' + name + '=([^;]*)'));
  return match ? decodeURIComponent(match[1]) : '';
}

// Toggles the "+" attach button's active indicator based on whether an image
// or document is currently pending — both attachment types share one trigger
// button, so its active state reflects either being set.
function _updateAttachMenuActiveState() {
  const btn = document.getElementById('attachMenuBtn');
  if (btn) btn.classList.toggle('active', !!(pendingImageBase64 || pendingDocumentText));
}

// Clears any pending image attachment — resets global state, hides the preview
// strip, and re-evaluates the send button. Called by sendMessage/sendMessageAndContinueListening
// in chat.js before dispatching the request, and by the remove-image button.
function clearImagePreview() {
  pendingImageDataUrl = null;
  pendingImageBase64 = null;
  document.getElementById('imagePreviewStrip').style.display = 'none';
  document.getElementById('imagePreviewThumb').src = '';
  _updateAttachMenuActiveState();
  const textarea = document.getElementById('userInput');
  document.getElementById('sendBtn').disabled = textarea.value.trim().length === 0 && !pendingDocumentText;
}

// Clears any pending document attachment — mirrors clearImagePreview(). Called
// by sendMessage/sendMessageAndContinueListening/clearChat/handleOpenFile in
// chat.js before dispatching a request or resetting the chat, and by the
// remove-document button.
function clearDocumentPreview() {
  pendingDocumentText = null;
  pendingDocumentName = null;
  pendingDocumentTruncated = false;
  document.getElementById('documentPreviewStrip').style.display = 'none';
  document.getElementById('documentPreviewName').textContent = '';
  _updateAttachMenuActiveState();
  const textarea = document.getElementById('userInput');
  document.getElementById('sendBtn').disabled = textarea.value.trim().length === 0 && !pendingImageBase64;
}

// --- Per-persona settings memory -------------------------------------------
// The persona `change` event fires after #systemPromptSelect.value has already
// changed, so the key of the persona being switched *away from* is tracked here.
// Persona switching is disabled during an active conversation, so `change` only
// ever fires from an empty conversation — no mid-chat handling is needed.
let _activePersonaKey = null;
let _personaPrefsJson = '{}';

// Single source of truth for the thinking-mode button + depth-select DOM state
// (shared by the toggle handler, the session restore, and per-persona restore).
function _setThinkingUI(isOn, depth) {
  const btn = document.getElementById('thinkingModeBtn');
  const depthSelect = document.getElementById('thinkingDepthSelect');
  btn.classList.toggle('thinking-on', isOn);
  btn.setAttribute('aria-pressed', String(isOn));
  btn.setAttribute('aria-label', isOn ? 'Thinking mode: On' : 'Thinking mode: Off');
  btn.title = isOn
    ? 'Thinking mode: On — click to disable'
    : 'Enable thinking mode — model reasons before answering';
  depthSelect.style.display = isOn ? 'inline-block' : 'none';
  if (depth) depthSelect.value = depth;
  currentThinkingMode = isOn ? depthSelect.value : 'off';
}

// Single source of truth for the TTS-engine select DOM state + global.
function _setTTSUI(engine) {
  document.getElementById('ttsEngineSelect').value = engine;
  currentTTSEngine = engine;
}

// Read the live thinking/TTS control state as a persona-pref patch.
function _snapshotPersonaSettings() {
  return {
    thinkingOn: document.getElementById('thinkingModeBtn').classList.contains('thinking-on'),
    thinkingDepth: document.getElementById('thinkingDepthSelect').value,
    ttsEngine: document.getElementById('ttsEngineSelect').value,
  };
}

// Apply a stored persona-pref entry to the thinking/TTS controls.
function _applyPersonaSettings(s) {
  if (!s) return;
  if (typeof s.thinkingOn === 'boolean') _setThinkingUI(s.thinkingOn, s.thinkingDepth);
  if (s.ttsEngine) _setTTSUI(s.ttsEngine);
}

// Merge a patch into the current persona's stored prefs and persist to localStorage.
function _persistPersonaPref(patch) {
  if (!_activePersonaKey) return;
  _personaPrefsJson = writePersonaPref(_personaPrefsJson, _activePersonaKey, patch);
  localStorage.setItem(PERSONA_PREFS_KEY, _personaPrefsJson);
}

document.addEventListener('DOMContentLoaded', function () {
  // Inject the CSRF token into the logout form (double-submit cookie pattern).
  // vpal_csrf is non-HttpOnly so JS can read it; the server verifies it matches
  // the HMAC-derived value tied to the session token.
  const logoutForm = document.getElementById('logoutForm');
  if (logoutForm) {
    const csrfInput = document.createElement('input');
    csrfInput.type = 'hidden';
    csrfInput.name = 'csrf_token';
    csrfInput.value = _getCookie('vpal_csrf');
    logoutForm.appendChild(csrfInput);
  }

  // Profile widget: try the vpal_user cookie first (set on fresh logins),
  // fall back to /auth/me for existing sessions that pre-date the cookie.
  function _applyProfileName(name) {
    document.getElementById('profileName').textContent = name
      .split(' ')
      .map(function (w) { return w.charAt(0).toUpperCase() + w.slice(1); })
      .join(' ');
  }
  var rawUsername = _getCookie('vpal_user');
  if (rawUsername) {
    _applyProfileName(rawUsername);
  } else {
    fetch('/auth/me')
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) { if (data && data.username) _applyProfileName(data.username); })
      .catch(function () {});
  }

  // Persona panel — shows #systemPromptSelect in a fixed overlay below the ▾ button.
  // _applyCurrentPersonaLabel() reads the selected option text and writes it under
  // the "AI Assistant" heading; called on init and after every selection change.
  function _applyCurrentPersonaLabel() {
    var sel = document.getElementById('systemPromptSelect');
    document.getElementById('currentPersonaLabel').textContent =
      sel.options[sel.selectedIndex].text;
  }

  var personaToggleBtn = document.getElementById('personaToggleBtn');
  var personaPanel = document.getElementById('personaPanel');

  function openPersonaPanel() {
    var rect = personaToggleBtn.getBoundingClientRect();
    personaPanel.style.top = (rect.bottom + 8) + 'px';
    personaPanel.style.left = rect.left + 'px';
    personaPanel.classList.add('open');
    personaToggleBtn.setAttribute('aria-expanded', 'true');
    var sel = document.getElementById('systemPromptSelect');
    if (!sel.disabled) sel.focus();
  }

  function closePersonaPanel() {
    if (personaPanel.contains(document.activeElement)) {
      personaToggleBtn.focus();
    }
    personaPanel.classList.remove('open');
    personaToggleBtn.setAttribute('aria-expanded', 'false');
  }

  personaToggleBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    personaPanel.classList.contains('open') ? closePersonaPanel() : openPersonaPanel();
  });

  document.addEventListener('click', function (e) {
    if (!personaPanel.contains(e.target)) closePersonaPanel();
  });

  // Initialise the label from the HTML selected attribute.
  _applyCurrentPersonaLabel();

  // Profile dropdown toggle — uses position:fixed positioned via JS so the
  // dropdown escapes the chat-container's overflow:hidden boundary.
  const profileTrigger = document.getElementById('profileTrigger');
  const profileDropdown = document.getElementById('profileDropdown');
  const profileMenu = document.getElementById('profileMenu');

  function openProfileDropdown() {
    const rect = profileTrigger.getBoundingClientRect();
    profileDropdown.style.top = (rect.bottom + 8) + 'px';
    profileDropdown.style.right = (window.innerWidth - rect.right) + 'px';
    profileDropdown.classList.add('open');
    profileTrigger.setAttribute('aria-expanded', 'true');
  }

  function closeProfileDropdown() {
    profileDropdown.classList.remove('open');
    profileTrigger.setAttribute('aria-expanded', 'false');
  }

  profileTrigger.addEventListener('click', function (e) {
    e.stopPropagation();
    profileDropdown.classList.contains('open') ? closeProfileDropdown() : openProfileDropdown();
  });

  // Close when clicking outside the menu.
  document.addEventListener('click', function (e) {
    if (!profileMenu.contains(e.target)) closeProfileDropdown();
  });

  // Attach menu ("+") — consolidates image + document attachment into a single
  // ChatGPT-style trigger; mirrors the profileTrigger/profileDropdown open/close
  // pattern above, but opens upward since the trigger lives in the bottom toolbar.
  const attachMenuBtn = document.getElementById('attachMenuBtn');
  const attachMenuDropdown = document.getElementById('attachMenuDropdown');
  const attachMenu = document.getElementById('attachMenu');

  function openAttachMenu() {
    const rect = attachMenuBtn.getBoundingClientRect();
    attachMenuDropdown.style.bottom = (window.innerHeight - rect.top + 8) + 'px';
    attachMenuDropdown.style.left = rect.left + 'px';
    attachMenuDropdown.classList.add('open');
    attachMenuBtn.setAttribute('aria-expanded', 'true');
  }

  function closeAttachMenu() {
    attachMenuDropdown.classList.remove('open');
    attachMenuBtn.setAttribute('aria-expanded', 'false');
  }

  attachMenuBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    attachMenuDropdown.classList.contains('open') ? closeAttachMenu() : openAttachMenu();
  });

  document.addEventListener('click', function (e) {
    if (!attachMenu.contains(e.target)) closeAttachMenu();
  });

  // Close all panels on Escape; trap Tab focus inside whichever panel is open.
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      closeProfileDropdown();
      closePersonaPanel();
      closeAttachMenu();
    }
    if (e.key === 'Tab') {
      if (personaPanel.classList.contains('open')) _trapFocus(personaPanel, e);
      if (profileDropdown.classList.contains('open')) _trapFocus(profileDropdown, e);
      if (attachMenuDropdown.classList.contains('open')) _trapFocus(attachMenuDropdown, e);
    }
  });

  // Close open panels on resize — their fixed positions were calculated at open
  // time and become stale as soon as the viewport dimensions change.
  window.addEventListener('resize', function () {
    if (personaPanel.classList.contains('open')) closePersonaPanel();
    if (profileDropdown.classList.contains('open')) closeProfileDropdown();
    if (attachMenuDropdown.classList.contains('open')) closeAttachMenu();
  });

  // Close the dropdown after each menu-item action (before any confirm dialogs).
  ['saveBtn', 'exportMdBtn', 'openBtn', 'clearBtn', 'closeBtn'].forEach(function (id) {
    document.getElementById(id).addEventListener('click', closeProfileDropdown);
  });

  loadVoices();

  // Sync JS state with whichever option is marked selected in the HTML
  const select = document.getElementById('systemPromptSelect');

  // English Editor output mode — only meaningful for the English Editor persona.
  // 'clean'/'changes' use the silent prompt (the 'changes' tracked-changes view
  // is derived client-side from that output); 'explain' swaps in the
  // change-explaining prompt variant.
  const editorModeSelect = document.getElementById('editorModeSelect');
  const editorModeRow = document.getElementById('editorModeRow');

  function _updateEditorModeVisibility() {
    editorModeRow.style.display = select.value === 'englishEditor' ? '' : 'none';
  }

  // Migrate the pre-1.18.0 boolean `editorExplainChanges` flag the first time
  // the app loads after this upgrade, then never look at it again.
  const _hadEditorMode = localStorage.getItem(EDITOR_MODE_KEY) !== null;
  const _legacyEditorExplain = localStorage.getItem('editorExplainChanges');
  currentEditorMode = migrateEditorModeValue(
    localStorage.getItem(EDITOR_MODE_KEY),
    _legacyEditorExplain
  );
  if (!_hadEditorMode && _legacyEditorExplain !== null) {
    localStorage.setItem(EDITOR_MODE_KEY, currentEditorMode);
    localStorage.removeItem('editorExplainChanges');
  }
  editorModeSelect.value = currentEditorMode;

  editorModeSelect.addEventListener('change', function () {
    currentEditorMode = this.value;
    localStorage.setItem(EDITOR_MODE_KEY, this.value);
    if (select.value === 'englishEditor') {
      currentSystemPrompt = _resolveSystemPrompt('englishEditor');
    }
  });
  _updateEditorModeVisibility();

  currentSystemPrompt = _resolveSystemPrompt(select.value);
  updateSystemPromptState();

  // Per-persona settings memory — load the store and record the starting persona.
  _personaPrefsJson = localStorage.getItem(PERSONA_PREFS_KEY) || '{}';
  _activePersonaKey = select.value;

  // Restore autoTTS preference across sessions
  const autoTTSBtn = document.getElementById('autoTTSBtn');
  if ('speechSynthesis' in window && localStorage.getItem('autoTTS') === 'true') {
    autoTTSBtn.classList.add('tts-on');
    autoTTSBtn.setAttribute('aria-pressed', 'true');
  }
  autoTTSBtn.addEventListener('click', function () {
    const isOn = this.classList.toggle('tts-on');
    this.setAttribute('aria-pressed', String(isOn));
    localStorage.setItem('autoTTS', String(isOn));
  });

  // TTS engine selector (Browser vs VoiceBox) — applies to both auto-TTS and
  // the per-message speak button; persisted to localStorage like autoTTS.
  const ttsEngineSelect = document.getElementById('ttsEngineSelect');
  _setTTSUI(localStorage.getItem('ttsEngine') || 'voicebox');
  ttsEngineSelect.addEventListener('change', function () {
    _setTTSUI(this.value);
    localStorage.setItem('ttsEngine', this.value);
    _persistPersonaPref({ ttsEngine: this.value });
  });

  // Chat input
  const userInput = document.getElementById('userInput');
  userInput.maxLength = MAX_INPUT_LENGTH;
  // Enter sends; Shift+Enter inserts a newline (textarea default behaviour).
  userInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  // Character counter — appears below 500 chars remaining, warns at 200, danger at 50
  const charCounter = document.getElementById('charCounter');
  userInput.addEventListener('input', function () {
    this.style.height = 'auto';
    this.style.height = this.scrollHeight + 'px';
    // Enable send if there is text OR a pending image attachment
    document.getElementById('sendBtn').disabled = this.value.trim().length === 0 && !pendingImageBase64;
    const remaining = MAX_INPUT_LENGTH - this.value.length;
    const show = remaining <= CHAR_COUNTER_SHOW_THRESHOLD;
    charCounter.textContent = show ? `${remaining}` : '';
    charCounter.classList.toggle('visible', show);
    charCounter.classList.toggle('warning', remaining <= CHAR_COUNTER_WARNING_THRESHOLD && remaining > CHAR_COUNTER_DANGER_THRESHOLD);
    charCounter.classList.toggle('danger', remaining <= CHAR_COUNTER_DANGER_THRESHOLD);
  });

  document.getElementById('sendBtn').addEventListener('click', sendMessage);
  document.getElementById('stopBtn').addEventListener('click', stopStreaming);

  // Header controls (now inside the profile dropdown)
  document.getElementById('saveBtn').addEventListener('click', saveChat);
  document.getElementById('exportMdBtn').addEventListener('click', exportChatAsMarkdown);
  document.getElementById('openBtn').addEventListener('click', openChat);
  document.getElementById('clearBtn').addEventListener('click', clearChat);
  document.getElementById('closeBtn').addEventListener('click', closeWindow);

  // Persona selector: run existing logic first (may revert selection on cancel),
  // then update the header label and close the panel with the final value.
  document.getElementById('systemPromptSelect').addEventListener('change', updateSystemPrompt);
  document.getElementById('systemPromptSelect').addEventListener('change', function () {
    // Save the persona being left, then restore the one being entered.
    _persistPersonaPref(_snapshotPersonaSettings());
    _activePersonaKey = this.value;
    _applyPersonaSettings(readPersonaPref(_personaPrefsJson, _activePersonaKey));
    _updateEditorModeVisibility();
  });
  document.getElementById('systemPromptSelect').addEventListener('change', function () {
    _applyCurrentPersonaLabel();
    closePersonaPanel();
  });

  // Voice controls
  document.getElementById('micBtn').addEventListener('click', toggleSpeechRecognition);
  document.getElementById('speakerBtn').addEventListener('click', stopSpeaking);

  // File open
  document.getElementById('openInput').addEventListener('change', handleOpenFile);

  // Attach menu items — each opens its hidden file input then closes the menu.
  const imageInput = document.getElementById('imageInput');
  const documentInput = document.getElementById('documentInput');

  document.getElementById('addImageMenuItem').addEventListener('click', function () {
    closeAttachMenu();
    imageInput.click();
  });

  document.getElementById('addFileMenuItem').addEventListener('click', function () {
    closeAttachMenu();
    documentInput.click();
  });

  // Image attachment — validates size/type, reads as data URL, shows preview strip.
  const imagePreviewStrip = document.getElementById('imagePreviewStrip');
  const imagePreviewThumb = document.getElementById('imagePreviewThumb');

  imageInput.addEventListener('change', function () {
    const file = this.files && this.files[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
      alert('Please select an image file (JPEG, PNG, GIF, WebP, etc.).');
      this.value = '';
      return;
    }

    if (file.size > MAX_IMAGE_SIZE_BYTES) {
      alert(`Image too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Maximum is ${MAX_IMAGE_SIZE_BYTES / 1024 / 1024} MB.`);
      this.value = '';
      return;
    }

    const reader = new FileReader();
    reader.onload = function (e) {
      const dataUrl = e.target.result;
      // Resize to ≤1024px before encoding for Ollama. Large images overflow
      // gemma3:4b's context window (causing HTTP 500). The resized JPEG is used
      // for both the thumbnail and the API — no need to hold the original in memory.
      const img = new Image();
      img.onload = function () {
        const MAX_DIM = 1024;
        const { w, h } = calcResizeDims(img.naturalWidth, img.naturalHeight, MAX_DIM);
        const wasResized = w !== img.naturalWidth || h !== img.naturalHeight;
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff'; // white fill for transparent PNG areas
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        const resizedDataUrl = canvas.toDataURL('image/jpeg', 0.85);

        pendingImageDataUrl = resizedDataUrl;               // resized: thumbnail + history
        pendingImageBase64 = resizedDataUrl.split(',')[1];  // resized JPEG: Ollama API

        imagePreviewThumb.src = resizedDataUrl;
        imagePreviewStrip.style.display = 'flex';
        _updateAttachMenuActiveState();
        document.getElementById('sendBtn').disabled = false;
        if (wasResized) showToast(`Image scaled to ${w}×${h} for analysis`);
      };
      img.src = dataUrl;
    };
    reader.readAsDataURL(file);
    this.value = ''; // reset so the same file can be re-selected
  });

  document.getElementById('removeImageBtn').addEventListener('click', clearImagePreview);

  // Document attachment — validates size/extension, extracts text (.txt/.md
  // read client-side; .pdf sent to the doc-extract service), shows preview strip.
  const documentPreviewStrip = document.getElementById('documentPreviewStrip');
  const documentPreviewName = document.getElementById('documentPreviewName');

  documentInput.addEventListener('change', async function () {
    const file = this.files && this.files[0];
    if (!file) return;
    this.value = ''; // reset so the same file can be re-selected

    const lowerName = file.name.toLowerCase();
    const isPdf = lowerName.endsWith('.pdf');
    const isPlainText = lowerName.endsWith('.txt') || lowerName.endsWith('.md') || lowerName.endsWith('.markdown');
    if (!isPdf && !isPlainText) {
      alert('Please select a .txt, .md, or .pdf file.');
      return;
    }

    if (file.size > MAX_DOCUMENT_UPLOAD_BYTES) {
      alert(`File too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Maximum is ${MAX_DOCUMENT_UPLOAD_BYTES / 1024 / 1024} MB.`);
      return;
    }

    attachMenuBtn.disabled = true;
    documentPreviewName.textContent = `Extracting text from ${file.name}…`;
    documentPreviewStrip.style.display = 'flex';

    try {
      let rawText;
      if (isPlainText) {
        rawText = await file.text();
      } else {
        const formData = new FormData();
        formData.append('file', file);
        const response = await fetch(DOC_EXTRACT_URL, { method: 'POST', body: formData });
        const data = await response.json();
        if (!response.ok || !data.ok) {
          throw new Error(data.error || 'Could not extract text from this PDF.');
        }
        rawText = data.text;
      }

      if (!rawText || !rawText.trim()) {
        throw new Error('No readable text found in this file (a scanned/image-only PDF has no extractable text).');
      }

      const { text, truncated } = truncateDocumentText(rawText, MAX_DOCUMENT_TEXT_CHARS);
      pendingDocumentText = text;
      pendingDocumentName = file.name;
      pendingDocumentTruncated = truncated;

      documentPreviewName.textContent = `${file.name} (${text.length.toLocaleString()} chars${truncated ? ', truncated' : ''})`;
      _updateAttachMenuActiveState();
      document.getElementById('sendBtn').disabled = false;
      if (truncated) showToast(`${file.name} was long — using the first ${MAX_DOCUMENT_TEXT_CHARS.toLocaleString()} characters`);
    } catch (err) {
      console.error('Document extraction failed:', err);
      showToast(err.message || 'Could not read this file.');
      clearDocumentPreview();
    } finally {
      attachMenuBtn.disabled = false;
    }
  });

  document.getElementById('removeDocumentBtn').addEventListener('click', clearDocumentPreview);

  // Thinking mode — toggle ON/OFF; when ON show depth selector and update global.
  const thinkingModeBtn = document.getElementById('thinkingModeBtn');
  const thinkingDepthSelect = document.getElementById('thinkingDepthSelect');

  thinkingModeBtn.addEventListener('click', function () {
    const isOn = !this.classList.contains('thinking-on');
    _setThinkingUI(isOn, thinkingDepthSelect.value);
    localStorage.setItem('thinkingOn', String(isOn));
    _persistPersonaPref({ thinkingOn: isOn, thinkingDepth: thinkingDepthSelect.value });
  });

  thinkingDepthSelect.addEventListener('change', function () {
    _setThinkingUI(thinkingModeBtn.classList.contains('thinking-on'), this.value);
    localStorage.setItem('thinkingDepth', this.value);
    _persistPersonaPref({
      thinkingOn: thinkingModeBtn.classList.contains('thinking-on'),
      thinkingDepth: this.value,
    });
  });

  // Restore thinking mode preference across sessions (mirrors autoTTS persistence).
  _setThinkingUI(
    localStorage.getItem('thinkingOn') === 'true',
    localStorage.getItem('thinkingDepth') || 'medium'
  );

  // Per-persona settings win over the global restore above when present for the
  // persona that's active on load.
  _applyPersonaSettings(readPersonaPref(_personaPrefsJson, _activePersonaKey));
});
