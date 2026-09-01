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

// Resolve the num_ctx to send for `modelName`: the model's *full* advertised
// context window (from GET /api/tags `details.context_length`) when known, so a
// long conversation or a large attached document can use everything the model
// was trained for. Falls back to `fallback` (OLLAMA_NUM_CTX) when the model's
// window is unknown (e.g. the gemma line, which reports no context_length).
//
// This can send num_ctx well above OLLAMA_NUM_CTX (qwen3:4b advertises 262144).
// The Ollama server's own OLLAMA_CONTEXT_LENGTH still clamps the request, so the
// KV-cache memory cost is a server-side budget decision — set the server's
// context length to what the host can afford.
function resolveNumCtx(modelName, fallback, contextMap) {
  const fb = typeof fallback === 'number' && isFinite(fallback) && fallback > 0
    ? Math.floor(fallback)
    : 16384;
  const known = contextMap && typeof contextMap === 'object' ? contextMap[modelName] : undefined;
  if (typeof known === 'number' && isFinite(known) && known > 0) {
    return Math.floor(known);
  }
  return fb;
}

// Split a Professional Consultant reply into its named markdown sections. A
// section starts at a heading line for one of `names` — tolerant of an optional
// `#`..`####` prefix or `**bold**` wrapping, an optional trailing `:` — and runs
// to the next recognised heading or EOF. Returns a { <lowercased name>: body }
// map (body = the raw markdown between headings, trimmed); each requested name is
// always a key (`''` when that section is absent). Pure; never throws.
function _parseNamedSections(text, names) {
  const out = {};
  names.forEach((n) => {
    out[n.toLowerCase()] = '';
  });
  if (typeof text !== 'string' || !text) return out;
  const alt = names.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  // Optional leading #### or **, the name, then any mix of trailing ** / : / ws.
  const headingRe = new RegExp(
    '^[ \\t]*(?:#{1,4}[ \\t]*)?(?:\\*\\*[ \\t]*)?(' + alt + ')(?:[ \\t]*(?::|\\*\\*))*[ \\t]*$',
    'i'
  );
  const lines = text.split(/\r?\n/);
  let current = null;
  let buf = [];
  const flush = () => {
    if (current) out[current] = buf.join('\n').trim();
  };
  for (const line of lines) {
    const m = line.match(headingRe);
    if (m) {
      flush();
      current = m[1].toLowerCase();
      buf = [];
    } else if (current) {
      buf.push(line);
    }
  }
  flush();
  return out;
}

// SWOT reply → { strengths, weaknesses, opportunities, threats } (raw markdown
// bodies). Returns null when fewer than 2 of the 4 sections were found, so the
// caller can fall back to a plain markdown render.
function parseSwotSections(text) {
  const s = _parseNamedSections(text, [
    'Strengths',
    'Weaknesses',
    'Opportunities',
    'Threats'
  ]);
  const found = ['strengths', 'weaknesses', 'opportunities', 'threats'].filter(
    (k) => s[k]
  ).length;
  return found >= 2 ? s : null;
}

// Pros & cons reply → { pros, cons } (raw markdown bodies). Null when neither
// section was found.
function parseProsConsSections(text) {
  const s = _parseNamedSections(text, ['Pros', 'Cons']);
  return s.pros || s.cons ? s : null;
}

// A markdown pipe table → array of trimmed-cell rows, with the separator row
// (--- | :--: | - | …) dropped. [] when there is no table. Pure.
function _splitMarkdownTable(text) {
  if (typeof text !== 'string' || text.indexOf('|') === -1) return [];
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith('|') || l.indexOf('|') > 0)
    .map((l) => l.replace(/^\||\|$/g, '').split('|').map((c) => c.trim()))
    .filter((cells) => !cells.every((c) => /^:?-+:?$/.test(c) || c === ''));
}

// Decision-matrix reply → { criteria: [name…], rows: [{ option, scores: [n…] }] }
// from the first markdown pipe table. First header cell (the "Option" label) is
// dropped; the rest are criteria. Row cells after the option name are coerced to
// numbers clamped 0–5 (non-numeric → 0). A trailing column whose header matches
// total/score/weighted and any row whose option matches /weight/i are ignored
// (models add them despite the instruction). Returns null when there is no
// usable table (no pipe rows, <1 criterion, or <2 option rows). Pure.
function parseDecisionMatrix(text) {
  const table = _splitMarkdownTable(text);
  if (table.length < 2) return null;

  let criteria = table[0].slice(1);
  let dataRows = table.slice(1);
  // Drop a trailing total/score column.
  if (criteria.length && /^(weighted\s*)?(total|score)$/i.test(criteria[criteria.length - 1])) {
    criteria = criteria.slice(0, -1);
    dataRows = dataRows.map((r) => r.slice(0, criteria.length + 1));
  }
  criteria = criteria.filter((c) => c !== '');
  if (!criteria.length) return null;

  const rows = [];
  for (const cells of dataRows) {
    const option = cells[0];
    if (!option || /^weights?$/i.test(option)) continue;
    const scores = criteria.map((_, i) => {
      const n = parseFloat(cells[i + 1]);
      if (!isFinite(n) || n < 0) return 0;
      return n > 5 ? 5 : n;
    });
    rows.push({ option, scores });
  }
  return rows.length >= 2 ? { criteria, rows } : null;
}

// Quiz reply → [{ question, options: [{ label, text, correct }], answer, explanation }].
// Splits on a "### Q1." / "1." / "**Question 2**" style header; each block wants a
// question line, ≥2 "A) …" options, and a "**Answer:** B — …" line. Returns null
// when no question parsed. Pure.
function parseQuiz(text) {
  if (typeof text !== 'string') return null;
  const qHead = /(?:^|\n)\s*(?:#{1,4}\s*)?\**\s*(?:Q(?:uestion)?[\s.]*)?\d+[.):]/i;
  const blocks = text
    .split(qHead)
    .map((b) => b.trim())
    .filter(Boolean);
  const questions = [];
  for (const block of blocks) {
    const lines = block.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    if (!lines.length) continue;
    let question = lines[0].replace(/^\**\s*/, '').replace(/\**\s*$/, '').trim();
    const options = [];
    let answer = null;
    let explanation = '';
    for (let i = 1; i < lines.length; i++) {
      const om = lines[i].match(/^(?:[-*]\s*)?\(?([A-H])[).]\s*(.+)$/);
      if (om) {
        options.push({ label: om[1].toUpperCase(), text: om[2].replace(/\**\s*$/, '').trim(), correct: false });
        continue;
      }
      const am = lines[i].match(/^\**\s*(?:Correct\s*)?Answer\**\s*:?\s*\**\s*\(?([A-H])\)?\b\s*[—–:-]?\s*(.*)$/i);
      if (am) {
        answer = am[1].toUpperCase();
        explanation = (am[2] || '').replace(/\**\s*$/, '').trim();
        continue;
      }
      if (!options.length) question += ' ' + lines[i];
    }
    if (!question || options.length < 2) continue;
    if (answer) {
      const hit = options.find((o) => o.label === answer);
      if (hit) hit.correct = true;
    }
    questions.push({ question, options, answer, explanation });
  }
  return questions.length ? questions : null;
}

// Flashcards reply → [{ front, back }] from a two-column markdown table. A
// "Term | Definition" header row is dropped. Null when <2 cards. Pure.
function parseFlashcards(text) {
  const rows = _splitMarkdownTable(text);
  if (rows.length < 2) return null;
  let body = rows;
  if (/^(term|front|question|word|concept|card)$/i.test(rows[0][0] || '')) body = rows.slice(1);
  const cards = body
    .filter((cells) => cells[0] && cells[1])
    .map((cells) => ({ front: cells[0], back: cells.slice(1).join(' — ') }));
  return cards.length >= 2 ? cards : null;
}

// Dispatch a persona-affordance reply to its parser. Returns the parsed
// structure or null (unknown template, or the parser rejected the text).
function parseConsultReply(text, template) {
  if (template === 'swot') return parseSwotSections(text);
  if (template === 'proscons') return parseProsConsSections(text);
  if (template === 'matrix') return parseDecisionMatrix(text);
  if (template === 'quiz') return parseQuiz(text);
  if (template === 'flashcards') return parseFlashcards(text);
  return null;
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
    resolveNumCtx,
    parseSwotSections,
    parseProsConsSections,
    parseDecisionMatrix,
    parseQuiz,
    parseFlashcards,
    parseConsultReply
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