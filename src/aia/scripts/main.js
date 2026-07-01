// main.js - Initialization and event handlers

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

  // Close both panels on Escape.
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') {
      closeProfileDropdown();
      closePersonaPanel();
    }
  });

  // Close open panels on resize — their fixed positions were calculated at open
  // time and become stale as soon as the viewport dimensions change.
  window.addEventListener('resize', function () {
    if (personaPanel.classList.contains('open')) closePersonaPanel();
    if (profileDropdown.classList.contains('open')) closeProfileDropdown();
  });

  // Close the dropdown after each menu-item action (before any confirm dialogs).
  ['saveBtn', 'openBtn', 'clearBtn', 'closeBtn'].forEach(function (id) {
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
      alert(`Image too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Maximum is 10 MB.`);
      this.value = '';
      return;
    }

    const reader = new FileReader();
    reader.onload = function (e) {
      const dataUrl = e.target.result;
      pendingImageDataUrl = dataUrl;
      // Strip the "data:<mime>;base64," prefix — Ollama expects raw base64.
      pendingImageBase64 = dataUrl.split(',')[1];

      imagePreviewThumb.src = dataUrl;
      imagePreviewStrip.style.display = 'flex';
      attachImageBtn.classList.add('active');
      document.getElementById('sendBtn').disabled = false;
    };
    reader.readAsDataURL(file);
    this.value = ''; // reset so the same file can be re-selected
  });

  document.getElementById('removeImageBtn').addEventListener('click', clearImagePreview);
});
