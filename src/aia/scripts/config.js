// config.js - Configuration constants and system prompts
const MODEL_NAME = 'gemma4:e4b';        // text + thinking mode
const VISION_MODEL_NAME = 'gemma3:4b'; // vision-capable model (gemma4:e4b has no vision encoder in its GGUF)
const OLLAMA_API_URL = 'https://localhost/ollama/api/chat';
const OLLAMA_TAGS_URL = 'https://localhost/ollama/api/tags'; // GET — lists models installed in Ollama, for the model selector
const OLLAMA_MODEL_KEY = 'ollamaModel'; // localStorage key for the user's selected model (legacy — read only by the one-time settings migration)
const SETTINGS_API_URL = 'https://localhost/settings'; // per-user settings-service (see settings.js)
const CONVERSATIONS_API_URL = 'https://localhost/conversations'; // per-user conversations-service (see history.js)
const VOICEBOX_SPEAK_URL = 'https://localhost/voicebox/speak';
const PIPER_SPEAK_URL = 'https://localhost/piper/speak';
const DOC_EXTRACT_URL = 'https://localhost/doc-extract/extract';
const OLLAMA_NUM_CTX = 16384; // FALLBACK num_ctx, used only when the active model's context window is unknown (e.g. the gemma line reports no `details.context_length`). When the window IS known, currentNumCtx is that full window (resolveNumCtx in utils.js) — which can be far larger (qwen3:4b → 262144); the Ollama server's own OLLAMA_CONTEXT_LENGTH then clamps the request, so size that to what the host can afford as KV cache. Sent explicitly on every text/thinking and vision-follow-up request so behavior never silently depends on Ollama's default
const MAX_HISTORY_MESSAGES = 40; // 20 user/assistant exchanges
const MAX_INPUT_LENGTH = 4000;
const MAX_UPLOAD_FILE_BYTES = 5 * 1024 * 1024; // 5 MB
const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB
const MAX_DOCUMENT_UPLOAD_BYTES = 15 * 1024 * 1024; // 15 MB — matches doc-extract's own limit (PDF only; .txt/.md read client-side)
const MAX_DOCUMENT_TEXT_CHARS = 28000; // budget for extracted text folded into a chat message — ~7K tokens at ~4 chars/token, sized against the 16384 fallback context so it stays safe even on a small-context model; a model with a larger advertised window (currentNumCtx) simply has more headroom to spare
const SILENCE_TIMEOUT_MS = 3000;
const CHAR_COUNTER_SHOW_THRESHOLD = 500;
const CHAR_COUNTER_WARNING_THRESHOLD = 200;
const CHAR_COUNTER_DANGER_THRESHOLD = 50;
const SPEECH_RECOGNITION_LANG = 'en-US'; // BCP 47 tag — e.g. 'en-AU', 'fr-FR'
const PERSONA_PREFS_KEY = 'personaPrefs'; // legacy localStorage key — read only by the one-time settings migration
const EDITOR_MODE_KEY = 'editorMode'; // legacy localStorage key — read only by the one-time settings migration
const NAV_RAIL_KEY = 'navRailEnabled'; // legacy localStorage key — read only by the one-time settings migration
const SIDEBAR_STATE_KEY = 'sidebarCollapsed'; // pure client view state (desktop sidebar collapsed) — never synced to the settings-service
const THEME_KEY = 'vpalTheme'; // localStorage mirror of the per-user `theme` setting — read by theme-boot.js before first paint (no-FOUC), written by settings.js
const HISTORY_GROUPS_KEY = 'historyGroupsCollapsed'; // pure client view state — JSON array of collapsed persona keys in the persona-grouped history list; never synced

// Every selectable persona instructs the model to reply in Australian English.
const _AU_EN = ' Always respond in Australian English — Australian spelling, vocabulary, and date formats.';

// Human-readable persona names, keyed by the same keys as `systemPrompts` (minus
// `englishEditorExplained`). Formerly the <option> label text in the persona
// <select>; kept here now that the persona is chosen from the Settings lightbox.
const personaLabels = {
  assistant: 'Assistant',
  casual: 'Casual Friend',
  creative: 'Creative Writer',
  englishEditor: 'English Editor (Australian)',
  legal: 'Legal Assistant',
  medical: 'Medical Expert',
  teacher: 'Patient Teacher',
  professional: 'Professional Consultant',
  technical: 'Technical Expert',
  transcriptai: 'Transcript-Based Assistant',
};

// System prompts
// Note: `englishEditorExplained` has no persona key of its own — it is selected
// when the `englishEditor` persona is active and its editor_mode is "explain"
// (Settings lightbox → Personas). See chat.js `_resolveSystemPrompt`.
const systemPrompts = {
  assistant: "You are a helpful AI assistant. Answer questions clearly, accurately, and concisely. Be direct and to the point without omitting important detail." + _AU_EN,
  englishEditor: "You are an Australian English editor. Review the provided text for spelling, grammar, punctuation, and style according to Australian English conventions. Make corrections and improvements that enhance readability, flow, and accuracy without altering the original tone, voice, or message. Rephrase sentences only when necessary for clarity or correctness. Avoid adding new information, interpretations, or opinions. Do not explain your changes, but present the revised text as a polished version of the original. CRITICAL RULES: - Do NOT alter or weaken the original intent, emotion, or core message of the text. - Do NOT provide an introduction, explanation, commentary, bullet points, or reasoning for your edits. - Output ONLY the final, polished version of the text. Review the following text:",
  englishEditorExplained: "Act as a proofreader and language editor. Review the provided text with attention to spelling, grammar, punctuation, and style in accordance with Australian English conventions. Make corrections and improvements that enhance readability, flow, and accuracy without altering the original tone, voice, or message. Rephrase sentences only when necessary for clarity or correctness. Avoid adding new information, interpretations, or opinions. Briefly explain your changes, then present the revised text as a polished version of the original.",
  transcriptai: "You are a specialized AI assistant designed to answer questions solely based on the information contained within the provided transcript. Your primary function is to extract and synthesize knowledge directly from this transcript. You are strictly forbidden from accessing external knowledge sources, the internet, or any information beyond the scope of this transcript. Your Process: Information Extraction: When presented with a query your first and only action is to carefully analyze the provided transcript for relevant information. Answer Synthesis: Formulate your response using only the explicit statements, details, and context found within the transcript. Paraphrase and rephrase as needed, but never introduce new information or opinions. Confirmation: Before responding, briefly confirm you are utilizing only the provided transcript. A short phrase like 'According to the transcript…' or 'Based on the information within the transcript…' is sufficient. Handling Ambiguity: If a query is ambiguous or unclear within the context of the transcript, to interpret the question's intent based on the available information. If this isn't possible, state that the transcript doesn't provide sufficient information to answer the question. Avoid speculating. Output Format: Respond concisely and directly, presenting your answer as a clear and factual statement. Important Restrictions: No External Knowledge: You must not consult any external sources, including the internet, databases, or any other data beyond the provided transcript.No Opinions or Interpretations: Do not offer personal opinions, judgments, or interpretations. Focus solely on the factual content within the transcript No Assumptions: Do not make any assumptions about the situation or context not explicitly stated in the transcript No Speculation: Do not speculate or infer information not present in the transcript." + _AU_EN,
  creative: "You are a creative writer with a vivid imagination. Use descriptive language and engaging storytelling techniques." + _AU_EN,
  technical: "You are a technical expert. Provide detailed, accurate technical information with examples and best practices. When a diagram would help, express it as Mermaid syntax inside a fenced code block tagged exactly ```mermaid (never a bare fence or a different label) so it renders as a diagram. Diagram rules: start flowcharts with `flowchart TD`; ALWAYS wrap every node label in double quotes — e.g. A[\"Web Application Firewall (WAF)\"] or B{\"NACL / subnet guardrail\"} — so parentheses, slashes and other punctuation never break parsing; do not use `subgraph`, `style`, `classDef` or `linkStyle`." + _AU_EN,
  teacher: "You are a patient teacher. Explain concepts clearly, use analogies, and break down complex topics into simple steps." + _AU_EN,
  casual: "You are a casual, friendly companion. Use a relaxed tone, humor when appropriate, and be conversational." + _AU_EN,
  professional: "You are a professional consultant. Provide well-structured, formal advice with strategic insights. When asked for a SWOT analysis, a pros-and-cons weighing, or a decision matrix, follow the exact structured format the request specifies." + _AU_EN,
  legal: "You are a legal-domain AI assistant. Provide information based on current laws and regulations in Australia, and avoid giving personal opinions. Follow these behaviour rules: creativity low; citation strictness strict; risk tolerance very low; hallucination tolerance zero; explanation depth step-by-step. Adhere to the following hard rules: do not fabricate cases, citations, legislation, or facts; if unsure, respond \"Insufficient data\"; maintain confidentiality at all times; keep reasoning logically consistent and legally grounded; use Australian English; do not provide justification for the response; do not provide follow-up questions.",
  medical: "You are a medical expert. Provide accurate health information based on established medical knowledge, and always recommend consulting a healthcare professional for personal advice." + _AU_EN
};

// Per-persona SVG icon — offline fallback for the copies delivered by the
// settings-service (`GET /settings` `personas.<key>.icon`, from `_PERSONA_ICONS`
// in `settings-service/main.py` — keep the two in sync). Inline line-icons,
// `stroke="currentColor"` so they follow the theme. Rendered via `personaIconEl()`
// in chat.js, which sanitises through DOMPurify (svg profile) before innerHTML.
const personaIcons = {
  assistant: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9.5 3 11 7.5 15.5 9 11 10.5 9.5 15 8 10.5 3.5 9 8 7.5z"/><path d="M18 13.5 18.8 16 21 16.8 18.8 17.5 18 20 17.2 17.5 15 16.8 17.2 16z"/></svg>',
  casual: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M8 14s1.4 2 4 2 4-2 4-2"/><line x1="9" y1="9.5" x2="9.01" y2="9.5"/><line x1="15" y1="9.5" x2="15.01" y2="9.5"/></svg>',
  creative: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.24 12.24a6 6 0 0 0-8.49-8.49L5 10.5V19h8.5z"/><line x1="16" y1="8" x2="2" y2="22"/><line x1="17.5" y1="15" x2="9" y2="15"/></svg>',
  englishEditor: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 16 6-12 6 12"/><path d="M8.5 12h7"/><path d="m15 20 2 2 4-4"/></svg>',
  legal: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3v18"/><path d="M7 21h10"/><path d="M5 7h14"/><path d="M5 7 2 13a3 3 0 0 0 6 0z"/><path d="M19 7l-3 6a3 3 0 0 0 6 0z"/><path d="m9 4 6-1"/></svg>',
  medical: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>',
  professional: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="7" width="20" height="14" rx="2"/><path d="M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16"/></svg>',
  teacher: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 4h6a4 4 0 0 1 4 4v13a3 3 0 0 0-3-3H2z"/><path d="M22 4h-6a4 4 0 0 0-4 4v13a3 3 0 0 1 3-3h7z"/></svg>',
  technical: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>',
  transcriptai: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><line x1="10" y1="9" x2="8" y2="9"/></svg>'
};

// Professional Consultant structured-analysis templates. Picking one from the
// composer menu (only shown when that persona is active) prefills the textarea
// with `scaffold` and folds `format` into the outgoing message so the reply
// comes back in a shape `parseConsultReply()` (utils.js) can render as a
// colour-coded grid. Frontend-only, same as `systemPrompts`.
const _CONSULT_TEMPLATES = {
  swot: {
    label: 'SWOT analysis',
    scaffold: 'SWOT analysis of: ',
    format:
      'Respond with exactly four markdown sections in this order — ' +
      '"## Strengths", "## Weaknesses", "## Opportunities", "## Threats" — ' +
      'each a short bullet list. No preamble or closing summary.'
  },
  proscons: {
    label: 'Pros & cons',
    scaffold: 'Weigh the pros and cons of: ',
    format:
      'Respond with exactly two markdown sections — "## Pros" then "## Cons" — ' +
      'each a bullet list. No preamble.'
  },
  matrix: {
    label: 'Decision matrix',
    scaffold: 'Build a decision matrix to choose between: ',
    format:
      'Respond with a single markdown table and nothing else. The first column ' +
      'header is "Option"; add one column per decision criterion. Each row is one ' +
      'option, scored against every criterion from 1 (poor) to 5 (excellent) as a ' +
      'bare number. Do not add a Totals column, a weights row, or any prose.'
  }
};

// Current system prompt
let currentSystemPrompt = systemPrompts.englishEditor;
let conversationHistory = [];
let pendingImageDataUrl = null; // data: URL for in-chat thumbnail display
let pendingImageBase64 = null;  // raw base64 for the Ollama API images field
let currentModel = MODEL_NAME; // model sent to Ollama for text/thinking turns; MODEL_NAME is the built-in default/fallback. Hydrated from window.vpalSettings by applyResolvedSettings() (settings.js)
let currentVisionModel = VISION_MODEL_NAME; // model sent to Ollama for image turns; VISION_MODEL_NAME is the built-in default/fallback. Hydrated from window.vpalSettings by applyResolvedSettings() (settings.js)
let currentThinkingMode = 'off'; // 'off' | 'low' | 'medium' | 'high'
let currentTTSEngine = 'piper'; // 'piper' | 'voicebox'
let currentEditorMode = 'clean'; // 'clean' | 'changes' | 'explain' — English Editor output mode
let currentConsultView = 'structured'; // 'structured' | 'text' — default view for a new Professional Consultant analysis artifact; from vpalSettings.personas.professional.default_analysis_view
let pendingConsultTemplate = null; // 'swot' | 'proscons' | 'matrix' — a Consultant template picked from the composer menu, consumed on the next send
let currentNavRailEnabled = true; // conversation navigator rail visible; toolbar toggle, persisted to localStorage[NAV_RAIL_KEY]
window.currentNavRailEnabled = currentNavRailEnabled; // nav-rail.js reads the flag off window to avoid script load-order issues
let currentTheme = 'system'; // 'system' | 'light' | 'dark' — resolved from vpalSettings.global.theme by applyResolvedSettings(); _applyTheme() (settings.js) sets <html data-theme> + the localStorage[THEME_KEY] mirror
let currentNumCtx = OLLAMA_NUM_CTX; // num_ctx actually sent to Ollama: the active model's full advertised context window when known, else the OLLAMA_NUM_CTX fallback. Recomputed by recomputeNumCtx() (settings.js) via resolveNumCtx(); CAN exceed OLLAMA_NUM_CTX (the Ollama server's OLLAMA_CONTEXT_LENGTH is the real cap)
let modelContextLengths = {}; // { modelName: contextLength } parsed from GET /api/tags `details.context_length`; populated at load (main.js) and whenever the Settings dialog opens. {} until the first successful fetch — until then every model uses the OLLAMA_NUM_CTX fallback
let pendingDocumentText = null; // extracted text, folded into the next outgoing message
let pendingDocumentName = null; // original filename, shown in the preview chip and user bubble
let pendingDocumentTruncated = false; // true when extracted text exceeded MAX_DOCUMENT_TEXT_CHARS