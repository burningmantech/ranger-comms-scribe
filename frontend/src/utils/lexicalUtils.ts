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
        return node.children.map(extractTextFromNode).join('');
      }
      
      return '';
    }
    
    // Extract text from all root children
    const text = data.root.children.map(extractTextFromNode).join('\n');
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