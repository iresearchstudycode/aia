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

// CommonMark's backslash-escape rule strips a backslash immediately before
// ASCII punctuation (e.g. `\(` -> `(`, `\\` -> `\`) — that silently destroys
// KaTeX's \(...\) / \[...\] delimiters and \\ row separators before KaTeX
// ever sees them, since marked.parse() always runs first. `\frac`, `\sqrt`,
// etc. are unaffected (backslash followed by a letter isn't in that
// punctuation set), so this only needs to cover the punctuation LaTeX
// actually pairs a backslash with: ( ) [ ] { } and \ itself.
//
// Swap the backslash for a placeholder (U+E000, Unicode Private Use Area —
// never appears in real text, so this can't collide with genuine content)
// before marked.parse() runs, then swap it back afterward with
// restoreLatexBackslashes(), once markdown can no longer touch it.
const _LATEX_BACKSLASH_PLACEHOLDER = '';

function protectLatexDelimiters(text) {
  return text.replace(/\\([()[\]{}\\])/g, _LATEX_BACKSLASH_PLACEHOLDER + '$1');
}

function restoreLatexBackslashes(html) {
  return html.split(_LATEX_BACKSLASH_PLACEHOLDER).join('\\');
}

// Truncate extracted document text to a safe character budget — the whole
// conversation history (including this text) is resent to Ollama on every
// turn, so an unbounded document would make every subsequent message more
// expensive, not just this one.
function truncateDocumentText(text, maxChars) {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(0, maxChars), truncated: true };
}

// Wrap extracted document text in a clearly-delimited block followed by the
// user's question — this is what actually gets sent to the model. There's no
// separate "documents" field in Ollama's chat API the way there is `images`
// for vision, so the text has to be folded directly into message content.
function buildDocumentMessageContent(documentName, documentText, truncated, userQuestion) {
  const notice = truncated ? ' (truncated)' : '';
  const question = userQuestion && userQuestion.trim()
    ? userQuestion.trim()
    : 'Please review the following document and be ready to answer questions about it.';
  return (
    `--- Attached file: ${documentName}${notice} ---\n` +
    `${documentText}\n` +
    `--- End of ${documentName} ---\n\n` +
    question
  );
}

// Inverse of buildDocumentMessageContent() — detects whether a message's
// content was built with a document attached and, if so, splits it back into
// { documentName, question } for display purposes. Used so the chat bubble
// can show a compact filename chip + the user's actual question instead of
// the full (possibly 28,000-character) document block that was sent to the
// model. Returns { hasDocument: false } for an ordinary message.
function parseDocumentMessageContent(content) {
  const match = content.match(
    /^--- Attached file: (.+?)(?: \(truncated\))? ---\n[\s\S]*?\n--- End of \1 ---\n\n([\s\S]*)$/
  );
  if (!match) return { hasDocument: false };
  return { hasDocument: true, documentName: match[1], question: match[2] };
}

// Node.js compat — lets Jest import these functions for unit tests; no-op in browser.
if (typeof module !== 'undefined') {
  module.exports = {
    splitThinkingContent,
    calcResizeDims,
    detectVisionContext,
    stripMarkdownForSpeech,
    protectLatexDelimiters,
    restoreLatexBackslashes,
    truncateDocumentText,
    buildDocumentMessageContent,
    parseDocumentMessageContent
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