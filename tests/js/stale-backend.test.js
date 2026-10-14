/**
 * @jest-environment jsdom
 */
'use strict';

// A backend image older than the frontend rejects values the UI legitimately sends
// (e.g. the cybersecurity persona). The UI must say "rebuild the service" rather than
// fail with a bare console 422 — but must NOT cry "stale" for an ordinary user mistake.

const path = require('path');

const SETTINGS_JS = path.join(__dirname, '../../src/aia/scripts/settings.js');
const HISTORY_JS = path.join(__dirname, '../../src/aia/scripts/history.js');

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function respond(status, body) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
  });
}

const PERSONA_ENUM_ERROR = {
  ok: false,
  error: 'active_persona must be one of: assistant, casual, creative, englishEditor, legal',
};

describe('isStaleServiceResponse', () => {
  const { isStaleServiceResponse } = require(SETTINGS_JS);

  test.each([
    [422, 'active_persona must be one of: assistant, casual'],
    [422, 'tts_engine must be one of: piper, voicebox'],
    [422, 'unknown persona setting: chat_model'],
    [422, 'unknown global setting: something_new'],
    [404, 'unknown persona: cybersecurity'],
    [422, 'editor_mode is only valid for the englishEditor persona'],
  ])('%i "%s" → stale backend', (status, error) => {
    expect(isStaleServiceResponse({ ok: false, error, __status: status })).toBe(true);
  });

  test.each([
    [422, 'stt_lang must be a BCP-47-style tag (e.g. en, en-US)'],
    [422, 'chat_model must be a non-empty string'],
    [422, 'chat_model must be at most 200 characters'],
    [422, 'request body must be valid JSON'],
    [500, 'active_persona must be one of: a, b'],
    [401, 'missing or malformed X-Auth-User header'],
  ])('%i "%s" → an ordinary error, not stale', (status, error) => {
    expect(isStaleServiceResponse({ ok: false, error, __status: status })).toBe(false);
  });

  test('never throws on junk', () => {
    expect(isStaleServiceResponse(null)).toBe(false);
    expect(isStaleServiceResponse(undefined)).toBe(false);
    expect(isStaleServiceResponse('nope')).toBe(false);
    expect(isStaleServiceResponse({})).toBe(false);
    expect(isStaleServiceResponse({ __status: 422 })).toBe(false);
  });
});

describe('switching persona against a stale settings-service', () => {
  let setActivePersona;
  let SETTINGS_STALE_MESSAGE;
  let toast;

  beforeEach(() => {
    jest.resetModules();
    ({ setActivePersona, SETTINGS_STALE_MESSAGE } = require(SETTINGS_JS));
    toast = jest.fn();
    global.showToast = toast;
    window.vpalSettings = {
      global: { active_persona: 'assistant' },
      personas: {},
      defaults: { global: {}, persona: {} },
    };
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    delete global.fetch;
    delete global.showToast;
    delete window.vpalSettings;
    jest.restoreAllMocks();
  });

  test('a persona-enum rejection tells the user to rebuild, for long enough to read', async () => {
    global.fetch = jest.fn(() => respond(422, PERSONA_ENUM_ERROR));
    await expect(setActivePersona('cybersecurity')).resolves.toBe(false);
    expect(toast).toHaveBeenCalledTimes(1);
    const [message, duration] = toast.mock.calls[0];
    expect(message).toBe(SETTINGS_STALE_MESSAGE);
    expect(message).toMatch(/docker-compose build --no-cache settings-service conversations-service/);
    expect(message).toMatch(/web-server/);
    expect(duration).toBeGreaterThanOrEqual(8000);
    // the active persona is NOT changed locally
    expect(window.vpalSettings.global.active_persona).toBe('assistant');
  });

  test('an ordinary server error keeps the plain message plus the server reason', async () => {
    global.fetch = jest.fn(() => respond(500, { ok: false, error: 'database is locked' }));
    await expect(setActivePersona('cybersecurity')).resolves.toBe(false);
    expect(toast).toHaveBeenCalledWith('Could not switch persona — database is locked');
  });

  test('a network failure keeps the generic message', async () => {
    global.fetch = jest.fn(() => Promise.reject(new Error('offline')));
    await expect(setActivePersona('cybersecurity')).resolves.toBe(false);
    expect(toast).toHaveBeenCalledWith('Could not switch persona');
  });

  test('an unparseable error body still resolves false with a message', async () => {
    global.fetch = jest.fn(() =>
      Promise.resolve({ ok: false, status: 502, json: () => Promise.reject(new Error('html')) })
    );
    await expect(setActivePersona('cybersecurity')).resolves.toBe(false);
    expect(toast).toHaveBeenCalledWith('Could not switch persona');
  });

  test('a successful switch shows no error toast', async () => {
    global.fetch = jest.fn(() =>
      respond(200, { ok: true, global: { active_persona: 'cybersecurity' } })
    );
    await expect(setActivePersona('cybersecurity')).resolves.toBe(true);
    expect(toast).not.toHaveBeenCalled();
    expect(window.vpalSettings.global.active_persona).toBe('cybersecurity');
  });
});

describe('history auto-save against a stale conversations-service', () => {
  let hist;
  let toast;

  beforeEach(() => {
    jest.resetModules();
    hist = require(HISTORY_JS);
    toast = jest.fn();
    global.showToast = toast;
    jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    delete global.showToast;
    jest.restoreAllMocks();
  });

  test('only a 422 counts as stale', () => {
    expect(hist.isStaleHistoryStatus(422)).toBe(true);
    [200, 204, 401, 404, 413, 429, 500, 502, undefined, null].forEach((s) =>
      expect(hist.isStaleHistoryStatus(s)).toBe(false)
    );
  });

  test('a rejected save warns once, with the rebuild command', () => {
    hist._hcNoteSaveFailure({ ok: false, status: 422 });
    hist._hcNoteSaveFailure({ ok: false, status: 422 });
    hist._hcNoteSaveFailure({ ok: false, status: 422 });
    expect(toast).toHaveBeenCalledTimes(1);
    const [message, duration] = toast.mock.calls[0];
    expect(message).toBe(hist.HISTORY_STALE_MESSAGE);
    expect(message).toMatch(/docker-compose build --no-cache conversations-service/);
    expect(duration).toBeGreaterThanOrEqual(8000);
  });

  test.each([
    [{ ok: true, status: 200 }],
    [{ ok: false, status: 500 }],
    [{ ok: false, status: 401 }],
    [undefined],
    [null],
  ])('%j is silent (retried next turn)', (res) => {
    hist._hcNoteSaveFailure(res);
    expect(toast).not.toHaveBeenCalled();
  });

  test('never throws without showToast', () => {
    delete global.showToast;
    expect(() => hist._hcNoteSaveFailure({ ok: false, status: 422 })).not.toThrow();
  });
});
