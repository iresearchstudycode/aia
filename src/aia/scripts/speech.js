// speech.js - Speech recognition (Web Speech API) and speech synthesis (Piper
// or VoiceBox, via same-origin proxies). No browser Web Speech *synthesis*.

// Speech recognition
let recognition = null;
let isRecording = false;
let silenceTimer = null;
let accumulatedTranscript = '';

// Text to speech
let isSpeaking = false;
let activeSpeakBtn = null;
// Object URL for the current Piper WAV blob — tracked so stopSpeaking() and the
// audio 'ended'/'error' handlers can revoke it and not leak.
let _ttsObjectUrl = null;

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

// Text to Speech function — routes to the Piper proxy (default) or the
// VoiceBox proxy depending on currentTTSEngine (config.js / ttsEngineSelect).
function speakText(text, sourceBtn) {
  if (currentTTSEngine === 'voicebox') {
    speakTextViaVoicebox(text, sourceBtn);
    return;
  }
  speakTextViaPiper(text, sourceBtn);
}

// Pause speech recognition (if active) while the AI is speaking, so the mic
// doesn't pick up the synthesised audio playing through the system output.
function _pauseRecognitionForSpeech() {
  if (isRecording) {
    recognition.stop();
    document.getElementById('micBtn').classList.remove('recording');
    document.getElementById('micBtn').classList.add('paused');
  }
}

// Resume speech recognition after speech ends, if it was left in the paused
// (recording-but-stopped) state.
function _resumeRecognitionAfterSpeech() {
  if (isRecording && !isSpeaking) {
    document.getElementById('micBtn').classList.remove('paused');
    document.getElementById('micBtn').classList.add('recording');
    try {
      recognition.start();
    } catch (e) {
      console.error('Failed to resume recognition after TTS:', e);
    }
  }
}

// Speak text through the local Piper proxy (POST /piper/speak, gated by the
// session cookie like every other authenticated route). Piper returns raw
// audio/wav; this page plays it through the shared <audio> element, so it has
// a real stop control (unlike a fresh VoiceBox generation). The pending fetch
// doubles as the "generating" indicator — the button (or the header speaker
// icon, for auto-TTS with no button) shows a spinner until audio starts.
function speakTextViaPiper(text, sourceBtn) {
  stopSpeaking(); // stop any in-progress playback and reset the previous button

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

  // Set speaking flag BEFORE pausing recognition so onend can't auto-restart it.
  isSpeaking = true;
  _pauseRecognitionForSpeech();

  fetch(PIPER_SPEAK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: cleanText })
  })
    .then(function (response) {
      if (!response.ok) throw new Error('Piper request failed (' + response.status + ')');
      return response.blob();
    })
    .then(function (blob) {
      if (btn) {
        btn.disabled = false;
        btn.classList.remove('generating');
      }
      speakerBtn.classList.remove('generating');
      _playTtsBlob(blob, btn);
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
      isSpeaking = false;
      _resumeRecognitionAfterSpeech();
      showToast('Piper TTS is unavailable');
    });
}

// Shared <audio> element — plays Piper WAV blobs and replays cached VoiceBox
// generations. Created lazily so pages that never speak don't pay for it.
let ttsAudio = null;

function getTtsAudio() {
  if (!ttsAudio) {
    ttsAudio = new Audio();
    ttsAudio.addEventListener('ended', onTtsAudioFinished);
    ttsAudio.addEventListener('error', onTtsAudioFinished);
  }
  return ttsAudio;
}

function onTtsAudioFinished() {
  if (_ttsObjectUrl) {
    URL.revokeObjectURL(_ttsObjectUrl);
    _ttsObjectUrl = null;
  }
  isSpeaking = false;
  resetActiveSpeakBtn();
  document.getElementById('speakerBtn').style.display = 'none';
  document.getElementById('speakerBtn').classList.remove('speaking');
  _resumeRecognitionAfterSpeech();
}

// Play a Piper WAV blob through the shared <audio> element, wiring the same
// stop/speaking state a cached VoiceBox replay uses.
function _playTtsBlob(blob, sourceBtn) {
  const audio = getTtsAudio();
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

  if (_ttsObjectUrl) URL.revokeObjectURL(_ttsObjectUrl);
  _ttsObjectUrl = URL.createObjectURL(blob);
  audio.src = _ttsObjectUrl;
  audio.play().catch(function () {
    onTtsAudioFinished();
    showToast('Could not play synthesised audio.');
  });
}

// Play a cached VoiceBox generation and wire up real stop/speaking state —
// unlike a fresh generation (which VoiceBox plays itself with no signal back
// to this page), a cache hit is played entirely by this page, so it can be
// stopped like the Piper engine can.
function playVoiceboxAudio(audioUrl, sourceBtn) {
  const audio = getTtsAudio();
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
    onTtsAudioFinished();
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
  stopSpeaking(); // stop any in-progress Piper or cached VoiceBox playback

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

// Stop speaking function — halts Piper or cached-VoiceBox playback through the
// shared <audio> element (a fresh VoiceBox generation plays on the host and
// can't be stopped from here) and resumes paused recognition.
function stopSpeaking() {
  resetActiveSpeakBtn();
  if (ttsAudio && !ttsAudio.paused) {
    ttsAudio.pause();
    ttsAudio.currentTime = 0;
  }
  if (_ttsObjectUrl) {
    URL.revokeObjectURL(_ttsObjectUrl);
    _ttsObjectUrl = null;
  }
  isSpeaking = false;
  document.getElementById('speakerBtn').style.display = 'none';
  document.getElementById('speakerBtn').classList.remove('speaking', 'generating');

  // Resume speech recognition if it was active before playback stopped.
  _resumeRecognitionAfterSpeech();
}

// Node.js compat — lets Jest import these for unit tests; no-op in the browser
// (mirrors utils.js / chat.js / api.js).
if (typeof module !== 'undefined') {
  module.exports = {
    speakText,
    speakTextViaPiper,
    speakTextViaVoicebox,
    stopSpeaking,
  };
}