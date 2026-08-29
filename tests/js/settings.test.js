/**
 * @jest-environment jsdom
 */
'use strict';

const {
  resolveSetting,
  resolveThinkingMode,
  resolveTtsEngine,
  diffSettings,
  buildMigrationPayload,
} = require('../../src/aia/scripts/settings.js');

// Minimal snapshot in the `GET /settings` shape.
function makeSnapshot(overrides) {
  const base = {
    global: {
      chat_model: 'gemma4:e4b',
      vision_model: 'gemma3:4b',
      tts_engine: 'piper',
      auto_speak: false,
      stt_lang: 'en-US',
      thinking_enabled: false,
      thinking_depth: 'medium',
      nav_rail: true,
      active_persona: 'englishEditor',
    },
    personas: {
      englishEditor: {
        thinking_enabled: null,
        thinking_depth: null,
        tts_engine: null,
        editor_mode: 'clean',
      },
      assistant: { thinking_enabled: null, thinking_depth: null, tts_engine: null },
    },
    defaults: {
      global: {
        chat_model: 'gemma4:e4b',
        vision_model: 'gemma3:4b',
        tts_engine: 'piper',
        auto_speak: false,
        stt_lang: 'en-US',
        thinking_enabled: false,
        thinking_depth: 'medium',
        nav_rail: true,
        active_persona: 'englishEditor',
      },
      persona: {
        thinking_enabled: null,
        thinking_depth: null,
        tts_engine: null,
        editor_mode: 'clean',
      },
    },
  };
  return Object.assign(base, overrides || {});
}

describe('resolveSetting', () => {
  test('persona override wins over the global value', () => {
    const s = makeSnapshot();
    s.personas.assistant.tts_engine = 'voicebox';
    expect(resolveSetting('tts_engine', 'assistant', s)).toBe('voicebox');
  });

  test('null persona override falls through to the global value', () => {
    const s = makeSnapshot();
    s.global.tts_engine = 'voicebox';
    s.personas.assistant.tts_engine = null;
    expect(resolveSetting('tts_engine', 'assistant', s)).toBe('voicebox');
  });

  test('global falls through to defaults.global when unset', () => {
    const s = makeSnapshot();
    delete s.global.thinking_depth;
    expect(resolveSetting('thinking_depth', 'assistant', s)).toBe('medium');
  });

  test('global-only key resolves via global for any persona', () => {
    const s = makeSnapshot();
    s.global.chat_model = 'llama3:8b';
    expect(resolveSetting('chat_model', 'assistant', s)).toBe('llama3:8b');
  });

  test('null personaKey uses the global view directly', () => {
    const s = makeSnapshot();
    s.personas.assistant.thinking_enabled = true;
    expect(resolveSetting('thinking_enabled', null, s)).toBe(false);
  });

  test('a false global value is returned, not treated as unset', () => {
    const s = makeSnapshot();
    expect(resolveSetting('auto_speak', 'assistant', s)).toBe(false);
  });

  test('unknown persona key is ignored, global used', () => {
    const s = makeSnapshot();
    expect(resolveSetting('tts_engine', 'nope', s)).toBe('piper');
  });
});

describe('resolveThinkingMode', () => {
  test('disabled globally → "off"', () => {
    expect(resolveThinkingMode('assistant', makeSnapshot())).toBe('off');
  });

  test('enabled globally → resolved depth', () => {
    const s = makeSnapshot();
    s.global.thinking_enabled = true;
    s.global.thinking_depth = 'high';
    expect(resolveThinkingMode('assistant', s)).toBe('high');
  });

  test('persona override enables thinking even when global is off', () => {
    const s = makeSnapshot();
    s.personas.assistant.thinking_enabled = true;
    expect(resolveThinkingMode('assistant', s)).toBe('medium');
  });

  test('persona override of depth is respected', () => {
    const s = makeSnapshot();
    s.global.thinking_enabled = true;
    s.personas.assistant.thinking_depth = 'low';
    expect(resolveThinkingMode('assistant', s)).toBe('low');
  });

  test('persona override can disable thinking that is globally on', () => {
    const s = makeSnapshot();
    s.global.thinking_enabled = true;
    s.personas.assistant.thinking_enabled = false;
    expect(resolveThinkingMode('assistant', s)).toBe('off');
  });

  test('bad resolved depth falls back to "medium"', () => {
    const s = makeSnapshot();
    s.global.thinking_enabled = true;
    s.global.thinking_depth = 'bogus';
    delete s.defaults.global.thinking_depth;
    expect(resolveThinkingMode('assistant', s)).toBe('medium');
  });
});

describe('resolveTtsEngine', () => {
  test('persona null → global engine', () => {
    const s = makeSnapshot();
    s.global.tts_engine = 'voicebox';
    expect(resolveTtsEngine('assistant', s)).toBe('voicebox');
  });

  test('persona set → persona engine', () => {
    const s = makeSnapshot();
    s.personas.assistant.tts_engine = 'voicebox';
    expect(resolveTtsEngine('assistant', s)).toBe('voicebox');
  });

  test('nothing resolvable → "piper"', () => {
    expect(resolveTtsEngine('assistant', { global: {}, personas: {}, defaults: { global: {} } })).toBe(
      'piper'
    );
  });
});

describe('diffSettings', () => {
  test('returns only the changed keys', () => {
    const form = { chat_model: 'llama3:8b', tts_engine: 'piper', auto_speak: true };
    const resolved = { chat_model: 'gemma4:e4b', tts_engine: 'piper', auto_speak: false };
    expect(diffSettings(form, resolved)).toEqual({ chat_model: 'llama3:8b', auto_speak: true });
  });

  test('empty object when identical', () => {
    const v = { a: 1, b: 'x', c: false };
    expect(diffSettings(v, { ...v })).toEqual({});
  });

  test('handles booleans (false → true is a change)', () => {
    expect(diffSettings({ nav_rail: false }, { nav_rail: true })).toEqual({ nav_rail: false });
  });

  test('handles null (override cleared)', () => {
    expect(diffSettings({ tts_engine: null }, { tts_engine: 'voicebox' })).toEqual({
      tts_engine: null,
    });
  });

  test('keys absent from the form are never emitted', () => {
    expect(diffSettings({}, { a: 1 })).toEqual({});
  });

  test('nullish arguments do not throw', () => {
    expect(diffSettings(null, null)).toEqual({});
    expect(diffSettings(undefined, undefined)).toEqual({});
  });
});

describe('buildMigrationPayload', () => {
  test('maps the legacy snapshot to global + persona keys', () => {
    const snapshot = {
      ollamaModel: 'llama3:8b',
      ttsEngine: 'voicebox',
      autoTTS: 'true',
      thinkingOn: 'true',
      thinkingDepth: 'high',
      navRailEnabled: 'false',
      editorMode: 'changes',
    };
    expect(buildMigrationPayload(snapshot)).toEqual({
      global: {
        chat_model: 'llama3:8b',
        tts_engine: 'voicebox',
        auto_speak: true,
        thinking_enabled: true,
        thinking_depth: 'high',
        nav_rail: false,
      },
      personas: {
        englishEditor: { editor_mode: 'changes' },
      },
    });
  });

  test('personaPrefs JSON expands to per-persona keys', () => {
    const snapshot = {
      personaPrefs: JSON.stringify({
        assistant: { thinkingOn: true, thinkingDepth: 'low', ttsEngine: 'voicebox' },
        creative: { thinkingOn: false },
      }),
    };
    expect(buildMigrationPayload(snapshot)).toEqual({
      global: {},
      personas: {
        assistant: { thinking_enabled: true, thinking_depth: 'low', tts_engine: 'voicebox' },
        creative: { thinking_enabled: false },
      },
    });
  });

  test('editorMode from personaPrefs and top-level key merge on englishEditor', () => {
    const snapshot = {
      editorMode: 'explain',
      personaPrefs: JSON.stringify({ englishEditor: { thinkingOn: true } }),
    };
    expect(buildMigrationPayload(snapshot).personas.englishEditor).toEqual({
      thinking_enabled: true,
      editor_mode: 'explain',
    });
  });

  test('missing keys are omitted', () => {
    expect(buildMigrationPayload({})).toEqual({ global: {}, personas: {} });
    expect(buildMigrationPayload(undefined)).toEqual({ global: {}, personas: {} });
  });

  test('unrecognised enum values are skipped', () => {
    const snapshot = { ttsEngine: 'espeak', thinkingDepth: 'ludicrous', editorMode: 'weird' };
    expect(buildMigrationPayload(snapshot)).toEqual({ global: {}, personas: {} });
  });

  test('"false" strings map to boolean false', () => {
    const snapshot = { autoTTS: 'false', thinkingOn: 'false', navRailEnabled: 'true' };
    expect(buildMigrationPayload(snapshot).global).toEqual({
      auto_speak: false,
      thinking_enabled: false,
      nav_rail: true,
    });
  });

  test('malformed personaPrefs JSON does not throw', () => {
    expect(() => buildMigrationPayload({ personaPrefs: '{not json' })).not.toThrow();
    expect(buildMigrationPayload({ personaPrefs: '{not json' })).toEqual({
      global: {},
      personas: {},
    });
  });

  test('personaPrefs that is a JSON array is ignored', () => {
    expect(buildMigrationPayload({ personaPrefs: '[1,2,3]' })).toEqual({
      global: {},
      personas: {},
    });
  });

  test('empty ollamaModel string is omitted', () => {
    expect(buildMigrationPayload({ ollamaModel: '' })).toEqual({ global: {}, personas: {} });
  });
});
