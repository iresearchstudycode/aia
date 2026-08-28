'use strict';

const { parseOllamaModels } = require('../../src/aia/scripts/utils.js');

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
