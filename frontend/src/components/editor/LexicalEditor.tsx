import React, { useEffect, useState, useRef } from 'react';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin';
import { OnChangePlugin } from '@lexical/react/LexicalOnChangePlugin';
import { AutoFocusPlugin } from '@lexical/react/LexicalAutoFocusPlugin';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { HeadingNode, QuoteNode } from '@lexical/rich-text';
import { ListItemNode, ListNode } from '@lexical/list';
import { CodeHighlightNode, CodeNode } from '@lexical/code';
import { TableNode, TableCellNode, TableRowNode } from '@lexical/table';
import { LinkNode } from '@lexical/link';
import { EditorState, LexicalEditor } from 'lexical';
import { ListPlugin } from '@lexical/react/LexicalListPlugin'; 
import { ToolbarPlugin } from './plugins/ToolbarPlugin';
import { ImagePlugin } from './plugins/ImagePlugin';
import { ImageNode } from './nodes/ImageNode';
import { CheckboxNode } from './nodes/CheckboxNode';
import { DraftJsImportPlugin } from './plugins/DraftJsImportPlugin';
import { isValidDraftJs, htmlToLexical } from '../editor/utils/serialization';
import { CheckboxPlugin } from './plugins/CheckboxPlugin';
import { TablePlugin } from './plugins/TablePlugin';
import { TableControlsPlugin } from './plugins/TableControlsPlugin';
import { IndentationPlugin, INDENT_COMMAND, OUTDENT_COMMAND } from './plugins/IndentationPlugin';
import './LexicalEditor.css';
import './styles/TableControlsPlugin.css';
import './styles/IndentationStyles.css';
import { $getRoot, $createParagraphNode, $createTextNode, COMMAND_PRIORITY_CRITICAL, KEY_TAB_COMMAND, KEY_MODIFIER_COMMAND } from 'lexical';

// Define PlaceholderConfig interface for proper typing 
interface PlaceholderConfig {
  placeholder: React.ReactNode;
}

// Define EditorProps interface
interface EditorProps {
  initialContent?: string;
  placeholder?: string;
  readOnly?: boolean;
  showToolbar?: boolean;
  onChange?: (editor: LexicalEditor, json: string) => void;
  className?: string;
  onImageSelect?: () => void;
  galleryImages?: string[];
}

const LexicalEditorComponent: React.FC<EditorProps> = ({
  initialContent = '',
  placeholder = 'Enter content...',
  readOnly = false,
  showToolbar = true,
  onChange,
  className = '',
  onImageSelect,
  galleryImages = []
}) => {
  const [isLoaded, setIsLoaded] = useState(false);
  const editorRef = useRef<LexicalEditor | null>(null);

  // Custom handling of state changes
  const handleChange = (editorState: EditorState, editor: LexicalEditor) => {
    // Update the editor reference if it's not set
    if (!editorRef.current) {
      editorRef.current = editor;
    }
    
    if (onChange) {
      // Serialize to JSON for storage
      const json = JSON.stringify(editorState);
      onChange(editor, json);
    }
  };

  const initialEditorStateSetup = (editor: LexicalEditor) => {
    // Store a reference to the editor without triggering a state update
    editorRef.current = editor;
    
    // If there is no initial content, do nothing
    if (!initialContent || initialContent === '') {
      return;
    }
    
    // Check if the initialContent is a Lexical JSON state
    if (initialContent.startsWith('{') && initialContent.includes('"root":')) {
      try {
        editor.setEditorState(editor.parseEditorState(initialContent));
        return;
      } catch (e) {
        console.error('Error parsing Lexical state:', e);
      }
    }
    
    // Check if it's a DraftJS state and convert it
    if (isValidDraftJs(initialContent)) {
      return; // DraftJsImportPlugin will handle this
    }
    
    // Otherwise, treat it as HTML
    try {
      htmlToLexical(editor, initialContent);
    } catch (e) {
      console.error('Error parsing HTML content:', e);
      editor.update(() => {
        const root = $getRoot();
        root.clear();
        const paragraph = $createParagraphNode();
        paragraph.append($createTextNode(initialContent));
        root.append(paragraph);
      });
    }
  };

  // Create initialization config for Lexical
  const initialConfig = {
    namespace: 'DynamicContentEditor',
    theme: {
      // Add your theme configuration here
      paragraph: 'editor-paragraph',
      heading: {
        h1: 'editor-heading-h1',
        h2: 'editor-heading-h2',
        h3: 'editor-heading-h3',
        h4: 'editor-heading-h4',
      },
      text: {
        bold: 'editor-text-bold',
        italic: 'editor-text-italic',
        underline: 'editor-text-underline',
      },
      list: {
        ol: 'editor-list-ol',
        ul: 'editor-list-ul',
        listitem: 'editor-listitem',
      },
      // Add specific theme entries for tables to ensure proper styling
      table: 'editor-table',
      tableCell: 'editor-tableCell',
      tableRow: 'editor-tableRow',
      // Add theme entry for checkbox
      checkbox: 'editor-checkbox',
      // Add theme entries for indentation
      indent1: 'editor-indent-1',
      indent2: 'editor-indent-2',
      indent3: 'editor-indent-3',
      indent4: 'editor-indent-4',
      indent5: 'editor-indent-5',
    },
    nodes: [
      HeadingNode,
      QuoteNode,
      ListNode,
      ListItemNode,
      CodeNode,
      CodeHighlightNode,
      TableNode,
      TableCellNode,
      TableRowNode,
      LinkNode,
      ImageNode,
      CheckboxNode,
    ],
    onError: (error: Error) => {
      console.error('Lexical Editor Error:', error);
    },
    editorState: initialEditorStateSetup,
    editable: !readOnly,
  };

  // Handle keyboard shortcuts for indentation within the editor component
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || readOnly) return;

    // Register keyboard shortcuts directly with the editor
    const unregisterTab = editor.registerCommand(
      KEY_TAB_COMMAND,
      (event: KeyboardEvent) => {
        if (event.shiftKey) {
          event.preventDefault();
          editor.dispatchCommand(OUTDENT_COMMAND, undefined);
          return true;
        } else {
          event.preventDefault();
          editor.dispatchCommand(INDENT_COMMAND, undefined);
          return true;
        }
      },
      COMMAND_PRIORITY_CRITICAL
    );

    // Register Cmd/Ctrl + [ and ] shortcuts
    const unregisterModifier = editor.registerCommand(
      KEY_MODIFIER_COMMAND,
      (event: KeyboardEvent) => {
        if (event.metaKey || event.ctrlKey) {
          if (event.key === ']') {
            event.preventDefault();
            editor.dispatchCommand(INDENT_COMMAND, undefined);
            return true;
          } else if (event.key === '[') {
            event.preventDefault();
            editor.dispatchCommand(OUTDENT_COMMAND, undefined);
            return true;
          }
        }
        return false;
      },
      COMMAND_PRIORITY_CRITICAL
    );

    return () => {
      unregisterTab();
      unregisterModifier();
    };
  }, [readOnly, editorRef.current]);

  useEffect(() => {
    setIsLoaded(true);

    // Add CSS styles for indentation
    const styleElement = document.createElement('style');
    styleElement.textContent = `
      /* Enhanced indentation styles */
      .editor-indent-1 {
        padding-left: 40px !important;
      }
      
      .editor-indent-2 {
        padding-left: 80px !important;
      }
      
      .editor-indent-3 {
        padding-left: 120px !important;
      }
      
      .editor-indent-4 {
        padding-left: 160px !important;
      }
      
      .editor-indent-5 {
        padding-left: 200px !important;
      }

      /* Legacy data-indent support */
      [data-lexical-editor] p[data-indent="1"],
      p[data-indent="1"] {
        padding-left: 40px !important;
      }
      
      [data-lexical-editor] p[data-indent="2"],
      p[data-indent="2"] {
        padding-left: 80px !important;
      }
      
      [data-lexical-editor] p[data-indent="3"],
      p[data-indent="3"] {
        padding-left: 120px !important;
      }
      
      [data-lexical-editor] p[data-indent="4"],
      p[data-indent="4"] {
        padding-left: 160px !important;
      }
      
      [data-lexical-editor] p[data-indent="5"],
      p[data-indent="5"] {
        padding-left: 200px !important;
      }
    `;
    document.head.appendChild(styleElement);

    return () => {
      document.head.removeChild(styleElement);
    };
  }, []);

  return (
    <div className={`lexical-editor-container ${readOnly ? 'read-only' : ''} ${className}`}>
      <div className="lexical-editor">
        <LexicalComposer initialConfig={initialConfig}>
          {showToolbar && !readOnly && <ToolbarPlugin />}
          <div className="editor-content-wrapper">
            <RichTextPlugin
              contentEditable={
                <ContentEditable className="editor-input" />
              }
              placeholder={
                <div className="editor-placeholder">{placeholder}</div>
              }
              ErrorBoundary={LexicalErrorBoundary}
            />
            {!readOnly && <TableControlsPlugin />}
          </div>
          <HistoryPlugin />
          {!readOnly && <AutoFocusPlugin />}
          <OnChangePlugin onChange={handleChange} />
          {/* Add ListPlugin for proper list continuation */}
          <ListPlugin />
          {/* Table Plugin for proper table support */}
          <TablePlugin />
          {/* Add CheckboxPlugin to handle checkbox behavior */}
          <CheckboxPlugin />
          {/* Add DraftJsImportPlugin to handle Draft.js content */}
          {initialContent && isValidDraftJs(initialContent) && (
            <DraftJsImportPlugin initialContent={initialContent} />
          )}
          <ImagePlugin onImageSelect={onImageSelect} />
          {/* Add IndentationPlugin for indentation support */}
          <IndentationPlugin />
        </LexicalComposer>
      </div>
    </div>
  );
};

export default LexicalEditorComponent;