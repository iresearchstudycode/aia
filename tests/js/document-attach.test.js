'use strict';

const {
  truncateDocumentText,
  buildDocumentMessageContent,
  parseDocumentMessageContent
} = require('../../src/aia/scripts/utils.js');

describe('truncateDocumentText', () => {
  test('returns text unchanged when under the budget', () => {
    expect(truncateDocumentText('hello', 100)).toEqual({ text: 'hello', truncated: false });
  });

  test('returns text unchanged when exactly at the budget', () => {
    expect(truncateDocumentText('hello', 5)).toEqual({ text: 'hello', truncated: false });
  });

  test('slices and flags truncation when over the budget', () => {
    expect(truncateDocumentText('hello world', 5)).toEqual({ text: 'hello', truncated: true });
  });

  test('empty text is never truncated', () => {
    expect(truncateDocumentText('', 0)).toEqual({ text: '', truncated: false });
  });
});

describe('buildDocumentMessageContent', () => {
  test('includes filename, text, and the user question in order', () => {
    const result = buildDocumentMessageContent('notes.txt', 'Meeting notes here.', false, 'Summarize this.');
    expect(result).toBe(
      '--- Attached file: notes.txt ---\n' +
      'Meeting notes here.\n' +
      '--- End of notes.txt ---\n\n' +
      'Summarize this.'
    );
  });

  test('adds a "(truncated)" notice to the header when truncated', () => {
    const result = buildDocumentMessageContent('report.pdf', 'partial text', true, 'What is this about?');
    expect(result).toContain('--- Attached file: report.pdf (truncated) ---');
  });

  test('omits the truncation notice when not truncated', () => {
    const result = buildDocumentMessageContent('report.pdf', 'full text', false, 'Q?');
    expect(result).toContain('--- Attached file: report.pdf ---');
    expect(result).not.toContain('truncated');
  });

  test('falls back to a default prompt when the user sent no question', () => {
    const result = buildDocumentMessageContent('doc.md', 'content', false, '');
    expect(result).toContain('Please review the following document and be ready to answer questions about it.');
  });

  test('falls back to the default prompt when the question is only whitespace', () => {
    const result = buildDocumentMessageContent('doc.md', 'content', false, '   \n  ');
    expect(result).toContain('Please review the following document');
  });

  test('trims surrounding whitespace from a real question', () => {
    const result = buildDocumentMessageContent('doc.md', 'content', false, '  What year was this?  ');
    expect(result.endsWith('What year was this?')).toBe(true);
  });
});

describe('parseDocumentMessageContent', () => {
  test('round-trips a document message built by buildDocumentMessageContent', () => {
    const content = buildDocumentMessageContent('notes.txt', 'Meeting notes here.\nMore lines.', false, 'Summarize this.');
    expect(parseDocumentMessageContent(content)).toEqual({
      hasDocument: true,
      documentName: 'notes.txt',
      question: 'Summarize this.'
    });
  });

  test('round-trips a truncated document message', () => {
    const content = buildDocumentMessageContent('report.pdf', 'partial extracted text', true, 'What is this?');
    const parsed = parseDocumentMessageContent(content);
    expect(parsed.hasDocument).toBe(true);
    expect(parsed.documentName).toBe('report.pdf');
    expect(parsed.question).toBe('What is this?');
  });

  test('round-trips the default question when none was typed', () => {
    const content = buildDocumentMessageContent('doc.md', 'content', false, '');
    const parsed = parseDocumentMessageContent(content);
    expect(parsed.question).toBe('Please review the following document and be ready to answer questions about it.');
  });

  test('returns hasDocument: false for an ordinary message', () => {
    expect(parseDocumentMessageContent('just a normal question, no document')).toEqual({
      hasDocument: false
    });
  });

  test('returns hasDocument: false for an empty message', () => {
    expect(parseDocumentMessageContent('')).toEqual({ hasDocument: false });
  });

  test('handles multi-page document text containing blank lines', () => {
    const documentText = 'Page one text.\n\nPage two text.\n\nPage three text.';
    const content = buildDocumentMessageContent('multipage.pdf', documentText, false, 'What happens on page two?');
    expect(parseDocumentMessageContent(content)).toEqual({
      hasDocument: true,
      documentName: 'multipage.pdf',
      question: 'What happens on page two?'
    });
  });
});
