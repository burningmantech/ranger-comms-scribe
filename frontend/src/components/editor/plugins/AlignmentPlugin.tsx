import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $getSelection, $isRangeSelection, FORMAT_ELEMENT_COMMAND } from 'lexical';
import { useEffect } from 'react';
import { COMMAND_PRIORITY_NORMAL } from 'lexical';
import { createCommand, LexicalCommand } from 'lexical';

export const ALIGNMENT_FORMAT = {
  LEFT: 'left',
  CENTER: 'center',
  RIGHT: 'right',
  JUSTIFY: 'justify',
} as const;

export type AlignmentFormat = (typeof ALIGNMENT_FORMAT)[keyof typeof ALIGNMENT_FORMAT];

export const FORMAT_ELEMENT_ALIGNMENT_COMMAND: LexicalCommand<AlignmentFormat> = 
  createCommand('FORMAT_ELEMENT_ALIGNMENT_COMMAND');

export function AlignmentPlugin(): null {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    return editor.registerCommand<AlignmentFormat>(
      FORMAT_ELEMENT_ALIGNMENT_COMMAND,
      (alignment) => {
        editor.update(() => {
          const selection = $getSelection();
          if ($isRangeSelection(selection)) {
            // Use the built-in FORMAT_ELEMENT_COMMAND with alignment format
            editor.dispatchCommand(FORMAT_ELEMENT_COMMAND, alignment);
          }
        });
        return true;
      },
      COMMAND_PRIORITY_NORMAL
    );
  }, [editor]);

  return null;
}

export default AlignmentPlugin;