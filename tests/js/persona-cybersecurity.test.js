/**
 * @jest-environment jsdom
 */
'use strict';

// Cybersecurity Consultant persona: the persona is registered in every list that
// must know about it, runs on the `cyber-consultant` model via a per-persona
// chat_model override, and sends no VPAL system prompt (the model carries its own).

const fs = require('fs');
const path = require('path');

const {
  resolveSetting,
  SETTINGS_PERSONA_KEYS,
  SETTINGS_PERSONA_LABELS,
  _settingsPersonaModelOptions,
} = require('../../src/aia/scripts/settings.js');
const { HISTORY_PERSONA_LABELS } = require('../../src/aia/scripts/history.js');

const SCRIPTS = path.join(__dirname, '../../src/aia/scripts');

// config.js is a plain browser script (no exports) — evaluate it and hand back
// the persona tables.
function loadConfig() {
  const src = fs.readFileSync(path.join(SCRIPTS, 'config.js'), 'utf8');
  return new Function(src + '\n;return { systemPrompts, personaLabels, personaIcons };')();
}

// main.js is a DOMContentLoaded script — read its `_PERSONA_KEYS` literal from source.
function mainPersonaKeys() {
  const src = fs.readFileSync(path.join(SCRIPTS, 'main.js'), 'utf8');
  const m = src.match(/const _PERSONA_KEYS = \[([^\]]*)\]/);
  return (m ? m[1].match(/'([^']+)'/g) : []).map((s) => s.slice(1, -1));
}

const sorted = (arr) => arr.slice().sort();

describe('cybersecurity persona — registration', () => {
  const cfg = loadConfig();
  const selectable = Object.keys(cfg.systemPrompts).filter((k) => k !== 'englishEditorExplained');

  test('every persona list agrees on the same keys (so none can be forgotten)', () => {
    const expected = sorted(selectable);
    expect(sorted(Object.keys(cfg.personaLabels))).toEqual(expected);
    expect(sorted(Object.keys(cfg.personaIcons))).toEqual(expected);
    expect(sorted(SETTINGS_PERSONA_KEYS)).toEqual(expected);
    expect(sorted(Object.keys(SETTINGS_PERSONA_LABELS))).toEqual(expected);
    expect(sorted(Object.keys(HISTORY_PERSONA_LABELS))).toEqual(expected);
    expect(sorted(mainPersonaKeys())).toEqual(expected);
  });

  test('cybersecurity is one of them', () => {
    expect(selectable).toContain('cybersecurity');
  });

  test('is labelled "Cybersecurity Consultant" everywhere a label is shown', () => {
    expect(cfg.personaLabels.cybersecurity).toBe('Cybersecurity Consultant');
    expect(SETTINGS_PERSONA_LABELS.cybersecurity).toBe('Cybersecurity Consultant');
    expect(HISTORY_PERSONA_LABELS.cybersecurity).toBe('Cybersecurity Consultant');
  });

  test('has an inline SVG icon that follows the theme colour', () => {
    const icon = cfg.personaIcons.cybersecurity;
    expect(icon.startsWith('<svg')).toBe(true);
    expect(icon).toContain('stroke="currentColor"');
    expect(icon).not.toMatch(/<script|on\w+=/i);
    expect(icon).not.toBe(cfg.personaIcons.assistant);
  });

  test('sends no system prompt (the model carries its own); every other persona does', () => {
    expect(cfg.systemPrompts.cybersecurity).toBe('');
    selectable
      .filter((k) => k !== 'cybersecurity')
      .forEach((k) => {
        expect(typeof cfg.systemPrompts[k]).toBe('string');
        expect(cfg.systemPrompts[k].length).toBeGreaterThan(0);
      });
  });
});

describe('cybersecurity persona — model resolution', () => {
  const snap = (cyberModel) => ({
    global: { chat_model: 'gemma4:e4b', active_persona: 'cybersecurity' },
    personas: {
      cybersecurity: { chat_model: cyberModel },
      assistant: { chat_model: null },
    },
    defaults: {
      global: { chat_model: 'gemma4:e4b' },
      persona: {},
      persona_chat_model: { cybersecurity: 'cyber-consultant' },
    },
  });

  test('the persona override wins over the global chat model', () => {
    expect(resolveSetting('chat_model', 'cybersecurity', snap('cyber-consultant'))).toBe(
      'cyber-consultant'
    );
  });

  test('other personas (null override) and the global view keep the global model', () => {
    const s = snap('cyber-consultant');
    expect(resolveSetting('chat_model', 'assistant', s)).toBe('gemma4:e4b');
    expect(resolveSetting('chat_model', null, s)).toBe('gemma4:e4b');
  });

  test('a null persona override falls through to the global model', () => {
    expect(resolveSetting('chat_model', 'cybersecurity', snap(null))).toBe('gemma4:e4b');
  });

  test('a user-chosen model replaces the house default', () => {
    expect(resolveSetting('chat_model', 'cybersecurity', snap('qwen3:4b'))).toBe('qwen3:4b');
  });
});

describe('_settingsPersonaModelOptions', () => {
  const snapshot = {
    defaults: { persona_chat_model: { cybersecurity: 'cyber-consultant' } },
  };

  test('pinned persona: first option names its house default', () => {
    const opts = _settingsPersonaModelOptions('cyber-consultant', 'cybersecurity', snapshot);
    expect(opts[0]).toEqual(['__inherit', 'Persona default (cyber-consultant)']);
  });

  test('unpinned persona: first option inherits the global model', () => {
    const opts = _settingsPersonaModelOptions(null, 'legal', snapshot);
    expect(opts[0]).toEqual(['__inherit', 'Inherit (global chat model)']);
    expect(opts).toHaveLength(1);
  });

  test('the current override stays selectable before the model list has loaded', () => {
    const opts = _settingsPersonaModelOptions('qwen3:4b', 'legal', snapshot);
    expect(opts).toContainEqual(['qwen3:4b', 'qwen3:4b']);
  });

  test('tolerates a snapshot with no defaults block', () => {
    expect(() => _settingsPersonaModelOptions(null, 'legal', {})).not.toThrow();
  });
});
