// history.js - Conversation history sidebar
//
// An auto-saved, searchable list of past conversations, persisted server-side
// per authenticated user by the conversations-service (reached at
// `CONVERSATIONS_API_URL`). Since v1.26.0 the list lives inline in the left
// app sidebar (`#appSidebar`) rather than a modal lightbox: the shell markup
// (`#historySearch`, `#historySearchBodyToggle`, `#historyList`, `#historyEmpty`,
// `#historyCount`, `#historyStorage`, `#newChatBtn`) is static in index.html and
// `initHistory()` only binds the handlers + does the initial fetch. The list
// refreshes after every completed turn (`hcRefreshSidebar`, debounced) and
// marks the active conversation card.
//
// Layer separation mirrors settings.js / nav-rail.js: every function that
// touches the DOM, the network or a cross-module runtime global lives inside a
// function body behind `typeof` guards, so this file can be CommonJS-required in
// Jest with no DOM, no fetch and no config.js present. Only the pure helpers
// (`chatTitleFrom`, `conversationRecordFrom`, `filterConversations`,
// `resolveActiveCardId`) are exercised by the unit suite and exported at the
// file tail.

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested in isolation, exported for Node at the file tail).
// ---------------------------------------------------------------------------

/**
 * Derive a short conversation title from a history array. Uses the first
 * `role: 'user'` entry: its `question` when the content is a folded document
 * block (via `parseDocumentMessageContent`, when that global is available and
 * the content parses as one), otherwise the raw content. Whitespace is
 * collapsed; the result is capped at the first 6 words / 60 characters with a
 * trailing '…' when anything was cut. Returns `'New conversation'` when there is
 * no user text.
 *
 * @param {?Array<object>} history
 * @returns {string}
 */
function chatTitleFrom(history) {
  var list = Array.isArray(history) ? history : [];
  var first = null;
  for (var i = 0; i < list.length; i++) {
    if (list[i] && list[i].role === 'user') {
      first = list[i];
      break;
    }
  }

  var raw = first && typeof first.content === 'string' ? first.content : '';
  if (raw && typeof parseDocumentMessageContent === 'function') {
    try {
      var parsed = parseDocumentMessageContent(raw);
      if (parsed && parsed.hasDocument && typeof parsed.question === 'string') {
        raw = parsed.question;
      }
    } catch {
      /* fall through to the raw content */
    }
  }

  var text = String(raw).replace(/\s+/g, ' ').trim();
  if (!text) return 'New conversation';

  var words = text.split(' ');
  var cut = words.length > 6;
  var title = words.slice(0, 6).join(' ');
  if (title.length > 60) {
    title = title.slice(0, 60).trim();
    cut = true;
  }
  return cut ? title + '…' : title;
}

/**
 * Build the record PUT to the conversations-service for a conversation id. The
 * `body` mapper matches `chat.js` `saveChat()` exactly: keep
 * `role` / `content` / `timestamp` always, keep `hasImage` / `editorExchange` /
 * `editorView` when truthy, and drop the in-memory `imageBase64` / `imageDataUrl`
 * blobs. (Logic is copied here on purpose — history.js never imports chat.js.)
 *
 * The id is intentionally NOT part of the returned object: it travels in the
 * PUT URL path, and the service rejects any body key outside
 * `{title, persona_key, message_count, body}` with a 422. `id` stays a
 * parameter only so callers still document which conversation the record is for.
 *
 * @param {string} id - the conversation id (used by the caller for the URL, not embedded)
 * @param {?Array<object>} history
 * @param {?string} personaKey
 * @returns {{title: string, persona_key: string,
 *   message_count: number, body: Array<object>}}
 */
function conversationRecordFrom(id, history, personaKey) {
  var list = Array.isArray(history) ? history : [];
  var body = list.map(function (m) {
    var entry = { role: m.role, content: m.content, timestamp: m.timestamp };
    if (m.hasImage) entry.hasImage = true;
    if (m.editorExchange) entry.editorExchange = true;
    if (m.editorView) entry.editorView = m.editorView;
    return entry;
  });
  return {
    title: chatTitleFrom(list),
    persona_key: personaKey || '',
    message_count: list.length,
    body: body
  };
}

/**
 * Client-side predicate over an already-fetched metadata list: case-insensitive
 * substring match on `title` and, when `searchBody` is truthy and the item
 * carries a `body` or `preview` string, on that too. An empty / whitespace
 * `query` returns `list` unchanged. Nullish-safe (never throws).
 *
 * @param {?Array<object>} list
 * @param {?string} query
 * @param {?boolean} searchBody
 * @returns {?Array<object>}
 */
function filterConversations(list, query, searchBody) {
  var arr = Array.isArray(list) ? list : [];
  var q = (query === null || query === undefined ? '' : String(query)).trim().toLowerCase();
  if (!q) return list;
  return arr.filter(function (item) {
    if (!item) return false;
    var title = typeof item.title === 'string' ? item.title.toLowerCase() : '';
    if (title.indexOf(q) !== -1) return true;
    if (searchBody) {
      var text =
        typeof item.body === 'string'
          ? item.body
          : typeof item.preview === 'string'
            ? item.preview
            : '';
      if (text && text.toLowerCase().indexOf(q) !== -1) return true;
    }
    return false;
  });
}

/**
 * Decide which conversation card should carry the "active" highlight. Returns
 * `currentId` only when it actually appears in `list` by `.id` — a brand-new
 * unsaved conversation (id minted, nothing PUT yet) must not light up a stale
 * card. Nullish-safe; never throws.
 *
 * @param {?Array<object>} list - GET /conversations metadata entries
 * @param {?string} currentId
 * @returns {?string}
 */
function resolveActiveCardId(list, currentId) {
  if (!currentId || !Array.isArray(list)) return null;
  for (var i = 0; i < list.length; i++) {
    if (list[i] && String(list[i].id) === String(currentId)) return currentId;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Browser-only state + wiring. None of this runs at require() time; every entry
// point re-checks the DOM / globals and returns early when they are absent.
// ---------------------------------------------------------------------------

var _historyInited = false;

var _currentId = null;

// Cached sidebar state, refreshed on load / turn-complete / search / delete.
var _hcConversations = [];
var _hcTotal = 0;
var _hcCap = 100;

var _hcSearchTimer = null;
var _hcRefreshTimer = null;

// hcTouchCurrent coalescing.
var _hcTouchTimer = null;
var _hcTouchInFlight = false;
var _hcTouchPending = false;

var HISTORY_PERSONA_LABELS = {
  assistant: 'Assistant',
  casual: 'Casual Friend',
  claudePromptCompressor: 'Claude Prompt Compressor',
  creative: 'Creative Writer',
  englishEditor: 'English Editor',
  legal: 'Legal Assistant',
  medical: 'Medical Expert',
  teacher: 'Patient Teacher',
  professional: 'Professional Consultant',
  technical: 'Technical Expert',
  transcriptai: 'Transcript-Based Assistant'
};

/**
 * Resolve the conversations-service base URL. `CONVERSATIONS_API_URL` is a
 * config.js constant (registered as a lint global by Agent D); fall back to the
 * documented default so the module is self-contained under test.
 *
 * @param {string} [path] - path suffix appended verbatim
 * @returns {string}
 */
function _hcApi(path) {
  var base =
    typeof CONVERSATIONS_API_URL !== 'undefined'
      ? CONVERSATIONS_API_URL
      : 'https://localhost/conversations';
  return base + (path || '');
}

/** @returns {string} the active persona key, or '' when unknown. */
function _hcActivePersona() {
  try {
    if (
      typeof window !== 'undefined' &&
      window.vpalSettings &&
      window.vpalSettings.global &&
      window.vpalSettings.global.active_persona
    ) {
      return window.vpalSettings.global.active_persona;
    }
  } catch {
    /* ignore */
  }
  return '';
}

/** @returns {boolean} true when there is a non-empty conversation in memory. */
function _hcHasHistory() {
  return (
    typeof conversationHistory !== 'undefined' &&
    Array.isArray(conversationHistory) &&
    conversationHistory.length > 0
  );
}

// -- id management --------------------------------------------------------

/** @returns {?string} the current conversation id, or null before the first turn. */
function hcCurrentId() {
  return _currentId || null;
}

/**
 * Mint + set a fresh current id and return it. Opaque to the server, which only
 * validates `^[A-Za-z0-9_-]{1,64}$`.
 *
 * @returns {string}
 */
function hcNewConversationId() {
  _currentId =
    'c-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
  return _currentId;
}

// -- Network --------------------------------------------------------------

/**
 * PUT the current record for `id`. Returns the fetch promise (or a resolved
 * promise when `fetch` is absent). Callers own error handling.
 *
 * @param {string} id
 * @param {object} record
 * @returns {Promise<*>}
 */
function _hcPut(id, record) {
  if (typeof fetch === 'undefined') return Promise.resolve();
  return fetch(_hcApi('/' + id), {
    method: 'PUT',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(record)
  });
}

/**
 * Archive the open conversation. Async; never throws. No-op unless there is a
 * current id and a non-empty `conversationHistory`. Called by chat.js
 * `clearChat()` before it wipes, and internally before loading another
 * conversation.
 *
 * @returns {Promise<void>}
 */
async function hcArchiveCurrent() {
  try {
    var id = hcCurrentId();
    if (!id || !_hcHasHistory()) return;
    var record = conversationRecordFrom(id, conversationHistory, _hcActivePersona());
    await _hcPut(id, record);
  } catch (err) {
    if (typeof console !== 'undefined') console.error('history: archive failed', err);
  }
}

/**
 * The debounced worker behind `hcTouchCurrent`. Async; never throws. Skips when
 * a PUT for the current id is already in flight (re-runs once on completion if a
 * call arrived meanwhile).
 *
 * @returns {Promise<void>}
 */
async function _hcDoTouch() {
  var id = hcCurrentId();
  if (!id || !_hcHasHistory()) return;
  if (_hcTouchInFlight) {
    _hcTouchPending = true;
    return;
  }
  _hcTouchInFlight = true;
  try {
    var record = conversationRecordFrom(id, conversationHistory, _hcActivePersona());
    await _hcPut(id, record);
    // A completed turn just landed — refresh the sidebar so a new conversation
    // appears (and its title / relative-time updates).
    hcRefreshSidebar();
  } catch (err) {
    if (typeof console !== 'undefined') console.error('history: auto-save failed', err);
  } finally {
    _hcTouchInFlight = false;
    if (_hcTouchPending) {
      _hcTouchPending = false;
      _hcDoTouch();
    }
  }
}

/**
 * Ensure a current id exists (mint if not), then PUT the current record after a
 * short trailing debounce. Async; never throws. Called fire-and-forget from the
 * turn-complete path in api.js.
 *
 * @returns {Promise<void>}
 */
async function hcTouchCurrent() {
  try {
    if (!hcCurrentId()) hcNewConversationId();
  } catch {
    /* ignore */
  }
  if (typeof setTimeout === 'undefined') {
    return _hcDoTouch();
  }
  if (_hcTouchTimer) clearTimeout(_hcTouchTimer);
  _hcTouchTimer = setTimeout(function () {
    _hcTouchTimer = null;
    _hcDoTouch();
  }, 400);
}

/**
 * Best-effort last save on page unload. Built for Agent D's `beforeunload`
 * handler. `navigator.sendBeacon` only issues POST and the service route is
 * PUT-only, so this uses `fetch(..., { keepalive: true })` — which supports PUT
 * and survives unload — while keeping the contract name `hcBeaconSave`. The
 * per-turn `hcTouchCurrent` PUTs are the real safety net; a missed final save
 * here is acceptable. Synchronous fire-and-forget; returns nothing.
 *
 * @returns {void}
 */
function hcBeaconSave() {
  try {
    var id = hcCurrentId();
    if (!id || !_hcHasHistory()) return;
    var record = conversationRecordFrom(id, conversationHistory, _hcActivePersona());
    var json = JSON.stringify(record);
    if (typeof fetch === 'function') {
      fetch(_hcApi('/' + id), {
        method: 'PUT',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: json,
        keepalive: true
      }).catch(function () {
        /* best-effort last save */
      });
    }
  } catch {
    /* best-effort last save */
  }
}

/**
 * Load a stored conversation. Async. Archives the open conversation first so it
 * is not lost, then GETs `{id}` and swaps it into the live chat. On any failure
 * the current state is left untouched and a toast is shown.
 *
 * @param {string} id
 * @returns {Promise<void>}
 */
async function hcLoadConversation(id) {
  await hcArchiveCurrent();
  try {
    if (typeof fetch === 'undefined') throw new Error('no fetch');
    var res = await fetch(_hcApi('/' + id), { credentials: 'same-origin' });
    if (!res.ok) throw new Error('GET ' + res.status);
    var data = await res.json();
    if (!data || !Array.isArray(data.body)) throw new Error('bad body');
    if (typeof conversationHistory !== 'undefined') {
      conversationHistory = data.body;
    }
    // Restore the persona this conversation was created with, so follow-up
    // turns continue in its context. setActivePersona (settings.js) validates
    // the key, no-ops when it already matches, PUTs `active_persona`, and
    // re-applies (currentSystemPrompt + labels) before the transcript renders.
    if (data.persona_key && typeof setActivePersona === 'function') {
      await setActivePersona(data.persona_key);
    }
    if (typeof renderConversationHistory === 'function') renderConversationHistory();
    _currentId = id;
    // Re-render the list so the active-card highlight moves to this entry, and
    // collapse the mobile drawer if it was open.
    _hcRenderList(_hcConversations);
    if (typeof closeSidebarDrawer === 'function') closeSidebarDrawer();
    var input = typeof document !== 'undefined' ? document.getElementById('userInput') : null;
    if (input && typeof input.focus === 'function') input.focus();
  } catch (err) {
    if (typeof console !== 'undefined') console.error('history: load failed', err);
    if (typeof showToast === 'function') showToast('Could not open that conversation');
  }
}

// -- Sidebar wiring ---------------------------------------------------

/**
 * Bind the static sidebar shell (built into `#appSidebar` by index.html) and do
 * the initial list fetch. Idempotent; a no-op when `#historyList` is absent
 * (e.g. under Jest). Called by main.js from DOMContentLoaded.
 *
 * @returns {void}
 */
function initHistory() {
  if (_historyInited) return;
  var list = typeof document !== 'undefined' ? document.getElementById('historyList') : null;
  if (!list) return;
  _historyInited = true;

  var search = document.getElementById('historySearch');
  if (search) {
    search.addEventListener('input', function () {
      if (_hcSearchTimer) clearTimeout(_hcSearchTimer);
      _hcSearchTimer = setTimeout(_hcRunSearch, 200);
    });
  }

  var bodyToggle = document.getElementById('historySearchBodyToggle');
  if (bodyToggle) bodyToggle.addEventListener('change', _hcRunSearch);

  var newChatBtn = document.getElementById('newChatBtn');
  if (newChatBtn) newChatBtn.addEventListener('click', hcNewChat);

  _hcFetchAndRender();
}

/**
 * "New chat" — hand off to `clearChat()` (chat.js), which archives the current
 * conversation to the history service, wipes the transcript, mints a fresh id
 * and refreshes this list. Then collapse the mobile drawer if it is open.
 *
 * @returns {Promise<void>}
 */
async function hcNewChat() {
  if (typeof clearChat === 'function') {
    await clearChat();
  }
  if (typeof closeSidebarDrawer === 'function') closeSidebarDrawer();
}

/**
 * Refresh the sidebar list out-of-band (after a completed turn, a load, a
 * delete, or "New chat"). Debounced ~800ms trailing; never throws. Re-runs the
 * active search when the search box has a value, otherwise re-fetches the list.
 * No loading placeholder — the list stays put until fresh data lands, so it
 * doesn't flicker on every turn.
 *
 * @returns {void}
 */
function hcRefreshSidebar() {
  if (typeof document === 'undefined' || !document.getElementById('historyList')) return;
  if (typeof setTimeout === 'undefined') return _hcDoRefreshSidebar();
  if (_hcRefreshTimer) clearTimeout(_hcRefreshTimer);
  _hcRefreshTimer = setTimeout(function () {
    _hcRefreshTimer = null;
    _hcDoRefreshSidebar();
  }, 800);
}

/** The worker behind `hcRefreshSidebar`. Async; never throws. */
async function _hcDoRefreshSidebar() {
  try {
    var search = document.getElementById('historySearch');
    if (search && search.value.trim()) {
      await _hcRunSearch();
      return;
    }
    if (typeof fetch === 'undefined') return;
    var res = await fetch(_hcApi(''), { credentials: 'same-origin' });
    if (!res.ok) return;
    var data = await res.json();
    _hcConversations = data && Array.isArray(data.conversations) ? data.conversations : [];
    _hcCap = data && typeof data.cap === 'number' ? data.cap : _hcCap;
    _hcTotal = data && typeof data.total === 'number' ? data.total : _hcConversations.length;
    _hcRenderList(_hcConversations);
    _hcRenderFooter();
  } catch (err) {
    if (typeof console !== 'undefined') console.error('history: sidebar refresh failed', err);
  }
}

// -- Fetch + render ----------------------------------------------------

/**
 * GET `/conversations`, cache the result, render the list + footer. Renders an
 * error state with a Retry button on failure.
 *
 * @returns {Promise<void>}
 */
async function _hcFetchAndRender() {
  var list = document.getElementById('historyList');
  if (!list) return;
  _hcRenderLoading(list);
  try {
    if (typeof fetch === 'undefined') throw new Error('no fetch');
    var res = await fetch(_hcApi(''), { credentials: 'same-origin' });
    if (!res.ok) throw new Error('GET /conversations ' + res.status);
    var data = await res.json();
    _hcConversations = data && Array.isArray(data.conversations) ? data.conversations : [];
    _hcCap = data && typeof data.cap === 'number' ? data.cap : 100;
    _hcTotal = data && typeof data.total === 'number' ? data.total : _hcConversations.length;
    _hcRenderList(_hcConversations);
    _hcRenderFooter();
  } catch (err) {
    if (typeof console !== 'undefined') console.error('history: list failed', err);
    _hcRenderError(list);
  }
}

/**
 * Run the current search. Title-only searches filter the cached list locally
 * (instant); "search message text" hits `GET /conversations/search?q=` for the
 * authoritative result.
 *
 * @returns {Promise<void>}
 */
async function _hcRunSearch() {
  var search = document.getElementById('historySearch');
  var bodyToggle = document.getElementById('historySearchBodyToggle');
  var q = search ? search.value.trim() : '';
  var searchBody = !!(bodyToggle && bodyToggle.checked);
  var list = document.getElementById('historyList');
  if (!list) return;

  if (searchBody && q) {
    _hcRenderLoading(list);
    try {
      if (typeof fetch === 'undefined') throw new Error('no fetch');
      var res = await fetch(_hcApi('/search?q=' + encodeURIComponent(q)), {
        credentials: 'same-origin'
      });
      if (!res.ok) throw new Error('search ' + res.status);
      var data = await res.json();
      _hcRenderList(data && Array.isArray(data.conversations) ? data.conversations : []);
    } catch (err) {
      if (typeof console !== 'undefined') console.error('history: search failed', err);
      _hcRenderError(list);
    }
    return;
  }

  _hcRenderList(filterConversations(_hcConversations, q, false));
}

/**
 * Replace the list contents with a loading placeholder.
 *
 * @param {HTMLElement} list
 * @returns {void}
 */
function _hcRenderLoading(list) {
  while (list.firstChild) list.removeChild(list.firstChild);
  var loading = document.createElement('div');
  loading.className = 'history-loading';
  loading.textContent = 'Loading…';
  list.appendChild(loading);
  var empty = document.getElementById('historyEmpty');
  if (empty) empty.hidden = true;
}

/**
 * Replace the list contents with an error state + Retry button.
 *
 * @param {HTMLElement} list
 * @returns {void}
 */
function _hcRenderError(list) {
  while (list.firstChild) list.removeChild(list.firstChild);
  var wrap = document.createElement('div');
  wrap.className = 'history-error';
  var msg = document.createElement('p');
  msg.textContent = "Couldn't load your conversations.";
  wrap.appendChild(msg);
  var retry = document.createElement('button');
  retry.type = 'button';
  retry.className = 'history-retry';
  retry.textContent = 'Retry';
  retry.addEventListener('click', function () {
    _hcFetchAndRender();
  });
  wrap.appendChild(retry);
  list.appendChild(wrap);
  var empty = document.getElementById('historyEmpty');
  if (empty) empty.hidden = true;
}

/**
 * Render `items` as `.history-card`s into `#historyList`. Shows `#historyEmpty`
 * when the list is empty.
 *
 * @param {?Array<object>} items
 * @returns {void}
 */
function _hcRenderList(items) {
  var list = document.getElementById('historyList');
  var empty = document.getElementById('historyEmpty');
  if (!list) return;
  while (list.firstChild) list.removeChild(list.firstChild);
  if (!items || !items.length) {
    if (empty) empty.hidden = false;
    return;
  }
  if (empty) empty.hidden = true;
  var activeId = resolveActiveCardId(items, hcCurrentId());
  items.forEach(function (item) {
    list.appendChild(_hcBuildCard(item, activeId));
  });
}

/**
 * Build one conversation card. Clicking the card (not the delete ✕) loads the
 * conversation; the ✕ confirms then DELETEs. `activeId` (from
 * `resolveActiveCardId`) marks the currently-open conversation.
 *
 * @param {object} item - a `GET /conversations` metadata entry
 * @param {?string} [activeId]
 * @returns {HTMLElement}
 */
function _hcBuildCard(item, activeId) {
  var id = item && item.id ? String(item.id) : '';

  var card = document.createElement('div');
  card.className = 'history-card';
  card.setAttribute('data-id', id);
  card.setAttribute('role', 'button');
  card.setAttribute('tabindex', '0');
  if (id && activeId && id === String(activeId)) {
    card.classList.add('is-active');
    card.setAttribute('aria-current', 'true');
  }

  var main = document.createElement('div');
  main.className = 'history-card-main';

  var title = document.createElement('div');
  title.className = 'history-card-title';
  title.textContent = (item && item.title) || 'New conversation';
  main.appendChild(title);

  var meta = document.createElement('div');
  meta.className = 'history-card-meta';
  var when = _hcRelativeDate((item && (item.updated_at || item.created_at)) || '');
  var count = item && typeof item.message_count === 'number' ? item.message_count : 0;
  var parts = [];
  if (when) parts.push(when);
  parts.push(count + (count === 1 ? ' msg' : ' msgs'));
  meta.textContent = parts.join(' · ');
  if (item && item.persona_key) {
    meta.appendChild(document.createTextNode(' · '));
    var chip = document.createElement('span');
    chip.className = 'history-persona-chip';
    chip.textContent = _hcPersonaLabel(item.persona_key);
    meta.appendChild(chip);
  }
  main.appendChild(meta);
  card.appendChild(main);

  var del = document.createElement('button');
  del.type = 'button';
  del.className = 'history-card-delete';
  del.setAttribute('aria-label', 'Delete conversation');
  del.textContent = '✕';
  del.addEventListener('click', function (e) {
    e.stopPropagation();
    _hcDeleteCard(id, card);
  });
  card.appendChild(del);

  card.addEventListener('click', function () {
    hcLoadConversation(id);
  });
  card.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      hcLoadConversation(id);
    }
  });

  return card;
}

/**
 * Confirm, DELETE `{id}`, then remove the card and refresh the footer.
 *
 * @param {string} id
 * @param {HTMLElement} card
 * @returns {void}
 */
function _hcDeleteCard(id, card) {
  if (typeof confirm === 'function' && !confirm('Delete this conversation? This cannot be undone.')) {
    return;
  }
  if (typeof fetch === 'undefined') return;
  fetch(_hcApi('/' + id), { method: 'DELETE', credentials: 'same-origin' })
    .then(function (res) {
      if (!res.ok) throw new Error('DELETE ' + res.status);
      if (card && card.parentNode) card.parentNode.removeChild(card);
      _hcConversations = _hcConversations.filter(function (c) {
        return c && c.id !== id;
      });
      _hcTotal = Math.max(0, _hcTotal - 1);
      _hcRenderFooter();
      var list = document.getElementById('historyList');
      if (list && !list.querySelector('.history-card')) {
        var empty = document.getElementById('historyEmpty');
        if (empty) empty.hidden = false;
      }
      hcRefreshSidebar();
    })
    .catch(function (err) {
      if (typeof console !== 'undefined') console.error('history: delete failed', err);
      if (typeof showToast === 'function') showToast('Could not delete that conversation');
    });
}

/**
 * Refresh the footer: "N of CAP" plus a storage-usage line when
 * `navigator.storage.estimate()` is available.
 *
 * @returns {void}
 */
function _hcRenderFooter() {
  var countEl = document.getElementById('historyCount');
  if (countEl) countEl.textContent = _hcTotal + ' of ' + _hcCap;

  var storageEl = document.getElementById('historyStorage');
  if (
    storageEl &&
    typeof navigator !== 'undefined' &&
    navigator.storage &&
    typeof navigator.storage.estimate === 'function'
  ) {
    navigator.storage
      .estimate()
      .then(function (est) {
        if (!est || typeof est.usage !== 'number') return;
        storageEl.textContent = ' · ' + _hcFormatBytes(est.usage) + ' used';
      })
      .catch(function () {
        /* storage estimate is best-effort */
      });
  }
}

/**
 * Human-readable persona label for the card chip.
 *
 * @param {string} key
 * @returns {string}
 */
function _hcPersonaLabel(key) {
  if (typeof personaLabels !== 'undefined' && personaLabels && personaLabels[key]) {
    return personaLabels[key];
  }
  return HISTORY_PERSONA_LABELS[key] || key;
}

/**
 * Format a byte count as a short "12.3 MB" / "456 KB" string.
 *
 * @param {number} bytes
 * @returns {string}
 */
function _hcFormatBytes(bytes) {
  if (typeof bytes !== 'number' || !isFinite(bytes) || bytes < 0) return '';
  if (bytes < 1024) return bytes + ' B';
  var kb = bytes / 1024;
  if (kb < 1024) return kb.toFixed(kb < 10 ? 1 : 0) + ' KB';
  var mb = kb / 1024;
  if (mb < 1024) return mb.toFixed(mb < 10 ? 1 : 0) + ' MB';
  var gb = mb / 1024;
  return gb.toFixed(gb < 10 ? 1 : 0) + ' GB';
}

/**
 * Relative date phrase (e.g. "3 hours ago") from an ISO-8601 timestamp.
 *
 * @param {string} iso
 * @returns {string}
 */
function _hcRelativeDate(iso) {
  if (!iso) return '';
  var then = new Date(iso).getTime();
  if (isNaN(then)) return '';
  var secs = Math.max(0, Math.round((Date.now() - then) / 1000));
  if (secs < 45) return 'just now';
  var mins = Math.round(secs / 60);
  if (mins < 60) return mins + (mins === 1 ? ' min ago' : ' mins ago');
  var hours = Math.round(mins / 60);
  if (hours < 24) return hours + (hours === 1 ? ' hour ago' : ' hours ago');
  var days = Math.round(hours / 24);
  if (days < 30) return days + (days === 1 ? ' day ago' : ' days ago');
  var months = Math.round(days / 30);
  if (months < 12) return months + (months === 1 ? ' month ago' : ' months ago');
  var years = Math.round(months / 12);
  return years + (years === 1 ? ' year ago' : ' years ago');
}

// Node.js compat — lets Jest import the pure helpers for unit tests; no-op in
// the browser (module is undefined there). Mirrors utils.js / nav-rail.js /
// settings.js.
if (typeof module !== 'undefined') {
  module.exports = {
    chatTitleFrom: chatTitleFrom,
    conversationRecordFrom: conversationRecordFrom,
    filterConversations: filterConversations,
    resolveActiveCardId: resolveActiveCardId
  };
}
