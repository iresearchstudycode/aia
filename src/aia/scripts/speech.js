// speech.js - Speech recognition and synthesis functions

// Speech recognition
let recognition = null;
let isRecording = false;
let silenceTimer = null;
let accumulatedTranscript = '';

// Text to speech
let currentUtterance = null;
let isSpeaking = false;
let availableVoices = [];
let activeSpeakBtn = null;

function resetActiveSpeakBtn() {
  if (activeSpeakBtn) {
    activeSpeakBtn.textContent = '🔊 Speak';
    activeSpeakBtn.classList.remove('speaking');
    activeSpeakBtn = null;
  }
}

// Initialize speech recognition
if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  recognition = new SpeechRecognition();
  recognition.continuous = true; // Keep listening continuously
  recognition.interimResults = true; // Get interim results to detect pauses
  recognition.lang = SPEECH_RECOGNITION_LANG;

  recognition.onresult = (event) => {
    // Clear the silence timer since we received speech
    if (silenceTimer) {
      clearTimeout(silenceTimer);
      silenceTimer = null;
    }

    // Build the full transcript from all results
    let finalTranscript = '';
    let interimTranscript = '';

    for (let i = event.resultIndex; i < event.results.length; i++) {
      const transcript = event.results[i][0].transcript;
      if (event.results[i].isFinal) {
        finalTranscript += transcript + ' ';
      } else {
        interimTranscript += transcript;
      }
    }

    // Update accumulated transcript with final results
    if (finalTranscript) {
      accumulatedTranscript += finalTranscript;
    }

    // Check for "stop listening" command
    const fullText = (accumulatedTranscript + interimTranscript).toLowerCase().trim();
    if (fullText.includes('stop listening') || fullText.includes('stop recording')) {
      recognition.stop();
      isRecording = false;
      document.getElementById('micBtn').classList.remove('recording');
      document.getElementById('micBtn').classList.remove('paused');
      if (silenceTimer) {
        clearTimeout(silenceTimer);
        silenceTimer = null;
      }
      accumulatedTranscript = '';
      const stopInput = document.getElementById('userInput');
      stopInput.value = '';
      stopInput.dispatchEvent(new Event('input'));
      return;
    }

    // Show current transcript in input field (accumulated + interim)
    const userInput = document.getElementById('userInput');
    userInput.value = (accumulatedTranscript + interimTranscript).trim();
    userInput.dispatchEvent(new Event('input'));

    // Start 3-second silence timer after receiving speech
    if (isRecording) {
      silenceTimer = setTimeout(() => {
        // 3 seconds of silence - send the message
        if (accumulatedTranscript.trim()) {
          sendMessageAndContinueListening();
        }
      }, SILENCE_TIMEOUT_MS);
    }
  };

  recognition.onerror = (event) => {
    console.error('Speech recognition error:', event.error);
    if (event.error === 'not-allowed') {
      alert('Microphone access denied. Please allow microphone access in your browser settings.');
    }
    // Don't auto-disable on errors like 'no-speech' - keep listening
    if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
      isRecording = false;
      document.getElementById('micBtn').classList.remove('recording');
      if (silenceTimer) {
        clearTimeout(silenceTimer);
        silenceTimer = null;
      }
      accumulatedTranscript = '';
    }
  };

  recognition.onend = () => {
    // Only restart recognition if we're supposed to be recording AND AI is not speaking
    // This prevents the AI's voice from being captured as input
    if (isRecording && !isSpeaking) {
      try {
        recognition.start();
      } catch (e) {
        console.error('Failed to restart recognition:', e);
      }
    }
  };
} else {
  console.warn('Speech recognition not supported in this browser');
}

// Load available voices — guarded so it is safe to call even when TTS is absent
function loadVoices() {
  if (!('speechSynthesis' in window)) return;
  availableVoices = window.speechSynthesis.getVoices();
}

// Wire onvoiceschanged only when TTS is present; otherwise disable the UI control
// once the DOM is ready (this code runs at parse time, before <body> exists).
if ('speechSynthesis' in window) {
  window.speechSynthesis.onvoiceschanged = loadVoices;
} else {
  console.warn('Text-to-speech not supported in this browser');
  document.addEventListener('DOMContentLoaded', function () {
    const el = document.getElementById('autoTTS');
    if (el) { el.checked = false; el.disabled = true; }
  });
}

// Speech to Text function
function toggleSpeechRecognition() {
  if (!recognition) {
    alert('Speech recognition is not supported in this browser. Please use Chrome, Edge, or Safari.');
    return;
  }

  if (isRecording) {
    // Stop listening and reset
    recognition.stop();
    isRecording = false;
    document.getElementById('micBtn').classList.remove('recording');
    document.getElementById('micBtn').classList.remove('paused');

    // Clear silence timer
    if (silenceTimer) {
      clearTimeout(silenceTimer);
      silenceTimer = null;
    }

    // Reset accumulated transcript
    accumulatedTranscript = '';
  } else {
    // Start continuous listening
    accumulatedTranscript = '';
    const startInput = document.getElementById('userInput');
    startInput.value = '';
    startInput.dispatchEvent(new Event('input'));
    recognition.start();
    isRecording = true;
    document.getElementById('micBtn').classList.add('recording');
    document.getElementById('micBtn').classList.remove('paused');
  }
}

// Text to Speech function
function speakText(text, sourceBtn) {
  if (!('speechSynthesis' in window)) {
    return;
  }

  // Stop any ongoing speech (also resets the previous activeSpeakBtn)
  stopSpeaking();

  // Wire the per-message button that triggered this call
  activeSpeakBtn = sourceBtn || null;
  if (activeSpeakBtn) {
    activeSpeakBtn.textContent = '⏹ Stop';
    activeSpeakBtn.classList.add('speaking');
  }

  // Set speaking flag BEFORE stopping recognition to prevent auto-restart
  isSpeaking = true;

  // Pause speech recognition while AI is speaking to avoid picking up AI voice
  const wasRecording = isRecording;
  if (isRecording) {
    recognition.stop();
    // Keep the recording state and visual indicator
    // Show paused state on microphone button
    document.getElementById('micBtn').classList.remove('recording');
    document.getElementById('micBtn').classList.add('paused');
  }

  // Remove markdown formatting for better speech
  const cleanText = text
    .replace(/[#*`_~]/g, '')
    .replace(/\[([^\]]+)\]\([^\)]+\)/g, '$1')
    .replace(/```[\s\S]*?```/g, 'code block')
    .replace(/\n+/g, '. ');

  // Select a specific voice
  const aussieVoice = availableVoices.find(voice =>
    voice.name.includes('Microsoft Catherine')
  );
  currentUtterance = new SpeechSynthesisUtterance(cleanText);
  currentUtterance.rate = 1.5;
  currentUtterance.pitch = 1.0;
  currentUtterance.volume = 1.0;
  currentUtterance.voice = aussieVoice || availableVoices[0];

  currentUtterance.onstart = () => {
    // Already set above, but reinforce it
    isSpeaking = true;
    document.getElementById('speakerBtn').style.display = 'flex';
    document.getElementById('speakerBtn').classList.add('speaking');
  };

  currentUtterance.onend = () => {
    isSpeaking = false;
    resetActiveSpeakBtn();
    document.getElementById('speakerBtn').style.display = 'none';
    document.getElementById('speakerBtn').classList.remove('speaking');
    currentUtterance = null;

    // Resume speech recognition if it was active before AI started speaking
    if (wasRecording && isRecording) {
      document.getElementById('micBtn').classList.remove('paused');
      document.getElementById('micBtn').classList.add('recording');
      try {
        recognition.start();
      } catch (e) {
        console.error('Failed to resume recognition after TTS:', e);
      }
    }
  };

  currentUtterance.onerror = () => {
    isSpeaking = false;
    resetActiveSpeakBtn();
    document.getElementById('speakerBtn').style.display = 'none';
    document.getElementById('speakerBtn').classList.remove('speaking');
    currentUtterance = null;

    // Resume speech recognition if it was active before AI started speaking
    if (wasRecording && isRecording) {
      document.getElementById('micBtn').classList.remove('paused');
      document.getElementById('micBtn').classList.add('recording');
      try {
        recognition.start();
      } catch (e) {
        console.error('Failed to resume recognition after TTS error:', e);
      }
    }
  };

  speechSynthesis.speak(currentUtterance);
}

// Stop speaking function
function stopSpeaking() {
  resetActiveSpeakBtn();
  if (speechSynthesis.speaking) {
    speechSynthesis.cancel();

    // Resume speech recognition if it was active before stopping
    if (isRecording && !isSpeaking) {
      document.getElementById('micBtn').classList.remove('paused');
      document.getElementById('micBtn').classList.add('recording');
      try {
        recognition.start();
      } catch (e) {
        console.error('Failed to resume recognition after stopping TTS:', e);
      }
    }
  }
  isSpeaking = false;
  document.getElementById('speakerBtn').style.display = 'none';
  document.getElementById('speakerBtn').classList.remove('speaking');
  currentUtterance = null;
}