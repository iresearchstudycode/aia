/**
 * @jest-environment jsdom
 */
'use strict';

const {
  chatTitleFrom,
  conversationRecordFrom,
  filterConversations,
  resolveActiveCardId,
  groupConversationsByPersona,
  _hcModifiedMs,
  _hcPersonaLabel,
  normalizeConversationTitle,
  _hcBuildCard,
  _hcRenderList,
  _hcBeginRename,
} = require('../../src/aia/scripts/history.js');

describe('chatTitleFrom', () => {
  test('no history / no user text → "New conversation"', () => {
    expect(chatTitleFrom([])).toBe('New conversation');
    expect(chatTitleFrom(null)).toBe('New conversation');
    expect(chatTitleFrom([{ role: 'assistant', content: 'hello there' }])).toBe('New conversation');
    expect(chatTitleFrom([{ role: 'user', content: '   \n\t ' }])).toBe('New conversation');
  });

  test('first user message, ≤6 words → returned unchanged, whitespace collapsed', () => {
    expect(
      chatTitleFrom([
        { role: 'assistant', content: 'ignored' },
        { role: 'user', content: '  Hello   there\n world  ' },
      ])
    ).toBe('Hello there world');
  });

  test('more than 6 words → first 6 words + "…"', () => {
    expect(
      chatTitleFrom([{ role: 'user', content: 'one two three four five six seven eight' }])
    ).toBe('one two three four five six…');
  });

  test('exactly 6 words → no ellipsis', () => {
    expect(chatTitleFrom([{ role: 'user', content: 'one two three four five six' }])).toBe(
      'one two three four five six'
    );
  });

  test('a single very long word is capped at 60 chars + "…"', () => {
    const title = chatTitleFrom([{ role: 'user', content: 'x'.repeat(200) }]);
    expect(title.endsWith('…')).toBe(true);
    expect(title.length).toBeLessThanOrEqual(61);
  });

  test('uses the question when the content is a folded document block', () => {
    global.parseDocumentMessageContent = (content) => {
      if (content.indexOf('Attached file') !== -1) {
        return { hasDocument: true, documentName: 'notes.pdf', question: 'What is the deadline here' };
      }
      return { hasDocument: false };
    };
    try {
      const folded =
        '--- Attached file: notes.pdf ---\nlots of text\n--- End of notes.pdf ---\n\nWhat is the deadline here';
      expect(chatTitleFrom([{ role: 'user', content: folded }])).toBe('What is the deadline here');
    } finally {
      delete global.parseDocumentMessageContent;
    }
  });

  test('non-string content is ignored', () => {
    expect(chatTitleFrom([{ role: 'user', content: [{ type: 'image' }] }])).toBe('New conversation');
  });
});

describe('conversationRecordFrom', () => {
  const history = [
    {
      role: 'user',
      content: 'Explain closures',
      timestamp: 1,
      hasImage: true,
      imageBase64: 'AAAA',
      imageDataUrl: 'data:image/png;base64,AAAA',
    },
    {
      role: 'assistant',
      content: 'A closure is…',
      timestamp: 2,
      editorExchange: true,
      editorView: 'changes',
    },
  ];

  test('shape: title / persona_key / message_count / body — and NO id key', () => {
    const rec = conversationRecordFrom('c-abc', history, 'technical');
    // id travels in the PUT URL path only; the service rejects a body carrying
    // any key outside {title, persona_key, message_count, body} with a 422.
    expect(rec).not.toHaveProperty('id');
    expect(Object.keys(rec).sort()).toEqual(['body', 'message_count', 'persona_key', 'title']);
    expect(rec.title).toBe('Explain closures');
    expect(rec.persona_key).toBe('technical');
    expect(rec.message_count).toBe(2);
    expect(Array.isArray(rec.body)).toBe(true);
    expect(rec.body).toHaveLength(2);
  });

  test('body drops imageBase64 / imageDataUrl, keeps hasImage / editorExchange / editorView', () => {
    const rec = conversationRecordFrom('c-abc', history, 'technical');
    expect(rec.body[0]).toEqual({
      role: 'user',
      content: 'Explain closures',
      timestamp: 1,
      hasImage: true,
    });
    expect(rec.body[0].imageBase64).toBeUndefined();
    expect(rec.body[0].imageDataUrl).toBeUndefined();
    expect(rec.body[1]).toEqual({
      role: 'assistant',
      content: 'A closure is…',
      timestamp: 2,
      editorExchange: true,
      editorView: 'changes',
    });
  });

  test('persona_key falls back to "" ; message_count tracks length', () => {
    const rec = conversationRecordFrom('c-1', [{ role: 'user', content: 'hi' }]);
    expect(rec.persona_key).toBe('');
    expect(rec.message_count).toBe(1);
  });

  test('nullish history → empty body, "New conversation" title', () => {
    const rec = conversationRecordFrom('c-1', null, '');
    expect(rec.body).toEqual([]);
    expect(rec.message_count).toBe(0);
    expect(rec.title).toBe('New conversation');
  });
});

describe('filterConversations', () => {
  const list = [
    { id: 'a', title: 'How to center a div', body: 'flexbox and grid notes' },
    { id: 'b', title: 'Tax return questions', preview: 'deductions for 2026' },
    { id: 'c', title: 'Dinner ideas' },
  ];

  test('empty / whitespace query → list returned unchanged', () => {
    expect(filterConversations(list, '')).toBe(list);
    expect(filterConversations(list, '   ')).toBe(list);
    expect(filterConversations(list, null)).toBe(list);
  });

  test('case-insensitive substring match on title', () => {
    expect(filterConversations(list, 'DIV').map((c) => c.id)).toEqual(['a']);
    expect(filterConversations(list, 'ideas').map((c) => c.id)).toEqual(['c']);
  });

  test('searchBody also matches a body / preview string', () => {
    expect(filterConversations(list, 'flexbox', false).map((c) => c.id)).toEqual([]);
    expect(filterConversations(list, 'flexbox', true).map((c) => c.id)).toEqual(['a']);
    expect(filterConversations(list, 'deductions', true).map((c) => c.id)).toEqual(['b']);
  });

  test('nullish-safe', () => {
    expect(filterConversations(null, 'x')).toEqual([]);
    expect(filterConversations(undefined, 'x')).toEqual([]);
    expect(filterConversations([null, { title: null }], 'x')).toEqual([]);
    expect(filterConversations(null, '')).toBe(null);
  });
});

describe('resolveActiveCardId', () => {
  const list = [{ id: 'c-a' }, { id: 'c-b' }, { id: 'c-c' }];

  test('returns currentId when it appears in the list', () => {
    expect(resolveActiveCardId(list, 'c-b')).toBe('c-b');
  });

  test('returns null when currentId is not in the list (new unsaved conversation)', () => {
    expect(resolveActiveCardId(list, 'c-new')).toBeNull();
  });

  test('returns null when currentId is nullish', () => {
    expect(resolveActiveCardId(list, null)).toBeNull();
    expect(resolveActiveCardId(list, '')).toBeNull();
    expect(resolveActiveCardId(list, undefined)).toBeNull();
  });

  test('nullish / non-array list → null, never throws', () => {
    expect(resolveActiveCardId(null, 'c-a')).toBeNull();
    expect(resolveActiveCardId(undefined, 'c-a')).toBeNull();
    expect(resolveActiveCardId('nope', 'c-a')).toBeNull();
  });

  test('skips malformed entries and matches by string equality', () => {
    expect(resolveActiveCardId([null, {}, { id: 42 }], '42')).toBe('42');
    expect(resolveActiveCardId([{ id: 'c-a' }], 'c-z')).toBeNull();
  });
});

describe('groupConversationsByPersona', () => {
  const L = { assistant: 'Assistant', teacher: 'Patient Teacher', legal: 'Legal Assistant' };

  test('buckets by persona_key; groups are A→Z by display name, not by activity', () => {
    const list = [
      { id: '1', persona_key: 'teacher' },
      { id: '2', persona_key: 'assistant' },
      { id: '3', persona_key: 'teacher' },
      { id: '4', persona_key: 'legal' },
    ];
    const groups = groupConversationsByPersona(list, L);
    // Assistant, Legal Assistant, Patient Teacher — whichever was used last.
    expect(groups.map((g) => g.key)).toEqual(['assistant', 'legal', 'teacher']);
    expect(groups.map((g) => g.label)).toEqual(['Assistant', 'Legal Assistant', 'Patient Teacher']);
    expect(groups[2].items.map((i) => i.id)).toEqual(['1', '3']);
  });

  test('sorts by the visible label, not the key (case-insensitive)', () => {
    const labels = { zeta: 'Alpha', alpha: 'beta', mid: 'Charlie' };
    const list = [{ persona_key: 'mid' }, { persona_key: 'alpha' }, { persona_key: 'zeta' }];
    expect(groupConversationsByPersona(list, labels).map((g) => g.label)).toEqual([
      'Alpha',
      'beta',
      'Charlie',
    ]);
  });

  test('group order is identical whatever the input order (stable under activity)', () => {
    const a = { id: 'a', persona_key: 'assistant', updated_at: '2026-01-01T00:00:00.000Z' };
    const t = { id: 't', persona_key: 'teacher', updated_at: '2026-01-02T00:00:00.000Z' };
    const l = { id: 'l', persona_key: 'legal', updated_at: '2026-01-03T00:00:00.000Z' };
    const order = (list) => groupConversationsByPersona(list, L).map((g) => g.key);
    const expected = ['assistant', 'legal', 'teacher'];
    expect(order([a, t, l])).toEqual(expected);
    expect(order([l, t, a])).toEqual(expected);
    expect(order([t, l, a])).toEqual(expected);
  });

  test('within a group, newest last-modified comes first', () => {
    const list = [
      { id: 'old', persona_key: 'teacher', updated_at: '2026-01-01T09:00:00.000Z' },
      { id: 'new', persona_key: 'teacher', updated_at: '2026-01-03T09:00:00.000Z' },
      { id: 'mid', persona_key: 'teacher', updated_at: '2026-01-02T09:00:00.000Z' },
    ];
    const [g] = groupConversationsByPersona(list, L);
    expect(g.items.map((i) => i.id)).toEqual(['new', 'mid', 'old']);
  });

  test('sorts by time of day, not just date', () => {
    const list = [
      { id: 'am', persona_key: 'teacher', updated_at: '2026-01-01T08:00:00.000Z' },
      { id: 'pm', persona_key: 'teacher', updated_at: '2026-01-01T17:30:00.000Z' },
    ];
    expect(groupConversationsByPersona(list, L)[0].items.map((i) => i.id)).toEqual(['pm', 'am']);
  });

  test('a modified chat moves to the top of its own group only — no group moves', () => {
    const base = [
      { id: 'a1', persona_key: 'assistant', updated_at: '2026-01-05T00:00:00.000Z' },
      { id: 'a2', persona_key: 'assistant', updated_at: '2026-01-04T00:00:00.000Z' },
      { id: 't1', persona_key: 'teacher', updated_at: '2026-01-03T00:00:00.000Z' },
      { id: 't2', persona_key: 'teacher', updated_at: '2026-01-02T00:00:00.000Z' },
    ];
    const before = groupConversationsByPersona(base, L);
    // The Patient Teacher chat t2 is modified — it is now the newest of ALL chats.
    const after = groupConversationsByPersona(
      base.map((c) => (c.id === 't2' ? { ...c, updated_at: '2026-02-01T00:00:00.000Z' } : c)),
      L
    );
    expect(after.map((g) => g.key)).toEqual(before.map((g) => g.key));
    expect(after.find((g) => g.key === 'teacher').items.map((i) => i.id)).toEqual(['t2', 't1']);
    expect(after.find((g) => g.key === 'assistant').items.map((i) => i.id)).toEqual(['a1', 'a2']);
  });

  test('falls back to created_at; missing/invalid dates sink to the bottom', () => {
    const list = [
      { id: 'none', persona_key: 'teacher' },
      { id: 'bad', persona_key: 'teacher', updated_at: 'not-a-date' },
      { id: 'created', persona_key: 'teacher', created_at: '2026-01-01T00:00:00.000Z' },
      { id: 'upd', persona_key: 'teacher', updated_at: '2026-01-02T00:00:00.000Z' },
    ];
    expect(groupConversationsByPersona(list, L)[0].items.map((i) => i.id)).toEqual([
      'upd',
      'created',
      'none',
      'bad',
    ]);
  });

  test('equal timestamps keep their given order (stable)', () => {
    const ts = '2026-01-01T00:00:00.000Z';
    const list = [
      { id: 'x', persona_key: 'teacher', updated_at: ts },
      { id: 'y', persona_key: 'teacher', updated_at: ts },
      { id: 'z', persona_key: 'teacher', updated_at: ts },
    ];
    expect(groupConversationsByPersona(list, L)[0].items.map((i) => i.id)).toEqual(['x', 'y', 'z']);
  });

  test('does not mutate the input list', () => {
    const list = [
      { id: '1', persona_key: 'teacher', updated_at: '2026-01-01T00:00:00.000Z' },
      { id: '2', persona_key: 'assistant', updated_at: '2026-01-02T00:00:00.000Z' },
    ];
    const copy = JSON.stringify(list);
    groupConversationsByPersona(list, L);
    expect(JSON.stringify(list)).toBe(copy);
  });

  test('"Unassigned" stays last even though it would sort before later letters', () => {
    const list = [{ id: '1' }, { id: '2', persona_key: 'teacher' }];
    expect(groupConversationsByPersona(list, L).map((g) => g.label)).toEqual([
      'Patient Teacher',
      'Unassigned',
    ]);
  });

  test('empty / missing persona_key → trailing "Unassigned" group', () => {
    const list = [
      { id: '1', persona_key: 'assistant' },
      { id: '2' },
      { id: '3', persona_key: '' },
    ];
    const groups = groupConversationsByPersona(list, L);
    expect(groups.map((g) => g.key)).toEqual(['assistant', '']);
    const last = groups[groups.length - 1];
    expect(last.label).toBe('Unassigned');
    expect(last.items.map((i) => i.id)).toEqual(['2', '3']);
  });

  test('a since-removed persona keeps its own labelled group', () => {
    const groups = groupConversationsByPersona([
      { id: '1', persona_key: 'claudePromptCompressor' },
    ]);
    expect(groups[0].key).toBe('claudePromptCompressor');
    expect(groups[0].label).toBe('Claude Prompt Compressor');
  });

  test('nullish / non-array → [] and never throws', () => {
    expect(groupConversationsByPersona(null)).toEqual([]);
    expect(groupConversationsByPersona(undefined)).toEqual([]);
    expect(groupConversationsByPersona('nope')).toEqual([]);
    expect(groupConversationsByPersona([null, {}])).toHaveLength(1);
  });
});

describe('_hcModifiedMs', () => {
  test('prefers updated_at, falls back to created_at, else 0', () => {
    const t = Date.parse('2026-01-01T00:00:00.000Z');
    expect(_hcModifiedMs({ updated_at: '2026-01-01T00:00:00.000Z' })).toBe(t);
    expect(_hcModifiedMs({ created_at: '2026-01-01T00:00:00.000Z' })).toBe(t);
    expect(_hcModifiedMs({})).toBe(0);
    expect(_hcModifiedMs(null)).toBe(0);
    expect(_hcModifiedMs({ updated_at: 'garbage' })).toBe(0);
  });
});

describe('_hcPersonaLabel', () => {
  test('override map wins, then removed-persona map, then the raw key', () => {
    expect(_hcPersonaLabel('teacher', { teacher: 'Coach' })).toBe('Coach');
    expect(_hcPersonaLabel('teacher')).toBe('Patient Teacher');
    expect(_hcPersonaLabel('claudePromptCompressor')).toBe('Claude Prompt Compressor');
    expect(_hcPersonaLabel('mystery')).toBe('mystery');
  });
});

describe('normalizeConversationTitle', () => {
  test('trims and collapses whitespace', () => {
    expect(normalizeConversationTitle('  hello \n\t  world  ')).toBe('hello world');
  });

  test('strips ASCII control characters', () => {
    expect(normalizeConversationTitle('a\u0000b\u0007c')).toBe('a b c');
  });

  test('empty / whitespace-only / non-string → empty string', () => {
    expect(normalizeConversationTitle('')).toBe('');
    expect(normalizeConversationTitle('   \n ')).toBe('');
    expect(normalizeConversationTitle(null)).toBe('');
    expect(normalizeConversationTitle(undefined)).toBe('');
    expect(normalizeConversationTitle(42)).toBe('');
    expect(normalizeConversationTitle({})).toBe('');
  });

  test('over-long input is cut to 200 chars (never rejected by the server)', () => {
    expect(normalizeConversationTitle('x'.repeat(500))).toHaveLength(200);
  });

  test('markup is kept verbatim as text (rendered via textContent, never HTML)', () => {
    expect(normalizeConversationTitle('<img src=x onerror=alert(1)>')).toBe(
      '<img src=x onerror=alert(1)>'
    );
  });
});

describe('inline rename (card DOM)', () => {
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

  function mount(title = 'Original title') {
    document.body.innerHTML = '<div id="historyList"></div>';
    const card = _hcBuildCard({ id: 'c-1', title, message_count: 2, updated_at: '' }, null);
    document.getElementById('historyList').appendChild(card);
    return card;
  }

  function key(el, k) {
    const ev = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true });
    el.dispatchEvent(ev);
    return ev;
  }

  function openEditor(card, value) {
    card.querySelector('.history-card-rename').click();
    const input = card.querySelector('.history-card-rename-input');
    if (value !== undefined) input.value = value;
    return input;
  }

  beforeEach(() => {
    global.fetch = jest.fn(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, title: 'New name' }) })
    );
    global.showToast = jest.fn();
  });

  afterEach(() => {
    delete global.fetch;
    delete global.showToast;
    document.body.innerHTML = '';
  });

  test('card has a rename button next to delete, inside the actions wrapper', () => {
    const card = mount();
    const actions = card.querySelector('.history-card-actions');
    expect(actions.querySelector('.history-card-rename')).not.toBeNull();
    expect(actions.querySelector('.history-card-delete')).not.toBeNull();
    expect(card.querySelector('.history-card-rename svg')).not.toBeNull();
  });

  test('clicking rename swaps the title for a prefilled input and does not open the chat', () => {
    const card = mount();
    const input = openEditor(card);
    expect(input).not.toBeNull();
    expect(input.value).toBe('Original title');
    expect(input.maxLength).toBe(200);
    expect(card.querySelector('.history-card-title')).toBeNull();
    expect(card.classList.contains('is-renaming')).toBe(true);
    expect(global.fetch).not.toHaveBeenCalled();
    key(input, 'Escape');
  });

  test('Enter saves: PUTs the normalised title to /<id>/title and shows it', async () => {
    const card = mount();
    const input = openEditor(card, '  New   name ');
    key(input, 'Enter');
    await flush();

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toMatch(/\/c-1\/title$/);
    expect(opts.method).toBe('PUT');
    expect(JSON.parse(opts.body)).toEqual({ title: 'New name' });
    expect(card.querySelector('.history-card-rename-input')).toBeNull();
    expect(card.querySelector('.history-card-title').textContent).toBe('New name');
    expect(card.classList.contains('is-renaming')).toBe(false);
  });

  test('blur also saves', async () => {
    const card = mount();
    const input = openEditor(card, 'Via blur');
    input.dispatchEvent(new FocusEvent('blur'));
    await flush();
    expect(JSON.parse(global.fetch.mock.calls[0][1].body)).toEqual({ title: 'Via blur' });
  });

  test('Escape cancels: no request, original title restored', () => {
    const card = mount();
    const input = openEditor(card, 'Discarded');
    key(input, 'Escape');
    expect(global.fetch).not.toHaveBeenCalled();
    expect(card.querySelector('.history-card-title').textContent).toBe('Original title');
  });

  test('empty value is a silent cancel (no request)', () => {
    const card = mount();
    key(openEditor(card, '   '), 'Enter');
    expect(global.fetch).not.toHaveBeenCalled();
    expect(card.querySelector('.history-card-title').textContent).toBe('Original title');
  });

  test('unchanged value is a silent cancel (no request)', () => {
    const card = mount();
    key(openEditor(card, 'Original title'), 'Enter');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('server failure reverts the title and shows a toast', async () => {
    global.fetch = jest.fn(() => Promise.resolve({ ok: false, status: 500 }));
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const card = mount();
    key(openEditor(card, 'Will fail'), 'Enter');
    await flush();
    expect(card.querySelector('.history-card-title').textContent).toBe('Original title');
    expect(global.showToast).toHaveBeenCalledWith('Could not rename that conversation');
    spy.mockRestore();
  });

  test('network error reverts the title and shows a toast', async () => {
    global.fetch = jest.fn(() => Promise.reject(new Error('offline')));
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const card = mount();
    key(openEditor(card, 'Will fail'), 'Enter');
    await flush();
    expect(card.querySelector('.history-card-title').textContent).toBe('Original title');
    expect(global.showToast).toHaveBeenCalled();
    spy.mockRestore();
  });

  test('Enter / Space inside the input never open the conversation', () => {
    const card = mount();
    const input = openEditor(card);
    key(input, ' ');
    key(input, 'Enter');
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('F2 on the focused card starts a rename', () => {
    const card = mount();
    key(card, 'F2');
    const input = card.querySelector('.history-card-rename-input');
    expect(input).not.toBeNull();
    key(input, 'Escape');
  });

  test('Enter on the card still opens it; Enter on its buttons does not', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const card = mount();
    // Opening a conversation GETs /<id> (the archive step is a no-op here).
    key(card.querySelector('.history-card-rename'), 'Enter');
    key(card.querySelector('.history-card-delete'), 'Enter');
    expect(global.fetch).not.toHaveBeenCalled();
    key(card, 'Enter');
    await flush();
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(global.fetch.mock.calls[0][0]).toMatch(/[/]c-1$/);
    spy.mockRestore();
  });

  test('only one rename can be open at a time', () => {
    const card = mount();
    _hcBeginRename(card, 'c-1');
    _hcBeginRename(card, 'c-1');
    expect(card.querySelectorAll('.history-card-rename-input')).toHaveLength(1);
    key(card.querySelector('.history-card-rename-input'), 'Escape');
  });

  test('a markup title is shown as text, never parsed as HTML', async () => {
    const payload = '<img src=x onerror=alert(1)>';
    global.fetch = jest.fn(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, title: payload }) })
    );
    const card = mount();
    key(openEditor(card, payload), 'Enter');
    await flush();
    expect(card.querySelector('.history-card-title').textContent).toBe(payload);
    expect(card.querySelector('img')).toBeNull();
  });

  test('request body carries only the title, so the persona group is untouched', async () => {
    const card = mount();
    key(openEditor(card, 'Another'), 'Enter');
    await flush();
    expect(Object.keys(JSON.parse(global.fetch.mock.calls[0][1].body))).toEqual(['title']);
  });
});

describe('sidebar render order (DOM)', () => {
  const T = (d, h = 0) => `2026-03-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:00:00.000Z`;

  const data = () => [
    { id: 't1', title: 'Teacher newest', persona_key: 'teacher', updated_at: T(9), message_count: 2 },
    { id: 'a1', title: 'Assistant older', persona_key: 'assistant', updated_at: T(3), message_count: 2 },
    { id: 'c1', title: 'Cyber middle', persona_key: 'cybersecurity', updated_at: T(5), message_count: 2 },
    { id: 'a2', title: 'Assistant newer', persona_key: 'assistant', updated_at: T(7), message_count: 2 },
    { id: 'u1', title: 'No persona', updated_at: T(8), message_count: 1 },
  ];

  function render(items) {
    document.body.innerHTML = '<div id="historyList"></div><div id="historyEmpty"></div>';
    _hcRenderList(items);
    const groups = Array.from(document.querySelectorAll('.history-group')).map((g) => ({
      label: g.querySelector('.history-group-label').textContent,
      titles: Array.from(g.querySelectorAll('.history-card-title')).map((t) => t.textContent),
    }));
    return groups;
  }

  afterEach(() => {
    document.body.innerHTML = '';
  });

  test('groups render A→Z (Unassigned last); chats newest-modified first inside each', () => {
    expect(render(data())).toEqual([
      { label: 'Assistant', titles: ['Assistant newer', 'Assistant older'] },
      { label: 'Cybersecurity Consultant', titles: ['Cyber middle'] },
      { label: 'Patient Teacher', titles: ['Teacher newest'] },
      { label: 'Unassigned', titles: ['No persona'] },
    ]);
  });

  test('modifying a chat reorders only within its group — the persona list is unchanged', () => {
    const before = render(data());
    // Assistant older (a1) is modified and becomes the newest chat overall.
    const modified = data().map((c) => (c.id === 'a1' ? { ...c, updated_at: T(20) } : c));
    const after = render(modified);
    expect(after.map((g) => g.label)).toEqual(before.map((g) => g.label));
    expect(after[0].titles).toEqual(['Assistant older', 'Assistant newer']);
    expect(after.slice(1)).toEqual(before.slice(1));
  });

  test('server list order does not matter', () => {
    const shuffled = data().reverse();
    expect(render(shuffled)).toEqual(render(data()));
  });
});
