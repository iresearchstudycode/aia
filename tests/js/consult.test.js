/**
 * @jest-environment jsdom
 */
'use strict';

// Consultant analysis templates — parsers (utils.js) + render path (chat.js).

const _utils = require('../../src/aia/scripts/utils.js');
const {
  parseSwotSections,
  parseProsConsSections,
  parseConsultReply
} = _utils;

// chat.js render helpers need these on the global scope (classic-script shape).
global.marked = require('../../src/aia/scripts/marked.min.js');
global.DOMPurify = require('../../src/aia/scripts/dompurify.min.js');
global.hljs = require('../../src/aia/scripts/highlight.min.js');
global.protectLatexDelimiters = _utils.protectLatexDelimiters;
global.restoreLatexBackslashes = _utils.restoreLatexBackslashes;
global.parseConsultReply = _utils.parseConsultReply;
global._CONSULT_TEMPLATES = {
  swot: { label: 'SWOT analysis', scaffold: 'SWOT analysis of: ', format: 'FMT-SWOT' },
  proscons: { label: 'Pros & cons', scaffold: 'Weigh the pros and cons of: ', format: 'FMT-PC' }
};

const {
  renderConsultReply,
  _buildConsultViewSwitch,
  _composeConsultMessage
} = require('../../src/aia/scripts/chat.js');

// ---------------------------------------------------------------------------
// parseSwotSections
// ---------------------------------------------------------------------------
describe('parseSwotSections', () => {
  const full = [
    '## Strengths',
    '- Strong brand',
    '- Loyal customers',
    '',
    '## Weaknesses',
    '- Thin margins',
    '',
    '## Opportunities',
    '- New markets',
    '',
    '## Threats',
    '- New entrants'
  ].join('\n');

  test('splits the four ## sections into raw markdown bodies', () => {
    const s = parseSwotSections(full);
    expect(s.strengths).toBe('- Strong brand\n- Loyal customers');
    expect(s.weaknesses).toBe('- Thin margins');
    expect(s.opportunities).toBe('- New markets');
    expect(s.threats).toBe('- New entrants');
  });

  test('tolerates bold headers and a trailing colon, any heading level', () => {
    const src = '**Strengths:**\n- a\n\n#### Weaknesses\n- b\nOpportunities\n- c\n### Threats:\n- d';
    const s = parseSwotSections(src);
    expect(s.strengths).toBe('- a');
    expect(s.weaknesses).toBe('- b');
    expect(s.opportunities).toBe('- c');
    expect(s.threats).toBe('- d');
  });

  test('returns null when fewer than 2 of the 4 sections are present', () => {
    expect(parseSwotSections('## Strengths\n- only this one')).toBeNull();
    expect(parseSwotSections('a plain reply with no headings at all')).toBeNull();
  });

  test('a missing section is an empty string, not absent', () => {
    const s = parseSwotSections('## Strengths\n- a\n## Weaknesses\n- b');
    expect(s).not.toBeNull();
    expect(s.opportunities).toBe('');
    expect(s.threats).toBe('');
  });

  test('tolerates non-string input', () => {
    expect(parseSwotSections(undefined)).toBeNull();
    expect(parseSwotSections(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parseProsConsSections
// ---------------------------------------------------------------------------
describe('parseProsConsSections', () => {
  test('splits ## Pros / ## Cons', () => {
    const s = parseProsConsSections('## Pros\n- cheap\n- fast\n## Cons\n- fragile');
    expect(s.pros).toBe('- cheap\n- fast');
    expect(s.cons).toBe('- fragile');
  });

  test('one section present is enough', () => {
    expect(parseProsConsSections('## Pros\n- only pros')).not.toBeNull();
  });

  test('null when neither section is present', () => {
    expect(parseProsConsSections('no headings here')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// parseConsultReply dispatcher
// ---------------------------------------------------------------------------
describe('parseConsultReply', () => {
  test('routes by template', () => {
    expect(parseConsultReply('## Pros\n- a\n## Cons\n- b', 'proscons')).toEqual({
      pros: '- a',
      cons: '- b'
    });
    expect(parseConsultReply('## Strengths\n- a\n## Weaknesses\n- b', 'swot')).not.toBeNull();
  });

  test('unknown template → null', () => {
    expect(parseConsultReply('## Pros\n- a', 'nope')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// renderConsultReply
// ---------------------------------------------------------------------------
describe('renderConsultReply', () => {
  const swotText = [
    '## Strengths', '- Strong brand',
    '## Weaknesses', '- Thin margins',
    '## Opportunities', '- New markets',
    '## Threats', '- New entrants'
  ].join('\n');

  test('structured view builds a 4-cell SWOT grid with the section text', () => {
    const el = document.createElement('div');
    renderConsultReply(el, swotText, 'swot', 'structured');
    expect(el.classList.contains('consult-artifact')).toBe(true);
    const cells = el.querySelectorAll('.consult-grid--swot .consult-cell');
    expect(cells).toHaveLength(4);
    expect(el.querySelector('.consult-cell--strengths').textContent).toContain('Strong brand');
    expect(el.querySelector('.consult-cell--threats').textContent).toContain('New entrants');
  });

  test('a missing section renders the muted em-dash placeholder', () => {
    const el = document.createElement('div');
    renderConsultReply(el, '## Strengths\n- a\n## Weaknesses\n- b', 'swot', 'structured');
    expect(el.querySelector('.consult-cell--opportunities .consult-cell__empty').textContent).toBe('—');
  });

  test('proscons structured view builds two cells', () => {
    const el = document.createElement('div');
    renderConsultReply(el, '## Pros\n- cheap\n## Cons\n- fragile', 'proscons', 'structured');
    expect(el.querySelectorAll('.consult-grid--proscons .consult-cell')).toHaveLength(2);
    expect(el.querySelector('.consult-cell--pros').textContent).toContain('cheap');
  });

  test('text view renders plain markdown, no grid', () => {
    const el = document.createElement('div');
    renderConsultReply(el, swotText, 'swot', 'text');
    expect(el.querySelector('.consult-grid')).toBeNull();
    expect(el.querySelector('h2')).not.toBeNull();
    expect(el.querySelector('.md-copy-btn')).not.toBeNull();
  });

  test('structured view falls back to text when the reply does not parse', () => {
    const el = document.createElement('div');
    renderConsultReply(el, 'just a sentence, no headings', 'swot', 'structured');
    expect(el.querySelector('.consult-grid')).toBeNull();
    expect(el.classList.contains('consult-artifact')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// _buildConsultViewSwitch
// ---------------------------------------------------------------------------
describe('_buildConsultViewSwitch', () => {
  test('flips the view in place and persists entry.consultView', () => {
    const container = document.createElement('div');
    const entry = { consultArtifact: 'swot', consultView: 'structured' };
    const text = '## Strengths\n- a\n## Weaknesses\n- b\n## Opportunities\n- c\n## Threats\n- d';
    renderConsultReply(container, text, 'swot', 'structured');
    const sel = _buildConsultViewSwitch(entry, container, text);
    expect(sel.value).toBe('structured');
    expect([...sel.options].map((o) => o.value)).toEqual(['structured', 'text']);

    sel.value = 'text';
    sel.dispatchEvent(new Event('change'));
    expect(entry.consultView).toBe('text');
    expect(container.querySelector('.consult-grid')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// _composeConsultMessage
// ---------------------------------------------------------------------------
describe('_composeConsultMessage', () => {
  test('appends the template format instruction on its own paragraph', () => {
    expect(_composeConsultMessage('a new coffee shop', 'swot')).toBe(
      'a new coffee shop\n\nFMT-SWOT'
    );
  });

  test('unknown template → message unchanged', () => {
    expect(_composeConsultMessage('hello', 'nope')).toBe('hello');
  });
});
