// nav-rail.js - Conversation Navigator Rail
//
// A thin vertical strip of markers down the edge of the chat, one per COMPLETED
// user turn (a user message that already has a non-empty AI reply). Hover a
// marker for a preview card (the question + a short snippet of the AI reply);
// click it to smooth-scroll to that turn and briefly flash it. The marker for
// the user turn nearest the top of the viewport is kept "active" as the user
// scrolls normally. Markers are rebuilt (debounced) whenever the message list
// changes.
//
// Everything that touches the DOM lives inside initNavRail()/helpers and behind
// `typeof` guards, so this file can also be CommonJS-required in Jest with no
// DOM present (mirrors chat.js / utils.js).

// ---------------------------------------------------------------------------
// Pure helpers (unit-tested in isolation, exported for Node at the file tail).
// ---------------------------------------------------------------------------

/**
 * Collapse a question into a single ellipsised line for the preview card title.
 * All whitespace runs become single spaces and the string is trimmed; if the
 * result is longer than 140 characters it is cut to 140 with a trailing '…'.
 *
 * @param {?string} text - raw question text (may be null/undefined/empty)
 * @returns {string} the collapsed single-line title, or '' for empty input
 */
function navRailCollapseTitle(text) {
  if (!text) return '';
  const collapsed = String(text).replace(/\s+/g, ' ').trim();
  if (collapsed.length > 140) return collapsed.slice(0, 140) + '…';
  return collapsed;
}

/**
 * Collapse whitespace, then keep at most `maxWords` space-separated words.
 * When the text already has `maxWords` or fewer words it is returned unchanged
 * (whitespace still collapsed/trimmed); otherwise the first `maxWords` words are
 * joined with a single space and a trailing '…' is appended.
 *
 * @param {?string} text - raw text (may be null/undefined/empty)
 * @param {number} [maxWords=25] - maximum number of words to keep
 * @returns {string} the truncated snippet, or '' for empty input
 */
function navRailTruncateWords(text, maxWords) {
  const limit = typeof maxWords === 'number' ? maxWords : 25;
  if (!text) return '';
  const collapsed = String(text).replace(/\s+/g, ' ').trim();
  if (!collapsed) return '';
  const words = collapsed.split(' ');
  if (words.length <= limit) return collapsed;
  return words.slice(0, limit).join(' ') + '…';
}

/**
 * Build the render model for the rail from an ordered list of completed turns.
 *
 * @param {Array<{userText: string, aiText: string}>} turns
 * @returns {Array<{index: number, title: string, snippet: string}>}
 *   `title` falls back to '(no text)' when the question collapses to empty.
 */
function navRailBuildModel(turns) {
  if (!Array.isArray(turns)) return [];
  return turns.map((turn, index) => {
    const entry = turn || {};
    const title = navRailCollapseTitle(entry.userText) || '(no text)';
    const snippet = navRailTruncateWords(entry.aiText, 25);
    return { index, title, snippet };
  });
}

// ---------------------------------------------------------------------------
// Browser-only state + wiring. None of this runs at require() time.
// ---------------------------------------------------------------------------

var _navRailInited = false;
var _navRailCard = null;
var _navRailRebuildTimer = null;
var _navRailCardCloseTimer = null;
var _navRailIntersectionObserver = null;
var _navRailMutationObserver = null;
var _navRailTurns = [];
var _navRailMarkerEls = [];

/**
 * Wire the rail up once. Called by main.js from its DOMContentLoaded handler.
 * A no-op if the rail or the messages container is not in the DOM.
 *
 * @returns {void}
 */
function initNavRail() {
  if (_navRailInited) return;
  const rail = document.getElementById('navRail');
  const container = document.getElementById('chatMessages');
  if (!rail || !container) return;
  _navRailInited = true;

  _navRailCard = _navRailCreateCard();
  rail.appendChild(_navRailCard);

  if (typeof MutationObserver !== 'undefined') {
    // Our own rebuild only mutates #navRail, never #chatMessages, so observing
    // the messages container here cannot feed back into an infinite loop.
    _navRailMutationObserver = new MutationObserver(_navRailScheduleRebuild);
    _navRailMutationObserver.observe(container, { childList: true, subtree: true });
  }

  _navRailRebuild();
}

/**
 * Enable or disable the rail. Called by main.js on load and on toggle click.
 * Disabling only hides it (class `nav-rail--off`); the markers are left in place
 * so re-enabling is instant. The canonical flag lives on
 * `window.currentNavRailEnabled` (config.js declares the bare identifier).
 *
 * @param {boolean} enabled
 * @returns {void}
 */
function setNavRailEnabled(enabled) {
  window.currentNavRailEnabled = !!enabled;
  const rail = document.getElementById('navRail');
  if (!rail) return;
  if (enabled) {
    rail.classList.remove('nav-rail--off');
    _navRailRebuild();
  } else {
    rail.classList.add('nav-rail--off');
    _navRailHideCard();
  }
}

/**
 * Create the (initially hidden) preview card. Hovering the card itself keeps it
 * open; leaving it closes it after the same short grace period as the markers.
 *
 * @returns {HTMLElement}
 */
function _navRailCreateCard() {
  const card = document.createElement('div');
  card.className = 'nav-rail__card';
  card.hidden = true;

  const title = document.createElement('div');
  title.className = 'nav-rail__card-title';
  const body = document.createElement('div');
  body.className = 'nav-rail__card-body';
  card.appendChild(title);
  card.appendChild(body);

  card.addEventListener('mouseenter', function () {
    clearTimeout(_navRailCardCloseTimer);
  });
  card.addEventListener('mouseleave', function () {
    _navRailCardCloseTimer = setTimeout(_navRailHideCard, 120);
  });
  return card;
}

/**
 * Debounced trigger for a full marker rebuild (~150ms).
 *
 * @returns {void}
 */
function _navRailScheduleRebuild() {
  clearTimeout(_navRailRebuildTimer);
  _navRailRebuildTimer = setTimeout(_navRailRebuild, 150);
}

/**
 * Walk the messages container and return one entry per COMPLETED user turn: a
 * `.message.user-message` whose next following `.message.ai-message` (before the
 * next user message) has non-whitespace `.message-content` text.
 *
 * @param {HTMLElement} container - the #chatMessages element
 * @returns {Array<{userEl: HTMLElement, userText: string, aiText: string}>}
 */
function _navRailCollectTurns(container) {
  const messages = Array.prototype.slice.call(container.querySelectorAll('.message'));
  const turns = [];
  for (let i = 0; i < messages.length; i++) {
    const userEl = messages[i];
    if (!userEl.classList.contains('user-message')) continue;

    let aiEl = null;
    for (let j = i + 1; j < messages.length; j++) {
      if (messages[j].classList.contains('user-message')) break;
      if (messages[j].classList.contains('ai-message')) {
        aiEl = messages[j];
        break;
      }
    }
    if (!aiEl) continue;

    const aiContent = aiEl.querySelector('.message-content');
    const aiText = aiContent ? aiContent.textContent.trim() : '';
    if (!aiText) continue;

    const userContent = userEl.querySelector('.message-content');
    const userText = userContent ? userContent.textContent.trim() : '';
    turns.push({ userEl: userEl, userText: userText, aiText: aiText });
  }
  return turns;
}

/**
 * Cheap full rebuild of the markers (bounded at ~20). No-op while the rail is
 * toggled off. The preview card is preserved; only `.nav-rail__marker` nodes
 * are replaced.
 *
 * @returns {void}
 */
function _navRailRebuild() {
  const rail = document.getElementById('navRail');
  const container = document.getElementById('chatMessages');
  if (!rail || !container) return;
  if (window.currentNavRailEnabled === false) return;

  const turns = _navRailCollectTurns(container);
  const model = navRailBuildModel(
    turns.map(function (turn) {
      return { userText: turn.userText, aiText: turn.aiText };
    })
  );

  Array.prototype.slice
    .call(rail.querySelectorAll('.nav-rail__marker'))
    .forEach(function (marker) {
      marker.remove();
    });

  _navRailTurns = turns;
  _navRailMarkerEls = [];

  model.forEach(function (entry, idx) {
    const marker = document.createElement('div');
    marker.className = 'nav-rail__marker';
    marker.setAttribute('data-turn-index', String(idx));

    marker.addEventListener('mouseenter', function () {
      clearTimeout(_navRailCardCloseTimer);
      _navRailShowCard(marker, entry);
    });
    marker.addEventListener('mouseleave', function () {
      _navRailCardCloseTimer = setTimeout(_navRailHideCard, 120);
    });
    marker.addEventListener('click', function () {
      _navRailScrollToTurn(idx);
    });

    // Keep the preview card as the last child of the rail.
    rail.insertBefore(marker, _navRailCard || null);
    _navRailMarkerEls.push(marker);
  });

  _navRailSetupObserver(turns, _navRailMarkerEls, container);
}

/**
 * (Re)create the IntersectionObserver that keeps exactly one marker marked
 * `nav-rail__marker--active` — the one whose user `.message` is nearest the top
 * of the scroll container.
 *
 * @param {Array<{userEl: HTMLElement}>} turns
 * @param {Array<HTMLElement>} markerEls
 * @param {HTMLElement} container
 * @returns {void}
 */
function _navRailSetupObserver(turns, markerEls, container) {
  if (_navRailIntersectionObserver) {
    _navRailIntersectionObserver.disconnect();
    _navRailIntersectionObserver = null;
  }
  if (typeof IntersectionObserver === 'undefined' || !turns.length) return;

  const visible = new Set();

  const indexOfTarget = function (target) {
    for (let i = 0; i < turns.length; i++) {
      if (turns[i].userEl === target) return i;
    }
    return -1;
  };

  _navRailIntersectionObserver = new IntersectionObserver(
    function (entries) {
      entries.forEach(function (entry) {
        const idx = indexOfTarget(entry.target);
        if (idx === -1) return;
        if (entry.isIntersecting) visible.add(idx);
        else visible.delete(idx);
      });
      _navRailUpdateActive(visible, turns, markerEls, container);
    },
    { root: container, threshold: 0 }
  );

  turns.forEach(function (turn) {
    if (turn.userEl) _navRailIntersectionObserver.observe(turn.userEl);
  });
}

/**
 * Recompute which marker is active from the currently-visible set.
 *
 * @param {Set<number>} visible
 * @param {Array<{userEl: HTMLElement}>} turns
 * @param {Array<HTMLElement>} markerEls
 * @param {HTMLElement} container
 * @returns {void}
 */
function _navRailUpdateActive(visible, turns, markerEls, container) {
  const containerTop = container.getBoundingClientRect().top;
  let bestIdx = -1;
  let bestDist = Infinity;

  visible.forEach(function (idx) {
    const turn = turns[idx];
    if (!turn || !turn.userEl) return;
    const dist = Math.abs(turn.userEl.getBoundingClientRect().top - containerTop);
    if (dist < bestDist) {
      bestDist = dist;
      bestIdx = idx;
    }
  });

  markerEls.forEach(function (marker, i) {
    marker.classList.toggle('nav-rail__marker--active', i === bestIdx);
  });
}

/**
 * Populate and show the preview card next to `markerEl`.
 *
 * @param {HTMLElement} markerEl
 * @param {{title: string, snippet: string}} entry
 * @returns {void}
 */
function _navRailShowCard(markerEl, entry) {
  if (!_navRailCard || !entry) return;

  const titleEl = _navRailCard.querySelector('.nav-rail__card-title');
  const bodyEl = _navRailCard.querySelector('.nav-rail__card-body');
  if (titleEl) titleEl.textContent = entry.title;
  if (bodyEl) bodyEl.textContent = entry.snippet;
  _navRailCard.hidden = false;

  const rail = document.getElementById('navRail');
  if (rail && typeof rail.getBoundingClientRect === 'function') {
    const railRect = rail.getBoundingClientRect();
    const markerRect = markerEl.getBoundingClientRect();
    _navRailCard.style.top = markerRect.top - railRect.top + 'px';
  }
}

/**
 * Hide the preview card.
 *
 * @returns {void}
 */
function _navRailHideCard() {
  if (_navRailCard) _navRailCard.hidden = true;
}

/**
 * Smooth-scroll to the user message for turn `idx` and flash it for 1s.
 *
 * @param {number} idx
 * @returns {void}
 */
function _navRailScrollToTurn(idx) {
  const turn = _navRailTurns[idx];
  if (!turn || !turn.userEl) return;

  if (typeof turn.userEl.scrollIntoView === 'function') {
    turn.userEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  _navRailFlashMessage(turn.userEl);
}

/**
 * Add the `nav-rail-flash` class to a `.message` element and remove it after 1s.
 *
 * @param {HTMLElement} messageEl
 * @returns {void}
 */
function _navRailFlashMessage(messageEl) {
  messageEl.classList.add('nav-rail-flash');
  setTimeout(function () {
    messageEl.classList.remove('nav-rail-flash');
  }, 1000);
}

// Node.js compat — lets Jest import the pure helpers for unit tests; no-op in
// the browser (module is undefined there). Mirrors utils.js / chat.js.
if (typeof module !== 'undefined') {
  module.exports = { navRailCollapseTitle, navRailTruncateWords, navRailBuildModel };
}
