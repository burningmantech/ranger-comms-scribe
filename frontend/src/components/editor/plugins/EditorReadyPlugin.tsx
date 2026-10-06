import { useEffect } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { LexicalEditor } from 'lexical';

/** Hands the editor instance to the page (e.g. to replace a date in the text). */
export default function EditorReadyPlugin({ onReady }: { onReady: (editor: LexicalEditor | null) => void }): null {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    onReady(editor);
    return () => onReady(null);
  }, [editor, onReady]);
  return null;
}
