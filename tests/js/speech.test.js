'use strict';

const { stripMarkdownForSpeech } = require('../../src/aia/scripts/utils.js');

describe('stripMarkdownForSpeech', () => {
  test('strips heading, bold, italic, and code markers', () => {
    expect(stripMarkdownForSpeech('Title **bold** *italic* `code` ~strike~')).toBe(
      'Title bold italic code strike'
    );
  });

  test('replaces markdown links with their link text', () => {
    expect(stripMarkdownForSpeech('See [the docs](https://example.com/path) for more')).toBe(
      'See the docs for more'
    );
  });

  test('replaces fenced code blocks with the words "code block"', () => {
    expect(stripMarkdownForSpeech('Run this:\n```js\nconsole.log(1);\n```\ndone')).toBe(
      'Run this:. code block. done'
    );
  });

  test('collapses newlines into ". "', () => {
    expect(stripMarkdownForSpeech('line one\nline two\n\nline three')).toBe(
      'line one. line two. line three'
    );
  });

  test('leaves plain text without markdown unchanged', () => {
    expect(stripMarkdownForSpeech('Hello world')).toBe('Hello world');
  });

  test('returns an empty string for empty input', () => {
    expect(stripMarkdownForSpeech('')).toBe('');
  });
});
