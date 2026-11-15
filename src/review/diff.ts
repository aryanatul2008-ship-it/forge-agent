import { DiffHunk } from './types';

interface DiffOp {
  type: 'keep' | 'delete' | 'insert';
  oldLineIndex?: number;
  newLineIndex?: number;
  text: string;
}

/**
 * Computes Longest Common Subsequence edit operations between lines.
 */
function computeLineDiff(origLines: string[], newLines: string[]): DiffOp[] {
  const m = origLines.length;
  const n = newLines.length;

  // DP table for LCS lengths
  // Optimize memory: Uint16Array if small, or standard 2D array
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));

  for (let i = 0; i < m; i++) {
    for (let j = 0; j < n; j++) {
      if (origLines[i] === newLines[j]) {
        dp[i + 1][j + 1] = dp[i][j] + 1;
      } else {
        dp[i + 1][j + 1] = Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
  }

  // Backtrack to find edit operations
  const ops: DiffOp[] = [];
  let i = m;
  let j = n;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && origLines[i - 1] === newLines[j - 1]) {
      ops.unshift({
        type: 'keep',
        oldLineIndex: i - 1,
        newLineIndex: j - 1,
        text: origLines[i - 1],
      });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      ops.unshift({
        type: 'insert',
        newLineIndex: j - 1,
        text: newLines[j - 1],
      });
      j--;
    } else if (i > 0 && (j === 0 || dp[i][j - 1] < dp[i - 1][j])) {
      ops.unshift({
        type: 'delete',
        oldLineIndex: i - 1,
        text: origLines[i - 1],
      });
      i--;
    }
  }

  return ops;
}

/**
 * Groups diff operations into coherent hunks with context.
 */
export function computeHunks(
  originalContent: string,
  proposedContent: string,
  contextLines: number = 2
): DiffHunk[] {
  const origLines = originalContent.length === 0 ? [] : originalContent.split(/\r?\n/);
  const newLines = proposedContent.length === 0 ? [] : proposedContent.split(/\r?\n/);

  if (originalContent === proposedContent) {
    return [];
  }

  const ops = computeLineDiff(origLines, newLines);
  const hunks: DiffHunk[] = [];

  interface DiffGroup {
    ops: DiffOp[];
    oldStart: number;
    newStart: number;
  }

  const groups: DiffGroup[] = [];
  let currentGroup: DiffOp[] | null = null;
  let keepCount = 0;

  for (let idx = 0; idx < ops.length; idx++) {
    const op = ops[idx];

    if (op.type !== 'keep') {
      if (!currentGroup) {
        currentGroup = [];
        groups.push({
          ops: currentGroup,
          oldStart: op.oldLineIndex ?? (idx > 0 && ops[idx - 1].oldLineIndex !== undefined ? ops[idx - 1].oldLineIndex! + 1 : 0),
          newStart: op.newLineIndex ?? (idx > 0 && ops[idx - 1].newLineIndex !== undefined ? ops[idx - 1].newLineIndex! + 1 : 0),
        });
      }
      currentGroup.push(op);
      keepCount = 0;
    } else {
      if (currentGroup) {
        keepCount++;
        if (keepCount <= contextLines) {
          currentGroup.push(op);
        } else {
          // Trim trailing keeps beyond contextLines
          while (
            currentGroup.length > 0 &&
            currentGroup[currentGroup.length - 1].type === 'keep'
          ) {
            currentGroup.pop();
          }
          currentGroup = null;
          keepCount = 0;
        }
      }
    }
  }

  // Cleanup trailing keeps on last group
  if (currentGroup) {
    while (
      currentGroup.length > 0 &&
      currentGroup[currentGroup.length - 1].type === 'keep'
    ) {
      currentGroup.pop();
    }
  }

  // Convert groups into DiffHunk records
  let hunkCounter = 1;
  for (const group of groups) {
    if (group.ops.length === 0) continue;

    const oldTextLines: string[] = [];
    const newTextLines: string[] = [];

    let oldStart: number | null = null;
    let newStart: number | null = null;

    let oldLinesCount = 0;
    let newLinesCount = 0;

    for (const op of group.ops) {
      if (op.type === 'delete') {
        if (oldStart === null && op.oldLineIndex !== undefined) {
          oldStart = op.oldLineIndex + 1;
        }
        oldTextLines.push(op.text);
        oldLinesCount++;
      } else if (op.type === 'insert') {
        if (newStart === null && op.newLineIndex !== undefined) {
          newStart = op.newLineIndex + 1;
        }
        newTextLines.push(op.text);
        newLinesCount++;
      } else if (op.type === 'keep') {
        // Context line
        if (oldStart === null && op.oldLineIndex !== undefined) {
          oldStart = op.oldLineIndex + 1;
        }
        if (newStart === null && op.newLineIndex !== undefined) {
          newStart = op.newLineIndex + 1;
        }
        oldTextLines.push(op.text);
        newTextLines.push(op.text);
        oldLinesCount++;
        newLinesCount++;
      }
    }

    // Determine start lines if purely inserts or deletes
    if (oldStart === null) {
      oldStart = Math.min(origLines.length + 1, (group.oldStart ?? 0) + 1);
    }
    if (newStart === null) {
      newStart = Math.min(newLines.length + 1, (group.newStart ?? 0) + 1);
    }

    hunks.push({
      id: `hunk-${hunkCounter++}`,
      oldStart,
      oldLines: oldLinesCount,
      newStart,
      newLines: newLinesCount,
      oldText: oldTextLines.join('\n'),
      newText: newTextLines.join('\n'),
      status: 'pending',
    });
  }

  return hunks;
}

/**
 * Applies only accepted hunks to original content.
 * Hunks are sorted in descending order of oldStart so earlier edits do not alter line offsets for later ones.
 */
export function applyPartialHunks(
  originalContent: string,
  hunks: DiffHunk[]
): { newContent: string; appliedCount: number; rejectedCount: number } {
  const accepted = hunks.filter((h) => h.status === 'accepted');
  const rejected = hunks.filter((h) => h.status === 'rejected' || h.status === 'pending');

  if (accepted.length === 0) {
    return {
      newContent: originalContent,
      appliedCount: 0,
      rejectedCount: rejected.length,
    };
  }

  const lines = originalContent.length === 0 ? [] : originalContent.split(/\r?\n/);

  // Sort descending by start line
  const sorted = [...accepted].sort((a, b) => b.oldStart - a.oldStart);

  for (const hunk of sorted) {
    const startIndex = Math.max(0, hunk.oldStart - 1);
    const deleteCount = Math.max(0, hunk.oldLines);
    const replacementLines = hunk.newText.length === 0 ? [] : hunk.newText.split(/\r?\n/);

    lines.splice(startIndex, deleteCount, ...replacementLines);
  }

  return {
    newContent: lines.join('\n'),
    appliedCount: accepted.length,
    rejectedCount: rejected.length,
  };
}

