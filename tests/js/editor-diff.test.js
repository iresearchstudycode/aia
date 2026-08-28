'use strict';

// The vendored diff-match-patch is a browser global at runtime (loaded as a
// classic <script> before the app modules). Under Jest it is CommonJS-required
// and injected onto `global`, mirroring that runtime shape — diffWords() also
// accepts the constructor explicitly, which is what the assertions below use.
const dmpModule = require('../../src/aia/scripts/diff-match-patch.js');
global.diff_match_patch = dmpModule.diff_match_patch;

const { diffWords, migrateEditorModeValue } = require('../../src/aia/scripts/utils.js');

const DMP = dmpModule.diff_match_patch;

// Reassemble a segment list into the "before" / "after" strings it encodes —
// equal + delete segments must reproduce `original`, equal + insert `revised`.
function reconstruct(segments) {
  let before = '';
  let after = '';
  for (const seg of segments) {
    if (seg.op === 0) {
      before += seg.text;
      after += seg.text;
    } else if (seg.op === -1) {
      before += seg.text;
    } else {
      after += seg.text;
    }
  }
  return { before, after };
}

describe('diffWords', () => {
  test('no change — a single equal segment covering the whole string', () => {
    const segs = diffWords('the quick brown fox', 'the quick brown fox', DMP);
    expect(segs).toEqual([{ op: 0, text: 'the quick brown fox' }]);
  });

  test('pure insertion', () => {
    const segs = diffWords('the cat sat', 'the very fluffy cat sat', DMP);
    expect(segs.every((s) => s.op === 0 || s.op === 1)).toBe(true);
    expect(reconstruct(segs)).toEqual({ before: 'the cat sat', after: 'the very fluffy cat sat' });
  });

  test('pure deletion', () => {
    const segs = diffWords('the very fluffy cat sat', 'the cat sat', DMP);
    expect(segs.every((s) => s.op === 0 || s.op === -1)).toBe(true);
    expect(reconstruct(segs)).toEqual({ before: 'the very fluffy cat sat', after: 'the cat sat' });
  });

  test('word replacement produces a delete + insert pair', () => {
    const segs = diffWords('she dont like it', 'she does not like it', DMP);
    expect(segs.some((s) => s.op === -1)).toBe(true);
    expect(segs.some((s) => s.op === 1)).toBe(true);
    expect(reconstruct(segs)).toEqual({
      before: 'she dont like it',
      after: 'she does not like it',
    });
  });

  test('empty original — one insert segment with the whole revised text', () => {
    const segs = diffWords('', 'brand new sentence', DMP);
    expect(segs).toEqual([{ op: 1, text: 'brand new sentence' }]);
  });

  test('empty revised — one delete segment with the whole original', () => {
    const segs = diffWords('discard all of this', '', DMP);
    expect(segs).toEqual([{ op: -1, text: 'discard all of this' }]);
  });

  test('both empty — no segments', () => {
    expect(diffWords('', '', DMP)).toEqual([]);
  });

  test('leading / trailing whitespace changes are captured losslessly', () => {
    const segs = diffWords('  hello', 'hello  ', DMP);
    expect(reconstruct(segs)).toEqual({ before: '  hello', after: 'hello  ' });
  });

  test('multi-word runs stay grouped after cleanupSemantic', () => {
    const segs = diffWords('one two three four', 'one 2 3 four', DMP);
    expect(reconstruct(segs)).toEqual({ before: 'one two three four', after: 'one 2 3 four' });
    // The middle change is a contiguous replacement, not four separate edits.
    expect(segs.filter((s) => s.op === -1).length).toBe(1);
    expect(segs.filter((s) => s.op === 1).length).toBe(1);
  });

  test('punctuation stays attached to its word token', () => {
    const segs = diffWords('hello world', 'hello, world!', DMP);
    expect(reconstruct(segs)).toEqual({ before: 'hello world', after: 'hello, world!' });
    // "world" -> "world!" is a change: the bare word is not preserved as equal.
    expect(segs.some((s) => s.op === 0 && /world/.test(s.text))).toBe(false);
  });

  test('every segment reconstructs the inputs for a realistic edit', () => {
    const original = 'the report was wrote by the team and it dont cover the third quater.';
    const revised = 'The report was written by the team, and it does not cover the third quarter.';
    const segs = diffWords(original, revised, DMP);
    expect(reconstruct(segs)).toEqual({ before: original, after: revised });
  });

  test('falls back to the injected global when no constructor is passed', () => {
    expect(() => diffWords('a b c', 'a c', undefined)).not.toThrow();
    expect(reconstruct(diffWords('a b c', 'a c'))).toEqual({ before: 'a b c', after: 'a c' });
  });

  test('throws a clear error when no constructor is available', () => {
    const saved = global.diff_match_patch;
    delete global.diff_match_patch;
    try {
      expect(() => diffWords('a', 'b')).toThrow(/diff_match_patch/);
    } finally {
      global.diff_match_patch = saved;
    }
  });
});

describe('migrateEditorModeValue', () => {
  test('keeps an already-stored editorMode verbatim', () => {
    expect(migrateEditorModeValue('changes', null)).toBe('changes');
    expect(migrateEditorModeValue('clean', 'true')).toBe('clean');
    expect(migrateEditorModeValue('explain', 'false')).toBe('explain');
  });

  test('migrates the legacy boolean when no editorMode is stored', () => {
    expect(migrateEditorModeValue(null, 'true')).toBe('explain');
    expect(migrateEditorModeValue(null, 'false')).toBe('clean');
  });

  test('treats an empty-string editorMode as absent', () => {
    expect(migrateEditorModeValue('', 'true')).toBe('explain');
  });

  test('defaults to clean when neither value is present', () => {
    expect(migrateEditorModeValue(null, null)).toBe('clean');
  });
});
