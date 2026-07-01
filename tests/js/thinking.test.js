'use strict';

const { splitThinkingContent } = require('../../src/aia/scripts/utils.js');

const THINK_END = '<|/think|>';

describe('splitThinkingContent — native Ollama thinking mode', () => {
  test('thinking phase: thinkingBuffer non-empty, fullResponse empty', () => {
    expect(splitThinkingContent('I am reasoning…', '')).toEqual({
      thinking: 'I am reasoning…',
      answer: '',
    });
  });

  test('answer phase: thinkingBuffer and fullResponse both non-empty', () => {
    expect(splitThinkingContent('deep thought', 'Here is my answer')).toEqual({
      thinking: 'deep thought',
      answer: 'Here is my answer',
    });
  });

  test('accumulates multi-token thinking and answer correctly', () => {
    const thinking = 'step1\nstep2\nstep3';
    const answer = 'final answer token';
    expect(splitThinkingContent(thinking, answer)).toEqual({ thinking, answer });
  });
});

describe('splitThinkingContent — inline token mode', () => {
  test('thinking phase: THINK_END not yet received', () => {
    expect(splitThinkingContent('', 'reasoning in progress')).toEqual({
      thinking: 'reasoning in progress',
      answer: '',
    });
  });

  test('splits correctly on THINK_END boundary', () => {
    expect(splitThinkingContent('', `think here${THINK_END}answer here`)).toEqual({
      thinking: 'think here',
      answer: 'answer here',
    });
  });

  test('trims leading whitespace and newlines from answer after THINK_END', () => {
    const { answer } = splitThinkingContent('', `think${THINK_END}  \n  answer`);
    expect(answer).toBe('answer');
  });

  test('THINK_END at start of fullResponse yields empty thinking', () => {
    expect(splitThinkingContent('', `${THINK_END}answer`)).toEqual({
      thinking: '',
      answer: 'answer',
    });
  });

  test('THINK_END at end of fullResponse yields empty answer', () => {
    const { thinking, answer } = splitThinkingContent('', `thinking text${THINK_END}`);
    expect(thinking).toBe('thinking text');
    expect(answer).toBe('');
  });

  test('only first THINK_END is used as boundary', () => {
    const { thinking, answer } = splitThinkingContent('', `a${THINK_END}b${THINK_END}c`);
    expect(thinking).toBe('a');
    expect(answer).toBe(`b${THINK_END}c`);
  });

  test('empty thinkingBuffer and empty fullResponse', () => {
    expect(splitThinkingContent('', '')).toEqual({ thinking: '', answer: '' });
  });
});

describe('splitThinkingContent — abort scenarios', () => {
  test('native mode abort mid-thinking: thinkingBuffer set, fullResponse empty → no answer to save', () => {
    const { thinking, answer } = splitThinkingContent('partial reasoning', '');
    expect(thinking).toBe('partial reasoning');
    expect(answer).toBe('');
  });

  test('native mode abort mid-answer: both buffers have content → answer is saved', () => {
    const { thinking, answer } = splitThinkingContent('full thinking', 'partial answer');
    expect(thinking).toBe('full thinking');
    expect(answer).toBe('partial answer');
  });

  test('inline mode abort mid-answer: THINK_END present, partial answer extractable', () => {
    const { thinking, answer } = splitThinkingContent('', `think${THINK_END}partial`);
    expect(thinking).toBe('think');
    expect(answer).toBe('partial');
  });

  test('inline mode abort mid-thinking: no THINK_END yet → answer is empty', () => {
    const { answer } = splitThinkingContent('', 'still thinking...');
    expect(answer).toBe('');
  });
});
