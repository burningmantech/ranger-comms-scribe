/**
 * Whether a range of the current document is text the user typed in the open transaction
 * (not in its before-state), for DeletionInterceptionPlugin: deleting such text really
 * deletes it, with no deletion marker (like deleting your own suggestion in Google Docs).
 *
 * Both documents are given as the plain text of each top-level block, in the same form
 * (extractTextFromLexical: only text nodes, concatenated; no line breaks, tabs, list
 * separators or deletion markers). Blocks are aligned first (so blocks inserted, removed,
 * split or merged above don't shift the comparison), then the characters of the changed
 * run of blocks around the range are diffed. Any doubt answers false: a marker is the
 * safe outcome, really deleting saved text is not.
 */
import { diffCharsOptimized } from './diffAlgorithm';

/** Index pairs (before, current) of equal blocks: longest common subsequence. */
export function matchBlocks(before: string[], current: string[]): Array<[number, number]> {
  const n = before.length;
  const m = current.length;
  let p = 0;
  while (p < n && p < m && before[p] === current[p]) p++;
  let s = 0;
  while (s < n - p && s < m - p && before[n - 1 - s] === current[m - 1 - s]) s++;
  const pairs: Array<[number, number]> = [];
  for (let i = 0; i < p; i++) pairs.push([i, i]);
  // LCS on the middle
  const a = before.slice(p, n - s);
  const b = current.slice(p, m - s);
  if (a.length > 0 && b.length > 0) {
    const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
    for (let i = a.length - 1; i >= 0; i--) {
      for (let j = b.length - 1; j >= 0; j--) {
        dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
      if (a[i] === b[j]) {
        pairs.push([p + i, p + j]);
        i++;
        j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        i++;
      } else {
        j++;
      }
    }
  }
  for (let k = s; k > 0; k--) pairs.push([n - k, m - k]);
  return pairs;
}

/**
 * Whether characters [start, end) of current block `blockIndex` are all text that isn't
 * in the before-state (typed in the open transaction). `start < end` is required.
 */
export function isTypedRange(
  beforeBlocks: string[],
  currentBlocks: string[],
  blockIndex: number,
  start: number,
  end: number,
): boolean {
  if (blockIndex < 0 || blockIndex >= currentBlocks.length || start < 0 || end <= start) return false;
  if (end > currentBlocks[blockIndex].length) return false;

  const pairs = matchBlocks(beforeBlocks, currentBlocks);
  if (pairs.some(([, j]) => j === blockIndex)) return false; // block unchanged

  // The run of unmatched blocks around this one, and the before-state blocks it replaced.
  let prev: [number, number] = [-1, -1];
  let next: [number, number] = [beforeBlocks.length, currentBlocks.length];
  for (const pair of pairs) {
    if (pair[1] < blockIndex) prev = pair;
    else if (pair[1] > blockIndex) {
      next = pair;
      break;
    }
  }
  const runBefore = beforeBlocks.slice(prev[0] + 1, next[0]).join('');
  const runCurrent = currentBlocks.slice(prev[1] + 1, next[1]);
  let offset = 0;
  for (let j = prev[1] + 1; j < blockIndex; j++) offset += currentBlocks[j].length;
  const from = offset + start;
  const to = offset + end;

  // Characters of the current run that the diff marks as inserted.
  let pos = 0;
  let covered = 0;
  for (const seg of diffCharsOptimized(runBefore, runCurrent.join(''))) {
    if (seg.type === 'delete') continue;
    const segEnd = pos + seg.value.length;
    if (seg.type === 'insert') {
      const lo = Math.max(pos, from);
      const hi = Math.min(segEnd, to);
      if (hi > lo) covered += hi - lo;
    }
    pos = segEnd;
  }
  return covered === to - from;
}
