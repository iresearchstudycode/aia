// main.js - Initialization and event handlers

document.addEventListener('DOMContentLoaded', function () {
  loadVoices();

  // Sync JS state with whichever option is marked selected in the HTML
  const select = document.getElementById('systemPromptSelect');
  currentSystemPrompt = systemPrompts[select.value];
  updateSystemPromptState();

  // Chat input
  document.getElementById('userInput').addEventListener('keypress', function (e) {
    if (e.key === 'Enter') sendMessage();
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
