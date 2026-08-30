/**
 * @jest-environment jsdom
 */
'use strict';

const {
  chatTitleFrom,
  conversationRecordFrom,
  filterConversations,
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
