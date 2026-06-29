// main.js - Initialization and event handlers

document.addEventListener('DOMContentLoaded', function () {
  loadVoices();

  // Sync JS state with whichever option is marked selected in the HTML
  const select = document.getElementById('systemPromptSelect');
  currentSystemPrompt = systemPrompts[select.value];
  updateSystemPromptState();

  // Restore autoTTS preference across sessions
  const autoTTS = document.getElementById('autoTTS');
  autoTTS.checked = localStorage.getItem('autoTTS') === 'true';
  autoTTS.addEventListener('change', function () {
    localStorage.setItem('autoTTS', this.checked);
  });

  // Chat input
  const userInput = document.getElementById('userInput');
  userInput.addEventListener('keypress', function (e) {
    if (e.key === 'Enter') sendMessage();
  });

  // Character counter — appears below 500 chars remaining, warns at 200, danger at 50
  const charCounter = document.getElementById('charCounter');
  userInput.addEventListener('input', function () {
    const remaining = 4000 - this.value.length;
    const show = remaining <= 500;
    charCounter.textContent = show ? `${remaining}` : '';
    charCounter.classList.toggle('visible', show);
    charCounter.classList.toggle('warning', remaining <= 200 && remaining > 50);
    charCounter.classList.toggle('danger', remaining <= 50);
  });

  document.getElementById('sendBtn').addEventListener('click', sendMessage);
  document.getElementById('stopBtn').addEventListener('click', stopStreaming);

  // Header controls
  document.getElementById('saveBtn').addEventListener('click', saveChat);
  document.getElementById('openBtn').addEventListener('click', openChat);
  document.getElementById('clearBtn').addEventListener('click', clearChat);
  document.getElementById('closeBtn').addEventListener('click', closeWindow);

  // System prompt selector
  document.getElementById('systemPromptSelect').addEventListener('change', updateSystemPrompt);

  // Voice controls
  document.getElementById('micBtn').addEventListener('click', toggleSpeechRecognition);
  document.getElementById('speakerBtn').addEventListener('click', stopSpeaking);

  // File open
  document.getElementById('openInput').addEventListener('change', handleOpenFile);
});
