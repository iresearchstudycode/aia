/**
 * @jest-environment jsdom
 */
'use strict';

// chat.js reaches for a handful of names as browser globals (defined in other
// classic <script>s at runtime). Wire the ones the rewind controls touch —
// mirrors the pattern in tests/js/code-render.test.js / editor-diff.test.js.
const _utils = require('../../src/aia/scripts/utils.js');
global.parseDocumentMessageContent = _utils.parseDocumentMessageContent;
global.buildDocumentMessageContent = _utils.buildDocumentMessageContent;

const {
  _lastExchangeIndices,
  _editableTextFor,
  regenerateLastResponse,
  editLastUserTurn,
  _refreshTurnControls,
} = require('../../src/aia/scripts/chat.js');

// ---------------------------------------------------------------------------
// _lastExchangeIndices — pure array bookkeeping
// ---------------------------------------------------------------------------

describe('_lastExchangeIndices', () => {
  const u = (content) => ({ role: 'user', content });
  const a = (content) => ({ role: 'assistant', content });

  test('empty history → both -1', () => {
    expect(_lastExchangeIndices([])).toEqual({ userIdx: -1, assistantIdx: -1 });
  });

  test('non-array input → both -1', () => {
    expect(_lastExchangeIndices(null)).toEqual({ userIdx: -1, assistantIdx: -1 });
    expect(_lastExchangeIndices(undefined)).toEqual({ userIdx: -1, assistantIdx: -1 });
    expect(_lastExchangeIndices('nope')).toEqual({ userIdx: -1, assistantIdx: -1 });
  });

  test('single completed exchange → user 0, assistant 1', () => {
    expect(_lastExchangeIndices([u('hi'), a('yo')])).toEqual({ userIdx: 0, assistantIdx: 1 });
  });

  test('trailing user with no reply yet → assistantIdx -1', () => {
    expect(_lastExchangeIndices([u('q1'), a('a1'), u('q2')])).toEqual({
      userIdx: 2,
      assistantIdx: -1,
    });
  });

  test('multi-turn history → indices of the LAST pair', () => {
    const h = [u('q1'), a('a1'), u('q2'), a('a2'), u('q3'), a('a3')];
    expect(_lastExchangeIndices(h)).toEqual({ userIdx: 4, assistantIdx: 5 });
  });

  test('assistant-only history (no user turn) → both -1', () => {
    expect(_lastExchangeIndices([a('orphan')])).toEqual({ userIdx: -1, assistantIdx: -1 });
  });

  test('assistant reply is the first one AFTER the last user, not a later stray', () => {
    // pathological ordering: two assistants trailing the last user
    const h = [u('q1'), a('a1'), u('q2'), a('a2a'), a('a2b')];
    expect(_lastExchangeIndices(h)).toEqual({ userIdx: 2, assistantIdx: 3 });
  });
});

// ---------------------------------------------------------------------------
// _editableTextFor — text recovered for the composer + attachment-loss flag
// ---------------------------------------------------------------------------

describe('_editableTextFor', () => {
  test('plain text turn → text as-is, nothing lost', () => {
    expect(_editableTextFor({ role: 'user', content: 'plain question' })).toEqual({
      text: 'plain question',
      lostAttachment: false,
    });
  });

  test('document turn → just the question, attachment flagged as lost', () => {
    const content = buildDocumentMessageContent(
      'contract.pdf',
      'A very long extracted document body...\nmany lines...',
      false,
      'What does clause 4 say?'
    );
    // sanity: the stored content really is a wrapped document block
    expect(parseDocumentMessageContent(content).hasDocument).toBe(true);

    expect(_editableTextFor({ role: 'user', content })).toEqual({
      text: 'What does clause 4 say?',
      lostAttachment: true,
    });
  });

  test('image turn (imageBase64) → text kept, attachment flagged as lost', () => {
    expect(
      _editableTextFor({ role: 'user', content: 'describe this', imageBase64: 'AAAA' })
    ).toEqual({ text: 'describe this', lostAttachment: true });
  });

  test('image turn loaded from file (hasImage flag) → attachment flagged as lost', () => {
    expect(_editableTextFor({ role: 'user', content: 'what is this', hasImage: true })).toEqual({
      text: 'what is this',
      lostAttachment: true,
    });
  });

  test('missing / empty content → empty string, nothing lost', () => {
    expect(_editableTextFor(undefined)).toEqual({ text: '', lostAttachment: false });
    expect(_editableTextFor({ role: 'user' })).toEqual({ text: '', lostAttachment: false });
  });
});

// ---------------------------------------------------------------------------
// _refreshTurnControls — button surfacing contract
// ---------------------------------------------------------------------------

function buildChatDom({ withAiActions = true } = {}) {
  document.body.innerHTML = `
    <textarea id="userInput"></textarea>
    <div id="chatMessages">
      <div class="message user-message">
        <div class="message-content"><p>hi</p></div>
      </div>
      <div class="message ai-message">
        <div class="message-content"><p>yo</p></div>
        ${withAiActions ? '<div class="message-actions"></div>' : ''}
      </div>
    </div>
  `;
}

describe('_refreshTurnControls', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    delete global.conversationHistory;
  });

  test('adds a regen button to the last AI reply and an edit button to the last user turn', () => {
    global.conversationHistory = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'yo' },
    ];
    buildChatDom();
    _refreshTurnControls();

    const regen = document.querySelectorAll('.msg-regen-btn');
    const edit = document.querySelectorAll('.msg-edit-btn');
    expect(regen).toHaveLength(1);
    expect(edit).toHaveLength(1);
    expect(document.querySelector('.ai-message .message-actions').contains(regen[0])).toBe(true);
    // user message had no .message-actions — one is created for the edit button
    expect(document.querySelector('.user-message .message-actions').contains(edit[0])).toBe(true);
    expect(regen[0].getAttribute('aria-label')).toBe('Regenerate response');
    expect(edit[0].getAttribute('aria-label')).toBe('Edit & resend');
  });

  test('is idempotent — a second call does not duplicate the buttons', () => {
    global.conversationHistory = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'yo' },
    ];
    buildChatDom();
    _refreshTurnControls();
    _refreshTurnControls();
    expect(document.querySelectorAll('.msg-regen-btn')).toHaveLength(1);
    expect(document.querySelectorAll('.msg-edit-btn')).toHaveLength(1);
  });

  test('no regen button while the AI actions row is still hidden (mid-stream placeholder)', () => {
    global.conversationHistory = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'yo' },
    ];
    buildChatDom();
    document.querySelector('.ai-message .message-actions').style.display = 'none';
    _refreshTurnControls();
    expect(document.querySelectorAll('.msg-regen-btn')).toHaveLength(0);
  });

  test('no edit button while a stream is in progress (Stop button visible)', () => {
    global.conversationHistory = [{ role: 'user', content: 'hi' }];
    document.body.innerHTML = `
      <button id="stopBtn" style="display: flex"></button>
      <div id="chatMessages">
        <div class="message user-message"><div class="message-content"><p>hi</p></div></div>
      </div>
    `;
    _refreshTurnControls();
    expect(document.querySelectorAll('.msg-edit-btn')).toHaveLength(0);
    expect(document.querySelectorAll('.msg-regen-btn')).toHaveLength(0);
  });

  test('skips both when the DOM and conversationHistory disagree (rolled-back turn)', () => {
    // DOM shows two user turns, history only knows about one → out of sync
    global.conversationHistory = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'yo' },
    ];
    document.body.innerHTML = `
      <div id="chatMessages">
        <div class="message user-message"><div class="message-content"><p>hi</p></div></div>
        <div class="message ai-message">
          <div class="message-content"><p>yo</p></div>
          <div class="message-actions"></div>
        </div>
        <div class="message user-message"><div class="message-content"><p>failed turn</p></div></div>
        <div class="message ai-message"><div class="message-content"><p>error</p></div></div>
      </div>
    `;
    _refreshTurnControls();
    expect(document.querySelectorAll('.msg-regen-btn')).toHaveLength(0);
    expect(document.querySelectorAll('.msg-edit-btn')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// regenerateLastResponse / editLastUserTurn — guard behaviour
// ---------------------------------------------------------------------------

describe('regenerateLastResponse — guards', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    delete global.conversationHistory;
  });

  test('no-op on empty history (does not throw, history untouched)', async () => {
    global.conversationHistory = [];
    await expect(regenerateLastResponse()).resolves.toBeUndefined();
    expect(global.conversationHistory).toEqual([]);
  });

  test('no-op when history ends with an unanswered user turn', async () => {
    global.conversationHistory = [
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' },
    ];
    const before = JSON.parse(JSON.stringify(global.conversationHistory));
    await regenerateLastResponse();
    expect(global.conversationHistory).toEqual(before);
  });
});

describe('editLastUserTurn — text recovery into the composer', () => {
  let toastSpy;

  beforeEach(() => {
    global.personaLabels = {};
    toastSpy = jest.fn();
    global.showToast = toastSpy;
    document.body.innerHTML = `
      <textarea id="userInput"></textarea>
      <div id="chatMessages"></div>
    `;
  });

  afterEach(() => {
    document.body.innerHTML = '';
    delete global.conversationHistory;
    delete global.personaLabels;
    delete global.showToast;
  });

  test('no-op on empty history', () => {
    global.conversationHistory = [];
    expect(() => editLastUserTurn()).not.toThrow();
    expect(document.getElementById('userInput').value).toBe('');
    expect(toastSpy).not.toHaveBeenCalled();
  });

  test('plain last user turn → full text loaded, its exchange popped, no toast', () => {
    global.conversationHistory = [
      { role: 'user', content: 'first draft of my question' },
      { role: 'assistant', content: 'a reply' },
    ];
    editLastUserTurn();
    expect(global.conversationHistory).toEqual([]);
    expect(document.getElementById('userInput').value).toBe('first draft of my question');
    expect(toastSpy).not.toHaveBeenCalled();
  });

  test('document last user turn → only the question is recovered, with an attachment-lost toast', () => {
    const content = buildDocumentMessageContent(
      'notes.pdf',
      'lots and lots of extracted text\n'.repeat(50),
      false,
      'Summarise section 2'
    );
    global.conversationHistory = [{ role: 'user', content }];
    editLastUserTurn();
    expect(document.getElementById('userInput').value).toBe('Summarise section 2');
    expect(toastSpy).toHaveBeenCalledWith('Attachment not carried over — re-attach if needed');
  });
});
