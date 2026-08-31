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
  _repairMermaid,
  _cleanupMermaidOrphan,
  _colourCodeMermaidNodes,
  _addMarkdownCopyBtn,
  personaIconEl,
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

describe('_repairMermaid', () => {
  test('quotes unquoted parentheses in a {rhombus} node label', () => {
    const src = 'graph TD\n  A --> D{Web Application Firewall (WAF)};';
    expect(_repairMermaid(src)).toContain('D{"Web Application Firewall (WAF)"}');
  });

  test('quotes parentheses inside a [rect] node label', () => {
    const src = 'flowchart TD\n  G[WAF (L7 OWASP/bot)] --> H;';
    expect(_repairMermaid(src)).toContain('G["WAF (L7 OWASP/bot)"]');
  });

  test('leaves a clean label untouched', () => {
    const src = 'graph TD\n  A[Internet] --> B[Shield];';
    expect(_repairMermaid(src)).toBe(src);
  });

  test('leaves doubled shapes ({{ }}) alone', () => {
    const src = 'graph TD\n  A{{Hexagon}} --> B;';
    expect(_repairMermaid(src)).toBe(src);
  });

  test('is a no-op for non-flowchart diagram types', () => {
    const src = 'sequenceDiagram\n  Alice->>Bob: Hi (there)';
    expect(_repairMermaid(src)).toBe(src);
  });

  test('tolerates non-string input', () => {
    expect(_repairMermaid(undefined)).toBeUndefined();
  });

  test('the repaired form of the real broken gemma output parses cleanly enough to differ', () => {
    const broken = [
      'graph TD',
      '    A[Internet] --> D{Web Application Firewall (WAF)};',
      '    D --> G{NACL (Subnet Guardrail)};',
      '    G --> H{Security Group (Instance State Allowance)};',
    ].join('\n');
    const fixed = _repairMermaid(broken);
    expect(fixed).not.toBe(broken);
    expect(fixed).toContain('{"Web Application Firewall (WAF)"}');
    expect(fixed).toContain('{"NACL (Subnet Guardrail)"}');
  });

  test('quotes an edge label containing braces / quotes / slashes', () => {
    const src =
      'flowchart TD\n  A -->|GET /api/generate {"model": "x"}| B[Server]';
    const fixed = _repairMermaid(src);
    expect(fixed).toContain("|\"GET /api/generate {'model': 'x'}\"|");
  });

  test('leaves a clean edge label unquoted', () => {
    const src = 'flowchart LR\n  A[Foo] -->|does a thing| B[Bar]';
    expect(_repairMermaid(src)).toBe(src);
  });

  test('strips classDef lines and :::class applications', () => {
    const src = [
      'flowchart TD',
      '  A[Start]:::hot --> B[End]',
      '  classDef hot fill:#e8f5e9,stroke:#4caf50;',
    ].join('\n');
    const fixed = _repairMermaid(src);
    expect(fixed).not.toMatch(/classDef/);
    expect(fixed).not.toMatch(/:::/);
    expect(fixed).toContain('A[Start] --> B[End]');
  });

  test('collapses a literal "\\n" and the "& \\n" node-chain form', () => {
    const src = 'flowchart TD\n  X[a] & \\nY[b] -.-> Z[c]';
    const fixed = _repairMermaid(src);
    expect(fixed).not.toMatch(/\\n/);
  });

  test('drops <br/> inside a quoted node label', () => {
    const src = 'flowchart TD\n  M[Gemma Service<br/>(GPU accelerated)] --> K';
    const fixed = _repairMermaid(src);
    expect(fixed).toContain('M["Gemma Service (GPU accelerated)"]');
  });

  test('appends a missing `end` when a subgraph is left unclosed', () => {
    const src = [
      'flowchart TD',
      '  A --> B',
      '  subgraph Cluster ["Ollama"]',
      '    B --> C',
      '  end',
      '  subgraph Stray thing', // model junk at the tail, no `end`
    ].join('\n');
    const fixed = _repairMermaid(src);
    const opens = (fixed.match(/^[ \t]*subgraph\b/gim) || []).length;
    const ends = (fixed.match(/^[ \t]*end\b/gim) || []).length;
    expect(opens).toBe(ends);
  });

  test('leaves a balanced multi-word subgraph title untouched', () => {
    const src = [
      'graph TD',
      '  C --> D{Web Application Firewall (WAF)}', // forces the repair path
      '  subgraph Egress Path Controls',
      '    I --> J',
      '  end',
    ].join('\n');
    const fixed = _repairMermaid(src);
    expect(fixed).toContain('subgraph Egress Path Controls');
    expect((fixed.match(/^[ \t]*end\b/gim) || []).length).toBe(1);
  });
});

describe('_cleanupMermaidOrphan', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  test('removes the throwaway #d<id> container when it is a direct body child', () => {
    const orphan = document.createElement('div');
    orphan.id = 'dmmd-abc';
    document.body.appendChild(orphan);
    _cleanupMermaidOrphan('mmd-abc');
    expect(document.getElementById('dmmd-abc')).toBeNull();
  });

  test('never removes the rendered SVG root, whose id equals the render id', () => {
    // mermaid ids the returned <svg> after the render id — deleting #<id> would
    // wipe the diagram. The cleanup must only touch #d<id>.
    const wrapper = document.createElement('div');
    wrapper.className = 'mermaid-diagram';
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.id = 'mmd-abc';
    wrapper.appendChild(svg);
    document.body.appendChild(wrapper);
    _cleanupMermaidOrphan('mmd-abc');
    expect(document.getElementById('mmd-abc')).not.toBeNull();
  });

  test('leaves a #d<id> node alone when it is nested rather than a body child', () => {
    const host = document.createElement('div');
    const nested = document.createElement('span');
    nested.id = 'dmmd-abc';
    host.appendChild(nested);
    document.body.appendChild(host);
    _cleanupMermaidOrphan('mmd-abc');
    expect(document.getElementById('dmmd-abc')).not.toBeNull();
  });
});

describe('_colourCodeMermaidNodes', () => {
  const NS = 'http://www.w3.org/2000/svg';
  function nodeWith(childTag, attrs = {}) {
    const wrapper = document.createElement('div');
    const svg = document.createElementNS(NS, 'svg');
    const g = document.createElementNS(NS, 'g');
    g.setAttribute('class', 'node');
    const shape = document.createElementNS(NS, childTag);
    Object.entries(attrs).forEach(([k, v]) => shape.setAttribute(k, v));
    g.appendChild(shape);
    svg.appendChild(g);
    wrapper.appendChild(svg);
    return { wrapper, shape };
  }

  test('a polygon (decision) node is filled with the amber decision colour', () => {
    const { wrapper, shape } = nodeWith('polygon', { points: '0,10 10,0 20,10 10,20' });
    _colourCodeMermaidNodes(wrapper);
    expect(shape.style.fill).toBe('#ffe7ba');
  });

  test('a circle (terminator) node is filled with the sage terminator colour', () => {
    const { wrapper, shape } = nodeWith('circle', { r: '12' });
    _colourCodeMermaidNodes(wrapper);
    expect(shape.style.fill).toBe('#dceedc');
  });

  test('a stadium rect (rx ≈ height/2) is treated as a terminator', () => {
    const { wrapper, shape } = nodeWith('rect', { rx: '20', height: '40' });
    _colourCodeMermaidNodes(wrapper);
    expect(shape.style.fill).toBe('#dceedc');
  });

  test('a plain rectangle (process) is left for the themeVariables fill', () => {
    const { wrapper, shape } = nodeWith('rect', { rx: '0', height: '40' });
    _colourCodeMermaidNodes(wrapper);
    expect(shape.style.fill).toBe('');
  });

  test('does not throw on an empty wrapper', () => {
    expect(() => _colourCodeMermaidNodes(document.createElement('div'))).not.toThrow();
  });
});

describe('_addMarkdownCopyBtn', () => {
  test('prepends a .md-copy-btn carrying the raw markdown', () => {
    const el = document.createElement('div');
    el.innerHTML = '<p>rendered</p>';
    _addMarkdownCopyBtn(el, '# Heading\n\nbody');
    const btn = el.querySelector(':scope > .md-copy-btn');
    expect(btn).not.toBeNull();
    expect(btn.dataset.markdown).toBe('# Heading\n\nbody');
    expect(el.firstChild).toBe(btn);
  });

  test('does nothing for empty / whitespace text', () => {
    const el = document.createElement('div');
    _addMarkdownCopyBtn(el, '   ');
    expect(el.querySelector('.md-copy-btn')).toBeNull();
  });

  test('is idempotent — a second call refreshes the text, not the button count', () => {
    const el = document.createElement('div');
    _addMarkdownCopyBtn(el, 'first');
    _addMarkdownCopyBtn(el, 'second');
    expect(el.querySelectorAll('.md-copy-btn')).toHaveLength(1);
    expect(el.querySelector('.md-copy-btn').dataset.markdown).toBe('second');
  });
});

describe('personaIconEl', () => {
  afterEach(() => {
    delete global.window.vpalSettings;
    delete global.personaIcons;
  });

  test('returns a sanitised <svg> element from vpalSettings.personas[key].icon', () => {
    global.window.vpalSettings = {
      personas: { teacher: { icon: '<svg viewBox="0 0 24 24"><path d="M2 4h6"/></svg>' } },
    };
    const el = personaIconEl('teacher');
    expect(el).not.toBeNull();
    expect(el.tagName.toLowerCase()).toBe('svg');
    expect(el.querySelector('path')).not.toBeNull();
  });

  test('falls back to the personaIcons global when the settings copy is absent', () => {
    global.personaIcons = { legal: '<svg viewBox="0 0 24 24"><line x1="0" y1="0" x2="9" y2="9"/></svg>' };
    const el = personaIconEl('legal');
    expect(el && el.tagName.toLowerCase()).toBe('svg');
  });

  test('strips scripts / event handlers from a hostile icon string', () => {
    global.window.vpalSettings = {
      personas: {
        x: { icon: '<svg onload="alert(1)"><script>alert(2)<\/script><path d="M0 0"/></svg>' },
      },
    };
    const el = personaIconEl('x');
    expect(el.getAttribute('onload')).toBeNull();
    expect(el.querySelector('script')).toBeNull();
  });

  test('returns null when there is no icon for the key', () => {
    expect(personaIconEl('nope')).toBeNull();
  });
});
