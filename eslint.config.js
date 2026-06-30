const js = require('@eslint/js');
const globals = require('globals');

// All scripts share the window scope (no module bundler). Globals declared here
// prevent false no-undef positives for names defined in other script files.
const crossModuleGlobals = {
  // config.js — constants
  MODEL_NAME: 'readonly',
  OLLAMA_API_URL: 'readonly',
  MAX_HISTORY_MESSAGES: 'readonly',
  MAX_INPUT_LENGTH: 'readonly',
  MAX_UPLOAD_FILE_BYTES: 'readonly',
  SILENCE_TIMEOUT_MS: 'readonly',
  CHAR_COUNTER_SHOW_THRESHOLD: 'readonly',
  CHAR_COUNTER_WARNING_THRESHOLD: 'readonly',
  CHAR_COUNTER_DANGER_THRESHOLD: 'readonly',
  SPEECH_RECOGNITION_LANG: 'readonly',
  systemPrompts: 'readonly',
  // config.js — mutable state
  conversationHistory: 'writable',
  currentSystemPrompt: 'writable',
  // utils.js
  formatTimestamp: 'readonly',
  escapeHtml: 'readonly',
  // speech.js — functions
  loadVoices: 'readonly',
  toggleSpeechRecognition: 'readonly',
  speakText: 'readonly',
  stopSpeaking: 'readonly',
  // speech.js — mutable state accessed cross-module
  recognition: 'readonly',
  isRecording: 'writable',
  silenceTimer: 'writable',
  accumulatedTranscript: 'writable',
  isSpeaking: 'writable',
  // chat.js
  updateSystemPromptState: 'readonly',
  addUserMessage: 'readonly',
  addAIMessagePlaceholder: 'readonly',
  addContextTrimNotice: 'readonly',
  clearChat: 'readonly',
  closeWindow: 'readonly',
  updateSystemPrompt: 'readonly',
  sendMessage: 'readonly',
  sendMessageAndContinueListening: 'readonly',
  saveChat: 'readonly',
  openChat: 'readonly',
  renderConversationHistory: 'readonly',
  handleOpenFile: 'readonly',
  // api.js
  streamOllamaResponse: 'readonly',
  stopStreaming: 'readonly',
  // vendored libraries (loaded before app scripts)
  marked: 'readonly',
  DOMPurify: 'readonly',
};

module.exports = [
  {
    files: ['src/aia/scripts/*.js'],
    ignores: ['**/*.min.js'],
    ...js.configs.recommended,
    languageOptions: {
      ecmaVersion: 2021,
      sourceType: 'script',
      globals: {
        ...globals.browser,
        ...crossModuleGlobals,
      },
    },
    rules: {
      // console.error / console.warn are used intentionally throughout
      'no-console': 'off',
      // Top-level names are exported to window for use by other scripts;
      // only flag unused variables that are local to a function.
      'no-unused-vars': ['error', { vars: 'local', args: 'after-used' }],
    },
  },
];
