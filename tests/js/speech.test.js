/**
 * @jest-environment jsdom
 */
'use strict';

const {
  stripMarkdownForSpeech,
  normalizeTtsEngine,
} = require('../../src/aia/scripts/utils.js');

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

describe('normalizeTtsEngine', () => {
  test('passes through the supported engines', () => {
    expect(normalizeTtsEngine('piper')).toBe('piper');
    expect(normalizeTtsEngine('voicebox')).toBe('voicebox');
  });

  test('maps the removed "browser" engine to "piper"', () => {
    expect(normalizeTtsEngine('browser')).toBe('piper');
  });

  test('maps unknown / null / undefined to "piper"', () => {
    expect(normalizeTtsEngine('robot')).toBe('piper');
    expect(normalizeTtsEngine(null)).toBe('piper');
    expect(normalizeTtsEngine(undefined)).toBe('piper');
    expect(normalizeTtsEngine('')).toBe('piper');
  });
});

// ---------------------------------------------------------------------------
// speakTextViaPiper / stopSpeaking — speech.js is a classic browser script,
// so we stub every cross-module global it reads before requiring it.
// ---------------------------------------------------------------------------

const flushPromises = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('speakTextViaPiper', () => {
  let speech;
  let fakeAudio;
  let playResolve;

  beforeEach(() => {
    jest.resetModules();

    document.body.innerHTML = `
      <button id="micBtn"></button>
      <button id="speakerBtn"></button>
    `;

    global.PIPER_SPEAK_URL = 'https://localhost/piper/speak';
    global.VOICEBOX_SPEAK_URL = 'https://localhost/voicebox/speak';
    global.SPEECH_RECOGNITION_LANG = 'en-US';
    global.SILENCE_TIMEOUT_MS = 3000;
    global.currentTTSEngine = 'piper';
    global.SPEAK_ICON = '<svg data-icon="speak"></svg>';
    global.STOP_ICON = '<svg data-icon="stop"></svg>';
    global.SPINNER_ICON = '<svg data-icon="spinner"></svg>';
    global.CHECK_ICON = '<svg data-icon="check"></svg>';
    global.stripMarkdownForSpeech = (t) => t;
    global.showToast = jest.fn();

    global.URL.createObjectURL = jest.fn(() => 'blob:mock-url');
    global.URL.revokeObjectURL = jest.fn();

    playResolve = null;
    fakeAudio = {
      paused: true,
      currentTime: 0,
      src: '',
      addEventListener: jest.fn(),
      pause: jest.fn(function () {
        this.paused = true;
      }),
      play: jest.fn(function () {
        this.paused = false;
        return new Promise((resolve) => {
          playResolve = resolve;
        });
      }),
    };
    global.Audio = jest.fn(() => fakeAudio);

    speech = require('../../src/aia/scripts/speech.js');
  });

  afterEach(() => {
    delete global.fetch;
    delete global.Audio;
  });

  test('POSTs the cleaned text to the Piper endpoint and plays the blob', async () => {
    const wavBlob = new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/wav' });
    global.fetch = jest.fn(() =>
      Promise.resolve({ ok: true, status: 200, blob: () => Promise.resolve(wavBlob) })
    );

    speech.speakTextViaPiper('Hello there.', null);
    await flushPromises();

    expect(global.fetch).toHaveBeenCalledWith(
      'https://localhost/piper/speak',
      expect.objectContaining({ method: 'POST' })
    );
    const body = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(body).toEqual({ text: 'Hello there.' });

    expect(global.URL.createObjectURL).toHaveBeenCalledWith(wavBlob);
    expect(fakeAudio.src).toBe('blob:mock-url');
    expect(fakeAudio.play).toHaveBeenCalled();
  });

  test('shows a toast and does not throw when the request fails', async () => {
    global.fetch = jest.fn(() => Promise.resolve({ ok: false, status: 502 }));

    speech.speakTextViaPiper('Hello there.', null);
    await flushPromises();

    expect(global.showToast).toHaveBeenCalledWith('Piper TTS is unavailable');
    expect(fakeAudio.play).not.toHaveBeenCalled();
  });

  test('ignores empty text after markdown stripping', () => {
    global.stripMarkdownForSpeech = () => '   ';
    global.fetch = jest.fn();

    speech.speakTextViaPiper('```only code```', null);

    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('stopSpeaking pauses playback and revokes the object URL', async () => {
    const wavBlob = new Blob([new Uint8Array([1, 2, 3])], { type: 'audio/wav' });
    global.fetch = jest.fn(() =>
      Promise.resolve({ ok: true, status: 200, blob: () => Promise.resolve(wavBlob) })
    );

    speech.speakTextViaPiper('Hello there.', null);
    await flushPromises();

    fakeAudio.paused = false; // simulate playing
    speech.stopSpeaking();

    expect(fakeAudio.pause).toHaveBeenCalled();
    expect(global.URL.revokeObjectURL).toHaveBeenCalledWith('blob:mock-url');
  });
});
