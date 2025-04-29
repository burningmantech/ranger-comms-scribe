import React, { useEffect, useRef, useState } from 'react';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin';
import { OnChangePlugin } from '@lexical/react/LexicalOnChangePlugin';
import { HeadingNode } from '@lexical/rich-text';
import { TableNode, TableRowNode, TableCellNode } from '@lexical/table';
import { ListNode, ListItemNode } from '@lexical/list';
import { CodeNode } from '@lexical/code';
import { QuoteNode } from '@lexical/rich-text';
import { LinkNode } from '@lexical/link';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { CheckboxNode, $createCheckboxNode, $isCheckboxNode } from '../nodes/CheckboxNode';
import { 
  $getSelection, 
  $isRangeSelection, 
  $createParagraphNode, 
  $createTextNode, 
  $isElementNode, 
  LexicalNode,
  ElementNode,
} from 'lexical';
import CheckboxPlugin from '../plugins/CheckboxPlugin';
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
  checkbox: 'editor-checkbox',
};

const initialConfig = {
  namespace: 'checkbox-test',
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
    CheckboxNode,
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

// Define a custom hook to insert sample text
function useSampleText(editor: any) {
  return () => {
    if (!editor) return;
    
    editor.update(() => {
      // Use the editor's getRootElement method directly
      const rootElement = editor.getRootElement();
      if (!rootElement) return;
      
      // Create paragraph nodes with sample text
      const paragraph1 = $createParagraphNode();
      paragraph1.append($createTextNode('First line to convert'));
      
      const paragraph2 = $createParagraphNode();
      paragraph2.append($createTextNode('Second line to convert'));
      
      const paragraph3 = $createParagraphNode();
      paragraph3.append($createTextNode('Third line to convert'));
      
      // Access the editor root and append our paragraphs
      editor.getEditorState().read(() => {
        const root = editor._rootElement;
        if (root) {
          editor.update(() => {
            const selection = $getSelection();
            if ($isRangeSelection(selection)) {
              selection.insertNodes([paragraph1, paragraph2, paragraph3]);
            }
          });
        }
      });
    });
  };
}

// Define proper interface for our CheckboxTest component
export default function CheckboxTest(): React.ReactElement {
  const editorRef = useRef<HTMLDivElement>(null);
  const [editorInstance, setEditorInstance] = useState<any>(null);

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

  // Insert sample text function using our custom hook
  const insertSampleText = useSampleText(editorInstance);

  // Fixed implementation for checkbox conversion
  function convertToCheckboxes() {
    if (!editorInstance) return;
    
    editorInstance.update(() => {
      const selection = $getSelection();
      
      if ($isRangeSelection(selection)) {
        const selectedText = selection.getTextContent();
        
        if (!selectedText.trim()) {
          return; // No text selected
        }
        
        // Split the selected text by lines
        const textLines = selectedText.split(/\r?\n/).filter(line => line.trim());
        
        // Get root node in a type-safe way
        const anchorNode = selection.anchor.getNode();
        const rootElement = anchorNode.getTopLevelElement();
        const root = rootElement?.getParent();
        
        if (!root) return;
        
        // Get all paragraph nodes in the selection range
        const paragraphNodes: ElementNode[] = [];
        
        // First get all top-level paragraph nodes from the document
        root.getChildren().forEach((child: LexicalNode) => {
          if ($isElementNode(child) && child.getType() === 'paragraph') {
            // Check if this paragraph is within our selection
            const isParagraphInSelection = selection.getNodes().some(node => 
              node === child || node.getParent() === child
            );
            
            if (isParagraphInSelection) {
              paragraphNodes.push(child as ElementNode);
            }
          }
        });
        
        // If we have paragraphs but no text lines, nothing to convert
        if (paragraphNodes.length === 0 || textLines.length === 0) {
          return;
        }
        
        // Process each paragraph to replace its content with a checkbox
        // Use the textLines array order to ensure paragraphs are processed in correct order
        for (let i = 0; i < paragraphNodes.length && i < textLines.length; i++) {
          const paragraphNode = paragraphNodes[i];
          const text = textLines[i].trim();
          
          if ($isElementNode(paragraphNode)) {
            // Get the text content before removal (fallback)
            const existingText = text || paragraphNode.getTextContent();
            
            // Clear the paragraph and create new checkbox node
            paragraphNode.clear();
            const checkboxNode = $createCheckboxNode(false);
            const textNode = $createTextNode(existingText);
            
            // Add the checkbox with the text node as its child
            paragraphNode.append(checkboxNode);
            checkboxNode.append(textNode);
          }
        }
      }
    });
  }

  return (
    <div
      className="checkbox-test-container"
      style={{
        maxWidth: '800px',
        margin: '0 auto',
        padding: '20px',
        fontFamily: 'sans-serif',
      }}
    >
      <h1>Checkbox Plugin Test</h1>

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
        <p>This test helps debug checkbox functionality in the editor.</p>
        <ol>
          <li>Click "Insert Sample Text" to add sample text</li>
          <li>Select one or more lines of text</li>
          <li>Click "Convert to Checkboxes" to test the checkbox conversion</li>
        </ol>
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
          onClick={insertSampleText}
          style={{
            padding: '8px 16px',
            backgroundColor: '#28a745',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            cursor: 'pointer',
          }}
        >
          Insert Sample Text
        </button>
        <button
          onClick={convertToCheckboxes}
          style={{
            padding: '8px 16px',
            backgroundColor: '#007bff',
            color: 'white',
            border: 'none',
            borderRadius: '4px',
            cursor: 'pointer',
          }}
        >
          Convert to Checkboxes
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
                    Enter some text or click "Insert Sample Text"...
                  </div>
                }
                ErrorBoundary={LexicalErrorBoundary}
              />
              <OnChangePlugin onChange={handleEditorChange} />
              <HistoryPlugin />
              <CheckboxPlugin />
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
        <h3>Implementation Details</h3>
        <p>
          The "Convert to Checkboxes" button tests a fixed implementation that:
        </p>
        <ul>
          <li>Identifies the paragraphs in the selection</li>
          <li>Preserves the text content of each paragraph</li>
          <li>Adds a checkbox to each paragraph while keeping the original text</li>
          <li>Ensures multiple lines are handled correctly</li>
        </ul>
      </div>
    </div>
  );
}