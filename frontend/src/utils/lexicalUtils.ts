/**
 * Extract plain text from Lexical editor JSON data
 */
export function extractTextFromLexical(lexicalJson: string | object): string {
  if (!lexicalJson) return '';

  try {
    const data = typeof lexicalJson === 'string' ? JSON.parse(lexicalJson) : lexicalJson;

    if (!data || !data.root || !data.root.children) {
      return '';
    }

    function extractTextFromNode(node: any): string {
      if (!node) return '';

      // If it's a text node, return the text
      if (node.type === 'text' && node.text) {
        return node.text;
      }

      // If it has children, recursively extract text from them
      if (node.children && Array.isArray(node.children)) {
        // Inline containers (paragraphs, links, etc.) concatenate children
        // directly — they are inline text runs, not separate words.
        // Block-level containers are joined at the root level with newlines.
        const childTexts = node.children
          .map(extractTextFromNode)
          .filter((text: string) => text !== '');

        return childTexts.join('');
      }

      return '';
    }

    // Extract text from all root children (paragraphs/blocks)
    // Join paragraphs with newlines to maintain structure
    const text = data.root.children
      .map(extractTextFromNode)
      .join('\n');

    return text;
  } catch (error) {
    console.error('Error extracting text from Lexical JSON:', error);
    return '';
  }
}

/**
 * Check if data is Lexical JSON data (string or object)
 */
export function isLexicalJson(data: string | object): boolean {
  if (!data) return false;

  try {
    const parsed = typeof data === 'string' ? JSON.parse(data) : data;
    return parsed && parsed.root && Array.isArray(parsed.root.children);
  } catch {
    return false;
  }
}

/**
 * Find and replace text within Lexical JSON while preserving formatting
 */
export function findAndReplaceInLexical(lexicalJson: string | object, searchText: string, replaceText: string): string {
  if (!lexicalJson || !searchText) return typeof lexicalJson === 'string' ? lexicalJson : JSON.stringify(lexicalJson);

  try {
    const data = typeof lexicalJson === 'string' ? JSON.parse(lexicalJson) : lexicalJson;

    if (!data || !data.root || !data.root.children) {
      return JSON.stringify(data);
    }

    function replaceInNode(node: any): any {
      if (!node) return node;

      // If it's a text node, replace the text while preserving other properties
      if (node.type === 'text' && node.text) {
        return {
          ...node,
          text: node.text.replace(new RegExp(escapeRegExp(searchText), 'g'), replaceText)
        };
      }

      // If it has children, recursively process them
      if (node.children && Array.isArray(node.children)) {
        return {
          ...node,
          children: node.children.map(replaceInNode)
        };
      }

      return node;
    }

    const updatedData = {
      ...data,
      root: {
        ...data.root,
        children: data.root.children.map(replaceInNode)
      }
    };

    return JSON.stringify(updatedData);
  } catch (error) {
    console.error('Error replacing text in Lexical JSON:', error);
    return typeof lexicalJson === 'string' ? lexicalJson : JSON.stringify(lexicalJson);
  }
}

/**
 * Insert text at a specific position in Lexical JSON while preserving formatting
 */
export function insertTextInLexical(lexicalJson: string | object, insertText: string, position?: number): string {
  if (!lexicalJson || !insertText) return typeof lexicalJson === 'string' ? lexicalJson : JSON.stringify(lexicalJson);

  try {
    const data = typeof lexicalJson === 'string' ? JSON.parse(lexicalJson) : lexicalJson;

    if (!data || !data.root || !data.root.children) {
      return JSON.stringify(data);
    }

    // If no position specified, append to the end
    if (position === undefined) {
      // Find the last paragraph and append text there, or create a new paragraph
      const lastChild = data.root.children[data.root.children.length - 1];

      if (lastChild && lastChild.type === 'paragraph' && lastChild.children) {
        // Append to last paragraph
        const newTextNode = {
          detail: 0,
          format: 0,
          mode: "normal",
          style: "",
          text: ' ' + insertText,
          type: "text",
          version: 1
        };

        lastChild.children.push(newTextNode);
      } else {
        // Create new paragraph
        const newParagraph = {
          children: [
            {
              detail: 0,
              format: 0,
              mode: "normal",
              style: "",
              text: insertText,
              type: "text",
              version: 1
            }
          ],
          direction: "ltr",
          format: "",
          indent: 0,
          type: "paragraph",
          version: 1
        };

        data.root.children.push(newParagraph);
      }
    } else {
      // Insert at specific position (more complex implementation needed)
      // For now, just append to end
      return insertTextInLexical(lexicalJson, insertText);
    }

    return JSON.stringify(data);
  } catch (error) {
    console.error('Error inserting text in Lexical JSON:', error);
    return typeof lexicalJson === 'string' ? lexicalJson : JSON.stringify(lexicalJson);
  }
}

/**
 * Remove specific text from Lexical JSON while preserving formatting
 */
export function removeTextFromLexical(lexicalJson: string | object, textToRemove: string): string {
  return findAndReplaceInLexical(lexicalJson, textToRemove, '');
}

/**
 * Restore deleted text at its original position in Lexical JSON.
 * Uses the original document structure to find the correct insertion point.
 *
 * Strategy 1: Context-based findAndReplace for within-paragraph deletions
 * Strategy 2: Paragraph-level node restoration for whole-paragraph deletions
 * Fallback: Append to end
 */
export function restoreDeletedTextInLexical(
  currentJson: string | object,
  deletedText: string,
  originalJson: string | object
): string {
  if (!currentJson || !deletedText || !originalJson) {
    return insertTextInLexical(currentJson, deletedText);
  }

  try {
    const current = typeof currentJson === 'string'
      ? JSON.parse(currentJson)
      : JSON.parse(JSON.stringify(currentJson));
    const original = typeof originalJson === 'string'
      ? JSON.parse(originalJson)
      : originalJson;

    if (!current?.root?.children || !original?.root?.children) {
      return insertTextInLexical(currentJson, deletedText);
    }

    // Helper to extract text from a node tree
    const nodeText = (node: any): string => {
      if (node.type === 'text' && node.text) return node.text;
      if (node.children) return node.children.map(nodeText).join('');
      return '';
    };

    const origParaTexts = original.root.children.map(nodeText);
    const currParaTexts = current.root.children.map(nodeText);

    // Strategy 1: Context-based findAndReplace (within-paragraph deletions)
    const originalFullText = origParaTexts.join('\n');
    const idx = originalFullText.indexOf(deletedText);

    if (idx !== -1) {
      const CTX = 15;
      const before = originalFullText.substring(Math.max(0, idx - CTX), idx);
      const after = originalFullText.substring(
        idx + deletedText.length,
        idx + deletedText.length + CTX
      );

      // Only try within-paragraph context (no \n in context strings)
      if (before.length > 0 && after.length > 0 &&
        !before.includes('\n') && !after.includes('\n')) {
        const junction = before + after;
        const replacement = before + deletedText + after;
        const result = findAndReplaceInLexical(currentJson, junction, replacement);
        const origStr = typeof currentJson === 'string'
          ? currentJson
          : JSON.stringify(currentJson);
        if (result !== origStr) {
          return result;
        }
      }
    }

    // Strategy 2: Paragraph-level restoration
    // Find paragraphs in original whose text matches the deleted text
    // and are missing from the current document
    const missingIndices: number[] = [];
    for (let i = 0; i < origParaTexts.length; i++) {
      const pt = origParaTexts[i].trim();
      if (pt && deletedText.includes(pt)) {
        if (!currParaTexts.some((cp: string) => cp.trim() === pt)) {
          missingIndices.push(i);
        }
      }
    }

    if (missingIndices.length > 0) {
      for (const origIdx of missingIndices) {
        // Find insertion position using NON-EMPTY paragraphs as anchors.
        // Empty paragraphs (blank line separators) are ambiguous since
        // findIndex always matches the first one.
        let insertPos = current.root.children.length;

        // Find nearest non-empty paragraph BEFORE the missing one in original
        let prevAnchorOrigIdx = -1;
        for (let k = origIdx - 1; k >= 0; k--) {
          if (origParaTexts[k].trim() !== '') {
            prevAnchorOrigIdx = k;
            break;
          }
        }

        if (prevAnchorOrigIdx !== -1) {
          const prevAnchorText = origParaTexts[prevAnchorOrigIdx].trim();
          const prevCurrIdx = currParaTexts.findIndex((cp: string) => cp.trim() === prevAnchorText);
          if (prevCurrIdx !== -1) {
            // Place restored paragraph at same offset from anchor as in original
            insertPos = prevCurrIdx + (origIdx - prevAnchorOrigIdx);
            insertPos = Math.min(insertPos, current.root.children.length);
          }
        } else {
          // No non-empty paragraph before it — preserve original index
          insertPos = Math.min(origIdx, current.root.children.length);
        }

        // Validate with nearest non-empty paragraph AFTER
        let nextAnchorOrigIdx = -1;
        for (let k = origIdx + 1; k < origParaTexts.length; k++) {
          if (origParaTexts[k].trim() !== '') {
            nextAnchorOrigIdx = k;
            break;
          }
        }

        if (nextAnchorOrigIdx !== -1) {
          const nextAnchorText = origParaTexts[nextAnchorOrigIdx].trim();
          const nextCurrIdx = currParaTexts.findIndex((cp: string) => cp.trim() === nextAnchorText);
          if (nextCurrIdx !== -1 && nextCurrIdx < insertPos) {
            insertPos = nextCurrIdx;
          }
        }

        const paraClone = JSON.parse(JSON.stringify(original.root.children[origIdx]));

        // If the target position has an empty paragraph, replace it instead of
        // inserting — Lexical often leaves an empty paragraph behind when the
        // user deletes a line's text, and we want to restore into that slot.
        if (insertPos < current.root.children.length &&
          nodeText(current.root.children[insertPos]).trim() === '') {
          current.root.children[insertPos] = paraClone;
          currParaTexts[insertPos] = origParaTexts[origIdx];
        } else {
          current.root.children.splice(insertPos, 0, paraClone);
          currParaTexts.splice(insertPos, 0, origParaTexts[origIdx]);
        }
      }
      return JSON.stringify(current);
    }

    // Fallback: append to end
    return insertTextInLexical(currentJson, deletedText);
  } catch (error) {
    console.error('Error restoring deleted text in Lexical JSON:', error);
    return insertTextInLexical(currentJson, deletedText);
  }
}

/**
 * Replace only the FIRST occurrence of searchText in Lexical JSON.
 * Unlike findAndReplaceInLexical (which uses the 'g' flag), this stops
 * after the first match to avoid corrupting duplicate text elsewhere.
 */
export function replaceFirstInLexical(
  lexicalJson: string | object,
  searchText: string,
  replaceText: string,
): string {
  if (!lexicalJson || !searchText) return typeof lexicalJson === 'string' ? lexicalJson : JSON.stringify(lexicalJson);

  try {
    const data = typeof lexicalJson === 'string' ? JSON.parse(lexicalJson) : JSON.parse(JSON.stringify(lexicalJson));

    if (!data || !data.root || !data.root.children) {
      return JSON.stringify(data);
    }

    let replaced = false;

    function replaceInNode(node: any): any {
      if (replaced || !node) return node;

      if (node.type === 'text' && node.text) {
        const idx = node.text.indexOf(searchText);
        if (idx !== -1) {
          replaced = true;
          return {
            ...node,
            text: node.text.substring(0, idx) + replaceText + node.text.substring(idx + searchText.length),
          };
        }
        return node;
      }

      if (node.children && Array.isArray(node.children)) {
        return {
          ...node,
          children: node.children.map(replaceInNode),
        };
      }

      return node;
    }

    const updatedData = {
      ...data,
      root: {
        ...data.root,
        children: data.root.children.map(replaceInNode),
      },
    };

    return JSON.stringify(updatedData);
  } catch (error) {
    console.error('Error replacing first occurrence in Lexical JSON:', error);
    return typeof lexicalJson === 'string' ? lexicalJson : JSON.stringify(lexicalJson);
  }
}

/**
 * Strip deleted-text nodes from Lexical JSON and merge adjacent text nodes.
 * This makes text continuous for search/replace operations that would
 * otherwise fail when text is split across nodes by DeletedTextNode markers.
 */
export function stripDeletedTextNodes(lexicalJson: string | object): string {
  if (!lexicalJson) return typeof lexicalJson === 'string' ? lexicalJson : JSON.stringify(lexicalJson);

  try {
    const data = typeof lexicalJson === 'string' ? JSON.parse(lexicalJson) : JSON.parse(JSON.stringify(lexicalJson));

    if (!data?.root?.children) {
      return JSON.stringify(data);
    }

    function processChildren(children: any[]): any[] {
      const result: any[] = [];
      for (const child of children) {
        // Skip deleted-text nodes entirely
        if (child.type === 'deleted-text') continue;

        // Recursively process children
        if (child.children && Array.isArray(child.children)) {
          child.children = processChildren(child.children);
        }

        // Merge adjacent text nodes with same formatting
        const prev = result[result.length - 1];
        if (prev && prev.type === 'text' && child.type === 'text' &&
            prev.format === child.format && prev.style === child.style) {
          prev.text = (prev.text || '') + (child.text || '');
        } else {
          result.push(child);
        }
      }
      return result;
    }

    data.root.children = data.root.children.map((block: any) => {
      if (block.children && Array.isArray(block.children)) {
        return { ...block, children: processChildren(block.children) };
      }
      return block;
    });

    return JSON.stringify(data);
  } catch (error) {
    console.error('Error stripping deleted text nodes:', error);
    return typeof lexicalJson === 'string' ? lexicalJson : JSON.stringify(lexicalJson);
  }
}

/**
 * Helper function to escape special regex characters
 */
function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
} 