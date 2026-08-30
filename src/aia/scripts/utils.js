// utils.js - Utility functions

// End-of-reasoning markers, longest first. `<|/think|>` is gemma's; `</think>` /
// `</thinking>` are what qwen3 / deepseek-r1 / most community GGUFs emit when a
// model's Ollama template doesn't peel reasoning into `message.thinking` itself.
const _THINK_END_TOKENS = ['<|/think|>', '</thinking>', '</think>'];
// A leading open tag on inline reasoning, stripped for display.
const _THINK_OPEN_RE = /^\s*<\|?\s*think(?:ing)?\s*\|?>\s*/i;

/**
 * Split streaming buffers into { thinking, answer } components.
 *
 * Two modes, in priority order:
 *  1. Native Ollama thinking — reasoning arrives as `message.thinking` tokens,
 *     the answer as `message.content`. When `thinkingBuffer` has any content we
 *     are unconditionally in this mode: `message.content` is the answer verbatim
 *     (it may legitimately contain the literal string "</think>").
 *  2. Inline — the model wrote its reasoning into `message.content` wrapped in
 *     `<think>…</think>` (or gemma's `<|think|>…<|/think|>`). Split on the first
 *     close marker; before it (open tag stripped) is thinking, after it is the
 *     answer. With no close marker yet, everything is still thinking.
 *
 * @param {string} thinkingBuffer - Accumulated message.thinking tokens
 * @param {string} fullResponse   - Accumulated message.content tokens
 * @returns {{ thinking: string, answer: string }}
 */
function splitThinkingContent(thinkingBuffer, fullResponse) {
  if (thinkingBuffer) {
    return { thinking: thinkingBuffer, answer: fullResponse };
  }

  let idx = -1;
  let tokenLen = 0;
  for (const token of _THINK_END_TOKENS) {
    const at = fullResponse.indexOf(token);
    if (at !== -1 && (idx === -1 || at < idx)) {
      idx = at;
      tokenLen = token.length;
    }
  }

  if (idx === -1) {
    return { thinking: fullResponse.replace(_THINK_OPEN_RE, ''), answer: '' };
  }
  return {
    thinking: fullResponse.slice(0, idx).replace(_THINK_OPEN_RE, ''),
    answer: fullResponse.slice(idx + tokenLen).trimStart()
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
// spoken aloud — shared by the Piper and VoiceBox text-to-speech paths in
// speech.js.
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

// Word-level tracked-changes diff between two strings, using the diff-match-patch
// "word mode" recipe: tokenize on whitespace boundaries (whitespace runs are
// their own tokens, so concatenating every token reproduces the input exactly),
// map each unique token to a single BMP code point, diff the resulting char
// strings, run cleanupSemantic, then expand each char run back to token text.
//
// @param {string} original - the "before" text (rendered struck-through)
// @param {string} revised  - the "after" text (rendered underlined)
// @param {Function} [DMP]   - the diff_match_patch constructor; defaults to the
//   browser global. Passed explicitly by the Jest suite, where the vendored
//   library is CommonJS-required rather than a global. Kept as a parameter (not
//   a module-level require) so utils.js has no hard Node dependency on the
//   vendored file at load time in the browser.
// @returns {Array<{op: -1|0|1, text: string}>} delete / equal / insert segments
function diffWords(original, revised, DMP) {
  const Ctor = DMP || (typeof diff_match_patch !== 'undefined' ? diff_match_patch : null);
  if (typeof Ctor !== 'function') {
    throw new Error('diffWords: diff_match_patch constructor is not available');
  }
  const dmp = new Ctor();

  // tokenArray[0] is reserved as '' (mirrors diff-match-patch's own line-mode
  // recipe) so real tokens start at code point 1 and code point 0 stays unused.
  const tokenArray = [''];
  const tokenHash = Object.create(null);

  const encode = (text) => {
    let chars = '';
    const tokens = text.match(/\s+|\S+/g) || [];
    for (const tok of tokens) {
      let id = tokenHash[tok];
      if (id === undefined) {
        id = tokenArray.length;
        tokenArray.push(tok);
        tokenHash[tok] = id;
      }
      chars += String.fromCharCode(id);
    }
    return chars;
  };

  const diffs = dmp.diff_main(encode(original), encode(revised), false);
  dmp.diff_cleanupSemantic(diffs);

  // diff-match-patch returns an array of 2-tuples ([op, text]) — index access
  // rather than destructuring, since this build's tuple objects are not iterable.
  const segments = [];
  for (const tuple of diffs) {
    const op = tuple[0];
    const data = tuple[1];
    let text = '';
    for (const ch of data) text += tokenArray[ch.charCodeAt(0)];
    if (text) segments.push({ op, text });
  }
  return segments;
}

// Parse Ollama's GET /api/tags response into a sorted list of model name
// strings for the model selector. Ollama returns { models: [{ name, model,
// size, digest, details, ... }, ...] }; `name` is the tag the user pulled
// (e.g. "gemma4:e4b"), with `model` as a fallback. De-duplicates and sorts
// case-insensitively. Returns [] for any malformed input — never throws.
function parseOllamaModels(json) {
  if (!json || typeof json !== 'object' || !Array.isArray(json.models)) return [];
  const names = [];
  for (const entry of json.models) {
    if (!entry || typeof entry !== 'object') continue;
    const name = typeof entry.name === 'string' && entry.name
      ? entry.name
      : (typeof entry.model === 'string' ? entry.model : '');
    if (name && !names.includes(name)) names.push(name);
  }
  return names.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));
}

// Parse Ollama's GET /api/tags response into a { modelName: contextLength } map.
// Recent Ollama builds expose `details.context_length` (the model's architectural
// context window) per entry; older builds and some models (e.g. the gemma line
// here) omit it. Only positive integers are kept; everything else — including
// models with no `context_length` — is simply absent from the map, and callers
// fall back to the configured ceiling. Returns {} for malformed input; never
// throws. Feeds resolveNumCtx().
function parseModelContextLengths(json) {
  const out = {};
  if (!json || typeof json !== 'object' || !Array.isArray(json.models)) return out;
  for (const entry of json.models) {
    if (!entry || typeof entry !== 'object') continue;
    const name = typeof entry.name === 'string' && entry.name
      ? entry.name
      : (typeof entry.model === 'string' ? entry.model : '');
    if (!name) continue;
    const ctx = entry.details && entry.details.context_length;
    if (typeof ctx === 'number' && isFinite(ctx) && ctx > 0 && Math.floor(ctx) === ctx) {
      out[name] = ctx;
    }
  }
  return out;
}

// Resolve the num_ctx to send for `modelName`: the configured `ceiling`
// (OLLAMA_NUM_CTX), reduced to the model's advertised context window when that
// is *smaller* — sending num_ctx larger than a model can hold makes Ollama
// silently clamp the request. It never raises above the ceiling: a larger KV
// cache is a deliberate memory-budget decision, not something to enable
// automatically from a model's architectural maximum (which can be 128K+).
// Falls back to the ceiling whenever the model's window is unknown.
function resolveNumCtx(modelName, ceiling, contextMap) {
  const cap = typeof ceiling === 'number' && isFinite(ceiling) && ceiling > 0
    ? Math.floor(ceiling)
    : 16384;
  const known = contextMap && typeof contextMap === 'object' ? contextMap[modelName] : undefined;
  if (typeof known === 'number' && isFinite(known) && known > 0) {
    return Math.min(cap, Math.floor(known));
  }
  return cap;
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
    parseDocumentMessageContent,
    diffWords,
    parseOllamaModels,
    parseModelContextLengths,
    resolveNumCtx
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