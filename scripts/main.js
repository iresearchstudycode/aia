// main.js - Initialization and event handlers

// Initialization code
document.addEventListener('DOMContentLoaded', function() {
  // Load voices initially
  loadVoices();

  // Set default system prompt in selector
  const select = document.getElementById('systemPromptSelect');
  select.value = 'quickwrite'; // Match the default currentSystemPrompt in config.js
  currentSystemPrompt = systemPrompts[select.value]; // Keep JS prompt state in sync with selector

  // Update system prompt state initially
  updateSystemPromptState();

  // Enter key to send
  document.getElementById('userInput').addEventListener('keypress', function (e) {
    if (e.key === 'Enter') {
      sendMessage();
    }
  });
});