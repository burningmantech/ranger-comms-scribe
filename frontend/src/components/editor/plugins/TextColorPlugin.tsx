import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  $getSelection,
  $isRangeSelection,
  COMMAND_PRIORITY_CRITICAL,
  createCommand,
  LexicalCommand
} from 'lexical';
import { $patchStyleText } from '@lexical/selection';
import { useEffect } from 'react';

export const TEXT_COLOR_COMMAND: LexicalCommand<string> = createCommand('textColor');

export default function TextColorPlugin() {
  const [editor] = useLexicalComposerContext();
  
  useEffect(() => {
    return editor.registerCommand<string>(
      TEXT_COLOR_COMMAND,
      (color) => {
        editor.update(() => {
          const selection = $getSelection();
          if ($isRangeSelection(selection)) {
            $patchStyleText(selection, {
              color,
            });
          }
        });
        return true;
      },
      COMMAND_PRIORITY_CRITICAL
    );
  }, [editor]);
  
  return null;
}