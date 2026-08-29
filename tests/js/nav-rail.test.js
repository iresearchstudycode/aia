'use strict';

const {
  navRailCollapseTitle,
  navRailTruncateWords,
  navRailBuildModel,
} = require('../../src/aia/scripts/nav-rail.js');

describe('navRailTruncateWords', () => {
  test('fewer than max words → returned unchanged', () => {
    expect(navRailTruncateWords('one two three', 25)).toBe('one two three');
  });

  test('exactly 25 words → returned unchanged (no ellipsis)', () => {
    const words = Array.from({ length: 25 }, (_, i) => `w${i + 1}`);
    const text = words.join(' ');
    expect(navRailTruncateWords(text, 25)).toBe(text);
  });

  test('more than 25 words → first 25 words + "…"', () => {
    const words = Array.from({ length: 40 }, (_, i) => `w${i + 1}`);
    const out = navRailTruncateWords(words.join(' '), 25);
    expect(out).toBe(words.slice(0, 25).join(' ') + '…');
    expect(out.split(' ')).toHaveLength(25);
    expect(out.endsWith('…')).toBe(true);
  });

  test('default maxWords is 25 when omitted', () => {
    const words = Array.from({ length: 30 }, (_, i) => `w${i + 1}`);
    const out = navRailTruncateWords(words.join(' '));
    expect(out).toBe(words.slice(0, 25).join(' ') + '…');
  });

  test('collapses newlines, tabs and multi-space runs', () => {
    expect(navRailTruncateWords('one   two\tthree\n\nfour', 25)).toBe('one two three four');
  });

  test('collapses whitespace before counting words', () => {
    const words = Array.from({ length: 26 }, (_, i) => `w${i + 1}`);
    const spaced = words.join('   \n  ');
    const out = navRailTruncateWords(spaced, 25);
    expect(out).toBe(words.slice(0, 25).join(' ') + '…');
  });

  test('empty string → ""', () => {
    expect(navRailTruncateWords('', 25)).toBe('');
  });

  test('whitespace-only string → ""', () => {
    expect(navRailTruncateWords('   \n\t  ', 25)).toBe('');
  });

  test('nullish → ""', () => {
    expect(navRailTruncateWords(null, 25)).toBe('');
    expect(navRailTruncateWords(undefined, 25)).toBe('');
  });
});

describe('navRailCollapseTitle', () => {
  test('multiline input → single trimmed line', () => {
    expect(navRailCollapseTitle('  How do I\n  center a div?\n')).toBe('How do I center a div?');
  });

  test('short input returned unchanged', () => {
    expect(navRailCollapseTitle('What is a closure?')).toBe('What is a closure?');
  });

  test('longer than 140 chars → cut to 140 + "…"', () => {
    const long = 'x'.repeat(200);
    const out = navRailCollapseTitle(long);
    expect(out).toHaveLength(141);
    expect(out.endsWith('…')).toBe(true);
    expect(out.slice(0, 140)).toBe('x'.repeat(140));
  });

  test('exactly 140 chars → unchanged (no ellipsis)', () => {
    const exact = 'y'.repeat(140);
    expect(navRailCollapseTitle(exact)).toBe(exact);
  });

  test('empty string → ""', () => {
    expect(navRailCollapseTitle('')).toBe('');
  });

  test('nullish → ""', () => {
    expect(navRailCollapseTitle(null)).toBe('');
    expect(navRailCollapseTitle(undefined)).toBe('');
  });
});

describe('navRailBuildModel', () => {
  test('produces { index, title, snippet } per turn with correct indices', () => {
    const turns = [
      { userText: 'First question', aiText: 'First answer' },
      { userText: 'Second question', aiText: 'Second answer' },
      { userText: 'Third question', aiText: 'Third answer' },
    ];
    expect(navRailBuildModel(turns)).toEqual([
      { index: 0, title: 'First question', snippet: 'First answer' },
      { index: 1, title: 'Second question', snippet: 'Second answer' },
      { index: 2, title: 'Third question', snippet: 'Third answer' },
    ]);
  });

  test('empty / whitespace userText → title "(no text)"', () => {
    const out = navRailBuildModel([
      { userText: '', aiText: 'a' },
      { userText: '   \n ', aiText: 'b' },
    ]);
    expect(out[0].title).toBe('(no text)');
    expect(out[1].title).toBe('(no text)');
  });

  test('missing userText → title "(no text)"', () => {
    const out = navRailBuildModel([{ aiText: 'answer only' }]);
    expect(out[0]).toEqual({ index: 0, title: '(no text)', snippet: 'answer only' });
  });

  test('long aiText → 25-word snippet with trailing "…"', () => {
    const words = Array.from({ length: 60 }, (_, i) => `word${i + 1}`);
    const out = navRailBuildModel([{ userText: 'Q', aiText: words.join(' ') }]);
    expect(out[0].snippet).toBe(words.slice(0, 25).join(' ') + '…');
  });

  test('title is collapsed/ellipsised via navRailCollapseTitle', () => {
    const long = 'z'.repeat(200);
    const out = navRailBuildModel([{ userText: long, aiText: 'x' }]);
    expect(out[0].title).toHaveLength(141);
    expect(out[0].title.endsWith('…')).toBe(true);
  });

  test('non-array input → []', () => {
    expect(navRailBuildModel(null)).toEqual([]);
    expect(navRailBuildModel(undefined)).toEqual([]);
    expect(navRailBuildModel('nope')).toEqual([]);
  });

  test('empty array → []', () => {
    expect(navRailBuildModel([])).toEqual([]);
  });
});
