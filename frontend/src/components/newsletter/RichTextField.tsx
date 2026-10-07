import React, { useRef, useState } from 'react';
import LexicalEditorComponent from '../editor/LexicalEditor';

interface RichTextFieldProps {
  /** The value when this field mounts. Give the field a new `key` to load a different value. */
  value: string;
  onChange: (json: string) => void;
  placeholder?: string;
  readOnly?: boolean;
  /** For image uploads in the editor. */
  userId: string;
}

/**
 * A Lexical editor as a form field.
 *
 * - The editor starts from `value` as it was at mount. (LexicalEditor loads `initialContent`
 *   the first time it is non-empty, so passing the live value back in would reload the editor
 *   after the first keystroke and throw the caret to the start.)
 * - `onChange` is called only for real edits: not for the editor reporting the content it
 *   loaded, nor for selection-only updates. Otherwise opening a page would count as an edit
 *   (and, in the edition editor, save a new version and drop its approval).
 */
export const RichTextField: React.FC<RichTextFieldProps> = ({ value, onChange, placeholder, readOnly, userId }) => {
  const [initial] = useState(value);
  const touched = useRef(false);
  const last = useRef<string | null>(null);
  const touch = () => {
    touched.current = true;
  };

  return (
    <div
      onKeyDownCapture={touch}
      onPasteCapture={touch}
      onDropCapture={touch}
      onMouseDownCapture={touch}
      onBeforeInputCapture={touch}
    >
      <LexicalEditorComponent
        initialContent={initial}
        onChange={(_editor, json) => {
          if (!touched.current || last.current === null) {
            last.current = json;
            if (!touched.current) return;
          }
          if (json === last.current) return;
          last.current = json;
          onChange(json);
        }}
        placeholder={placeholder}
        readOnly={readOnly}
        autoFocus={false}
        currentUserId={userId}
        canCreateSuggestions={false}
      />
    </div>
  );
};

export default RichTextField;
