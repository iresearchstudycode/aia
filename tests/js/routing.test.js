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
    const { requestBody } = _buildRequestBody(null, [], SYSTEM, MODEL, VISION, 'off');
    expect(requestBody.model).toBe(MODEL);
  });

  test('initial vision (imageBase64 set) uses VISION_MODEL_NAME', () => {
    const { requestBody } = _buildRequestBody('img64', [], SYSTEM, MODEL, VISION, 'off');
    expect(requestBody.model).toBe(VISION);
  });

  test('follow-up text after image in history uses VISION_MODEL_NAME', () => {
    const history = [
      { role: 'user', content: 'describe this', imageBase64: 'img64' },
      { role: 'assistant', content: 'a motorway at night' },
    ];
    const { requestBody } = _buildRequestBody(null, history, SYSTEM, MODEL, VISION, 'off');
    expect(requestBody.model).toBe(VISION);
  });

  test('thinking mode does not affect model selection', () => {
    const { requestBody: off } = _buildRequestBody(null, [], SYSTEM, MODEL, VISION, 'off');
    const { requestBody: high } = _buildRequestBody(null, [], SYSTEM, MODEL, VISION, 'high');
    expect(off.model).toBe(MODEL);
    expect(high.model).toBe(MODEL);
  });

  test('a user-selected model (currentModel) lands in requestBody.model for the text path', () => {
    const picked = 'qwen2.5-coder:32b-instruct-q4_K_M';
    const { requestBody } = _buildRequestBody(null, [], SYSTEM, picked, VISION, 'off');
    expect(requestBody.model).toBe(picked);
  });

  test('vision turns ignore the selected model and use the vision model', () => {
    const picked = 'qwen2.5-coder:32b';
    // initial vision (new image attached)
    const initial = _buildRequestBody('img64', [], SYSTEM, picked, VISION, 'off');
    expect(initial.requestBody.model).toBe(VISION);
    // follow-up text after an image in history
    const history = [
      { role: 'user', content: 'describe this', imageBase64: 'img64' },
      { role: 'assistant', content: 'a street at dusk' },
    ];
    const followUp = _buildRequestBody(null, history, SYSTEM, picked, VISION, 'off');
    expect(followUp.requestBody.model).toBe(VISION);
  });
});

// ─── Stream mode ──────────────────────────────────────────────────────────────

describe('_buildRequestBody — stream mode', () => {
  test('text-only: stream:true', () => {
    const { requestBody } = _buildRequestBody(null, [], SYSTEM, MODEL, VISION, 'off');
    expect(requestBody.stream).toBe(true);
  });

  test('initial vision (hasCurrentImage): stream:false', () => {
    const { requestBody } = _buildRequestBody('img64', [], SYSTEM, MODEL, VISION, 'off');
    expect(requestBody.stream).toBe(false);
  });

  test('follow-up vision (no new image, history has image): stream:true', () => {
    const history = [{ role: 'user', imageBase64: 'img64' }];
    const { requestBody } = _buildRequestBody(null, history, SYSTEM, MODEL, VISION, 'off');
    expect(requestBody.stream).toBe(true);
  });
});

// ─── No assistant prefill ─────────────────────────────────────────────────────
// The `<|think|>  ` assistant prefill was removed in v1.26.1: Ollama's `think`
// parameter alone drives native reasoning separation for every thinking-capable
// model, and the prefill broke that split on qwen3 (whole reply → thinking box).

describe('_buildRequestBody — never injects an assistant prefill', () => {
  const NO_PREFILL = (rb) =>
    !rb.messages.some(m => m.role === 'assistant' && m.content && m.content.includes(THINK));

  for (const mode of ['off', 'low', 'medium', 'high']) {
    test(`thinking ${mode}: no assistant prefill, no trailing assistant message`, () => {
      const { requestBody } = _buildRequestBody(null, [], SYSTEM, MODEL, VISION, mode);
      expect(NO_PREFILL(requestBody)).toBe(true);
      expect(requestBody.messages[requestBody.messages.length - 1].role).not.toBe('assistant');
    });
  }

  test('history assistant turns are preserved verbatim (not mistaken for a prefill)', () => {
    const history = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello there' },
      { role: 'user', content: 'and now?' },
    ];
    const { requestBody } = _buildRequestBody(null, history, SYSTEM, MODEL, VISION, 'high');
    expect(requestBody.messages).toEqual([
      { role: 'system', content: SYSTEM },
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello there' },
      { role: 'user', content: 'and now?' },
    ]);
  });

  test('vision turns: no prefill regardless of mode', () => {
    const { requestBody: initial } = _buildRequestBody('img64', [], SYSTEM, MODEL, VISION, 'high');
    expect(NO_PREFILL(initial)).toBe(true);
    const history = [
      { role: 'user', content: 'describe', imageBase64: 'img64' },
      { role: 'assistant', content: 'a cat' },
    ];
    const { requestBody: followUp } = _buildRequestBody(null, history, SYSTEM, MODEL, VISION, 'high');
    expect(NO_PREFILL(followUp)).toBe(true);
  });
});

// ─── think field ─────────────────────────────────────────────────────────────

describe('_buildRequestBody — think field', () => {
  test('thinking off: think:false sent explicitly (model reasons by default otherwise)', () => {
    const { requestBody } = _buildRequestBody(null, [], SYSTEM, MODEL, VISION, 'off');
    expect(requestBody.think).toBe(false);
  });

  test('thinking low: think:true', () => {
    const { requestBody } = _buildRequestBody(null, [], SYSTEM, MODEL, VISION, 'low');
    expect(requestBody.think).toBe(true);
  });

  test('thinking medium: think:true', () => {
    const { requestBody } = _buildRequestBody(null, [], SYSTEM, MODEL, VISION, 'medium');
    expect(requestBody.think).toBe(true);
  });

  test('thinking high: think:true', () => {
    const { requestBody } = _buildRequestBody(null, [], SYSTEM, MODEL, VISION, 'high');
    expect(requestBody.think).toBe(true);
  });

  test('initial vision: no think field (gemma3 does not support reasoning)', () => {
    const { requestBody } = _buildRequestBody('img64', [], SYSTEM, MODEL, VISION, 'off');
    expect(requestBody.think).toBeUndefined();
  });

  test('follow-up vision: no think field regardless of mode', () => {
    const history = [{ role: 'user', imageBase64: 'img64' }];
    const { requestBody } = _buildRequestBody(null, history, SYSTEM, MODEL, VISION, 'high');
    expect(requestBody.think).toBeUndefined();
  });
});

// ─── Options ─────────────────────────────────────────────────────────────────

describe('_buildRequestBody — options', () => {
  const GEMMA_SAMPLING = { temperature: 1.0, top_p: 0.95, top_k: 64 };

  test('gemma, thinking off: gemma sampling + default num_ctx, no num_predict', () => {
    const { requestBody } = _buildRequestBody(null, [], SYSTEM, MODEL, VISION, 'off');
    expect(requestBody.options).toEqual({ ...GEMMA_SAMPLING, num_ctx: 16384 });
  });

  test('gemma, thinking low: gemma sampling + num_predict 4096 ceiling', () => {
    const { requestBody } = _buildRequestBody(null, [], SYSTEM, MODEL, VISION, 'low');
    expect(requestBody.options).toEqual({ ...GEMMA_SAMPLING, num_ctx: 16384, num_predict: 4096 });
  });

  test('gemma, thinking medium: gemma sampling + num_predict 8192 ceiling', () => {
    const { requestBody } = _buildRequestBody(null, [], SYSTEM, MODEL, VISION, 'medium');
    expect(requestBody.options).toEqual({ ...GEMMA_SAMPLING, num_ctx: 16384, num_predict: 8192 });
  });

  test('gemma, thinking high: gemma sampling, no num_predict ceiling (uncapped)', () => {
    const { requestBody } = _buildRequestBody(null, [], SYSTEM, MODEL, VISION, 'high');
    expect(requestBody.options).toEqual({ ...GEMMA_SAMPLING, num_ctx: 16384 });
  });

  test('non-gemma model: no gemma sampling override, only num_ctx', () => {
    const { requestBody } = _buildRequestBody(null, [], SYSTEM, 'qwen3.5:9b', VISION, 'off');
    expect(requestBody.options).toEqual({ num_ctx: 16384 });
  });

  test('non-gemma model, thinking low: num_predict ceiling but no sampling override', () => {
    const { requestBody } = _buildRequestBody(null, [], SYSTEM, 'qwen3.5:9b', VISION, 'low');
    expect(requestBody.options).toEqual({ num_ctx: 16384, num_predict: 4096 });
  });

  test('non-gemma model, thinking high: no num_predict, no sampling override', () => {
    const { requestBody } = _buildRequestBody(null, [], SYSTEM, 'deepseek-r1:8b', VISION, 'high');
    expect(requestBody.options).toEqual({ num_ctx: 16384 });
  });

  test('text-only: honors a custom numCtx when the caller passes one', () => {
    const { requestBody } = _buildRequestBody(null, [], SYSTEM, MODEL, VISION, 'off', 32768);
    expect(requestBody.options.num_ctx).toBe(32768);
  });

  test('initial vision: no options (matches Ollama working sample)', () => {
    const { requestBody } = _buildRequestBody('img64', [], SYSTEM, MODEL, VISION, 'off');
    expect(requestBody.options).toBeUndefined();
  });

  test('follow-up vision: num_ctx hint to prevent context truncation', () => {
    const history = [{ role: 'user', imageBase64: 'img64' }];
    const { requestBody } = _buildRequestBody(null, history, SYSTEM, MODEL, VISION, 'off');
    expect(requestBody.options).toEqual({ num_ctx: 16384 });
  });

  test('follow-up vision: honors a custom numCtx when the caller passes one', () => {
    const history = [{ role: 'user', imageBase64: 'img64' }];
    const { requestBody } = _buildRequestBody(null, history, SYSTEM, MODEL, VISION, 'off', 32768);
    expect(requestBody.options).toEqual({ num_ctx: 32768 });
  });

  test('vision ignores thinking mode: no sampling options or budget on initial vision', () => {
    const { requestBody } = _buildRequestBody('img64', [], SYSTEM, MODEL, VISION, 'high');
    expect(requestBody.options).toBeUndefined();
  });
});

// ─── Messages array ───────────────────────────────────────────────────────────

describe('_buildRequestBody — messages array', () => {
  test('system prompt is always the first message', () => {
    const { requestBody } = _buildRequestBody(null, [], SYSTEM, MODEL, VISION, 'off');
    expect(requestBody.messages[0]).toEqual({ role: 'system', content: SYSTEM });
  });

  test('history entry with image gets images field', () => {
    const history = [{ role: 'user', content: 'look at this', imageBase64: 'img64' }];
    const { requestBody } = _buildRequestBody(null, history, SYSTEM, MODEL, VISION, 'off');
    const msg = requestBody.messages.find(m => m.content === 'look at this');
    expect(msg.images).toEqual(['img64']);
  });

  test('text-only history entry has no images field', () => {
    const history = [{ role: 'user', content: 'hello' }];
    const { requestBody } = _buildRequestBody(null, history, SYSTEM, MODEL, VISION, 'off');
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
    const { requestBody } = _buildRequestBody('b64_2', history, SYSTEM, MODEL, VISION, 'off');
    const histImg = requestBody.messages.find(m => m.content === 'first image');
    const curImg = requestBody.messages.find(m => m.content === 'second image');
    expect(histImg.images).toEqual(['b64_1']);
    expect(curImg.images).toEqual(['b64_2']);
  });
});

// ─── Returned flags ───────────────────────────────────────────────────────────

describe('_buildRequestBody — returned flags', () => {
  test('text-only: isVision=false, hasCurrentImage=false', () => {
    const { isVision, hasCurrentImage } = _buildRequestBody(null, [], SYSTEM, MODEL, VISION, 'off');
    expect(isVision).toBe(false);
    expect(hasCurrentImage).toBe(false);
  });

  test('initial vision: isVision=true, hasCurrentImage=true', () => {
    const { isVision, hasCurrentImage } = _buildRequestBody('img64', [], SYSTEM, MODEL, VISION, 'off');
    expect(isVision).toBe(true);
    expect(hasCurrentImage).toBe(true);
  });

  test('follow-up vision: isVision=true, hasCurrentImage=false', () => {
    const history = [{ role: 'user', imageBase64: 'img64' }];
    const { isVision, hasCurrentImage } = _buildRequestBody(null, history, SYSTEM, MODEL, VISION, 'off');
    expect(isVision).toBe(true);
    expect(hasCurrentImage).toBe(false);
  });
});
