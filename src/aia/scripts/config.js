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
const OLLAMA_NUM_CTX = 16384; // must match the Ollama server's configured context length (OLLAMA_CONTEXT_LENGTH env var or Modelfile `PARAMETER num_ctx`) — sent explicitly on every text/thinking and vision-follow-up request so behavior never silently depends on Ollama's own default
const MAX_HISTORY_MESSAGES = 40; // 20 user/assistant exchanges
const MAX_INPUT_LENGTH = 4000;
const MAX_UPLOAD_FILE_BYTES = 5 * 1024 * 1024; // 5 MB
const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024; // 5 MB
const MAX_DOCUMENT_UPLOAD_BYTES = 15 * 1024 * 1024; // 15 MB — matches doc-extract's own limit (PDF only; .txt/.md read client-side)
const MAX_DOCUMENT_TEXT_CHARS = 28000; // budget for extracted text folded into a chat message — ~7K tokens at ~4 chars/token, leaving headroom in OLLAMA_NUM_CTX (16384) for the system prompt, conversation history, thinking budget, and the response itself
const SILENCE_TIMEOUT_MS = 3000;
const CHAR_COUNTER_SHOW_THRESHOLD = 500;
const CHAR_COUNTER_WARNING_THRESHOLD = 200;
const CHAR_COUNTER_DANGER_THRESHOLD = 50;
const SPEECH_RECOGNITION_LANG = 'en-US'; // BCP 47 tag — e.g. 'en-AU', 'fr-FR'
const PERSONA_PREFS_KEY = 'personaPrefs'; // legacy localStorage key — read only by the one-time settings migration
const EDITOR_MODE_KEY = 'editorMode'; // legacy localStorage key — read only by the one-time settings migration
const NAV_RAIL_KEY = 'navRailEnabled'; // legacy localStorage key — read only by the one-time settings migration
const SIDEBAR_STATE_KEY = 'sidebarCollapsed'; // pure client view state (desktop sidebar collapsed) — never synced to the settings-service

// Human-readable persona names, keyed by the same keys as `systemPrompts` (minus
// `englishEditorExplained`). Formerly the <option> label text in the persona
// <select>; kept here now that the persona is chosen from the Settings lightbox.
const personaLabels = {
  assistant: 'Assistant',
  casual: 'Casual Friend',
  claudePromptCompressor: 'Claude Prompt Compressor',
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
  assistant: "You are a helpful AI assistant. Answer questions clearly, accurately, and concisely. Be direct and to the point without omitting important detail.",
  englishEditor: "You are an Australian English editor. Review the provided text for spelling, grammar, punctuation, and style according to Australian English conventions. Make corrections and improvements that enhance readability, flow, and accuracy without altering the original tone, voice, or message. Rephrase sentences only when necessary for clarity or correctness. Avoid adding new information, interpretations, or opinions. Do not explain your changes, but present the revised text as a polished version of the original. CRITICAL RULES: - Do NOT alter or weaken the original intent, emotion, or core message of the text. - Do NOT provide an introduction, explanation, commentary, bullet points, or reasoning for your edits. - Output ONLY the final, polished version of the text. Review the following text:",
  englishEditorExplained: "Act as a proofreader and language editor. Review the provided text with attention to spelling, grammar, punctuation, and style in accordance with Australian English conventions. Make corrections and improvements that enhance readability, flow, and accuracy without altering the original tone, voice, or message. Rephrase sentences only when necessary for clarity or correctness. Avoid adding new information, interpretations, or opinions. Briefly explain your changes, then present the revised text as a polished version of the original.",
  claudePromptCompressor:"You are an expert Prompt Engineer optimizing developer commands for the Claude Code CLI. Your goal is to maximize instruction density while minimizing token count and terminal screen space. When the user provides a raw instruction or feature request, rewrite it into a highly dense, actionable prompt optimized for a CLI terminal interface. CRITICAL RULES: 1. OUTPUT FORMAT: Output your response inside a single, clean markdown code block. Do NOT use markdown headers (###). Use plain text labels (CONTEXT:, OBJECTIVE:, CONSTRAINTS:). 2. CONCISE LINES: Keep lines short and punchy. Every sentence must deliver fresh, actionable developer information. Eliminate all conversational filler, preambles, and fluff. 3. DIRECT COMMAND FORMAT: Phrase the objective as a direct command that the Claude Code CLI can execute immediately against the active repository workspace. 4. ABSOLUTE SILENCE: Do not explain your changes, do not output any introductory or concluding text, and do not provide reasoning. Output ONLY the code block.",
  transcriptai: "You are a specialized AI assistant designed to answer questions solely based on the information contained within the provided transcript. Your primary function is to extract and synthesize knowledge directly from this transcript. You are strictly forbidden from accessing external knowledge sources, the internet, or any information beyond the scope of this transcript. Your Process: Information Extraction: When presented with a query your first and only action is to carefully analyze the provided transcript for relevant information. Answer Synthesis: Formulate your response using only the explicit statements, details, and context found within the transcript. Paraphrase and rephrase as needed, but never introduce new information or opinions. Confirmation: Before responding, briefly confirm you are utilizing only the provided transcript. A short phrase like 'According to the transcript…' or 'Based on the information within the transcript…' is sufficient. Handling Ambiguity: If a query is ambiguous or unclear within the context of the transcript, to interpret the question's intent based on the available information. If this isn't possible, state that the transcript doesn't provide sufficient information to answer the question. Avoid speculating. Output Format: Respond concisely and directly, presenting your answer as a clear and factual statement. Important Restrictions: No External Knowledge: You must not consult any external sources, including the internet, databases, or any other data beyond the provided transcript.No Opinions or Interpretations: Do not offer personal opinions, judgments, or interpretations. Focus solely on the factual content within the transcript No Assumptions: Do not make any assumptions about the situation or context not explicitly stated in the transcript No Speculation: Do not speculate or infer information not present in the transcript.",
  creative: "You are a creative writer with a vivid imagination. Use descriptive language and engaging storytelling techniques.",
  technical: "You are a technical expert. Provide detailed, accurate technical information with examples and best practices. When a diagram would help, express it as Mermaid syntax inside a fenced code block tagged exactly ```mermaid (never a bare fence or a different label) so it renders as a diagram.",
  teacher: "You are a patient teacher. Explain concepts clearly, use analogies, and break down complex topics into simple steps.",
  casual: "You are a casual, friendly companion. Use a relaxed tone, humor when appropriate, and be conversational.",
  professional: "You are a professional consultant. Provide well-structured, formal advice with strategic insights.",
  legal: "You are a legal-domain AI assistant. Provide information based on current laws and regulations in Australian, and avoid giving personal opinions. Follow these behaviour rules: creativity low; citation strictness strict; risk tolerance very low; hallucination tolerance zero; explanation depth step-by-step. Adhere to the following hard rules: do not fabricate cases, citations, legislation, or facts; if unsure, respond \"Insufficient data\"; maintain confidentiality at all times; keep reasoning logically consistent and legally grounded; use Australian English; do not provide justification for the response; do not provide follow-up questions.",
  medical: "You are a medical expert. Provide accurate health information based on established medical knowledge, and always recommend consulting a healthcare professional for personal advice."
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
let currentNavRailEnabled = true; // conversation navigator rail visible; toolbar toggle, persisted to localStorage[NAV_RAIL_KEY]
window.currentNavRailEnabled = currentNavRailEnabled; // nav-rail.js reads the flag off window to avoid script load-order issues
let pendingDocumentText = null; // extracted text, folded into the next outgoing message
let pendingDocumentName = null; // original filename, shown in the preview chip and user bubble
let pendingDocumentTruncated = false; // true when extracted text exceeded MAX_DOCUMENT_TEXT_CHARS