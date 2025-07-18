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
        // Join child text nodes with spaces to prevent words from running together
        // Filter out empty strings first, then join with spaces
        const childTexts = node.children
          .map(extractTextFromNode)
          .filter((text: string) => text.trim() !== '');
        
        return childTexts.join(' ');
      }
      
      return '';
    }
    
    // Extract text from all root children (paragraphs/blocks)
    // Join paragraphs with newlines to maintain structure
    const text = data.root.children
      .map(extractTextFromNode)
      .filter((text: string) => text.trim() !== '')
      .join('\n');
    
    return text.trim();
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
 * Helper function to escape special regex characters
 */
function escapeRegExp(string: string): string {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
} 