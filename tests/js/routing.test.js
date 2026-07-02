// routing.test.js — integration tests for the Ollama request routing logic.
// _buildRequestBody is extracted from api.js as a pure function; detectVisionContext
// must be wired as a global before require so the function can find it at call time.

const { detectVisionContext } = require('../../src/aia/scripts/utils.js');
global.detectVisionContext = detectVisionContext;
const { _buildRequestBody } = require('../../src/aia/scripts/api.js');

const MODEL = 'gemma4:e4b';
const VISION = 'gemma3:4b';
const SYSTEM = 'You are a helpful assistant.';
const THINK = '<|think|>';

// ─── Model selection ──────────────────────────────────────────────────────────

describe('_buildRequestBody — model selection', () => {
  test('text-only request uses MODEL_NAME', () => {
    const { requestBody } = _buildRequestBody(null, [], SYSTEM, MODEL, VISION);
    expect(requestBody.model).toBe(MODEL);
  });

  test('initial vision (imageBase64 set) uses VISION_MODEL_NAME', () => {
    const { requestBody } = _buildRequestBody('img64', [], SYSTEM, MODEL, VISION);
    expect(requestBody.model).toBe(VISION);
  });

  test('follow-up text after image in history uses VISION_MODEL_NAME', () => {
    const history = [
      { role: 'user', content: 'describe this', imageBase64: 'img64' },
      { role: 'assistant', content: 'a motorway at night' },
    ];
    const { requestBody } = _buildRequestBody(null, history, SYSTEM, MODEL, VISION);
    expect(requestBody.model).toBe(VISION);
  });
});

// ─── Stream mode ──────────────────────────────────────────────────────────────

describe('_buildRequestBody — stream mode', () => {
  test('text-only: stream:true', () => {
    const { requestBody } = _buildRequestBody(null, [], SYSTEM, MODEL, VISION);
    expect(requestBody.stream).toBe(true);
  });

  test('initial vision (hasCurrentImage): stream:false', () => {
    const { requestBody } = _buildRequestBody('img64', [], SYSTEM, MODEL, VISION);
    expect(requestBody.stream).toBe(false);
  });

  test('follow-up vision (no new image, history has image): stream:true', () => {
    const history = [{ role: 'user', imageBase64: 'img64' }];
    const { requestBody } = _buildRequestBody(null, history, SYSTEM, MODEL, VISION);
    expect(requestBody.stream).toBe(true);
  });
});

// ─── Thinking prefill ─────────────────────────────────────────────────────────

describe('_buildRequestBody — thinking prefill', () => {
  test('text-only: assistant prefill with <|think|> present', () => {
    const { requestBody } = _buildRequestBody(null, [], SYSTEM, MODEL, VISION);
    const prefill = requestBody.messages.find(
      m => m.role === 'assistant' && m.content && m.content.includes(THINK)
    );
    expect(prefill).toBeTruthy();
  });

  test('initial vision: no thinking prefill', () => {
    const { requestBody } = _buildRequestBody('img64', [], SYSTEM, MODEL, VISION);
    const hasPrefill = requestBody.messages.some(m => m.content && m.content.includes(THINK));
    expect(hasPrefill).toBe(false);
  });

  test('follow-up vision: no thinking prefill injected', () => {
    const history = [
      { role: 'user', content: 'describe', imageBase64: 'img64' },
      { role: 'assistant', content: 'a cat' },
    ];
    const { requestBody } = _buildRequestBody(null, history, SYSTEM, MODEL, VISION);
    const hasPrefill = requestBody.messages.some(m => m.content && m.content.includes(THINK));
    expect(hasPrefill).toBe(false);
  });
});

// ─── Options ─────────────────────────────────────────────────────────────────

describe('_buildRequestBody — options', () => {
  test('text-only: thinking-mode sampling options', () => {
    const { requestBody } = _buildRequestBody(null, [], SYSTEM, MODEL, VISION);
    expect(requestBody.options).toEqual({ temperature: 1.0, top_p: 0.95, top_k: 64 });
  });

  test('initial vision: no options (matches Ollama working sample)', () => {
    const { requestBody } = _buildRequestBody('img64', [], SYSTEM, MODEL, VISION);
    expect(requestBody.options).toBeUndefined();
  });

  test('follow-up vision: num_ctx hint to prevent context truncation', () => {
    const history = [{ role: 'user', imageBase64: 'img64' }];
    const { requestBody } = _buildRequestBody(null, history, SYSTEM, MODEL, VISION);
    expect(requestBody.options).toEqual({ num_ctx: 8192 });
  });
});

// ─── Messages array ───────────────────────────────────────────────────────────

describe('_buildRequestBody — messages array', () => {
  test('system prompt is always the first message', () => {
    const { requestBody } = _buildRequestBody(null, [], SYSTEM, MODEL, VISION);
    expect(requestBody.messages[0]).toEqual({ role: 'system', content: SYSTEM });
  });

  test('history entry with image gets images field', () => {
    const history = [{ role: 'user', content: 'look at this', imageBase64: 'img64' }];
    const { requestBody } = _buildRequestBody(null, history, SYSTEM, MODEL, VISION);
    const msg = requestBody.messages.find(m => m.content === 'look at this');
    expect(msg.images).toEqual(['img64']);
  });

  test('text-only history entry has no images field', () => {
    const history = [{ role: 'user', content: 'hello' }];
    const { requestBody } = _buildRequestBody(null, history, SYSTEM, MODEL, VISION);
    const msg = requestBody.messages.find(m => m.content === 'hello');
    expect(msg.images).toBeUndefined();
  });

  test('multi-turn: all history images forwarded to Ollama', () => {
    // streamOllamaResponse pushes the current user entry to conversationHistory
    // before calling _buildRequestBody, so the current message is already in history.
    const history = [
      { role: 'user', content: 'first image', imageBase64: 'b64_1' },
      { role: 'assistant', content: 'response' },
      { role: 'user', content: 'second image', imageBase64: 'b64_2' },
    ];
    const { requestBody } = _buildRequestBody('b64_2', history, SYSTEM, MODEL, VISION);
    const histImg = requestBody.messages.find(m => m.content === 'first image');
    const curImg = requestBody.messages.find(m => m.content === 'second image');
    expect(histImg.images).toEqual(['b64_1']);
    expect(curImg.images).toEqual(['b64_2']);
  });
});

// ─── Returned flags ───────────────────────────────────────────────────────────

describe('_buildRequestBody — returned flags', () => {
  test('text-only: isVision=false, hasCurrentImage=false', () => {
    const { isVision, hasCurrentImage } = _buildRequestBody(null, [], SYSTEM, MODEL, VISION);
    expect(isVision).toBe(false);
    expect(hasCurrentImage).toBe(false);
  });

  test('initial vision: isVision=true, hasCurrentImage=true', () => {
    const { isVision, hasCurrentImage } = _buildRequestBody('img64', [], SYSTEM, MODEL, VISION);
    expect(isVision).toBe(true);
    expect(hasCurrentImage).toBe(true);
  });

  test('follow-up vision: isVision=true, hasCurrentImage=false', () => {
    const history = [{ role: 'user', imageBase64: 'img64' }];
    const { isVision, hasCurrentImage } = _buildRequestBody(null, history, SYSTEM, MODEL, VISION);
    expect(isVision).toBe(true);
    expect(hasCurrentImage).toBe(false);
  });
});
