import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $getSelection, $isRangeSelection, createCommand, COMMAND_PRIORITY_EDITOR, TextNode } from 'lexical';
import { useEffect } from 'react';

export const BACKGROUND_COLOR_COMMAND = createCommand('applyBackgroundColor');

export default function BackgroundColorPlugin() {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    return editor.registerCommand(
      BACKGROUND_COLOR_COMMAND,
      (color: string) => {
        editor.update(() => {
          const selection = $getSelection();
          if ($isRangeSelection(selection)) {
            selection.getNodes().forEach(node => {
              if (node instanceof TextNode) {
                node.setStyle(`background-color: ${color}`);
              }
            });
          }
        });
        return true;
      },
      COMMAND_PRIORITY_EDITOR
    );
  }, [editor]);

  return null;
}