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

// --- Consolidated settings ------------------------------------------------------
// The 11 persona keys (must match config.js `systemPrompts` minus
// `englishEditorExplained` and the spec's contract).
const _PERSONA_KEYS = [
  'assistant', 'casual', 'claudePromptCompressor', 'creative', 'englishEditor',
  'legal', 'medical', 'professional', 'teacher', 'technical', 'transcriptai'
];

// A defaults-shaped `window.vpalSettings` built entirely from config.js
// constants — used when the settings-service can't be reached on load so the
// app stays fully usable. `__unavailable: true` tells the lightbox (settings.js)
// to render its "can't connect / Retry" state with Save disabled.
function _defaultVpalSettings() {
  const personas = {};
  _PERSONA_KEYS.forEach(function (k) {
    personas[k] = { thinking_enabled: null, thinking_depth: null, tts_engine: null };
  });
  personas.englishEditor.editor_mode = 'clean';

  const global = {
    chat_model: MODEL_NAME,
    vision_model: VISION_MODEL_NAME,
    tts_engine: 'piper',
    auto_speak: false,
    stt_lang: SPEECH_RECOGNITION_LANG,
    thinking_enabled: false,
    thinking_depth: 'medium',
    nav_rail: true,
    active_persona: 'englishEditor'
  };

  return {
    __unavailable: true,
    global: global,
    personas: personas,
    defaults: {
      global: Object.assign({}, global),
      persona: { thinking_enabled: null, thinking_depth: null, tts_engine: null, editor_mode: 'clean' }
    }
  };
}

// One-time migration of the pre-1.23.0 per-preference localStorage keys into the
// settings-service. Guarded by localStorage['settingsMigrated'] === '1'. On a
// successful PUT the legacy keys are removed and the guard is set; a failure is
// swallowed so the next load retries. Re-reads GET /settings into
// window.vpalSettings afterwards so the applied state reflects what was stored.
async function _migrateLegacySettingsIfNeeded() {
  if (localStorage.getItem('settingsMigrated') === '1') return;

  const snapshot = {
    ollamaModel: localStorage.getItem(OLLAMA_MODEL_KEY),
    ttsEngine: localStorage.getItem('ttsEngine'),
    autoTTS: localStorage.getItem('autoTTS'),
    thinkingOn: localStorage.getItem('thinkingOn'),
    thinkingDepth: localStorage.getItem('thinkingDepth'),
    navRailEnabled: localStorage.getItem(NAV_RAIL_KEY),
    editorMode: localStorage.getItem(EDITOR_MODE_KEY),
    personaPrefs: localStorage.getItem(PERSONA_PREFS_KEY)
  };

  const legacyKeys = [
    OLLAMA_MODEL_KEY, 'ttsEngine', 'autoTTS', 'thinkingOn', 'thinkingDepth',
    NAV_RAIL_KEY, EDITOR_MODE_KEY, PERSONA_PREFS_KEY
  ];

  // Nothing stored locally — mark migrated and skip the round-trips.
  const hasAny = Object.keys(snapshot).some(function (k) { return snapshot[k] !== null; });
  if (!hasAny) {
    localStorage.setItem('settingsMigrated', '1');
    return;
  }

  const payload = buildMigrationPayload(snapshot);

  try {
    if (payload.global && Object.keys(payload.global).length) {
      const r = await fetch(SETTINGS_API_URL + '/global', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(payload.global)
      });
      if (!r.ok) throw new Error('migrate global ' + r.status);
    }

    const personas = payload.personas || {};
    for (const key of Object.keys(personas)) {
      if (!personas[key] || !Object.keys(personas[key]).length) continue;
      const r = await fetch(SETTINGS_API_URL + '/persona/' + encodeURIComponent(key), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(personas[key])
      });
      if (!r.ok) throw new Error('migrate persona ' + key + ' ' + r.status);
    }

    legacyKeys.forEach(function (k) { localStorage.removeItem(k); });
    localStorage.setItem('settingsMigrated', '1');

    const fresh = await fetch(SETTINGS_API_URL, { credentials: 'same-origin' });
    if (fresh.ok) window.vpalSettings = await fresh.json();
  } catch (e) {
    console.error('Legacy settings migration failed (will retry next load):', e);
  }
}

document.addEventListener('DOMContentLoaded', async function () {
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

  // --- Settings bootstrap ----------------------------------------------------
  // Build the (hidden) lightbox, hydrate window.vpalSettings from the
  // settings-service, run the one-time legacy-localStorage migration, then apply
  // the resolved values to the runtime globals (currentModel, currentSystemPrompt,
  // currentThinkingMode, currentTTSEngine, currentNavRailEnabled, ...).
  initSettings();

  let _settingsResolved = false;
  try {
    const r = await fetch(SETTINGS_API_URL, { credentials: 'same-origin' });
    if (!r.ok) throw new Error('settings ' + r.status);
    window.vpalSettings = await r.json();
    _settingsResolved = true;
  } catch (e) {
    console.error('Settings service unavailable:', e);
    window.vpalSettings = _defaultVpalSettings();
    showToast('Settings service unavailable — using defaults');
  }

  // Exposed so the lightbox's "Retry" control (settings.js) can re-attempt
  // hydration without a page reload.
  window.__vpalRetrySettings = async function () {
    try {
      const r = await fetch(SETTINGS_API_URL, { credentials: 'same-origin' });
      if (!r.ok) throw new Error('settings ' + r.status);
      window.vpalSettings = await r.json();
      await _migrateLegacySettingsIfNeeded();
      applyResolvedSettings();
      updateSystemPromptState();
      initSettings();
      return true;
    } catch (e) {
      console.error('Settings retry failed:', e);
      showToast('Settings service still unavailable');
      return false;
    }
  };

  if (_settingsResolved) await _migrateLegacySettingsIfNeeded();

  // nav-rail must be wired before applyResolvedSettings() (which calls
  // setNavRailEnabled()).
  initNavRail();

  // Conversation history lightbox (history.js) — builds its hidden DOM into
  // #historyRoot and wires its own search / cards / delete / Escape / focus-trap.
  if (typeof initHistory === 'function') initHistory();

  applyResolvedSettings();
  updateSystemPromptState();

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

  // Settings lightbox entry points — the profile-dropdown item, the persona ▾
  // toggle next to the header title, and the two toolbar status badges.
  const settingsMenuItem = document.getElementById('settingsMenuItem');
  if (settingsMenuItem) {
    settingsMenuItem.addEventListener('click', function () {
      closeProfileDropdown();
      openSettings('models');
    });
  }

  // Conversation history — profile-dropdown item opens the history lightbox.
  const historyMenuItem = document.getElementById('historyMenuItem');
  if (historyMenuItem) {
    historyMenuItem.addEventListener('click', function () {
      closeProfileDropdown();
      if (typeof openHistory === 'function') openHistory();
    });
  }

  const personaToggleBtn = document.getElementById('personaToggleBtn');
  if (personaToggleBtn) {
    personaToggleBtn.addEventListener('click', function (e) {
      e.stopPropagation();
      openSettings('personas');
    });
  }

  const modelBadge = document.getElementById('modelBadge');
  if (modelBadge) {
    modelBadge.addEventListener('click', function () { openSettings('models'); });
  }
  const thinkingBadge = document.getElementById('thinkingBadge');
  if (thinkingBadge) {
    thinkingBadge.addEventListener('click', function () { openSettings('reasoning'); });
  }

  // Global keyboard shortcuts + panel Escape/Tab handling.
  // (The Settings lightbox runs its own focus trap / Escape handling in settings.js.)
  //
  //   Escape            1st: cancel an in-flight stream (Stop button visible)
  //                     2nd: close whichever panel is open (profile / attach menu)
  //                     3rd: return focus to the composer
  //   Ctrl/Cmd + ,      open Settings (Models pane)
  //   Ctrl/Cmd+Shift+O  "New chat" — archives the current conversation, then resets
  //
  // The Ctrl/Cmd combos fire even while the composer is focused; the bare
  // Escape path never disrupts typing (worst case it re-focuses #userInput).
  document.addEventListener('keydown', function (e) {
    var mod = e.ctrlKey || e.metaKey;

    // Ctrl/Cmd + , → Settings. `,` is unshifted; guard against Alt to avoid
    // stealing OS/browser chords.
    if (mod && !e.shiftKey && !e.altKey && e.key === ',') {
      e.preventDefault();
      if (typeof openSettings === 'function') openSettings('models');
      return;
    }

    // Ctrl/Cmd + Shift + O → "New chat" (archive + reset).
    if (mod && e.shiftKey && !e.altKey && (e.key === 'o' || e.key === 'O')) {
      e.preventDefault();
      if (typeof clearChat === 'function') clearChat();
      return;
    }

    if (e.key === 'Escape') {
      // Settings lightbox owns its own Escape — don't double-handle.
      var lightbox = document.getElementById('settingsLightbox');
      if (lightbox && lightbox.classList.contains('open')) return;

      // 1. A stream is running (Stop button is showing) — cancel it.
      var stopBtn = document.getElementById('stopBtn');
      if (stopBtn && stopBtn.offsetParent !== null) {
        if (typeof stopStreaming === 'function') stopStreaming();
        return;
      }

      // 2. A panel is open — close it.
      if (profileDropdown.classList.contains('open') || attachMenuDropdown.classList.contains('open')) {
        closeProfileDropdown();
        closeAttachMenu();
        return;
      }

      // 3. Nothing open or streaming — put the caret back in the composer.
      var input = document.getElementById('userInput');
      if (input && document.activeElement !== input) input.focus();
      return;
    }

    if (e.key === 'Tab') {
      if (profileDropdown.classList.contains('open')) _trapFocus(profileDropdown, e);
      if (attachMenuDropdown.classList.contains('open')) _trapFocus(attachMenuDropdown, e);
    }
  });

  // Close open panels on resize — their fixed positions were calculated at open
  // time and become stale as soon as the viewport dimensions change.
  window.addEventListener('resize', function () {
    if (profileDropdown.classList.contains('open')) closeProfileDropdown();
    if (attachMenuDropdown.classList.contains('open')) closeAttachMenu();
  });

  // Close the dropdown after each menu-item action (before any confirm dialogs).
  ['saveBtn', 'exportMdBtn', 'openBtn', 'clearBtn', 'closeBtn'].forEach(function (id) {
    document.getElementById(id).addEventListener('click', closeProfileDropdown);
  });

  // Best-effort final save of the current conversation when the tab is closing —
  // hcBeaconSave() builds the PUT and ships it via navigator.sendBeacon (history.js).
  window.addEventListener('beforeunload', function () {
    if (typeof hcBeaconSave === 'function') hcBeaconSave();
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
});
