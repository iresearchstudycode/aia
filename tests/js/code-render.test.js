/**
 * @jest-environment jsdom
 */
'use strict';

// marked, DOMPurify and highlight.js are browser globals at runtime (classic
// <script>s loaded before the app modules). Under Jest they are CommonJS-required
// and injected onto the global scope, mirroring that runtime shape — the same
// pattern tests/js/editor-diff.test.js uses for diff-match-patch.
global.marked = require('../../src/aia/scripts/marked.min.js');
global.DOMPurify = require('../../src/aia/scripts/dompurify.min.js');
global.hljs = require('../../src/aia/scripts/highlight.min.js');

// renderMarkdownToHtml() also reaches for these utils.js helpers as globals
// (the LaTeX backslash protect/restore pair) — inject them the same way.
const _utils = require('../../src/aia/scripts/utils.js');
global.protectLatexDelimiters = _utils.protectLatexDelimiters;
global.restoreLatexBackslashes = _utils.restoreLatexBackslashes;
// mermaid is deliberately NOT loaded: mermaid.render() needs real browser SVG
// layout and is not unit-testable — renderMermaidIn() no-ops when it is absent,
// and highlightCodeIn() must skip language-mermaid blocks regardless.

const {
  renderMarkdownToHtml,
  highlightCodeIn,
  renderMermaidIn,
} = require('../../src/aia/scripts/chat.js');

describe('renderMarkdownToHtml — fenced code blocks', () => {
  test('a ```mermaid block survives as <pre><code class="language-mermaid">', () => {
    const html = renderMarkdownToHtml('```mermaid\nflowchart TD\n  A[Start] --> B\n```');
    expect(html).toMatch(/<pre><code class="language-mermaid">/);
    expect(html).toContain('flowchart TD');
  });

  test('a regular ```js block keeps its language- class for highlight.js', () => {
    const html = renderMarkdownToHtml('```js\nconst x = 1;\n```');
    expect(html).toMatch(/<code class="language-js">/);
  });
});

describe('highlightCodeIn', () => {
  test('adds the hljs class and hljs-* token spans to a pre > code block', () => {
    const el = document.createElement('div');
    el.innerHTML = renderMarkdownToHtml('```js\nconst answer = 42;\n```');
    highlightCodeIn(el);

    const code = el.querySelector('pre code');
    expect(code.classList.contains('hljs')).toBe(true);
    expect(code.querySelectorAll('span[class^="hljs-"]').length).toBeGreaterThan(0);
    expect(code.dataset.hljsDone).toBe('1');
  });

  test('does not touch a language-mermaid block', () => {
    const el = document.createElement('div');
    el.innerHTML = renderMarkdownToHtml('```mermaid\nflowchart TD\n  A --> B\n```');
    highlightCodeIn(el);

    const code = el.querySelector('pre code');
    expect(code.classList.contains('hljs')).toBe(false);
    expect(code.classList.contains('language-mermaid')).toBe(true);
    expect(code.dataset.hljsDone).toBeUndefined();
  });

  test('is idempotent — a second pass leaves an already-highlighted block alone', () => {
    const el = document.createElement('div');
    el.innerHTML = renderMarkdownToHtml('```python\nx = 1\n```');
    highlightCodeIn(el);
    const firstPass = el.querySelector('pre code').innerHTML;
    highlightCodeIn(el);
    expect(el.querySelector('pre code').innerHTML).toBe(firstPass);
  });

  test('no pre > code in the element is a no-op', () => {
    const el = document.createElement('div');
    el.innerHTML = renderMarkdownToHtml('just a paragraph, no code');
    expect(() => highlightCodeIn(el)).not.toThrow();
  });
});

describe('renderMermaidIn', () => {
  test('no-ops (does not throw) when the mermaid global is absent', async () => {
    const el = document.createElement('div');
    el.innerHTML = renderMarkdownToHtml('```mermaid\nflowchart TD\n  A --> B\n```');
    await expect(renderMermaidIn(el)).resolves.toBeUndefined();
    // The <pre> is left in place for a browser (where mermaid is loaded) to render.
    expect(el.querySelector('pre code.language-mermaid')).not.toBeNull();
  });
});
