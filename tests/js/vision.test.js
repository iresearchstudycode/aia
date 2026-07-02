const { calcResizeDims, detectVisionContext } = require('../../src/aia/scripts/utils.js');

// ─── calcResizeDims ───────────────────────────────────────────────────────────

describe('calcResizeDims', () => {
  test('image smaller than maxDim is unchanged', () => {
    expect(calcResizeDims(800, 600, 1024)).toEqual({ w: 800, h: 600 });
  });

  test('image exactly at maxDim is unchanged', () => {
    expect(calcResizeDims(1024, 768, 1024)).toEqual({ w: 1024, h: 768 });
  });

  test('landscape: width capped, height scaled proportionally', () => {
    expect(calcResizeDims(2048, 1536, 1024)).toEqual({ w: 1024, h: 768 });
  });

  test('landscape: non-divisible height rounded correctly', () => {
    // 2000 × 1333 → width=1024, height=round(1333*1024/2000)=round(682.496)=682
    expect(calcResizeDims(2000, 1333, 1024)).toEqual({ w: 1024, h: 682 });
  });

  test('portrait: height capped, width scaled proportionally', () => {
    expect(calcResizeDims(1536, 2048, 1024)).toEqual({ w: 768, h: 1024 });
  });

  test('square: both sides capped to maxDim', () => {
    expect(calcResizeDims(2000, 2000, 1024)).toEqual({ w: 1024, h: 1024 });
  });

  test('very small image is unchanged', () => {
    expect(calcResizeDims(100, 80, 1024)).toEqual({ w: 100, h: 80 });
  });

  test('1×1 image is unchanged', () => {
    expect(calcResizeDims(1, 1, 1024)).toEqual({ w: 1, h: 1 });
  });
});

// ─── detectVisionContext ──────────────────────────────────────────────────────

describe('detectVisionContext', () => {
  test('current imageBase64 set → true', () => {
    expect(detectVisionContext('base64data', [])).toBe(true);
  });

  test('no image, empty history → false', () => {
    expect(detectVisionContext(null, [])).toBe(false);
  });

  test('no image, history without images → false', () => {
    expect(detectVisionContext(null, [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ])).toBe(false);
  });

  test('no current image, history has image → true', () => {
    expect(detectVisionContext(null, [
      { role: 'user', content: 'what is this?', imageBase64: 'base64...' },
      { role: 'assistant', content: 'a motorway at night' },
    ])).toBe(true);
  });

  test('both current image and history image → true', () => {
    expect(detectVisionContext('newImage', [
      { role: 'user', imageBase64: 'oldImage' },
    ])).toBe(true);
  });

  test('image only in second history entry → true', () => {
    expect(detectVisionContext(null, [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
      { role: 'user', content: 'look at this', imageBase64: 'img64' },
      { role: 'assistant', content: 'I see it' },
    ])).toBe(true);
  });

  test('undefined imageBase64 → false', () => {
    expect(detectVisionContext(undefined, [])).toBe(false);
  });

  test('null history handled gracefully → false', () => {
    expect(detectVisionContext(null, null)).toBe(false);
  });

  test('undefined history handled gracefully → false', () => {
    expect(detectVisionContext(null, undefined)).toBe(false);
  });
});
