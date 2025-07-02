// Advanced diff algorithm for tracking text changes
// Based on Myers' diff algorithm with enhancements for word-level diffs

export interface DiffSegment {
  type: 'equal' | 'insert' | 'delete';
  value: string;
  startIndex: number;
  endIndex: number;
}

export interface WordDiff {
  type: 'equal' | 'insert' | 'delete';
  value: string;
}

// Longest Common Subsequence algorithm
function lcs(a: string[], b: string[]): number[][] {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }

  return dp;
}

// Generate diff from LCS table
function generateDiff(a: string[], b: string[], dp: number[][]): DiffSegment[] {
  const diff: DiffSegment[] = [];
  let i = a.length;
  let j = b.length;
  let aIndex = a.length;
  let bIndex = b.length;

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && a[i - 1] === b[j - 1]) {
      // Equal
      if (diff.length === 0 || diff[0].type !== 'equal') {
        diff.unshift({
          type: 'equal',
          value: a[i - 1],
          startIndex: i - 1,
          endIndex: i
        });
      } else {
        diff[0].value = a[i - 1] + diff[0].value;
        diff[0].startIndex = i - 1;
      }
      i--;
      j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      // Insert
      if (diff.length === 0 || diff[0].type !== 'insert') {
        diff.unshift({
          type: 'insert',
          value: b[j - 1],
          startIndex: i,
          endIndex: i
        });
      } else {
        diff[0].value = b[j - 1] + diff[0].value;
      }
      j--;
    } else {
      // Delete
      if (diff.length === 0 || diff[0].type !== 'delete') {
        diff.unshift({
          type: 'delete',
          value: a[i - 1],
          startIndex: i - 1,
          endIndex: i
        });
      } else {
        diff[0].value = a[i - 1] + diff[0].value;
        diff[0].startIndex = i - 1;
      }
      i--;
    }
  }

  return diff;
}

// Word-level diff
export function diffWords(oldText: string, newText: string): WordDiff[] {
  // Split by word boundaries while preserving whitespace
  const wordRegex = /(\s+|\b)/;
  const oldWords = oldText.split(wordRegex).filter(w => w !== '');
  const newWords = newText.split(wordRegex).filter(w => w !== '');

  const dp = lcs(oldWords, newWords);
  const segments = generateDiff(oldWords, newWords, dp);

  return segments.map(seg => ({
    type: seg.type,
    value: seg.value
  }));
}

// Line-level diff
export function diffLines(oldText: string, newText: string): DiffSegment[] {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');

  const dp = lcs(oldLines, newLines);
  return generateDiff(oldLines, newLines, dp);
}

// Character-level diff (for small texts)
export function diffChars(oldText: string, newText: string): DiffSegment[] {
  const oldChars = oldText.split('');
  const newChars = newText.split('');

  const dp = lcs(oldChars, newChars);
  return generateDiff(oldChars, newChars, dp);
}

// Smart diff that chooses the best algorithm based on text size
export function smartDiff(oldText: string, newText: string): WordDiff[] {
  // For very short texts, use character diff
  if (oldText.length < 50 && newText.length < 50) {
    const charDiff = diffChars(oldText, newText);
    return charDiff.map(seg => ({
      type: seg.type,
      value: seg.value
    }));
  }

  // For longer texts, use word diff
  return diffWords(oldText, newText);
}

// Apply a series of changes to text
export function applyChanges(originalText: string, changes: Array<{
  oldValue: string;
  newValue: string;
  timestamp: Date;
}>): string {
  let result = originalText;
  
  // Sort changes by timestamp
  const sortedChanges = [...changes].sort((a, b) => 
    a.timestamp.getTime() - b.timestamp.getTime()
  );

  for (const change of sortedChanges) {
    const index = result.indexOf(change.oldValue);
    if (index !== -1) {
      result = result.substring(0, index) + 
               change.newValue + 
               result.substring(index + change.oldValue.length);
    }
  }

  return result;
}

// Generate a unified diff format
export function generateUnifiedDiff(
  oldText: string, 
  newText: string, 
  oldLabel = 'Original', 
  newLabel = 'Modified'
): string {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  const diff = diffLines(oldText, newText);
  
  let result = `--- ${oldLabel}\n+++ ${newLabel}\n`;
  let oldLineNum = 1;
  let newLineNum = 1;

  for (const segment of diff) {
    const lines = segment.value.split('\n');
    
    switch (segment.type) {
      case 'equal':
        for (const line of lines) {
          result += ` ${line}\n`;
          oldLineNum++;
          newLineNum++;
        }
        break;
      case 'delete':
        for (const line of lines) {
          result += `-${line}\n`;
          oldLineNum++;
        }
        break;
      case 'insert':
        for (const line of lines) {
          result += `+${line}\n`;
          newLineNum++;
        }
        break;
    }
  }

  return result;
}

// Find all occurrences of a substring in text
export function findAllOccurrences(text: string, substring: string): number[] {
  const indices: number[] = [];
  let index = text.indexOf(substring);
  
  while (index !== -1) {
    indices.push(index);
    index = text.indexOf(substring, index + 1);
  }
  
  return indices;
}

// Calculate similarity between two texts (0-1)
export function calculateSimilarity(text1: string, text2: string): number {
  const diff = diffWords(text1, text2);
  let equalChars = 0;
  let totalChars = 0;

  for (const segment of diff) {
    if (segment.type === 'equal') {
      equalChars += segment.value.length;
    }
    totalChars += segment.value.length;
  }

  return totalChars === 0 ? 1 : equalChars / totalChars;
}