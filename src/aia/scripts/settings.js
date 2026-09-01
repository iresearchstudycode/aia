// settings.js - Consolidated Settings lightbox
//
// One modal dialog (opened from the profile dropdown, or from the toolbar
// #modelBadge / #thinkingBadge) that replaces the scattered toolbar / persona
// panel preference controls. Per-user preferences live server-side in the
// settings-service; this module reads the hydrated snapshot from
// `window.vpalSettings` (written by main.js), renders it as editable
// categories, and PUTs / POSTs changes back.
//
// Layer separation: everything that touches the DOM, the network, or the
// cross-module runtime globals lives inside functions and behind `typeof`
// guards, so this file can be CommonJS-required in Jest with no DOM, no fetch
// and no config.js present (mirrors nav-rail.js / utils.js). Only the pure
// resolver / diff / migration helpers are exercised by the unit suite.

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested in isolation, exported for Node at the file tail).
// ---------------------------------------------------------------------------

var _SETTINGS_THINKING_DEPTHS = ['low', 'medium', 'high'];
var _SETTINGS_TTS_ENGINES = ['piper', 'voicebox'];

/**
 * Resolve a single setting value: persona override wins over the global value,
 * which wins over the baked-in default. A persona override of `null` (or a
 * missing override) falls through to the global; a missing global falls
 * through to `defaults.global`.
 *
 * @param {string} key - a canonical setting key
 * @param {?string} personaKey - persona to resolve for, or null/undefined for
 *   the global-only view
 * @param {?object} vpalSettings - the `GET /settings` shaped object
 * @returns {*} the resolved value (may be undefined if nothing defines it)
 */
function resolveSetting(key, personaKey, vpalSettings) {
  var s = vpalSettings || {};
  var personas = s.personas || {};
  var persona = (personaKey && personas[personaKey]) || {};
  if (
    Object.prototype.hasOwnProperty.call(persona, key) &&
    persona[key] !== null &&
    persona[key] !== undefined
  ) {
    return persona[key];
  }
  var global = s.global || {};
  if (
    Object.prototype.hasOwnProperty.call(global, key) &&
    global[key] !== null &&
    global[key] !== undefined
  ) {
    return global[key];
  }
  var defaults = (s.defaults && s.defaults.global) || {};
  return defaults[key];
}

/**
 * Resolve the effective thinking mode for a persona.
 *
 * @param {?string} personaKey
 * @param {?object} vpalSettings
 * @returns {'off'|'low'|'medium'|'high'} `'off'` when thinking is disabled,
 *   otherwise the resolved depth (falling back to `'medium'` for a bad value)
 */
function resolveThinkingMode(personaKey, vpalSettings) {
  var enabled = resolveSetting('thinking_enabled', personaKey, vpalSettings);
  if (!enabled) return 'off';
  var depth = resolveSetting('thinking_depth', personaKey, vpalSettings);
  return _SETTINGS_THINKING_DEPTHS.indexOf(depth) !== -1 ? depth : 'medium';
}

/**
 * Resolve the effective TTS engine for a persona (persona override → global →
 * `'piper'`).
 *
 * @param {?string} personaKey
 * @param {?object} vpalSettings
 * @returns {'piper'|'voicebox'}
 */
function resolveTtsEngine(personaKey, vpalSettings) {
  var v = resolveSetting('tts_engine', personaKey, vpalSettings);
  return _SETTINGS_TTS_ENGINES.indexOf(v) !== -1 ? v : 'piper';
}

/**
 * Compare a form's current values against the values they were resolved from
 * and return only the changed subset. Strict equality, so booleans and `null`
 * are handled directly; keys absent from `formValues` are never emitted.
 *
 * @param {?object} formValues
 * @param {?object} resolvedValues
 * @returns {object} the changed-only subset of `formValues`
 */
function diffSettings(formValues, resolvedValues) {
  var form = formValues || {};
  var resolved = resolvedValues || {};
  var out = {};
  Object.keys(form).forEach(function (k) {
    if (form[k] !== resolved[k]) out[k] = form[k];
  });
  return out;
}

/**
 * Map a legacy `localStorage` snapshot to the migration payload shape
 * `{ global: {...}, personas: { <key>: {...} } }`. Only keys actually present
 * in the snapshot are emitted; unrecognised / malformed values are skipped and
 * never throw (a bad `personaPrefs` JSON string is ignored).
 *
 * @param {?object} snapshot - plain object of legacy localStorage entries
 * @returns {{global: object, personas: object}}
 */
function buildMigrationPayload(snapshot) {
  var s = snapshot || {};
  var global = {};
  var personas = {};

  var setBool = function (raw, key) {
    if (raw === 'true' || raw === true) global[key] = true;
    else if (raw === 'false' || raw === false) global[key] = false;
  };

  if (typeof s.ollamaModel === 'string' && s.ollamaModel) global.chat_model = s.ollamaModel;
  if (_SETTINGS_TTS_ENGINES.indexOf(s.ttsEngine) !== -1) global.tts_engine = s.ttsEngine;
  setBool(s.autoTTS, 'auto_speak');
  setBool(s.thinkingOn, 'thinking_enabled');
  if (_SETTINGS_THINKING_DEPTHS.indexOf(s.thinkingDepth) !== -1) {
    global.thinking_depth = s.thinkingDepth;
  }
  setBool(s.navRailEnabled, 'nav_rail');

  if (s.editorMode === 'clean' || s.editorMode === 'changes' || s.editorMode === 'explain') {
    personas.englishEditor = personas.englishEditor || {};
    personas.englishEditor.editor_mode = s.editorMode;
  }

  if (s.personaPrefs) {
    var parsed = null;
    try {
      parsed = JSON.parse(s.personaPrefs);
    } catch {
      parsed = null;
    }
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      Object.keys(parsed).forEach(function (personaKey) {
        var entry = parsed[personaKey];
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return;
        var p = personas[personaKey] || {};
        if (typeof entry.thinkingOn === 'boolean') p.thinking_enabled = entry.thinkingOn;
        if (_SETTINGS_THINKING_DEPTHS.indexOf(entry.thinkingDepth) !== -1) {
          p.thinking_depth = entry.thinkingDepth;
        }
        if (_SETTINGS_TTS_ENGINES.indexOf(entry.ttsEngine) !== -1) p.tts_engine = entry.ttsEngine;
        if (Object.keys(p).length) personas[personaKey] = p;
      });
    }
  }

  return { global: global, personas: personas };
}

// ---------------------------------------------------------------------------
// Browser-only state + wiring. None of this runs at require() time; every
// entry point re-checks the DOM and returns early when it is absent.
// ---------------------------------------------------------------------------

var _settingsInited = false;
var _settingsOpen = false;
var _settingsOpener = null;
var _settingsActiveCategory = 'models';
var _settingsEditPersona = null;
var _settingsKeydownBound = false;

// Per-category pending edits. Global categories store `{ key: value }`; the
// personas category splits into a global part (`active_persona`) and the
// currently-edited persona's override part.
var _settingsEdits = {
  models: {},
  voice: {},
  reasoning: {},
  interface: {},
  personas: {},
  personaOverride: { personaKey: null, values: {} }
};

var SETTINGS_CATEGORIES = [
  { id: 'models', label: 'Models' },
  { id: 'voice', label: 'Voice' },
  { id: 'reasoning', label: 'Reasoning' },
  { id: 'interface', label: 'Interface' },
  { id: 'personas', label: 'Personas' }
];

var SETTINGS_PERSONA_LABELS = {
  assistant: 'Assistant',
  casual: 'Casual Friend',
  creative: 'Creative Writer',
  englishEditor: 'English Editor (Australian)',
  legal: 'Legal Assistant',
  medical: 'Medical Expert',
  teacher: 'Patient Teacher',
  professional: 'Professional Consultant',
  technical: 'Technical Expert',
  transcriptai: 'Transcript-Based Assistant'
};

var SETTINGS_PERSONA_KEYS = [
  'assistant',
  'casual',
  'creative',
  'englishEditor',
  'legal',
  'medical',
  'professional',
  'teacher',
  'technical',
  'transcriptai'
];

// Field descriptors for the four global categories.
var SETTINGS_FIELD_DEFS = {
  chat_model: { type: 'model-select', label: 'Chat model' },
  vision_model: { type: 'model-select', label: 'Vision model' },
  tts_engine: {
    type: 'select',
    label: 'Speech engine',
    options: [['piper', 'Piper (offline)'], ['voicebox', 'VoiceBox']]
  },
  auto_speak: { type: 'toggle', label: 'Speak responses automatically' },
  stt_lang: {
    type: 'text',
    label: 'Speech-recognition language',
    hint: 'BCP 47 tag — e.g. en-US, en-AU, fr-FR'
  },
  thinking_enabled: { type: 'toggle', label: 'Enable thinking by default' },
  thinking_depth: {
    type: 'select',
    label: 'Default thinking depth',
    options: [['low', 'Low'], ['medium', 'Medium'], ['high', 'High']]
  },
  nav_rail: { type: 'toggle', label: 'Show the conversation navigator rail' },
  theme: {
    type: 'select',
    label: 'Theme',
    options: [['system', 'Match system'], ['light', 'Light'], ['dark', 'Dark']]
  }
};

var SETTINGS_CATEGORY_FIELDS = {
  models: ['chat_model', 'vision_model'],
  voice: ['tts_engine', 'auto_speak', 'stt_lang'],
  reasoning: ['thinking_enabled', 'thinking_depth'],
  interface: ['theme', 'nav_rail']
};

// Cached list of installed Ollama model names (populated lazily on first open
// of the Models category).
var _settingsModelNames = null;

/**
 * Resolve the settings-service base URL. `SETTINGS_API_URL` is a config.js
 * constant (registered as a lint global by Agent D); fall back to the
 * documented default so the module is self-contained under test.
 *
 * @param {string} [path] - path suffix appended verbatim
 * @returns {string}
 */
function _settingsApi(path) {
  var base =
    typeof SETTINGS_API_URL !== 'undefined' ? SETTINGS_API_URL : 'https://localhost/settings';
  return base + (path || '');
}

/**
 * Small createElement helper. `opts.class` sets className; `opts.text` sets
 * textContent; `opts.dataset` is a plain map; anything else is a property when
 * it exists on the node, else an attribute. Never uses innerHTML.
 *
 * @param {string} tag
 * @param {?object} opts
 * @param {Array<(Node|string)>} [kids]
 * @returns {HTMLElement}
 */
function _settingsEl(tag, opts, kids) {
  var node = document.createElement(tag);
  var o = opts || {};
  Object.keys(o).forEach(function (k) {
    if (k === 'class') node.className = o[k];
    else if (k === 'text') node.textContent = o[k];
    else if (k === 'dataset') {
      Object.keys(o[k]).forEach(function (d) {
        node.dataset[d] = o[k][d];
      });
    } else if (k in node) node[k] = o[k];
    else node.setAttribute(k, o[k]);
  });
  (kids || []).forEach(function (c) {
    if (c === null || c === undefined) return;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  });
  return node;
}

/**
 * Build a `<select>` from `[value, label]` pairs and preselect `value`.
 *
 * @param {Array<Array<string>>} pairs
 * @param {*} value
 * @param {?object} attrs
 * @returns {HTMLSelectElement}
 */
function _settingsSelect(pairs, value, attrs) {
  var sel = _settingsEl('select', attrs || {});
  pairs.forEach(function (pair) {
    var opt = _settingsEl('option', { value: pair[0], text: pair[1] });
    if (String(pair[0]) === String(value)) opt.selected = true;
    sel.appendChild(opt);
  });
  return sel;
}

/**
 * The current snapshot object (never null once main.js has run; this module
 * treats a missing one as the unavailable state).
 *
 * @returns {object}
 */
function _settingsSnapshot() {
  if (typeof window === 'undefined' || !window.vpalSettings) {
    return { __unavailable: true, global: {}, personas: {}, defaults: { global: {}, persona: {} } };
  }
  return window.vpalSettings;
}

/** @returns {boolean} true when a conversation is in progress. */
function _settingsConversationActive() {
  return (
    typeof conversationHistory !== 'undefined' &&
    Array.isArray(conversationHistory) &&
    conversationHistory.length > 0
  );
}

/** @returns {string} the resolved active persona key. */
function _settingsActivePersona(snapshot) {
  var s = snapshot || _settingsSnapshot();
  var v = resolveSetting('active_persona', null, s);
  return SETTINGS_PERSONA_KEYS.indexOf(v) !== -1 ? v : 'englishEditor';
}

// -- Lightbox construction --------------------------------------------------

/**
 * Build the hidden lightbox DOM into `#settingsRoot`. Idempotent; a no-op when
 * `#settingsRoot` is absent. Called by main.js from DOMContentLoaded.
 *
 * @returns {void}
 */
function initSettings() {
  if (_settingsInited) return;
  var root = typeof document !== 'undefined' ? document.getElementById('settingsRoot') : null;
  if (!root) return;
  _settingsInited = true;

  var backdrop = _settingsEl('div', { id: 'settingsBackdrop', class: 'lightbox__backdrop' });
  backdrop.addEventListener('click', function () {
    _settingsAttemptClose();
  });

  var closeBtn = _settingsEl('button', {
    id: 'settingsCloseBtn',
    class: 'settings-close',
    type: 'button',
    'aria-label': 'Close settings',
    text: '✕'
  });
  closeBtn.addEventListener('click', function () {
    _settingsAttemptClose();
  });

  var header = _settingsEl('div', { class: 'settings-header' }, [
    _settingsEl('span', { class: 'settings-title', text: 'Settings' }),
    closeBtn
  ]);

  var nav = _settingsEl('div', { id: 'settingsNav' });
  var panel = _settingsEl('div', { id: 'settingsPanel' });
  var body = _settingsEl('div', { class: 'settings-body' }, [nav, panel]);

  var resetAll = _settingsEl('button', {
    id: 'settingsResetAll',
    class: 'settings-reset-all',
    type: 'button',
    text: 'Reset all settings'
  });
  resetAll.addEventListener('click', _settingsOnResetAll);

  // Backup block — export the raw GET /settings JSON to a file, or import one
  // back. Ids are `settings*`-scoped so the history lightbox's `history-*` CSS
  // never collides. `.settings-backup-btn` gives them the same neutral pill as
  // `#settingsResetAll` so the footer reads as one row of peer buttons.
  var exportBtn = _settingsEl('button', {
    id: 'settingsExportBtn',
    class: 'settings-backup-btn',
    type: 'button',
    text: 'Export settings'
  });
  exportBtn.addEventListener('click', _settingsExportBackup);

  var importBtn = _settingsEl('button', {
    id: 'settingsImportBtn',
    class: 'settings-backup-btn',
    type: 'button',
    text: 'Import settings'
  });
  var importInput = _settingsEl('input', {
    id: 'settingsImportInput',
    type: 'file',
    accept: 'application/json'
  });
  importInput.style.display = 'none';
  importBtn.addEventListener('click', function () {
    importInput.value = '';
    importInput.click();
  });
  importInput.addEventListener('change', function () {
    var file = importInput.files && importInput.files[0];
    if (file) _settingsImportBackup(file);
  });

  var backup = _settingsEl('div', { id: 'settingsBackup', class: 'settings-backup' }, [
    _settingsEl('span', { class: 'settings-backup-label', text: 'Backup' }),
    exportBtn,
    importBtn,
    importInput
  ]);

  var footer = _settingsEl('div', { class: 'settings-footer' }, [resetAll, backup]);

  var lightbox = _settingsEl(
    'div',
    {
      id: 'settingsLightbox',
      class: 'lightbox__panel',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': 'Settings'
    },
    [header, body, footer]
  );

  root.appendChild(backdrop);
  root.appendChild(lightbox);

  if (!_settingsKeydownBound) {
    document.addEventListener('keydown', _settingsOnKeydown);
    _settingsKeydownBound = true;
  }
}

/**
 * Show the lightbox and select a category.
 *
 * @param {('models'|'voice'|'reasoning'|'interface'|'personas')} [categoryId]
 * @returns {void}
 */
function openSettings(categoryId) {
  if (!_settingsInited) initSettings();
  var lightbox = document.getElementById('settingsLightbox');
  var backdrop = document.getElementById('settingsBackdrop');
  if (!lightbox || !backdrop) return;

  _settingsOpener =
    document.activeElement && document.activeElement !== document.body
      ? document.activeElement
      : null;

  // Fresh edit state on every open.
  _settingsEdits = {
    models: {},
    voice: {},
    reasoning: {},
    interface: {},
    personas: {},
    personaOverride: { personaKey: null, values: {} }
  };
  _settingsEditPersona = _settingsActivePersona();

  var valid = SETTINGS_CATEGORIES.some(function (c) {
    return c.id === categoryId;
  });
  _settingsActiveCategory = valid ? categoryId : 'models';

  _settingsRenderNav();
  _settingsRenderPanel();

  backdrop.classList.add('open');
  lightbox.classList.add('open');
  _settingsOpen = true;

  var focusable = _settingsFocusable();
  if (focusable.length) focusable[0].focus();
}

/**
 * Hide the lightbox and restore focus to whatever opened it. Does not prompt;
 * callers that need the discard confirm go through `_settingsAttemptClose`.
 *
 * @returns {void}
 */
function closeSettings() {
  var lightbox = document.getElementById('settingsLightbox');
  var backdrop = document.getElementById('settingsBackdrop');
  if (lightbox) lightbox.classList.remove('open');
  if (backdrop) backdrop.classList.remove('open');
  _settingsOpen = false;
  if (_settingsOpener && typeof _settingsOpener.focus === 'function') {
    _settingsOpener.focus();
  }
  _settingsOpener = null;
}

/**
 * Close via a UI gesture (Escape / backdrop / ✕). Confirms first when any
 * category has unsaved edits.
 *
 * @returns {void}
 */
function _settingsAttemptClose() {
  if (_settingsAnyDirty()) {
    _settingsShowConfirm('Discard unsaved changes?', function () {
      closeSettings();
    });
    return;
  }
  closeSettings();
}

// -- Dirty tracking --------------------------------------------------------

/** @returns {boolean} true when the given category has pending edits. */
function _settingsCategoryDirty(categoryId) {
  if (categoryId === 'personas') {
    return (
      Object.keys(_settingsEdits.personas).length > 0 ||
      Object.keys(_settingsEdits.personaOverride.values).length > 0
    );
  }
  return Object.keys(_settingsEdits[categoryId] || {}).length > 0;
}

/** @returns {boolean} true when any category has pending edits. */
function _settingsAnyDirty() {
  return SETTINGS_CATEGORIES.some(function (c) {
    return _settingsCategoryDirty(c.id);
  });
}

// -- Rendering: nav -------------------------------------------------------

function _settingsRenderNav() {
  var nav = document.getElementById('settingsNav');
  if (!nav) return;
  while (nav.firstChild) nav.removeChild(nav.firstChild);

  SETTINGS_CATEGORIES.forEach(function (cat) {
    var btn = _settingsEl('button', {
      class:
        'settings-nav-btn' + (cat.id === _settingsActiveCategory ? ' is-active' : ''),
      type: 'button',
      dataset: { category: cat.id },
      text: cat.label
    });
    btn.addEventListener('click', function () {
      if (cat.id === _settingsActiveCategory) return;
      var leaving = _settingsActiveCategory;
      if (_settingsCategoryDirty(leaving)) {
        _settingsShowConfirm(
          'Discard unsaved changes in ' + _settingsCategoryLabel(leaving) + '?',
          function () {
            _settingsResetCategoryEdits(leaving);
            _settingsActiveCategory = cat.id;
            _settingsRenderNav();
            _settingsRenderPanel();
          }
        );
        return;
      }
      _settingsActiveCategory = cat.id;
      _settingsRenderNav();
      _settingsRenderPanel();
    });
    nav.appendChild(btn);
  });
}

function _settingsCategoryLabel(categoryId) {
  var found = SETTINGS_CATEGORIES.filter(function (c) {
    return c.id === categoryId;
  })[0];
  return found ? found.label : categoryId;
}

function _settingsResetCategoryEdits(categoryId) {
  if (categoryId === 'personas') {
    _settingsEdits.personas = {};
    _settingsEdits.personaOverride = { personaKey: null, values: {} };
    return;
  }
  _settingsEdits[categoryId] = {};
}

// -- Rendering: panel ---------------------------------------------------

function _settingsRenderPanel() {
  var panel = document.getElementById('settingsPanel');
  if (!panel) return;
  while (panel.firstChild) panel.removeChild(panel.firstChild);

  var snapshot = _settingsSnapshot();
  if (snapshot.__unavailable === true) {
    panel.appendChild(_settingsRenderUnavailable());
    return;
  }

  if (_settingsActiveCategory === 'personas') {
    panel.appendChild(_settingsRenderPersonasCategory(snapshot));
  } else {
    panel.appendChild(_settingsRenderGlobalCategory(_settingsActiveCategory, snapshot));
  }
}

function _settingsRenderUnavailable() {
  var wrap = _settingsEl('div', {
    class: 'settings-category settings-unavailable',
    dataset: { category: _settingsActiveCategory }
  });
  wrap.appendChild(
    _settingsEl('p', {
      class: 'settings-note',
      text: "Can't reach the settings service. Your changes can't be saved right now."
    })
  );
  var retry = _settingsEl('button', {
    class: 'settings-save',
    type: 'button',
    text: 'Retry'
  });
  retry.addEventListener('click', function () {
    if (typeof window !== 'undefined' && typeof window.__vpalRetrySettings === 'function') {
      Promise.resolve(window.__vpalRetrySettings()).then(function () {
        _settingsRenderPanel();
        applyResolvedSettings();
      });
      return;
    }
    _settingsReloadSnapshot().then(function () {
      _settingsRenderPanel();
      applyResolvedSettings();
    });
  });
  wrap.appendChild(retry);
  return wrap;
}

/**
 * Current form value for a global field: the pending edit if there is one,
 * otherwise the resolved (persisted) value.
 */
function _settingsGlobalFormValue(categoryId, key, snapshot) {
  var edits = _settingsEdits[categoryId] || {};
  if (Object.prototype.hasOwnProperty.call(edits, key)) return edits[key];
  return resolveSetting(key, null, snapshot);
}

function _settingsGlobalDefault(key, snapshot) {
  var defaults = (snapshot.defaults && snapshot.defaults.global) || {};
  return defaults[key];
}

function _settingsRenderGlobalCategory(categoryId, snapshot) {
  var wrap = _settingsEl('div', {
    class: 'settings-category',
    dataset: { category: categoryId }
  });

  var confirmSlot = _settingsEl('div', { class: 'settings-confirm-slot' });
  wrap.appendChild(confirmSlot);

  SETTINGS_CATEGORY_FIELDS[categoryId].forEach(function (key) {
    wrap.appendChild(_settingsRenderGlobalField(categoryId, key, snapshot));
  });

  wrap.appendChild(_settingsRenderCategoryActions(categoryId));
  return wrap;
}

function _settingsRenderGlobalField(categoryId, key, snapshot) {
  var def = SETTINGS_FIELD_DEFS[key];
  var value = _settingsGlobalFormValue(categoryId, key, snapshot);
  var defaultValue = _settingsGlobalDefault(key, snapshot);

  var row = _settingsEl('div', { class: 'settings-field', dataset: { field: key } });

  var labelEl = _settingsEl('label', { text: def.label, for: 'settings-f-' + key });

  var resetBtn = _settingsEl('button', {
    class: 'settings-field-reset',
    type: 'button',
    title: 'Reset to default',
    text: '↺'
  });
  resetBtn.hidden = value === defaultValue;
  resetBtn.addEventListener('click', function () {
    _settingsResetKeys('global', [key]);
  });

  var top = _settingsEl('div', { class: 'settings-field-top' }, [labelEl, resetBtn]);
  row.appendChild(top);

  var control;
  if (def.type === 'model-select') {
    control = _settingsSelect(_settingsModelOptions(value), value, { id: 'settings-f-' + key });
    _settingsEnsureModelNames(function (names) {
      if (!names || !names.length) return;
      var fresh = names.map(function (n) {
        return [n, n];
      });
      if (names.indexOf(value) === -1) fresh.unshift([value, value + ' (not installed)']);
      var newSel = _settingsSelect(fresh, _settingsGlobalFormValue(categoryId, key, snapshot), {
        id: 'settings-f-' + key
      });
      newSel.addEventListener('change', function () {
        _settingsOnGlobalEdit(categoryId, key, newSel.value, snapshot, row);
      });
      if (control.parentNode) control.parentNode.replaceChild(newSel, control);
      control = newSel;
    });
    control.addEventListener('change', function () {
      _settingsOnGlobalEdit(categoryId, key, control.value, snapshot, row);
    });
  } else if (def.type === 'select') {
    control = _settingsSelect(def.options, value, { id: 'settings-f-' + key });
    control.addEventListener('change', function () {
      _settingsOnGlobalEdit(categoryId, key, control.value, snapshot, row);
    });
  } else if (def.type === 'toggle') {
    control = _settingsEl('input', { type: 'checkbox', id: 'settings-f-' + key });
    control.checked = !!value;
    control.addEventListener('change', function () {
      _settingsOnGlobalEdit(categoryId, key, control.checked, snapshot, row);
    });
  } else {
    control = _settingsEl('input', { type: 'text', id: 'settings-f-' + key, value: value || '' });
    control.addEventListener('input', function () {
      _settingsOnGlobalEdit(categoryId, key, control.value, snapshot, row);
    });
  }
  row.appendChild(control);

  if (def.hint) row.appendChild(_settingsEl('div', { class: 'settings-field-hint', text: def.hint }));

  return row;
}

function _settingsModelOptions(value) {
  if (_settingsModelNames && _settingsModelNames.length) {
    var pairs = _settingsModelNames.map(function (n) {
      return [n, n];
    });
    if (_settingsModelNames.indexOf(value) === -1 && value) {
      pairs.unshift([value, value + ' (not installed)']);
    }
    return pairs;
  }
  return [[value || '', value || '(none)']];
}

/**
 * Lazily fetch the installed-model list (once). Mirrors the toolbar model
 * selector's graceful fallback: on failure the stored value stays the only
 * option.
 *
 * @param {function(Array<string>)} cb
 * @returns {void}
 */
function _settingsEnsureModelNames(cb) {
  if (_settingsModelNames !== null) {
    cb(_settingsModelNames);
    return;
  }
  var url = typeof OLLAMA_TAGS_URL !== 'undefined' ? OLLAMA_TAGS_URL : null;
  if (!url || typeof fetch === 'undefined') {
    _settingsModelNames = [];
    cb(_settingsModelNames);
    return;
  }
  // redirect: 'manual' so an expired session (nginx 302 -> /auth/login) surfaces
  // as an opaqueredirect we can act on, instead of silently resolving to the
  // login HTML and looking like an Ollama failure. Mirrors api.js.
  fetch(url, { redirect: 'manual' })
    .then(function (r) {
      if (r.type === 'opaqueredirect') {
        window.location.reload();
        return null;
      }
      if (!r.ok) throw new Error('tags ' + r.status);
      return r.json();
    })
    .then(function (json) {
      if (json === null) return; // reloading for auth
      _settingsModelNames =
        typeof parseOllamaModels === 'function' ? parseOllamaModels(json) : [];
      // Same payload also carries per-model context windows — refresh the map
      // and re-cap num_ctx in case the installed models changed since load.
      if (typeof parseModelContextLengths === 'function' && typeof modelContextLengths !== 'undefined') {
        modelContextLengths = parseModelContextLengths(json);
        recomputeNumCtx();
      }
      cb(_settingsModelNames);
    })
    .catch(function () {
      _settingsModelNames = [];
      if (typeof showToast === 'function') showToast('Could not load model list from Ollama');
      cb(_settingsModelNames);
    });
}

function _settingsOnGlobalEdit(categoryId, key, value, snapshot, row) {
  var resolved = resolveSetting(key, null, snapshot);
  if (value === resolved) delete _settingsEdits[categoryId][key];
  else _settingsEdits[categoryId][key] = value;

  var defaultValue = _settingsGlobalDefault(key, snapshot);
  var resetBtn = row.querySelector('.settings-field-reset');
  if (resetBtn) resetBtn.hidden = value === defaultValue;

  _settingsRefreshActions(categoryId);
}

// -- Rendering: category actions (Save / Cancel / Reset this section) -------

function _settingsRenderCategoryActions(categoryId) {
  var actions = _settingsEl('div', { class: 'settings-actions' });

  var save = _settingsEl('button', {
    class: 'settings-save',
    type: 'button',
    text: 'Save'
  });
  save.disabled = !_settingsCategoryDirty(categoryId);
  save.addEventListener('click', function () {
    _settingsSaveCategory(categoryId);
  });

  var cancel = _settingsEl('button', {
    class: 'settings-cancel',
    type: 'button',
    text: 'Cancel'
  });
  cancel.disabled = !_settingsCategoryDirty(categoryId);
  cancel.addEventListener('click', function () {
    if (!_settingsCategoryDirty(categoryId)) return;
    _settingsShowConfirm(
      'Discard unsaved changes in ' + _settingsCategoryLabel(categoryId) + '?',
      function () {
        _settingsResetCategoryEdits(categoryId);
        _settingsRenderPanel();
      }
    );
  });

  var sectionReset = _settingsEl('button', {
    class: 'settings-section-reset',
    type: 'button',
    text: 'Reset this section'
  });
  sectionReset.addEventListener('click', function () {
    _settingsShowConfirm(
      'Reset all ' + _settingsCategoryLabel(categoryId) + ' settings to defaults?',
      function () {
        var scope = categoryId === 'personas' ? 'persona:' + _settingsEditPersona : 'global';
        _settingsResetScope(scope);
      }
    );
  });

  actions.appendChild(save);
  actions.appendChild(cancel);
  actions.appendChild(sectionReset);
  return actions;
}

function _settingsRefreshActions(categoryId) {
  var panel = document.getElementById('settingsPanel');
  if (!panel) return;
  var dirty = _settingsCategoryDirty(categoryId);
  var save = panel.querySelector('.settings-save');
  var cancel = panel.querySelector('.settings-cancel');
  if (save && save.parentNode && save.parentNode.classList.contains('settings-actions')) {
    save.disabled = !dirty;
  }
  if (cancel) cancel.disabled = !dirty;
}

// -- Rendering: personas category -----------------------------------------

function _settingsRenderPersonasCategory(snapshot) {
  var wrap = _settingsEl('div', {
    class: 'settings-category',
    dataset: { category: 'personas' }
  });
  wrap.appendChild(_settingsEl('div', { class: 'settings-confirm-slot' }));

  // Active persona -------------------------------------------------------
  var activeStored = _settingsActivePersona(snapshot);
  var activeValue = Object.prototype.hasOwnProperty.call(
    _settingsEdits.personas,
    'active_persona'
  )
    ? _settingsEdits.personas.active_persona
    : activeStored;

  var activeRow = _settingsEl('div', { class: 'settings-field', dataset: { field: 'active_persona' } });
  activeRow.appendChild(
    _settingsEl('div', { class: 'settings-field-top' }, [
      _settingsEl('label', { text: 'Active persona', for: 'settings-active-persona' })
    ])
  );
  var activeSelect = _settingsSelect(
    SETTINGS_PERSONA_KEYS.map(function (k) {
      return [k, SETTINGS_PERSONA_LABELS[k]];
    }),
    activeValue,
    { id: 'settings-active-persona' }
  );
  var convoActive = _settingsConversationActive();
  activeSelect.disabled = convoActive;
  activeSelect.addEventListener('change', function () {
    if (activeSelect.value === activeStored) delete _settingsEdits.personas.active_persona;
    else _settingsEdits.personas.active_persona = activeSelect.value;
    _settingsRefreshActions('personas');
  });
  activeRow.appendChild(activeSelect);
  if (convoActive) {
    activeRow.appendChild(
      _settingsEl('div', {
        class: 'settings-note',
        text: 'Finish or clear the conversation to switch persona.'
      })
    );
  }
  wrap.appendChild(activeRow);

  // Edit persona --------------------------------------------------------
  var editRow = _settingsEl('div', { class: 'settings-field', dataset: { field: 'edit_persona' } });
  editRow.appendChild(
    _settingsEl('div', { class: 'settings-field-top' }, [
      _settingsEl('label', { text: 'Edit persona', for: 'settings-edit-persona' })
    ])
  );
  var editSelect = _settingsSelect(
    SETTINGS_PERSONA_KEYS.map(function (k) {
      return [k, SETTINGS_PERSONA_LABELS[k]];
    }),
    _settingsEditPersona,
    { id: 'settings-edit-persona' }
  );
  editSelect.addEventListener('change', function () {
    var target = editSelect.value;
    var pendingKey = _settingsEdits.personaOverride.personaKey;
    if (
      pendingKey &&
      pendingKey !== target &&
      Object.keys(_settingsEdits.personaOverride.values).length
    ) {
      _settingsShowConfirm('Discard unsaved changes in Personas?', function () {
        _settingsEdits.personaOverride = { personaKey: null, values: {} };
        _settingsEditPersona = target;
        _settingsRenderPanel();
      });
      editSelect.value = _settingsEditPersona;
      return;
    }
    _settingsEditPersona = target;
    _settingsRenderPanel();
  });
  editRow.appendChild(editSelect);
  wrap.appendChild(editRow);

  wrap.appendChild(_settingsRenderPersonaOverrideFields(snapshot));
  wrap.appendChild(_settingsRenderCategoryActions('personas'));
  return wrap;
}

var SETTINGS_OVERRIDE_DEFS = [
  {
    key: 'thinking_enabled',
    label: 'Thinking',
    options: [['__inherit', 'Inherit'], ['true', 'On'], ['false', 'Off']]
  },
  {
    key: 'thinking_depth',
    label: 'Thinking depth',
    options: [
      ['__inherit', 'Inherit'],
      ['low', 'Low'],
      ['medium', 'Medium'],
      ['high', 'High']
    ]
  },
  {
    key: 'tts_engine',
    label: 'Speech engine',
    options: [['__inherit', 'Inherit'], ['piper', 'Piper'], ['voicebox', 'VoiceBox']]
  }
];

/** Map an override value (`null` | bool | string) to its `<select>` token. */
function _settingsOverrideToken(key, value) {
  if (value === null || value === undefined) return '__inherit';
  if (key === 'thinking_enabled') return value ? 'true' : 'false';
  return String(value);
}

/** Inverse of `_settingsOverrideToken`. */
function _settingsTokenToOverride(key, token) {
  if (token === '__inherit') return null;
  if (key === 'thinking_enabled') return token === 'true';
  return token;
}

function _settingsPersonaOverrideValue(key, snapshot) {
  var edits = _settingsEdits.personaOverride;
  if (
    edits.personaKey === _settingsEditPersona &&
    Object.prototype.hasOwnProperty.call(edits.values, key)
  ) {
    return edits.values[key];
  }
  var stored = (snapshot.personas && snapshot.personas[_settingsEditPersona]) || {};
  return Object.prototype.hasOwnProperty.call(stored, key) ? stored[key] : null;
}

function _settingsPersonaOverrideDefault(key, snapshot) {
  var d = (snapshot.defaults && snapshot.defaults.persona) || {};
  return Object.prototype.hasOwnProperty.call(d, key) ? d[key] : null;
}

function _settingsRenderPersonaOverrideFields(snapshot) {
  var group = _settingsEl('div', { class: 'settings-persona-overrides' });
  var key = _settingsEditPersona;

  // Persona identity row — its icon + name (the icon comes from the
  // settings-service, see personaIconEl in chat.js).
  var idRow = _settingsEl('div', { class: 'settings-persona-identity' });
  if (typeof personaIconEl === 'function') {
    var pIcon = personaIconEl(key);
    if (pIcon) {
      var iconWrap = _settingsEl('span', { class: 'settings-persona-icon' });
      iconWrap.appendChild(pIcon);
      idRow.appendChild(iconWrap);
    }
  }
  idRow.appendChild(
    _settingsEl('span', {
      class: 'settings-persona-name',
      text: SETTINGS_PERSONA_LABELS[key] || key
    })
  );
  group.appendChild(idRow);

  var defs = SETTINGS_OVERRIDE_DEFS.slice();
  if (key === 'englishEditor') {
    defs.push({
      key: 'editor_mode',
      label: 'Editor output',
      options: [['clean', 'Clean'], ['changes', 'Changes'], ['explain', 'Explain']],
      noInherit: true,
      fallback: 'clean'
    });
  }
  if (key === 'professional') {
    defs.push({
      key: 'default_analysis_view',
      label: 'Default analysis view',
      options: [['structured', 'Structured'], ['text', 'Text']],
      noInherit: true,
      fallback: 'structured'
    });
  }

  defs.forEach(function (def) {
    var fb = def.fallback || 'clean';
    var value = _settingsPersonaOverrideValue(def.key, snapshot);
    var token = def.noInherit ? String(value || fb) : _settingsOverrideToken(def.key, value);
    var defaultValue = def.noInherit
      ? fb
      : _settingsPersonaOverrideDefault(def.key, snapshot);

    var row = _settingsEl('div', { class: 'settings-field', dataset: { field: def.key } });

    var resetBtn = _settingsEl('button', {
      class: 'settings-field-reset',
      type: 'button',
      title: 'Reset to default',
      text: '↺'
    });
    resetBtn.hidden = _settingsOverrideEqualsDefault(def, value, defaultValue);
    resetBtn.addEventListener('click', function () {
      _settingsResetKeys('persona:' + key, [def.key]);
    });

    row.appendChild(
      _settingsEl('div', { class: 'settings-field-top' }, [
        _settingsEl('label', { text: def.label, for: 'settings-o-' + def.key }),
        resetBtn
      ])
    );

    var sel = _settingsSelect(def.options, token, { id: 'settings-o-' + def.key });
    sel.addEventListener('change', function () {
      var next = def.noInherit ? sel.value : _settingsTokenToOverride(def.key, sel.value);
      _settingsOnPersonaOverrideEdit(def, next, snapshot, row);
    });
    row.appendChild(sel);
    group.appendChild(row);
  });

  // Read-only system prompt.
  var prompt =
    typeof systemPrompts !== 'undefined' && systemPrompts[key] ? systemPrompts[key] : '';
  var details = _settingsEl('details', { class: 'settings-prompt-details' }, [
    _settingsEl('summary', { text: 'View system prompt' }),
    _settingsEl('div', { class: 'settings-prompt-view', text: prompt })
  ]);
  group.appendChild(details);

  return group;
}

function _settingsOverrideEqualsDefault(def, value, defaultValue) {
  if (def.noInherit) return String(value || (def.fallback || 'clean')) === String(defaultValue);
  return value === defaultValue;
}

function _settingsOnPersonaOverrideEdit(def, next, snapshot, row) {
  var edits = _settingsEdits.personaOverride;
  if (edits.personaKey !== _settingsEditPersona) {
    edits.personaKey = _settingsEditPersona;
    edits.values = {};
  }
  var fb = def.fallback || 'clean';
  var stored = (snapshot.personas && snapshot.personas[_settingsEditPersona]) || {};
  var storedValue = Object.prototype.hasOwnProperty.call(stored, def.key)
    ? stored[def.key]
    : def.noInherit
      ? fb
      : null;

  if (next === storedValue) delete edits.values[def.key];
  else edits.values[def.key] = next;

  var defaultValue = def.noInherit
    ? fb
    : _settingsPersonaOverrideDefault(def.key, snapshot);
  var resetBtn = row.querySelector('.settings-field-reset');
  if (resetBtn) resetBtn.hidden = _settingsOverrideEqualsDefault(def, next, defaultValue);

  _settingsRefreshActions('personas');
}

// -- Inline confirm ------------------------------------------------------

function _settingsShowConfirm(message, onYes) {
  var slot = document.querySelector('#settingsPanel .settings-confirm-slot');
  if (!slot) {
    // No slot (unavailable state) — fall back to acting immediately.
    onYes();
    return;
  }
  while (slot.firstChild) slot.removeChild(slot.firstChild);

  var yes = _settingsEl('button', {
    class: 'settings-confirm-yes',
    type: 'button',
    text: 'Discard'
  });
  var no = _settingsEl('button', {
    class: 'settings-confirm-no',
    type: 'button',
    text: 'Keep editing'
  });
  var bar = _settingsEl('div', { class: 'settings-confirm' }, [
    _settingsEl('span', { text: message }),
    yes,
    no
  ]);
  yes.addEventListener('click', function () {
    while (slot.firstChild) slot.removeChild(slot.firstChild);
    onYes();
  });
  no.addEventListener('click', function () {
    while (slot.firstChild) slot.removeChild(slot.firstChild);
  });
  slot.appendChild(bar);
  yes.focus();
}

// -- Save --------------------------------------------------------------

function _settingsSaveCategory(categoryId) {
  var snapshot = _settingsSnapshot();
  if (snapshot.__unavailable === true) return;

  if (categoryId === 'personas') {
    _settingsSavePersonas(snapshot);
    return;
  }

  var edits = _settingsEdits[categoryId] || {};
  var changed = {};
  Object.keys(edits).forEach(function (k) {
    changed[k] = edits[k];
  });
  if (!Object.keys(changed).length) return;

  _settingsPut(_settingsApi('/global'), changed)
    .then(function (resp) {
      if (!resp || resp.ok !== true) {
        _settingsSaveErrorToast(resp);
        return;
      }
      window.vpalSettings = _settingsMergeGlobal(snapshot, resp.global);
      _settingsEdits[categoryId] = {};
      applyResolvedSettings();
      if (typeof showToast === 'function') {
        showToast(_settingsCategoryLabel(categoryId) + ' saved');
      }
      _settingsRenderPanel();
    })
    .catch(function () {
      _settingsSaveErrorToast(null);
    });
}

function _settingsSavePersonas(snapshot) {
  var tasks = [];

  if (Object.prototype.hasOwnProperty.call(_settingsEdits.personas, 'active_persona')) {
    var storedActive = _settingsActivePersona(snapshot);
    if (_settingsEdits.personas.active_persona !== storedActive) {
      tasks.push(
        _settingsPut(_settingsApi('/global'), {
          active_persona: _settingsEdits.personas.active_persona
        }).then(function (resp) {
          if (!resp || resp.ok !== true) throw new Error((resp && resp.error) || '');
          window.vpalSettings = _settingsMergeGlobal(_settingsSnapshot(), resp.global);
        })
      );
    }
  }

  var oEdits = _settingsEdits.personaOverride;
  if (oEdits.personaKey && Object.keys(oEdits.values).length) {
    var body = {};
    Object.keys(oEdits.values).forEach(function (k) {
      body[k] = oEdits.values[k];
    });
    var pKey = oEdits.personaKey;
    tasks.push(
      _settingsPut(_settingsApi('/persona/' + pKey), body).then(function (resp) {
        if (!resp || resp.ok !== true) throw new Error((resp && resp.error) || '');
        var s = _settingsSnapshot();
        s.personas = s.personas || {};
        s.personas[pKey] = resp.persona;
        window.vpalSettings = s;
      })
    );
  }

  if (!tasks.length) return;

  Promise.all(tasks)
    .then(function () {
      _settingsEdits.personas = {};
      _settingsEdits.personaOverride = { personaKey: null, values: {} };
      applyResolvedSettings();
      if (typeof showToast === 'function') showToast('Personas saved');
      _settingsRenderPanel();
    })
    .catch(function (e) {
      _settingsSaveErrorToast(e && e.message ? { error: e.message } : null);
    });
}

function _settingsMergeGlobal(snapshot, freshGlobal) {
  var s = snapshot || {};
  var merged = {
    global: freshGlobal || s.global || {},
    personas: s.personas || {},
    defaults: s.defaults || { global: {}, persona: {} }
  };
  return merged;
}

/**
 * Switch the active persona without opening the Settings lightbox — used by the
 * header persona picker (main.js) and by history.js when a loaded conversation
 * carries its own `persona_key`. PUTs `active_persona` to `/settings/global`,
 * merges the response into `window.vpalSettings`, and re-applies. Never throws;
 * a no-op (resolves `false`) when the key is unknown or already active.
 *
 * @param {string} personaKey
 * @returns {Promise<boolean>} true when the persona actually changed
 */
function setActivePersona(personaKey) {
  if (typeof personaKey !== 'string' || SETTINGS_PERSONA_KEYS.indexOf(personaKey) === -1) {
    return Promise.resolve(false);
  }
  if (_settingsActivePersona() === personaKey) return Promise.resolve(false);
  if (typeof fetch === 'undefined') return Promise.resolve(false);

  return _settingsPut(_settingsApi('/global'), { active_persona: personaKey })
    .then(function (resp) {
      if (!resp || resp.ok !== true) throw new Error('persona save failed');
      window.vpalSettings = _settingsMergeGlobal(_settingsSnapshot(), resp.global);
      if (typeof applyResolvedSettings === 'function') applyResolvedSettings();
      // Keep the (possibly open) Personas panel in sync.
      if (_settingsInited && _settingsActiveCategory === 'personas') {
        _settingsEditPersona = _settingsActivePersona();
        _settingsRenderPanel();
      }
      return true;
    })
    .catch(function () {
      if (typeof showToast === 'function') showToast('Could not switch persona');
      return false;
    });
}

// -- Reset ------------------------------------------------------------

function _settingsOnResetAll() {
  _settingsShowConfirm('Reset every setting to its default? This cannot be undone.', function () {
    _settingsResetScope('all');
  });
}

function _settingsResetScope(scope) {
  _settingsPost(_settingsApi('/reset'), { scope: scope })
    .then(function (resp) {
      if (!resp || resp.ok !== true) throw new Error('reset failed');
      return _settingsReloadSnapshot();
    })
    .then(function () {
      _settingsEdits = {
        models: {},
        voice: {},
        reasoning: {},
        interface: {},
        personas: {},
        personaOverride: { personaKey: null, values: {} }
      };
      applyResolvedSettings();
      _settingsRenderNav();
      _settingsRenderPanel();
      if (typeof showToast === 'function') showToast('Settings reset');
    })
    .catch(function () {
      if (typeof showToast === 'function') showToast('Could not reset settings');
    });
}

function _settingsResetKeys(scope, keys) {
  _settingsPost(_settingsApi('/reset'), { scope: scope, keys: keys })
    .then(function (resp) {
      if (!resp || resp.ok !== true) throw new Error('reset failed');
      return _settingsReloadSnapshot();
    })
    .then(function () {
      applyResolvedSettings();
      _settingsRenderPanel();
      if (typeof showToast === 'function') showToast('Reset to default');
    })
    .catch(function () {
      if (typeof showToast === 'function') showToast('Could not reset settings');
    });
}

// -- Backup: export / import --------------------------------------------

/** Timestamp for a backup filename: `YYYYMMDD-HHMMSS` (local time). */
function _settingsBackupStamp(now) {
  var d = now || new Date();
  var p = function (n) {
    return String(n).padStart(2, '0');
  };
  return (
    '' +
    d.getFullYear() +
    p(d.getMonth() + 1) +
    p(d.getDate()) +
    '-' +
    p(d.getHours()) +
    p(d.getMinutes()) +
    p(d.getSeconds())
  );
}

/**
 * Download the current `GET /settings` payload as
 * `vpal-settings-<YYYYMMDD-HHMMSS>.json`.
 *
 * @returns {void}
 */
function _settingsExportBackup() {
  if (typeof fetch === 'undefined') return;
  fetch(_settingsApi(''), { credentials: 'same-origin' })
    .then(function (r) {
      if (!r.ok) throw new Error('GET /settings ' + r.status);
      return r.json();
    })
    .then(function (data) {
      var json = JSON.stringify(data, null, 2);
      var blob = new Blob([json], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = 'vpal-settings-' + _settingsBackupStamp() + '.json';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      if (typeof showToast === 'function') showToast('Settings exported');
    })
    .catch(function () {
      if (typeof showToast === 'function') showToast('Settings export failed');
    });
}

/** Strip `null` / `undefined` values from a persona override object. */
function _settingsNonNull(obj) {
  var out = {};
  Object.keys(obj || {}).forEach(function (k) {
    if (obj[k] !== null && obj[k] !== undefined) out[k] = obj[k];
  });
  return out;
}

/**
 * Read a settings-export JSON file and push it back into the service: `PUT
 * /global` with `parsed.global`, then `PUT /persona/<k>` with each persona's
 * non-null overrides, then re-`GET` and re-apply. Any failure → a single toast.
 *
 * @param {File} file
 * @returns {void}
 */
function _settingsImportBackup(file) {
  if (!file || typeof file.text !== 'function') {
    if (typeof showToast === 'function') showToast('Settings import failed');
    return;
  }
  file
    .text()
    .then(function (raw) {
      var parsed = JSON.parse(raw);
      if (!parsed || !parsed.global || typeof parsed.global !== 'object') {
        if (typeof showToast === 'function') showToast('Not a settings file');
        return null;
      }
      var chain = _settingsPut(_settingsApi('/global'), parsed.global).then(function (resp) {
        if (!resp || resp.ok !== true) throw new Error('import global');
      });
      var personas = parsed.personas || {};
      Object.keys(personas).forEach(function (key) {
        var body = _settingsNonNull(personas[key]);
        if (!Object.keys(body).length) return;
        chain = chain.then(function () {
          return _settingsPut(_settingsApi('/persona/' + encodeURIComponent(key)), body).then(
            function (resp) {
              if (!resp || resp.ok !== true) throw new Error('import persona ' + key);
            }
          );
        });
      });
      return chain
        .then(function () {
          return _settingsReloadSnapshot();
        })
        .then(function () {
          if (typeof applyResolvedSettings === 'function') applyResolvedSettings();
          if (_settingsInited) {
            _settingsRenderNav();
            _settingsRenderPanel();
          }
          if (typeof showToast === 'function') showToast('Settings imported');
        });
    })
    .catch(function () {
      if (typeof showToast === 'function') showToast('Settings import failed');
    });
}

// -- Network helpers -------------------------------------------------

function _settingsReloadSnapshot() {
  if (typeof fetch === 'undefined') return Promise.resolve();
  return fetch(_settingsApi(''), { credentials: 'same-origin' })
    .then(function (r) {
      if (!r.ok) throw new Error('GET /settings ' + r.status);
      return r.json();
    })
    .then(function (json) {
      window.vpalSettings = json;
    });
}

// Toast text for a failed settings write. `resp` is _settingsPut / _settingsPost's
// parsed body; on a 4xx the service sends `{ ok:false, error:"<reason>" }` —
// surface that so a rejected value, or a settings-service still running an older
// image without a newly-added key ("unknown global setting: theme"), is
// diagnosable instead of a bare "Could not save settings".
function _settingsSaveErrorToast(resp) {
  if (typeof showToast !== 'function') return;
  var detail = resp && typeof resp.error === 'string' && resp.error ? ' — ' + resp.error : '';
  showToast('Could not save settings' + detail);
}

function _settingsPut(url, body) {
  return fetch(url, {
    method: 'PUT',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }).then(function (r) {
    return r.json().catch(function () {
      return { ok: false };
    });
  });
}

function _settingsPost(url, body) {
  return fetch(url, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }).then(function (r) {
    return r.json().catch(function () {
      return { ok: false };
    });
  });
}

// -- Focus trap + keyboard ------------------------------------------

function _settingsFocusable() {
  var lightbox = document.getElementById('settingsLightbox');
  if (!lightbox) return [];
  return Array.prototype.slice
    .call(
      lightbox.querySelectorAll(
        'button:not(:disabled), select:not(:disabled), input:not(:disabled), a[href], [tabindex]:not([tabindex="-1"]), details summary'
      )
    )
    .filter(function (el) {
      return el.offsetParent !== null || el === document.activeElement;
    });
}

function _settingsOnKeydown(e) {
  if (!_settingsOpen) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    _settingsAttemptClose();
    return;
  }
  if (e.key !== 'Tab') return;
  var focusable = _settingsFocusable();
  if (!focusable.length) return;
  var first = focusable[0];
  var last = focusable[focusable.length - 1];
  var lightbox = document.getElementById('settingsLightbox');
  if (lightbox && !lightbox.contains(document.activeElement)) {
    e.preventDefault();
    first.focus();
    return;
  }
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

// -- Apply resolved settings to the app runtime -----------------------

/**
 * Push `window.vpalSettings` into the app's cross-module runtime globals and
 * refresh the toolbar badges. Every global / function touch is `typeof`
 * guarded so a partial environment (or Jest) never throws.
 *
 * @returns {void}
 */
function applyResolvedSettings() {
  var s = _settingsSnapshot();
  var active = _settingsActivePersona(s);

  var chatModel = resolveSetting('chat_model', null, s);
  var visionModel = resolveSetting('vision_model', null, s);
  var ttsEngine = resolveTtsEngine(active, s);
  var thinkingMode = resolveThinkingMode(active, s);
  var navRail = !!resolveSetting('nav_rail', null, s);
  var theme = resolveSetting('theme', null, s) || 'system';
  var editorMode = 'clean';
  if (s.personas && s.personas.englishEditor && s.personas.englishEditor.editor_mode) {
    editorMode = s.personas.englishEditor.editor_mode;
  }
  var consultView = 'structured';
  if (
    s.personas &&
    s.personas.professional &&
    s.personas.professional.default_analysis_view
  ) {
    consultView = s.personas.professional.default_analysis_view;
  }

  if (typeof currentModel !== 'undefined' && chatModel) currentModel = chatModel;
  if (typeof currentVisionModel !== 'undefined' && visionModel) currentVisionModel = visionModel;
  if (typeof currentTTSEngine !== 'undefined') currentTTSEngine = ttsEngine;
  if (typeof currentThinkingMode !== 'undefined') currentThinkingMode = thinkingMode;
  if (typeof currentEditorMode !== 'undefined') currentEditorMode = editorMode;
  if (typeof currentConsultView !== 'undefined') currentConsultView = consultView;
  if (typeof currentNavRailEnabled !== 'undefined') currentNavRailEnabled = navRail;
  if (typeof window !== 'undefined') window.currentNavRailEnabled = navRail;
  if (typeof setNavRailEnabled === 'function') setNavRailEnabled(navRail);
  _applyTheme(theme);

  // The chat model may have just changed — re-cap num_ctx to its context window.
  recomputeNumCtx();

  if (typeof currentSystemPrompt !== 'undefined') {
    if (typeof _resolveSystemPrompt === 'function') {
      currentSystemPrompt = _resolveSystemPrompt(active);
    } else if (typeof systemPrompts !== 'undefined' && systemPrompts[active]) {
      currentSystemPrompt = systemPrompts[active];
    }
  }

  _settingsUpdateBadges(chatModel, thinkingMode);

  // Refresh the header persona label + toggle lock state — a persona change
  // made inside the open dialog reaches the DOM only through this call.
  if (typeof updateSystemPromptState === 'function') updateSystemPromptState();
}

/**
 * Re-derive `currentNumCtx` (config.js) from the active chat model and the
 * `modelContextLengths` map: the model's full advertised context window when
 * known, else the OLLAMA_NUM_CTX fallback. Safe to call before the /api/tags
 * map has loaded (map is {} → uses the fallback). Called from
 * applyResolvedSettings() (model may have changed) and after each successful
 * /api/tags fetch (main.js at load, _settingsEnsureModelNames on dialog open).
 *
 * @returns {void}
 */
/**
 * Apply a resolved theme choice: set `currentTheme`, stamp (or clear) the
 * `data-theme` attribute on <html>, and mirror the choice to
 * localStorage[THEME_KEY] so theme-boot.js can paint it before first paint on
 * the next load. `'system'` clears the attribute and lets the CSS
 * `@media (prefers-color-scheme)` block decide — no matchMedia needed.
 *
 * @param {('system'|'light'|'dark')} mode
 * @returns {void}
 */
function _applyTheme(mode) {
  var m = mode === 'light' || mode === 'dark' ? mode : 'system';
  if (typeof currentTheme !== 'undefined') currentTheme = m;
  if (typeof document !== 'undefined' && document.documentElement) {
    var root = document.documentElement;
    // Suppress transitions across the swap + force one synchronous recalc:
    // some Chromium versions don't re-evaluate a `transition`ed
    // `background: var(--token)` when the token changes via an ancestor
    // `[data-theme]` toggle, leaving e.g. the send button the wrong colour
    // until the next reflow. The `.theme-switching` rule zeroes transitions;
    // reading offsetWidth flushes style; a 0ms timer restores them.
    root.classList.add('theme-switching');
    if (m === 'system') root.removeAttribute('data-theme');
    else root.setAttribute('data-theme', m);
    void root.offsetWidth;
    setTimeout(function () {
      root.classList.remove('theme-switching');
    }, 0);
  }
  try {
    var key = typeof THEME_KEY !== 'undefined' ? THEME_KEY : 'vpalTheme';
    localStorage.setItem(key, m);
  } catch {
    /* storage disabled — the attribute is set for this session regardless */
  }
}

function recomputeNumCtx() {
  if (typeof currentNumCtx === 'undefined' || typeof resolveNumCtx !== 'function') return;
  var fallback = typeof OLLAMA_NUM_CTX !== 'undefined' ? OLLAMA_NUM_CTX : 16384;
  var map = (typeof modelContextLengths !== 'undefined' && modelContextLengths) || {};
  var model = typeof currentModel !== 'undefined' ? currentModel : '';
  currentNumCtx = resolveNumCtx(model, fallback, map);
}

// Inline SVG line icons for the toolbar badges — the app uses SVG icons, never
// emoji (matches every other control). Hardcoded constants, no user data.
// width/height are set explicitly: the badges have no CSS `svg` sizing rule, and
// an SVG with only a viewBox otherwise renders at the 300x150 default and gets
// clipped to an invisible sliver by the badge's `overflow: hidden`.
var _SETTINGS_ICON_HEAD =
  '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" ' +
  'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" ' +
  'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ' +
  'style="flex:none">';
var _SETTINGS_MODEL_ICON =
  _SETTINGS_ICON_HEAD +
  '<rect x="5" y="5" width="14" height="14" rx="2"/>' +
  '<line x1="9" y1="2" x2="9" y2="5"/><line x1="15" y1="2" x2="15" y2="5"/>' +
  '<line x1="9" y1="19" x2="9" y2="22"/><line x1="15" y1="19" x2="15" y2="22"/>' +
  '<line x1="2" y1="9" x2="5" y2="9"/><line x1="2" y1="15" x2="5" y2="15"/>' +
  '<line x1="19" y1="9" x2="22" y2="9"/><line x1="19" y1="15" x2="22" y2="15"/></svg>';
var _SETTINGS_THINKING_ICON =
  _SETTINGS_ICON_HEAD +
  '<line x1="9" y1="18" x2="15" y2="18"/><line x1="10" y1="22" x2="14" y2="22"/>' +
  '<path d="M15.09 14c.18-.98.65-1.74 1.41-2.5A4.65 4.65 0 0 0 18 8 6 6 0 0 0 ' +
  '6 8c0 1 .23 2.23 1.5 3.5A4.61 4.61 0 0 1 8.91 14"/></svg>';

// Ensure a badge holds `<icon><span class="settings-badge-text">` exactly once,
// then return the span so callers only ever touch text.
function _settingsBadgeText(badge, iconSvg) {
  var span = badge.querySelector('.settings-badge-text');
  if (!span) {
    // Inline style (no CSS rule for the badge internals, and style.css is being
    // edited elsewhere): keep the icon fixed and let a long model name ellipsise
    // instead of clipping — `text-overflow` on the flex badge can't reach a child.
    badge.innerHTML =
      iconSvg +
      '<span class="settings-badge-text" style="overflow:hidden;' +
      'text-overflow:ellipsis;white-space:nowrap;min-width:0"></span>';
    span = badge.querySelector('.settings-badge-text');
  }
  return span;
}

function _settingsUpdateBadges(chatModel, thinkingMode) {
  if (typeof document === 'undefined') return;

  var modelBadge = document.getElementById('modelBadge');
  if (modelBadge) {
    _settingsBadgeText(modelBadge, _SETTINGS_MODEL_ICON).textContent = chatModel || 'model';
    modelBadge.title = 'Chat model: ' + (chatModel || 'unset') + ' — click to change';
  }

  var thinkingBadge = document.getElementById('thinkingBadge');
  if (thinkingBadge) {
    var on = thinkingMode && thinkingMode !== 'off';
    var depthLabel = on ? thinkingMode.charAt(0).toUpperCase() + thinkingMode.slice(1) : '';
    _settingsBadgeText(thinkingBadge, _SETTINGS_THINKING_ICON).textContent = on
      ? 'On · ' + depthLabel
      : 'Off';
    thinkingBadge.classList.toggle('is-on', !!on);
    thinkingBadge.title = 'Thinking: ' + (on ? 'on, ' + depthLabel : 'off') + ' — click to change';
  }
}

// Node.js compat — lets Jest import the pure helpers for unit tests; no-op in
// the browser (module is undefined there). Mirrors utils.js / nav-rail.js.
if (typeof module !== 'undefined') {
  module.exports = {
    resolveSetting: resolveSetting,
    resolveThinkingMode: resolveThinkingMode,
    resolveTtsEngine: resolveTtsEngine,
    diffSettings: diffSettings,
    buildMigrationPayload: buildMigrationPayload,
    setActivePersona: setActivePersona,
    _applyTheme: _applyTheme
  };
}
