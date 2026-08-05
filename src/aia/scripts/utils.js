// utils.js - Utility functions

const _THINK_END = '<|/think|>';

/**
 * Split streaming buffers into { thinking, answer } components.
 * Works for both Ollama native thinking mode (separate message.thinking tokens)
 * and inline token mode (<|/think|> boundary inside message.content).
 *
 * @param {string} thinkingBuffer - Accumulated message.thinking tokens
 * @param {string} fullResponse   - Accumulated message.content tokens
 * @returns {{ thinking: string, answer: string }}
 */
function splitThinkingContent(thinkingBuffer, fullResponse) {
  if (thinkingBuffer && !fullResponse.includes(_THINK_END)) {
    // Native Ollama thinking mode: thinking and answer arrive in separate fields.
    return { thinking: thinkingBuffer, answer: fullResponse };
  }
  const idx = fullResponse.indexOf(_THINK_END);
  if (idx === -1) {
    // Inline token mode, still in the thinking phase.
    return { thinking: fullResponse, answer: '' };
  }
  return {
    thinking: fullResponse.slice(0, idx),
    answer: fullResponse.slice(idx + _THINK_END.length).trimStart()
  };
}

// Returns clamped { w, h } for an image resize. If both dimensions already fit
// within maxDim, the original values are returned unchanged. Exported for testing.
function calcResizeDims(naturalWidth, naturalHeight, maxDim) {
  if (naturalWidth <= maxDim && naturalHeight <= maxDim) return { w: naturalWidth, h: naturalHeight };
  if (naturalWidth >= naturalHeight) {
    return { w: maxDim, h: Math.round(naturalHeight * maxDim / naturalWidth) };
  }
  return { w: Math.round(naturalWidth * maxDim / naturalHeight), h: maxDim };
}

// Returns true when the current message or any history entry carries an image.
// Used by api.js to select the vision model and adjust stream/options behaviour.
function detectVisionContext(imageBase64, history) {
  // m.imageBase64 covers live-session entries; m.hasImage covers entries loaded
  // from saved files where base64 was stripped to keep the JSON small.
  return !!imageBase64 || (Array.isArray(history) && history.some(m => !!m.imageBase64 || m.hasImage === true));
}

// Strip markdown formatting from AI response text so it reads naturally when
// spoken aloud — shared by both the browser (Web Speech API) and VoiceBox
// text-to-speech paths in speech.js.
function stripMarkdownForSpeech(text) {
  return text
    // Must run before the char-strip below, which would otherwise remove the
    // backtick fences and make this pattern unmatchable.
    .replace(/```[\s\S]*?```/g, 'code block')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/[#*`_~]/g, '')
    .replace(/\n+/g, '. ');
}

// Node.js compat — lets Jest import these functions for unit tests; no-op in browser.
if (typeof module !== 'undefined') {
  module.exports = {
    splitThinkingContent,
    calcResizeDims,
    detectVisionContext,
    stripMarkdownForSpeech
  };
}

// Format timestamp as: ddd, dd/mmm/yyyy HH:MM:SS AM/PM
function formatTimestamp(d) {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const dayName = days[d.getDay()];
  const dd = String(d.getDate()).padStart(2, '0');
  const mmm = months[d.getMonth()];
  const yyyy = d.getFullYear();
  let hh = d.getHours();
  const ampm = hh >= 12 ? 'PM' : 'AM';
  hh = hh % 12;
  if (hh === 0) hh = 12;
  const hhStr = String(hh).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  return `${dayName}, ${dd}/${mmm}/${yyyy} ${hhStr}:${mm}:${ss} ${ampm}`;
}

// Utility to escape HTML for plain text user messages
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

var _toastTimer = null;

function showToast(message, durationMs) {
  var toast = document.getElementById('toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'toast';
    toast.className = 'toast';
    document.body.appendChild(toast);
  }
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(function () { toast.classList.remove('show'); }, durationMs || 2000);
}