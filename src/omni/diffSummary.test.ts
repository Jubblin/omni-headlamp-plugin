import { describe, expect, it } from 'vitest';
import { summarizeDiff, toDiffHunks } from './diffSummary';

describe('toDiffHunks', () => {
  it('returns an empty array for null or undefined input', () => {
    expect(toDiffHunks(null)).toEqual([]);
    expect(toDiffHunks(undefined)).toEqual([]);
  });

  it('passes through a normal line change unchanged', () => {
    const hunks = toDiffHunks([
      {
        originalStartLineNumber: 3,
        originalEndLineNumber: 5,
        modifiedStartLineNumber: 3,
        modifiedEndLineNumber: 4,
      } as any,
    ]);
    expect(hunks).toEqual([
      {
        originalStartLineNumber: 3,
        originalEndLineNumber: 5,
        modifiedStartLineNumber: 3,
        modifiedEndLineNumber: 4,
      },
    ]);
  });

  it('falls back originalEndLineNumber to originalStartLineNumber for a pure insertion (Monaco reports 0)', () => {
    const hunks = toDiffHunks([
      {
        originalStartLineNumber: 5,
        originalEndLineNumber: 0,
        modifiedStartLineNumber: 5,
        modifiedEndLineNumber: 7,
      } as any,
    ]);
    expect(hunks[0].originalEndLineNumber).toBe(5);
  });

  it('falls back modifiedEndLineNumber to modifiedStartLineNumber for a pure deletion (Monaco reports 0)', () => {
    const hunks = toDiffHunks([
      {
        originalStartLineNumber: 5,
        originalEndLineNumber: 7,
        modifiedStartLineNumber: 5,
        modifiedEndLineNumber: 0,
      } as any,
    ]);
    expect(hunks[0].modifiedEndLineNumber).toBe(5);
  });
});

describe('summarizeDiff', () => {
  it('reports no changes for an empty hunk list', () => {
    expect(summarizeDiff([], [], [])).toBe('No changes.');
  });

  it('recognizes added kernel args', () => {
    const modified = ['machine:', '  install:', '    extraKernelArgs:', '      - console=tty0'];
    const original = ['machine:', '  install:', '    disk: /dev/sda'];
    const hunks = [
      {
        originalStartLineNumber: 3,
        originalEndLineNumber: 3,
        modifiedStartLineNumber: 3,
        modifiedEndLineNumber: 4,
      },
    ];
    expect(summarizeDiff(hunks, original, modified)).toBe('Adds kernel args.');
  });

  it('recognizes removed kernel args', () => {
    const original = ['machine:', '    extraKernelArgs:', '      - console=tty0'];
    const modified = ['machine:'];
    const hunks = [
      {
        originalStartLineNumber: 2,
        originalEndLineNumber: 3,
        modifiedStartLineNumber: 1,
        modifiedEndLineNumber: 1,
      },
    ];
    expect(summarizeDiff(hunks, original, modified)).toBe('Removes kernel args.');
  });

  it('recognizes KubeSpan changes regardless of added/removed', () => {
    const original = ['  kubespan:', '    enabled: false'];
    const modified = ['  kubespan:', '    enabled: true'];
    // Hunk must cover line 1 (the "kubespan:" line itself, where the
    // pattern lives) -- the actually-differing text is line 2
    // ("enabled: true/false"), which doesn't match any PATTERN_RULE on its
    // own.
    const hunks = [
      {
        originalStartLineNumber: 1,
        originalEndLineNumber: 2,
        modifiedStartLineNumber: 1,
        modifiedEndLineNumber: 2,
      },
    ];
    expect(summarizeDiff(hunks, original, modified)).toBe('Changes KubeSpan settings.');
  });

  it('recognizes the machine selector via match_labels (MachineClass JSON shape)', () => {
    const original = ['{', '  "match_labels": ["a"]', '}'];
    const modified = ['{', '  "match_labels": ["a", "b"]', '}'];
    const hunks = [
      {
        originalStartLineNumber: 2,
        originalEndLineNumber: 2,
        modifiedStartLineNumber: 2,
        modifiedEndLineNumber: 2,
      },
    ];
    expect(summarizeDiff(hunks, original, modified)).toBe('Changes the machine selector.');
  });

  it('recognizes added labels', () => {
    const original = ['metadata:'];
    const modified = ['metadata:', '  labels:', '    foo: bar'];
    const hunks = [
      {
        originalStartLineNumber: 1,
        originalEndLineNumber: 1,
        modifiedStartLineNumber: 2,
        modifiedEndLineNumber: 3,
      },
    ];
    expect(summarizeDiff(hunks, original, modified)).toBe('Adds labels.');
  });

  it('joins multiple distinct recognized patterns into one sentence', () => {
    const original = ['machine:'];
    const modified = [
      'machine:',
      '  install:',
      '    extraKernelArgs:',
      '      - foo',
      '  network:',
      '    kubespan:',
      '      enabled: true',
    ];
    const hunks = [
      {
        originalStartLineNumber: 1,
        originalEndLineNumber: 1,
        modifiedStartLineNumber: 2,
        modifiedEndLineNumber: 7,
      },
    ];
    // Deterministic: recognized order follows line-scan order (kernel args
    // on line 3, kubespan on line 6), only the sentence's first character is
    // capitalized -- not each clause -- so assert the exact joined string
    // rather than a lowercase substring.
    expect(summarizeDiff(hunks, original, modified)).toBe(
      'Adds kernel args, changes KubeSpan settings.'
    );
  });

  it('deduplicates the same recognized pattern touched by multiple hunks', () => {
    // Two separate pure-insertion hunks (empty original range on each, so
    // only the "added" direction ever matches -- an unchanged "labels:" line
    // present on both sides of a hunk would otherwise also match the
    // "removed" direction of the same rule, which is a different scenario).
    const original = ['x: 1', 'y: 1'];
    const modified = ['x: 1', '  labels:', '    a: 1', 'y: 1', '  labels:', '    b: 2'];
    const hunks = [
      {
        originalStartLineNumber: 1,
        originalEndLineNumber: 0,
        modifiedStartLineNumber: 2,
        modifiedEndLineNumber: 3,
      },
      {
        originalStartLineNumber: 2,
        originalEndLineNumber: 1,
        modifiedStartLineNumber: 5,
        modifiedEndLineNumber: 6,
      },
    ];
    expect(summarizeDiff(hunks, original, modified)).toBe('Adds labels.');
  });

  it('falls back to a singular line-count description for one unrecognized changed line', () => {
    const original = ['foo: 1'];
    const modified = ['foo: 2'];
    const hunks = [
      {
        originalStartLineNumber: 1,
        originalEndLineNumber: 1,
        modifiedStartLineNumber: 1,
        modifiedEndLineNumber: 1,
      },
    ];
    expect(summarizeDiff(hunks, original, modified)).toBe('1 line changed.');
  });

  it('falls back to a plural line-count description for multiple unrecognized changed lines', () => {
    const original = ['foo: 1', 'bar: 1'];
    const modified = ['foo: 2', 'bar: 2'];
    const hunks = [
      {
        originalStartLineNumber: 1,
        originalEndLineNumber: 2,
        modifiedStartLineNumber: 1,
        modifiedEndLineNumber: 2,
      },
    ];
    expect(summarizeDiff(hunks, original, modified)).toBe('2 lines changed.');
  });

  it('counts a changed-line range as the max of removed/added line counts', () => {
    // 3 original lines replaced by 1 modified line -- unrecognized content, so
    // the fallback count should reflect the larger (removed) side, not the
    // smaller (added) side.
    const original = ['a: 1', 'b: 1', 'c: 1'];
    const modified = ['a: 2'];
    const hunks = [
      {
        originalStartLineNumber: 1,
        originalEndLineNumber: 3,
        modifiedStartLineNumber: 1,
        modifiedEndLineNumber: 1,
      },
    ];
    expect(summarizeDiff(hunks, original, modified)).toBe('3 lines changed.');
  });
});
