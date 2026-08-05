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
    activeSpeakBtn.innerHTML = SPEAK_ICON;
    activeSpeakBtn.title = 'Speak this response';
    activeSpeakBtn.setAttribute('aria-label', 'Speak this response');
    activeSpeakBtn.setAttribute('aria-pressed', 'false');
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
      document.getElementById('micBtn').setAttribute('aria-pressed', 'false');
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
      document.getElementById('micBtn').setAttribute('aria-pressed', 'false');
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
    const el = document.getElementById('autoTTSBtn');
    if (el) { el.disabled = true; el.classList.remove('tts-on'); el.setAttribute('aria-pressed', 'false'); }
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
    document.getElementById('micBtn').setAttribute('aria-pressed', 'false');

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
    document.getElementById('micBtn').setAttribute('aria-pressed', 'true');
  }
}

// Text to Speech function — routes to the browser's Web Speech API or the
// VoiceBox proxy depending on currentTTSEngine (config.js / ttsEngineSelect).
function speakText(text, sourceBtn) {
  if (currentTTSEngine === 'voicebox') {
    speakTextViaVoicebox(text, sourceBtn);
    return;
  }
  speakTextViaBrowser(text, sourceBtn);
}

function speakTextViaBrowser(text, sourceBtn) {
  if (!('speechSynthesis' in window)) {
    return;
  }

  // Stop any ongoing speech (also resets the previous activeSpeakBtn)
  stopSpeaking();

  // Wire the per-message button that triggered this call
  activeSpeakBtn = sourceBtn || null;
  if (activeSpeakBtn) {
    activeSpeakBtn.innerHTML = STOP_ICON;
    activeSpeakBtn.title = 'Stop speaking';
    activeSpeakBtn.setAttribute('aria-label', 'Stop speaking');
    activeSpeakBtn.setAttribute('aria-pressed', 'true');
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

  const cleanText = stripMarkdownForSpeech(text);

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

// Shared <audio> element used only to replay a cached VoiceBox generation —
// created lazily so pages that never touch VoiceBox don't pay for it. A
// *fresh* generation is played by Voicebox itself through the host's
// speakers (no audio element involved); this element only ever plays back
// clips VoiceBox already generated earlier, fetched via GET /voicebox/audio/{id}.
let voiceboxAudio = null;

function getVoiceboxAudio() {
  if (!voiceboxAudio) {
    voiceboxAudio = new Audio();
    voiceboxAudio.addEventListener('ended', onVoiceboxAudioFinished);
    voiceboxAudio.addEventListener('error', onVoiceboxAudioFinished);
  }
  return voiceboxAudio;
}

function onVoiceboxAudioFinished() {
  isSpeaking = false;
  resetActiveSpeakBtn();
  document.getElementById('speakerBtn').style.display = 'none';
  document.getElementById('speakerBtn').classList.remove('speaking');
}

// Play a cached VoiceBox generation and wire up real stop/speaking state —
// unlike a fresh generation (which VoiceBox plays itself with no signal back
// to this page), a cache hit is played entirely by this page, so it can be
// stopped like the browser engine can.
function playVoiceboxAudio(audioUrl, sourceBtn) {
  const audio = getVoiceboxAudio();
  const speakerBtn = document.getElementById('speakerBtn');

  activeSpeakBtn = sourceBtn || null;
  if (activeSpeakBtn) {
    activeSpeakBtn.innerHTML = STOP_ICON;
    activeSpeakBtn.title = 'Stop speaking';
    activeSpeakBtn.setAttribute('aria-label', 'Stop speaking');
    activeSpeakBtn.setAttribute('aria-pressed', 'true');
    activeSpeakBtn.classList.add('speaking');
  }

  isSpeaking = true;
  speakerBtn.style.display = 'flex';
  speakerBtn.classList.add('speaking');

  audio.src = audioUrl;
  audio.play().catch(function () {
    onVoiceboxAudioFinished();
    showToast('Could not play VoiceBox audio.');
  });
}

// Speak text through the VoiceBox proxy (POST /voicebox/speak, gated by the
// session cookie like every other authenticated route). The request stays
// pending for the whole synthesis duration on a cache miss, so its pending
// state doubles as the "generating" indicator — the button (or the header
// speaker icon, for auto-TTS with no button) shows a spinner until it
// resolves. A fresh generation is played by VoiceBox itself through the
// host's speakers; a cache hit is replayed by this page via
// playVoiceboxAudio(), which does support a real stop control.
function speakTextViaVoicebox(text, sourceBtn) {
  stopSpeaking(); // stop any in-progress browser speech or cached VoiceBox playback

  const cleanText = stripMarkdownForSpeech(text);
  if (!cleanText.trim()) return;

  const btn = sourceBtn || null;
  const speakerBtn = document.getElementById('speakerBtn');

  if (btn) {
    btn.disabled = true;
    btn.innerHTML = SPINNER_ICON;
    btn.classList.add('generating');
    btn.title = 'Generating voice…';
    btn.setAttribute('aria-label', 'Generating voice');
  }
  speakerBtn.style.display = 'flex';
  speakerBtn.classList.add('generating');

  fetch(VOICEBOX_SPEAK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: cleanText })
  })
    .then(function (response) {
      if (!response.ok) throw new Error('Voicebox request failed');
      return response.json();
    })
    .then(function (data) {
      if (btn) {
        btn.disabled = false;
        btn.classList.remove('generating');
      }
      speakerBtn.classList.remove('generating');

      if (data.cached) {
        playVoiceboxAudio(data.audio_url, btn);
        return;
      }

      // Fresh generation — VoiceBox already played it through the host
      // speakers, so there is nothing left for this page to play.
      speakerBtn.style.display = 'none';
      if (btn) {
        btn.innerHTML = CHECK_ICON;
        btn.title = 'Sent to VoiceBox';
        setTimeout(function () {
          btn.innerHTML = SPEAK_ICON;
          btn.title = 'Speak this response';
          btn.setAttribute('aria-label', 'Speak this response');
        }, 1500);
      }
    })
    .catch(function () {
      if (btn) {
        btn.disabled = false;
        btn.classList.remove('generating');
        btn.innerHTML = SPEAK_ICON;
        btn.title = 'Speak this response';
        btn.setAttribute('aria-label', 'Speak this response');
      }
      speakerBtn.classList.remove('generating');
      speakerBtn.style.display = 'none';
      showToast('VoiceBox is unavailable — check the Voicebox app is running');
    });
}

// Stop speaking function
function stopSpeaking() {
  resetActiveSpeakBtn();
  if ('speechSynthesis' in window && speechSynthesis.speaking) {
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
  if (voiceboxAudio && !voiceboxAudio.paused) {
    voiceboxAudio.pause();
    voiceboxAudio.currentTime = 0;
  }
  isSpeaking = false;
  document.getElementById('speakerBtn').style.display = 'none';
  document.getElementById('speakerBtn').classList.remove('speaking', 'generating');
  currentUtterance = null;
}