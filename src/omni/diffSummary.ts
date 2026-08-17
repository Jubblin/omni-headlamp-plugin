/**
 * Trust-moment summary formatters for the ConfigPatch/MachineClass diff view.
 *
 * Per the design doc: hand-written formatters for common, recognizable patch
 * shapes (kernel args, labels, machine selectors, KubeSpan), not a general
 * YAML-semantic summarizer. Anything unrecognized falls back to a plain
 * line-count description.
 *
 * Takes Monaco's own line-change hunks (from the mounted DiffEditor's
 * getLineChanges()) rather than re-implementing a diff algorithm -- the
 * summary is guaranteed to describe exactly what's highlighted below it.
 */
import type { editor } from 'monaco-editor';

export interface DiffHunk {
  originalStartLineNumber: number;
  originalEndLineNumber: number;
  modifiedStartLineNumber: number;
  modifiedEndLineNumber: number;
}

interface PatternRule {
  test: RegExp;
  describe: (added: boolean) => string;
}

// Ordered by specificity -- first match wins per touched line.
const PATTERN_RULES: PatternRule[] = [
  {
    test: /extraKernelArgs/i,
    describe: added => (added ? 'adds kernel args' : 'removes kernel args'),
  },
  {
    test: /kubespan:/i,
    describe: () => 'changes KubeSpan settings',
  },
  {
    test: /matchLabels|match_labels/i,
    describe: () => 'changes the machine selector',
  },
  {
    test: /labels:/i,
    describe: added => (added ? 'adds labels' : 'removes labels'),
  },
];

function describeLine(lineText: string, added: boolean): string | null {
  for (const rule of PATTERN_RULES) {
    if (rule.test.test(lineText)) {
      return rule.describe(added);
    }
  }
  return null;
}

/**
 * Summarizes a set of diff hunks into a short, human-readable sentence.
 *
 * @param hunks - Line-change ranges from the mounted DiffEditor.
 * @param originalLines - The original text, split into lines.
 * @param modifiedLines - The modified text, split into lines.
 */
export function summarizeDiff(
  hunks: DiffHunk[],
  originalLines: string[],
  modifiedLines: string[]
): string {
  if (hunks.length === 0) {
    return 'No changes.';
  }

  const recognized = new Set<string>();
  let changedLineCount = 0;

  for (const hunk of hunks) {
    const removedCount = hunk.originalEndLineNumber - hunk.originalStartLineNumber + 1;
    const addedCount = hunk.modifiedEndLineNumber - hunk.modifiedStartLineNumber + 1;
    changedLineCount += Math.max(removedCount, addedCount, 1);

    for (let i = hunk.modifiedStartLineNumber; i <= hunk.modifiedEndLineNumber; i++) {
      const line = modifiedLines[i - 1];
      if (line === undefined) continue;
      const desc = describeLine(line, /* added */ true);
      if (desc) recognized.add(desc);
    }
    for (let i = hunk.originalStartLineNumber; i <= hunk.originalEndLineNumber; i++) {
      const line = originalLines[i - 1];
      if (line === undefined) continue;
      const desc = describeLine(line, /* added */ false);
      if (desc) recognized.add(desc);
    }
  }

  if (recognized.size > 0) {
    const parts = Array.from(recognized);
    const sentence = parts.join(', ');
    return sentence.charAt(0).toUpperCase() + sentence.slice(1) + '.';
  }

  return `${changedLineCount} line${changedLineCount === 1 ? '' : 's'} changed.`;
}

/** Converts Monaco's ILineChange[] (from editor.getLineChanges()) into our simpler DiffHunk shape. */
export function toDiffHunks(lineChanges: editor.ILineChange[] | null | undefined): DiffHunk[] {
  if (!lineChanges) return [];
  return lineChanges.map(c => ({
    originalStartLineNumber: c.originalStartLineNumber,
    originalEndLineNumber: c.originalEndLineNumber || c.originalStartLineNumber,
    modifiedStartLineNumber: c.modifiedStartLineNumber,
    modifiedEndLineNumber: c.modifiedEndLineNumber || c.modifiedStartLineNumber,
  }));
}
