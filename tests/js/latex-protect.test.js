'use strict';

const { protectLatexDelimiters, restoreLatexBackslashes } = require('../../src/aia/scripts/utils.js');

// marked.parse() applies CommonMark's backslash-escape rule, which strips a
// backslash immediately before ASCII punctuation (e.g. `\(` -> `(`). These
// tests simulate that by running protect -> [markdown's escape rule] -> restore,
// asserting the LaTeX-critical sequences survive the round trip.
function simulateMarkdownBackslashEscape(text) {
  // Mirrors CommonMark: backslash + one of !"#$%&'()*+,-./:;<=>?@[\]^_`{|}~
  // collapses to the bare punctuation character.
  return text.replace(/\\([!"#$%&'()*+,\-./:;<=>?@[\]^_`{|}~])/g, '$1');
}

function protectRenderRestore(text) {
  return restoreLatexBackslashes(simulateMarkdownBackslashEscape(protectLatexDelimiters(text)));
}

describe('protectLatexDelimiters / restoreLatexBackslashes', () => {
  test('plain round trip with no backslashes is a no-op', () => {
    const text = 'no backslashes here at all';
    expect(restoreLatexBackslashes(protectLatexDelimiters(text))).toBe(text);
  });

  test('\\(...\\) inline delimiter survives simulated markdown escaping', () => {
    const text = 'inline \\(a^2+b^2=c^2\\) paren-delimited';
    expect(protectRenderRestore(text)).toBe(text);
  });

  test('\\[...\\] display delimiter survives simulated markdown escaping', () => {
    const text = 'display \\[E = mc^2\\] bracket-delimited';
    expect(protectRenderRestore(text)).toBe(text);
  });

  test('\\\\ row separator survives simulated markdown escaping', () => {
    const text = 'matrix row sep \\\\ end';
    expect(protectRenderRestore(text)).toBe(text);
  });

  test('\\{...\\} escaped braces survive simulated markdown escaping', () => {
    const text = 'set notation \\{1, 2, 3\\}';
    expect(protectRenderRestore(text)).toBe(text);
  });

  test('without protection, simulated markdown escaping would strip these (sanity check)', () => {
    const text = 'inline \\(x\\) and \\[y\\]';
    expect(simulateMarkdownBackslashEscape(text)).toBe('inline (x) and [y]');
  });

  test('unescaped LaTeX commands (backslash + letter) are left untouched by protect', () => {
    const text = '\\frac{1}{2} + \\sqrt{2} + \\alpha';
    expect(protectLatexDelimiters(text)).toBe(text);
    expect(protectRenderRestore(text)).toBe(text);
  });

  test('bare single/double dollar delimiters are untouched (not in the protected set)', () => {
    const text = 'inline $x^2$ and display $$y^2$$';
    expect(protectLatexDelimiters(text)).toBe(text);
    expect(protectRenderRestore(text)).toBe(text);
  });

  test('mixed prose with multiple protected sequences round-trips correctly', () => {
    const text =
      'The formula \\(x = \\frac{-b \\pm \\sqrt{b^2-4ac}}{2a}\\) solves it, ' +
      'or in display form: \\[E = mc^2\\] with row sep \\\\ and set \\{1,2\\}.';
    expect(protectRenderRestore(text)).toBe(text);
  });

  test('restoreLatexBackslashes is a no-op when no placeholder is present', () => {
    const html = '<p>no placeholder chars in this html</p>';
    expect(restoreLatexBackslashes(html)).toBe(html);
  });
});
