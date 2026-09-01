'use strict';

const {
  parseOllamaModels,
  parseModelContextLengths,
  resolveNumCtx,
} = require('../../src/aia/scripts/utils.js');

describe('parseOllamaModels', () => {
  test('valid /api/tags response → case-insensitively sorted model names', () => {
    const json = {
      models: [
        { name: 'llama3:8b', model: 'llama3:8b', size: 1 },
        { name: 'Gemma4:e4b', model: 'Gemma4:e4b', size: 2 },
        { name: 'qwen2.5-coder:32b', model: 'qwen2.5-coder:32b', size: 3 },
      ],
    };
    expect(parseOllamaModels(json)).toEqual([
      'Gemma4:e4b',
      'llama3:8b',
      'qwen2.5-coder:32b',
    ]);
  });

  test('falls back to m.model when m.name is absent', () => {
    const json = { models: [{ model: 'gemma3:4b' }, { name: '', model: 'phi3:mini' }] };
    expect(parseOllamaModels(json)).toEqual(['gemma3:4b', 'phi3:mini']);
  });

  test('de-duplicates repeated names', () => {
    const json = {
      models: [
        { name: 'gemma4:e4b' },
        { name: 'gemma4:e4b' },
        { name: 'llama3:8b' },
      ],
    };
    expect(parseOllamaModels(json)).toEqual(['gemma4:e4b', 'llama3:8b']);
  });

  test('empty models array → []', () => {
    expect(parseOllamaModels({ models: [] })).toEqual([]);
  });

  test('missing models key → []', () => {
    expect(parseOllamaModels({})).toEqual([]);
    expect(parseOllamaModels({ tags: [] })).toEqual([]);
  });

  test('models is not an array → []', () => {
    expect(parseOllamaModels({ models: 'gemma4:e4b' })).toEqual([]);
    expect(parseOllamaModels({ models: { name: 'gemma4:e4b' } })).toEqual([]);
  });

  test('non-object / null / string / array input → [] (never throws)', () => {
    expect(parseOllamaModels(null)).toEqual([]);
    expect(parseOllamaModels(undefined)).toEqual([]);
    expect(parseOllamaModels('gemma4:e4b')).toEqual([]);
    expect(parseOllamaModels(42)).toEqual([]);
    expect(parseOllamaModels([{ name: 'gemma4:e4b' }])).toEqual([]);
  });

  test('skips malformed entries without a usable name', () => {
    const json = {
      models: [
        null,
        'gemma4:e4b',
        { size: 10 },
        { name: 123 },
        { name: 'llama3:8b' },
      ],
    };
    expect(parseOllamaModels(json)).toEqual(['llama3:8b']);
  });
});

describe('parseModelContextLengths', () => {
  test('extracts details.context_length keyed by model name', () => {
    const json = {
      models: [
        { name: 'qwen3:4b', details: { context_length: 262144 } },
        { name: 'deepseek-r1:8b', details: { context_length: 131072 } },
      ],
    };
    expect(parseModelContextLengths(json)).toEqual({
      'qwen3:4b': 262144,
      'deepseek-r1:8b': 131072,
    });
  });

  test('omits entries whose details have no context_length (e.g. the gemma line)', () => {
    const json = {
      models: [
        { name: 'gemma4:e4b', details: { family: 'gemma4' } },
        { name: 'gemma3:4b', details: {} },
        { name: 'qwen3:4b', details: { context_length: 262144 } },
      ],
    };
    expect(parseModelContextLengths(json)).toEqual({ 'qwen3:4b': 262144 });
  });

  test('falls back to m.model for the key when m.name is absent', () => {
    const json = { models: [{ model: 'phi3:mini', details: { context_length: 4096 } }] };
    expect(parseModelContextLengths(json)).toEqual({ 'phi3:mini': 4096 });
  });

  test('ignores non-positive, non-integer, non-numeric context_length values', () => {
    const json = {
      models: [
        { name: 'a', details: { context_length: 0 } },
        { name: 'b', details: { context_length: -1 } },
        { name: 'c', details: { context_length: 8192.5 } },
        { name: 'd', details: { context_length: '8192' } },
        { name: 'e', details: { context_length: Infinity } },
        { name: 'f', details: { context_length: 8192 } },
      ],
    };
    expect(parseModelContextLengths(json)).toEqual({ f: 8192 });
  });

  test('malformed / missing input → {} (never throws)', () => {
    expect(parseModelContextLengths(null)).toEqual({});
    expect(parseModelContextLengths(undefined)).toEqual({});
    expect(parseModelContextLengths('nope')).toEqual({});
    expect(parseModelContextLengths({})).toEqual({});
    expect(parseModelContextLengths({ models: 'x' })).toEqual({});
    expect(parseModelContextLengths({ models: [null, 'str', { size: 1 }] })).toEqual({});
  });
});

describe('resolveNumCtx', () => {
  const FALLBACK = 16384;
  const MAP = { 'qwen3:4b': 262144, 'small:1b': 8192, 'exact:1b': 16384 };

  test('unknown model → the fallback', () => {
    expect(resolveNumCtx('gemma4:e4b', FALLBACK, MAP)).toBe(16384);
  });

  test('known model → its full advertised window, even above the fallback', () => {
    expect(resolveNumCtx('qwen3:4b', FALLBACK, MAP)).toBe(262144);
  });

  test('known model with a small window → that window (below the fallback)', () => {
    expect(resolveNumCtx('small:1b', FALLBACK, MAP)).toBe(8192);
  });

  test('known model window equal to the fallback → that value', () => {
    expect(resolveNumCtx('exact:1b', FALLBACK, MAP)).toBe(16384);
  });

  test('empty / missing map → the fallback', () => {
    expect(resolveNumCtx('qwen3:4b', FALLBACK, {})).toBe(16384);
    expect(resolveNumCtx('qwen3:4b', FALLBACK, null)).toBe(16384);
    expect(resolveNumCtx('qwen3:4b', FALLBACK, undefined)).toBe(16384);
  });

  test('invalid fallback → 16384 (but a known window still wins)', () => {
    expect(resolveNumCtx('gemma4:e4b', 0, MAP)).toBe(16384);
    expect(resolveNumCtx('gemma4:e4b', -5, MAP)).toBe(16384);
    expect(resolveNumCtx('gemma4:e4b', 'big', MAP)).toBe(16384);
    expect(resolveNumCtx('small:1b', NaN, MAP)).toBe(8192);
    expect(resolveNumCtx('qwen3:4b', NaN, MAP)).toBe(262144);
  });
});
