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

// Clears any pending image attachment — resets global state, hides the preview
// strip, and re-evaluates the send button. Called by sendMessage/sendMessageAndContinueListening
// in chat.js before dispatching the request, and by the remove-image button.
function clearImagePreview() {
  pendingImageDataUrl = null;
  pendingImageBase64 = null;
  document.getElementById('imagePreviewStrip').style.display = 'none';
  document.getElementById('imagePreviewThumb').src = '';
  document.getElementById('attachImageBtn').classList.remove('active');
  const textarea = document.getElementById('userInput');
  document.getElementById('sendBtn').disabled = textarea.value.trim().length === 0;
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

  // Close both panels on Escape; trap Tab focus inside whichever panel is open.
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      closeProfileDropdown();
      closePersonaPanel();
    }
    if (e.key === 'Tab') {
      if (personaPanel.classList.contains('open')) _trapFocus(personaPanel, e);
      if (profileDropdown.classList.contains('open')) _trapFocus(profileDropdown, e);
    }
  });

  // Close open panels on resize — their fixed positions were calculated at open
  // time and become stale as soon as the viewport dimensions change.
  window.addEventListener('resize', function () {
    if (personaPanel.classList.contains('open')) closePersonaPanel();
    if (profileDropdown.classList.contains('open')) closeProfileDropdown();
  });

  // Close the dropdown after each menu-item action (before any confirm dialogs).
  ['saveBtn', 'exportMdBtn', 'openBtn', 'clearBtn', 'closeBtn'].forEach(function (id) {
    document.getElementById(id).addEventListener('click', closeProfileDropdown);
  });

  loadVoices();

  // Sync JS state with whichever option is marked selected in the HTML
  const select = document.getElementById('systemPromptSelect');
  currentSystemPrompt = systemPrompts[select.value];
  updateSystemPromptState();

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
    _applyCurrentPersonaLabel();
    closePersonaPanel();
  });

  // Voice controls
  document.getElementById('micBtn').addEventListener('click', toggleSpeechRecognition);
  document.getElementById('speakerBtn').addEventListener('click', stopSpeaking);

  // File open
  document.getElementById('openInput').addEventListener('change', handleOpenFile);

  // Image attachment — validates size/type, reads as data URL, shows preview strip.
  const attachImageBtn = document.getElementById('attachImageBtn');
  const imageInput = document.getElementById('imageInput');
  const imagePreviewStrip = document.getElementById('imagePreviewStrip');
  const imagePreviewThumb = document.getElementById('imagePreviewThumb');

  attachImageBtn.addEventListener('click', function () {
    imageInput.click();
  });

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
        attachImageBtn.classList.add('active');
        document.getElementById('sendBtn').disabled = false;
        if (wasResized) showToast(`Image scaled to ${w}×${h} for analysis`);
      };
      img.src = dataUrl;
    };
    reader.readAsDataURL(file);
    this.value = ''; // reset so the same file can be re-selected
  });

  document.getElementById('removeImageBtn').addEventListener('click', clearImagePreview);

  // Thinking mode — toggle ON/OFF; when ON show depth selector and update global.
  const thinkingModeBtn = document.getElementById('thinkingModeBtn');
  const thinkingDepthSelect = document.getElementById('thinkingDepthSelect');

  thinkingModeBtn.addEventListener('click', function () {
    const isOn = this.classList.toggle('thinking-on');
    this.setAttribute('aria-pressed', String(isOn));
    this.setAttribute('aria-label', isOn ? 'Thinking mode: On' : 'Thinking mode: Off');
    this.title = isOn
      ? 'Thinking mode: On — click to disable'
      : 'Enable thinking mode — model reasons before answering';
    thinkingDepthSelect.style.display = isOn ? 'inline-block' : 'none';
    currentThinkingMode = isOn ? thinkingDepthSelect.value : 'off';
    localStorage.setItem('thinkingOn', String(isOn));
  });

  thinkingDepthSelect.addEventListener('change', function () {
    currentThinkingMode = this.value;
    localStorage.setItem('thinkingDepth', this.value);
  });

  // Restore thinking mode preference across sessions (mirrors autoTTS persistence).
  const savedThinkingDepth = localStorage.getItem('thinkingDepth') || 'medium';
  const savedThinkingOn = localStorage.getItem('thinkingOn') === 'true';
  thinkingDepthSelect.value = savedThinkingDepth;
  if (savedThinkingOn) {
    thinkingModeBtn.classList.add('thinking-on');
    thinkingModeBtn.setAttribute('aria-pressed', 'true');
    thinkingModeBtn.setAttribute('aria-label', 'Thinking mode: On');
    thinkingModeBtn.title = 'Thinking mode: On — click to disable';
    thinkingDepthSelect.style.display = 'inline-block';
    currentThinkingMode = savedThinkingDepth;
  }
});
