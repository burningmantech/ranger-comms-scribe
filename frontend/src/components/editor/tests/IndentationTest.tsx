import React, { useEffect, useRef, useState } from 'react';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin';
import { OnChangePlugin } from '@lexical/react/LexicalOnChangePlugin';
import { HeadingNode } from '@lexical/rich-text';
import { IndentationPlugin, INDENT_COMMAND, OUTDENT_COMMAND } from '../plugins/IndentationPlugin';
import { TableNode, TableRowNode, TableCellNode } from '@lexical/table';
import { ListNode, ListItemNode } from '@lexical/list';
import { CodeNode } from '@lexical/code';
import { QuoteNode } from '@lexical/rich-text';
import { LinkNode } from '@lexical/link';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import '../LexicalEditor.css';

// Define our own ErrorBoundaryProps interface
interface ErrorBoundaryProps {
  children: React.ReactNode;
  onError?: (error: Error) => void;
}

// Editor theme
const theme = {
  ltr: 'ltr',
  rtl: 'rtl',
  paragraph: 'editor-paragraph',
  quote: 'editor-quote',
  heading: {
    h1: 'editor-heading-h1',
    h2: 'editor-heading-h2',
    h3: 'editor-heading-h3',
    h4: 'editor-heading-h4',
    h5: 'editor-heading-h5',
  },
  list: {
    nested: {
      listitem: 'editor-nested-listitem',
    },
    ol: 'editor-list-ol',
    ul: 'editor-list-ul',
    listitem: 'editor-listitem',
  },
  image: 'editor-image',
  link: 'editor-link',
  text: {
    bold: 'editor-text-bold',
    italic: 'editor-text-italic',
    underline: 'editor-text-underline',
    strikethrough: 'editor-text-strikethrough',
    underlineStrikethrough: 'editor-text-underlineStrikethrough',
    code: 'editor-text-code',
  },
  code: 'editor-code',
  codeHighlight: {
    atrule: 'editor-tokenAttr',
    attr: 'editor-tokenAttr',
    boolean: 'editor-tokenProperty',
    builtin: 'editor-tokenSelector',
    cdata: 'editor-tokenComment',
    char: 'editor-tokenSelector',
    class: 'editor-tokenFunction',
    'class-name': 'editor-tokenFunction',
    comment: 'editor-tokenComment',
    constant: 'editor-tokenProperty',
    deleted: 'editor-tokenProperty',
    doctype: 'editor-tokenComment',
    entity: 'editor-tokenOperator',
    function: 'editor-tokenFunction',
    important: 'editor-tokenVariable',
    inserted: 'editor-tokenSelector',
    keyword: 'editor-tokenAttr',
    namespace: 'editor-tokenVariable',
    number: 'editor-tokenProperty',
    operator: 'editor-tokenOperator',
    prolog: 'editor-tokenComment',
    property: 'editor-tokenProperty',
    punctuation: 'editor-tokenPunctuation',
    regex: 'editor-tokenVariable',
    selector: 'editor-tokenSelector',
    string: 'editor-tokenSelector',
    symbol: 'editor-tokenProperty',
    tag: 'editor-tokenProperty',
    url: 'editor-tokenOperator',
    variable: 'editor-tokenVariable',
  },
};

const initialConfig = {
  namespace: 'indentation-test',
  theme,
  onError: (error: Error) => console.error(error),
  nodes: [
    HeadingNode,
    ListNode,
    ListItemNode,
    QuoteNode,
    CodeNode,
    TableNode,
    TableCellNode,
    TableRowNode,
    LinkNode,
  ],
};

// Custom error boundary for Lexical that implements the required interface
class EditorErrorBoundary extends React.Component<ErrorBoundaryProps, { error: Error | null }> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error('Editor error:', error, errorInfo);
    if (this.props.onError) {
      this.props.onError(error);
    }
  }

  render() {
    if (this.state.error) {
      return (
        <div className="editor-error">
          <h3>Error in editor</h3>
          <pre>{this.state.error.message}</pre>
        </div>
      );
    }
    return this.props.children;
  }
}

// EditorReference component to capture and expose the editor instance
function EditorReference({ onEditorReady }: { onEditorReady: (editor: any) => void }): null {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    // Pass the editor instance to the parent component
    onEditorReady(editor);
  }, [editor, onEditorReady]);

  return null;
}

export default function IndentationTest(): React.ReactElement {
  const editorRef = useRef<HTMLDivElement>(null);
  const keyLogRef = useRef<HTMLDivElement>(null);
  const [editorInstance, setEditorInstance] = useState<any>(null);

  // Log key events at the document level for debugging
  useEffect(() => {
    function logKeyEvent(e: KeyboardEvent) {
      if (!keyLogRef.current) return;

      // Create a log entry
      const entry = document.createElement('div');
      entry.className = 'key-event';

      entry.innerHTML = `
        <span class="event-type">${e.type}</span>: 
        <span class="key-info">key=${e.key}, code=${e.code}</span>
        <span class="modifiers">
          ${e.ctrlKey ? 'Ctrl+' : ''}
          ${e.altKey ? 'Alt+' : ''}
          ${e.shiftKey ? 'Shift+' : ''}
          ${e.metaKey ? 'Meta+' : ''}
        </span>
        <span class="prevented">${e.defaultPrevented ? '(prevented)' : ''}</span>
      `;

      // Add the entry to the log
      keyLogRef.current.prepend(entry);

      // Keep only the last 10 events
      while (keyLogRef.current.children.length > 10) {
        keyLogRef.current.removeChild(keyLogRef.current.lastChild!);
      }
    }

    window.addEventListener('keydown', logKeyEvent, true);
    window.addEventListener('keyup', logKeyEvent, true);

    return () => {
      window.removeEventListener('keydown', logKeyEvent, true);
      window.removeEventListener('keyup', logKeyEvent, true);
    };
  }, []);

  function handleEditorChange(editorState: any) {
    editorState.read(() => {
      // Any debugging code here
    });
  }

  // Function to save the editor reference when it's initialized
  function handleEditorInitialized(editor: any) {
    console.log('Editor initialized:', editor);
    setEditorInstance(editor);
  }

  // Manual indentation buttons (for testing)
  function handleIndent() {
    console.log('Indent button clicked, editor:', editorInstance);
    if (editorInstance) {
      editorInstance.dispatchCommand(INDENT_COMMAND, undefined);
    }
  }

  function handleOutdent() {
    console.log('Outdent button clicked, editor:', editorInstance);
    if (editorInstance) {
      editorInstance.dispatchCommand(OUTDENT_COMMAND, undefined);
    }
  }

  return (
    <div
      className="indentation-test-container"
      style={{
        maxWidth: '800px',
        margin: '0 auto',
        padding: '20px',
        fontFamily: 'sans-serif',
      }}
    >
      <h1>Indentation Plugin Test</h1>

      <div
        className="instructions"
        style={{
          marginBottom: '20px',
          padding: '15px',
          backgroundColor: '#f8f9fa',
          borderLeft: '4px solid #007bff',
        }}
      >
        <h2>Instructions</h2>
        <p>Type some text below and test the following keyboard shortcuts:</p>
        <ul>
          <li>Tab - Increase indentation</li>
          <li>Shift+Tab - Decrease indentation</li>
          <li>Cmd+] (Mac) / Ctrl+] (Windows) - Increase indentation</li>
          <li>Cmd+[ (Mac) / Ctrl+[ (Windows) - Decrease indentation</li>
        </ul>
      </div>

      {/* Add manual control buttons */}
      <div
        className="manual-controls"
        style={{
          marginBottom: '20px',
          display: 'flex',
          gap: '10px',
        }}
      >
        <button
          onClick={handleIndent}
          style={{
            padding: '8px 16px',
            backgroundColor: '#007bff',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            cursor: 'pointer',
          }}
        >
          Increase Indent
        </button>
        <button
          onClick={handleOutdent}
          style={{
            padding: '8px 16px',
            backgroundColor: '#6c757d',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            cursor: 'pointer',
          }}
        >
          Decrease Indent
        </button>
      </div>

      <div
        className="editor-wrapper"
        ref={editorRef}
        style={{
          marginBottom: '30px',
          border: '1px solid #ddd',
          borderRadius: '4px',
        }}
      >
        <LexicalComposer initialConfig={initialConfig}>
          <div
            className="editor-container"
            style={{
              position: 'relative',
              borderRadius: '4px',
              minHeight: '200px',
            }}
          >
            <div
              className="editor-inner"
              style={{
                background: '#fff',
                position: 'relative',
              }}
            >
              <RichTextPlugin
                contentEditable={
                  <ContentEditable
                    className="editor-input"
                    style={{
                      minHeight: '200px',
                      resize: 'none',
                      fontSize: '16px',
                      position: 'relative',
                      tabSize: 1,
                      outline: 0,
                      padding: '15px',
                      caretColor: '#444',
                    }}
                  />
                }
                placeholder={
                  <div
                    className="editor-placeholder"
                    style={{
                      color: '#999',
                      overflow: 'hidden',
                      position: 'absolute',
                      textOverflow: 'ellipsis',
                      top: '15px',
                      left: '15px',
                      fontSize: '16px',
                      userSelect: 'none',
                      display: 'inline-block',
                      pointerEvents: 'none',
                    }}
                  >
                    Enter some text...
                  </div>
                }
                ErrorBoundary={LexicalErrorBoundary}
              />
              <OnChangePlugin onChange={handleEditorChange} />
              <HistoryPlugin />
              <IndentationPlugin />
              <EditorReference onEditorReady={handleEditorInitialized} />
            </div>
          </div>
        </LexicalComposer>
      </div>

      <div
        className="debug-section"
        style={{
          marginTop: '20px',
          padding: '15px',
          backgroundColor: '#f8f9fa',
          borderRadius: '4px',
          border: '1px solid #ddd',
        }}
      >
        <h3>Key Event Log</h3>
        <div
          className="key-log"
          ref={keyLogRef}
          style={{
            backgroundColor: '#282c34',
            color: '#abb2bf',
            padding: '10px',
            borderRadius: '4px',
            fontFamily: 'monospace',
            height: '200px',
            overflowY: 'auto',
          }}
        ></div>
      </div>

      <style>
        {`
        .key-event {
          margin-bottom: 5px;
          padding: 5px;
          border-bottom: 1px solid #3e4451;
        }

        .event-type {
          color: #e06c75;
        }

        .key-info {
          color: #98c379;
        }

        .modifiers {
          color: #61afef;
        }

        .prevented {
          color: #c678dd;
        }
        `}
      </style>
    </div>
  );
}