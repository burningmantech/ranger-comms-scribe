import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $getSelection, $isRangeSelection, createCommand, COMMAND_PRIORITY_EDITOR } from 'lexical';
import { $createCodeNode } from '@lexical/code';
import { useEffect } from 'react';
import { $setBlocksType } from '@lexical/selection';

export const INSERT_CODE_BLOCK_COMMAND = createCommand('insertCodeBlock');

export default function CodeBlockPlugin() {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    return editor.registerCommand(
      INSERT_CODE_BLOCK_COMMAND,
      (payload: { language?: string }) => {
        const language = payload?.language || 'javascript';
        
        editor.update(() => {
          const selection = $getSelection();
          if ($isRangeSelection(selection)) {
            const selectedText = selection.getTextContent();
            const codeNode = $createCodeNode(language);
            $setBlocksType(selection, () => codeNode);
            
            // Force re-render to apply syntax highlighting
            setTimeout(() => {
              const codeElements = document.querySelectorAll('code[class*="language-"]');
              if (window.Prism && codeElements.length) {
                window.Prism.highlightAll();
              }
            }, 0);
          }
        });
        return true;
      },
      COMMAND_PRIORITY_EDITOR
    );
  }, [editor]);

  return null;
}