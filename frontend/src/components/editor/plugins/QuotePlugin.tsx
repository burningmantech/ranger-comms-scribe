import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { $getSelection, $isRangeSelection, createCommand, COMMAND_PRIORITY_EDITOR } from 'lexical';
import { $createQuoteNode, $isQuoteNode, QuoteNode } from '@lexical/rich-text';
import { $wrapNodes } from '@lexical/selection';
import { useEffect } from 'react';

export const QUOTE_COMMAND = createCommand('insertQuote');

export default function QuotePlugin() {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    if (!editor.hasNodes([QuoteNode])) {
      throw new Error('QuotePlugin: QuoteNode not registered on editor');
    }

    return editor.registerCommand(
      QUOTE_COMMAND,
      () => {
        editor.update(() => {
          const selection = $getSelection();
          if ($isRangeSelection(selection)) {
            $wrapNodes(selection, () => $createQuoteNode());
          }
        });
        return true;
      },
      COMMAND_PRIORITY_EDITOR
    );
  }, [editor]);

  return null;
}