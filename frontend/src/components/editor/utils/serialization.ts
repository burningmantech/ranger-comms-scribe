import { $generateHtmlFromNodes, $generateNodesFromDOM } from '@lexical/html';
import { $getRoot, LexicalEditor } from 'lexical';
import { convertFromRaw, convertToRaw, EditorState } from 'draft-js';
import { stateToHTML } from 'draft-js-export-html';

/**
 * Convert Lexical editor content to HTML
 */
export function lexicalToHtml(editor: LexicalEditor): string {
  return editor.getEditorState().read(() => {
    return $generateHtmlFromNodes(editor, null);
  });
}

/**
 * Convert Lexical editor content to serialized JSON
 */
export function lexicalToJson(editor: LexicalEditor): string {
  return JSON.stringify(editor.getEditorState());
}

/**
 * Convert DraftJS raw content to HTML
 * This helps migrate existing Draft.js content to Lexical
 */
export function draftToHtml(draftRawContent: string): string {
  try {
    const contentState = convertFromRaw(JSON.parse(draftRawContent));
    return stateToHTML(contentState);
  } catch (error) {
    console.error('Error converting Draft.js content to HTML:', error);
    return '';
  }
}

/**
 * Convert HTML to Lexical editor content
 * Use this to render HTML content in the Lexical editor
 */
export function htmlToLexical(editor: LexicalEditor, html: string): void {
  editor.update(() => {
    const parser = new DOMParser();
    const dom = parser.parseFromString(html, 'text/html');
    const nodes = $generateNodesFromDOM(editor, dom);
    
    const root = $getRoot();
    root.clear();
    root.append(...nodes);
  });
}

/**
 * Check if a string is valid Draft.js content
 */
export function isValidDraftJs(content: string): boolean {
  try {
    const parsed = JSON.parse(content);
    return (
      parsed &&
      typeof parsed === 'object' &&
      parsed.blocks &&
      Array.isArray(parsed.blocks) &&
      parsed.entityMap &&
      typeof parsed.entityMap === 'object'
    );
  } catch (e) {
    return false;
  }
}