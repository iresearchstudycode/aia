'use strict';

const { readPersonaPref, writePersonaPref } = require('../../src/aia/scripts/utils.js');

describe('readPersonaPref', () => {
  test('returns the stored entry for a known persona key', () => {
    const json = JSON.stringify({
      legal: { thinkingOn: true, thinkingDepth: 'high', ttsEngine: 'browser' },
    });
    expect(readPersonaPref(json, 'legal')).toEqual({
      thinkingOn: true,
      thinkingDepth: 'high',
      ttsEngine: 'browser',
    });
  });

  test('returns null when the persona key is missing', () => {
    const json = JSON.stringify({ legal: { thinkingOn: true } });
    expect(readPersonaPref(json, 'creative')).toBeNull();
  });

  test('returns null (does not throw) on malformed JSON', () => {
    expect(readPersonaPref('{ not valid json', 'legal')).toBeNull();
  });

  test('returns null on an empty string', () => {
    expect(readPersonaPref('', 'legal')).toBeNull();
  });

  test('returns null when the parsed value is not an object', () => {
    expect(readPersonaPref('42', 'legal')).toBeNull();
    expect(readPersonaPref('"hello"', 'legal')).toBeNull();
    expect(readPersonaPref('[1,2,3]', 'legal')).toBeNull();
  });

  test('returns null when the entry itself is not an object', () => {
    expect(readPersonaPref(JSON.stringify({ legal: 'nope' }), 'legal')).toBeNull();
  });
});

describe('writePersonaPref', () => {
  test('creates a new entry from an empty store', () => {
    const out = writePersonaPref('{}', 'legal', { thinkingOn: true, thinkingDepth: 'high' });
    expect(JSON.parse(out)).toEqual({ legal: { thinkingOn: true, thinkingDepth: 'high' } });
  });

  test('merges a patch into an existing entry without dropping other keys', () => {
    const start = JSON.stringify({
      legal: { thinkingOn: false, thinkingDepth: 'low', ttsEngine: 'browser' },
    });
    const out = writePersonaPref(start, 'legal', { thinkingDepth: 'high' });
    expect(JSON.parse(out).legal).toEqual({
      thinkingOn: false,
      thinkingDepth: 'high',
      ttsEngine: 'browser',
    });
  });

  test('leaves other personas untouched', () => {
    const start = JSON.stringify({ creative: { ttsEngine: 'voicebox' } });
    const out = writePersonaPref(start, 'legal', { thinkingOn: true });
    expect(JSON.parse(out)).toEqual({
      creative: { ttsEngine: 'voicebox' },
      legal: { thinkingOn: true },
    });
  });

  test('ignores invalid thinkingDepth values', () => {
    const out = writePersonaPref('{}', 'legal', { thinkingDepth: 'extreme' });
    expect(JSON.parse(out)).toEqual({ legal: {} });
  });

  test('ignores invalid ttsEngine values', () => {
    const out = writePersonaPref('{}', 'legal', { ttsEngine: 'robot' });
    expect(JSON.parse(out)).toEqual({ legal: {} });
  });

  test('ignores non-boolean thinkingOn values', () => {
    const out = writePersonaPref('{}', 'legal', { thinkingOn: 'true' });
    expect(JSON.parse(out)).toEqual({ legal: {} });
  });

  test('ignores unknown keys', () => {
    const out = writePersonaPref('{}', 'legal', { colour: 'blue', thinkingOn: true });
    expect(JSON.parse(out)).toEqual({ legal: { thinkingOn: true } });
  });

  test('treats malformed input JSON as an empty store', () => {
    const out = writePersonaPref('{ broken', 'legal', { ttsEngine: 'voicebox' });
    expect(JSON.parse(out)).toEqual({ legal: { ttsEngine: 'voicebox' } });
  });

  test('round-trips with readPersonaPref', () => {
    const patch = { thinkingOn: true, thinkingDepth: 'medium', ttsEngine: 'voicebox' };
    const json = writePersonaPref('{}', 'teacher', patch);
    expect(readPersonaPref(json, 'teacher')).toEqual(patch);
  });

  test('accepts every valid thinkingDepth', () => {
    for (const depth of ['low', 'medium', 'high']) {
      const out = writePersonaPref('{}', 'legal', { thinkingDepth: depth });
      expect(JSON.parse(out).legal.thinkingDepth).toBe(depth);
    }
  });
});
