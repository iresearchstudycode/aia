// main.js - Initialization and event handlers

// Initialization code
document.addEventListener('DOMContentLoaded', function() {
  // Load voices initially
  loadVoices();

  // Sync JS state with whichever option is marked selected in the HTML
  const select = document.getElementById('systemPromptSelect');
  currentSystemPrompt = systemPrompts[select.value];

  // Update system prompt state initially
  updateSystemPromptState();

  // Enter key to send
  document.getElementById('userInput').addEventListener('keypress', function (e) {
    if (e.key === 'Enter') {
      sendMessage();
    }
  });
});