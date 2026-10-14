/**
 * @jest-environment jsdom
 */
'use strict';

// Settings → Personas renders a per-persona "Chat model" override. These tests
// open the real panel in jsdom (real settings.js, real DOM building) and check
// what the user would see for the Cybersecurity Consultant and for a persona
// that simply inherits the global model.

const path = require('path');

const SETTINGS_JS = path.join(__dirname, '../../src/aia/scripts/settings.js');
const UTILS_JS = path.join(__dirname, '../../src/aia/scripts/utils.js');

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function snapshotFor(active) {
  const persona = (extra) => ({
    thinking_enabled: null,
    thinking_depth: null,
    tts_engine: null,
    chat_model: null,
    icon: '',
    ...extra,
  });
  return {
    global: {
      chat_model: 'gemma4:e4b',
      vision_model: 'gemma3:4b',
      tts_engine: 'piper',
      auto_speak: false,
      stt_lang: 'en-US',
      thinking_enabled: false,
      thinking_depth: 'medium',
      nav_rail: true,
      theme: 'system',
      active_persona: active,
    },
    personas: {
      assistant: persona(),
      cybersecurity: persona({ chat_model: 'cyber-consultant' }),
    },
    defaults: {
      global: {},
      persona: { thinking_enabled: null, thinking_depth: null, tts_engine: null },
      persona_chat_model: { cybersecurity: 'cyber-consultant' },
    },
  };
}

// Fresh module (the installed-model list is cached in a module variable) +
// fresh DOM, with /api/tags answering `installed`.
async function openPersonas(active, installed) {
  jest.resetModules();
  document.body.innerHTML = '<div id="settingsRoot"></div>';
  window.vpalSettings = snapshotFor(active);
  global.OLLAMA_TAGS_URL = 'https://localhost/ollama/api/tags';
  global.parseOllamaModels = require(UTILS_JS).parseOllamaModels;
  global.fetch = jest.fn(() =>
    Promise.resolve({
      ok: true,
      type: 'basic',
      json: () => Promise.resolve({ models: installed.map((name) => ({ name })) }),
    })
  );
  const { openSettings } = require(SETTINGS_JS);
  openSettings('personas');
  await flush();
  await flush();
  return {
    select: () => document.getElementById('settings-o-chat_model'),
    row: () => document.querySelector('[data-field="chat_model"]'),
  };
}

afterEach(() => {
  delete global.fetch;
  delete global.OLLAMA_TAGS_URL;
  delete global.parseOllamaModels;
  delete window.vpalSettings;
  document.body.innerHTML = '';
});

const optionTexts = (sel) => Array.from(sel.options).map((o) => o.textContent);

describe('Settings → Personas → Chat model', () => {
  test('Cybersecurity Consultant shows the cyber-consultant model, selected, with no reset arrow', async () => {
    const ui = await openPersonas('cybersecurity', ['cyber-consultant:latest', 'gemma4:e4b']);
    const sel = ui.select();
    expect(sel).not.toBeNull();
    expect(sel.value).toBe('cyber-consultant');
    // Ollama's `:latest` suffix is shown, not flagged "(not installed)".
    expect(sel.options[sel.selectedIndex].textContent).toBe('cyber-consultant:latest');
    expect(optionTexts(sel).join('|')).not.toMatch(/not installed/);
    expect(ui.row().querySelector('.settings-field-reset').hidden).toBe(true);
  });

  test('offers inherit (naming the persona default) plus every installed model', async () => {
    const ui = await openPersonas('cybersecurity', ['cyber-consultant:latest', 'gemma4:e4b']);
    expect(optionTexts(ui.select())).toEqual([
      'Persona default (cyber-consultant)',
      'cyber-consultant:latest',
      'gemma4:e4b',
    ]);
  });

  test('flags the model when Ollama does not have it', async () => {
    const ui = await openPersonas('cybersecurity', ['gemma4:e4b']);
    expect(optionTexts(ui.select())).toContain('cyber-consultant (not installed)');
  });

  test('picking a different model reveals the reset arrow', async () => {
    const ui = await openPersonas('cybersecurity', ['cyber-consultant:latest', 'gemma4:e4b']);
    const sel = ui.select();
    sel.value = 'gemma4:e4b';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    expect(ui.row().querySelector('.settings-field-reset').hidden).toBe(false);
  });

  test('a persona with no pinned model inherits the global one', async () => {
    const ui = await openPersonas('assistant', ['cyber-consultant:latest', 'gemma4:e4b']);
    const sel = ui.select();
    expect(sel.value).toBe('__inherit');
    expect(sel.options[0].textContent).toBe('Inherit (global chat model)');
    expect(ui.row().querySelector('.settings-field-reset').hidden).toBe(true);
  });

  test('explains that no system prompt is sent for the cybersecurity persona', async () => {
    await openPersonas('cybersecurity', ['cyber-consultant:latest']);
    const view = document.querySelector('.settings-prompt-view');
    expect(view.textContent).toMatch(/VPAL sends no system prompt/);
  });
});
