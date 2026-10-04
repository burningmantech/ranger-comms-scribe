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

// Optimized character-level diff for large texts.
// Finds common prefix and suffix in O(n), only diffs the small changed middle.
// This keeps keystroke-driven diffs fast even on long documents.
export function diffCharsOptimized(
  oldText: string,
  newText: string,
  options?: { paragraphAligned?: boolean },
): DiffSegment[] {
  if (oldText === newText) {
    return oldText.length > 0
      ? [{ type: 'equal', value: oldText, startIndex: 0, endIndex: oldText.length }]
      : [];
  }

  // Find common prefix
  const minLen = Math.min(oldText.length, newText.length);
  let prefixLen = 0;
  while (prefixLen < minLen && oldText[prefixLen] === newText[prefixLen]) {
    prefixLen++;
  }

  // Find common suffix (not overlapping with prefix)
  let suffixLen = 0;
  while (
    suffixLen < (minLen - prefixLen) &&
    oldText[oldText.length - 1 - suffixLen] === newText[newText.length - 1 - suffixLen]
  ) {
    suffixLen++;
  }

  // When paragraphAligned, snap prefix/suffix to nearest \n boundary so that
  // the diff engine doesn't match partial text across paragraph boundaries
  // (e.g. "He has " shared between two different paragraphs).
  if (options?.paragraphAligned) {
    // Back up prefix to the last \n (keep the \n in the prefix)
    let adj = prefixLen;
    while (adj > 0 && oldText[adj - 1] !== '\n') {
      adj--;
    }
    if (adj > 0) prefixLen = adj;

    // Back up suffix so it starts at a \n
    adj = suffixLen;
    while (adj > 0 && oldText[oldText.length - adj] !== '\n') {
      adj--;
    }
    if (adj > 0) suffixLen = adj;
  }

  const oldMiddle = oldText.slice(prefixLen, oldText.length - suffixLen);
  const newMiddle = newText.slice(prefixLen, newText.length - suffixLen);

  const result: DiffSegment[] = [];

  // Add prefix as equal segment
  if (prefixLen > 0) {
    result.push({
      type: 'equal',
      value: oldText.slice(0, prefixLen),
      startIndex: 0,
      endIndex: prefixLen,
    });
  }

  // Diff the changed middle
  if (oldMiddle.length > 0 || newMiddle.length > 0) {
    if (oldMiddle.length === 0) {
      // Pure insertion
      result.push({ type: 'insert', value: newMiddle, startIndex: prefixLen, endIndex: prefixLen });
    } else if (newMiddle.length === 0) {
      // Pure deletion
      result.push({ type: 'delete', value: oldMiddle, startIndex: prefixLen, endIndex: prefixLen + oldMiddle.length });
    } else if (oldMiddle.length < 500 && newMiddle.length < 500) {
      // Small middle — char-level diff
      const middleDiff = diffChars(oldMiddle, newMiddle);
      for (const seg of middleDiff) {
        result.push({
          type: seg.type,
          value: seg.value,
          startIndex: prefixLen + seg.startIndex,
          endIndex: prefixLen + seg.endIndex,
        });
      }
    } else {
      // Large middle — word-level diff with char-level refinement.
      // Run diffWords for speed, then refine adjacent delete+insert pairs
      // (word replacements like "States" → "states") into char-level diffs.
      const wordDiff = diffWords(oldMiddle, newMiddle);
      let idx = prefixLen;
      for (let w = 0; w < wordDiff.length; w++) {
        const seg = wordDiff[w];
        // Detect adjacent delete+insert (word replacement) and refine
        if (seg.type === 'delete' && w + 1 < wordDiff.length && wordDiff[w + 1].type === 'insert') {
          const ins = wordDiff[w + 1];
          const charRefine = diffChars(seg.value, ins.value);
          for (const cs of charRefine) {
            result.push({
              type: cs.type,
              value: cs.value,
              startIndex: idx,
              endIndex: idx + cs.value.length,
            });
            if (cs.type !== 'delete') {
              idx += cs.value.length;
            }
          }
          w++; // skip the insert, already processed
        } else {
          result.push({
            type: seg.type,
            value: seg.value,
            startIndex: idx,
            endIndex: idx + seg.value.length,
          });
          if (seg.type !== 'delete') {
            idx += seg.value.length;
          }
        }
      }
    }
  }

  // Add suffix as equal segment
  if (suffixLen > 0) {
    result.push({
      type: 'equal',
      value: oldText.slice(oldText.length - suffixLen),
      startIndex: oldText.length - suffixLen,
      endIndex: oldText.length,
    });
  }

  return result;
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

// Calculate incremental changes between consecutive versions
export function calculateIncrementalChanges(
  originalText: string,
  previousVersion: string,
  currentVersion: string
): WordDiff[] {
  // If there's no previous version, show the full diff from original
  if (!previousVersion || previousVersion === originalText) {
    return smartDiff(originalText, currentVersion);
  }
  
  // Calculate the diff between the previous version and current version
  // This shows only what changed from the previous proposed version
  return smartDiff(previousVersion, currentVersion);
}

// Apply incremental changes to reconstruct the full text
export function applyIncrementalChanges(
  originalText: string,
  changes: Array<{
    oldValue: string;
    newValue: string;
    isIncremental: boolean;
    timestamp: Date;
  }>
): string {
  let currentText = originalText;
  
  // Sort changes by timestamp
  const sortedChanges = [...changes].sort((a, b) => 
    a.timestamp.getTime() - b.timestamp.getTime()
  );

  for (const change of sortedChanges) {
    if (change.isIncremental) {
      // For incremental changes, find and replace the old value with the new value
      const index = currentText.indexOf(change.oldValue);
      if (index !== -1) {
        currentText = currentText.substring(0, index) + 
                     change.newValue + 
                     currentText.substring(index + change.oldValue.length);
      } else {
        // If we can't find the exact match, append the new value
        currentText += change.newValue;
      }
    } else {
      // For non-incremental changes, replace the entire text
      currentText = change.newValue;
    }
  }

  return currentText;
}