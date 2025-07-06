import React, { useEffect, useState, useRef } from 'react';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
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
import { LinkPlugin } from '@lexical/react/LexicalLinkPlugin';
import { MarkdownShortcutPlugin } from '@lexical/react/LexicalMarkdownShortcutPlugin';
import { TRANSFORMERS } from '@lexical/markdown';
import { $getRoot, $createParagraphNode, $createTextNode } from 'lexical';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { ToolbarPlugin } from './plugins/ToolbarPlugin';
import { ImagePlugin } from './plugins/ImagePlugin';
import { ImageNode } from './nodes/ImageNode';
import { CheckboxNode } from './nodes/CheckboxNode';
import { DraftJsImportPlugin } from './plugins/DraftJsImportPlugin';
import { isValidDraftJs, htmlToLexical } from './utils/serialization';
import CheckboxPlugin from './plugins/CheckboxPlugin';
import { TablePlugin } from './plugins/TablePlugin';
import { TableControlsPlugin } from './plugins/TableControlsPlugin';
import { IndentationPlugin } from './plugins/IndentationPlugin';
import TextColorPlugin from './plugins/TextColorPlugin';
import FontSizePlugin from './plugins/FontSizePlugin';
import FontFamilyPlugin from './plugins/FontFamilyPlugin';
import AlignmentPlugin from './plugins/AlignmentPlugin';
import QuotePlugin from './plugins/QuotePlugin';
import { SuggestionNode } from './nodes/SuggestionNode';
import SuggestionPlugin from './plugins/SuggestionPlugin';
import './LexicalEditor.css';
import './styles/TableControlsPlugin.css';
import './styles/IndentationStyles.css';
import './styles/SuggestionStyles.css';
import './styles/ContextMenuStyles.css';

import { CursorPosition } from '../../services/websocketService';
import CollaborativeCursorPlugin, { RemoteCursor } from './plugins/CollaborativeCursorPlugin';

// Define EditorProps interface
interface EditorProps {
  initialContent?: string;
  content?: string; // For updating content after mount
  forceReinitialize?: boolean; // Force reinitialization
  placeholder?: string;
  readOnly?: boolean;
  showToolbar?: boolean;
  onChange?: (editor: LexicalEditor, json: string) => void;
  className?: string;
  onImageSelect?: () => void;
  currentUserId?: string;
  onSuggestionCreate?: (suggestion: any) => void;
  onSuggestionApprove?: (suggestionId: string, reason?: string) => void;
  onSuggestionReject?: (suggestionId: string, reason?: string) => void;
  canCreateSuggestions?: boolean;
  canApproveSuggestions?: boolean;
  // Collaboration props
  isCollaborative?: boolean;
  remoteCursors?: RemoteCursor[];
  onCursorUpdate?: (position: CursorPosition) => void;
}

const LexicalEditorComponent: React.FC<EditorProps> = ({
  initialContent = '',
  content,
  forceReinitialize = false,
  placeholder = 'Enter content...',
  readOnly = false,
  showToolbar = true,
  onChange,
  className = '',
  onImageSelect,
  currentUserId,
  onSuggestionCreate,
  onSuggestionApprove,
  onSuggestionReject,
  canCreateSuggestions = true,
  canApproveSuggestions = false,
  // Collaboration props
  isCollaborative = false,
  remoteCursors = [],
  onCursorUpdate,
}) => {
  const [isLoaded, setIsLoaded] = useState(false);
  const editorRef = useRef<LexicalEditor | null>(null);
  const hasInitialized = useRef(false);

  // Update editor state when readOnly changes
  useEffect(() => {
    if (editorRef.current) {
      editorRef.current.setEditable(!readOnly);
    }
  }, [readOnly]);

  // Plugin to initialize editor reference
  const EditorInitPlugin: React.FC = () => {
    const [editor] = useLexicalComposerContext();
    
    useEffect(() => {
      console.log('EditorInitPlugin: Setting editor reference');
      editorRef.current = editor;
    }, [editor]);
    
    return null;
  };

  // Prevent form submission when interacting with editor
  const handleEditorClick = (e: React.MouseEvent) => {
    // Allow normal text selection when suggestions are enabled
    if (canCreateSuggestions) {
      return;
    }
    
    // Only prevent default for non-suggestion interactions
    if (!currentUserId) {
      e.preventDefault();
      e.stopPropagation();
    }
  };

  const handleEditorKeyDown = (e: React.KeyboardEvent) => {
    // Only prevent Enter in edit mode, allow text selection in suggestion mode
    if (e.key === 'Enter' && !e.shiftKey && !readOnly) {
      e.preventDefault();
    }
  };

  // Custom handling of state changes
  const handleChange = (editorState: EditorState, editor: LexicalEditor) => {
    if (!editorRef.current) {
      editorRef.current = editor;
    }
    
    // Log the first few state changes to debug initialization
    console.log('LexicalEditor onChange:', {
      hasEditor: !!editor,
      stateType: editorState._nodeMap ? 'populated' : 'empty',
      nodeCount: editorState._nodeMap?.size || 0
    });
    
    if (onChange) {
      const json = JSON.stringify(editorState);
      onChange(editor, json);
    }
  };

  // Initialize editor content when component mounts or initialContent changes
  useEffect(() => {
    console.log('LexicalEditor useEffect triggered:', {
      hasEditor: !!editorRef.current,
      hasContent: !!initialContent,
      isLoaded,
      hasInitialized: hasInitialized.current,
      contentLength: initialContent?.length,
      contentPreview: initialContent?.substring(0, 100)
    });
    
    if (!editorRef.current || !initialContent || !isLoaded || (hasInitialized.current && !forceReinitialize)) {
      console.log('LexicalEditor: Skipping initialization - missing editor, content, not loaded, or already initialized (and not forcing reinitialize)');
      return;
    }

    const editor = editorRef.current;
    
    // Check if the initialContent is a Lexical JSON state
    if (initialContent.startsWith('{') && initialContent.includes('"root":')) {
      try {
        console.log('LexicalEditor: Setting Lexical JSON state');
        const editorState = editor.parseEditorState(initialContent);
        editor.setEditorState(editorState);
        console.log('LexicalEditor: Successfully set editor state');
        hasInitialized.current = true;
        return;
      } catch (e) {
        console.error('Error parsing Lexical state:', e);
      }
    }
    
    // Check if it's a DraftJS state and convert it
    if (isValidDraftJs(initialContent)) {
      console.log('LexicalEditor: Content is DraftJS, letting DraftJsImportPlugin handle it');
      hasInitialized.current = true;
      return; // DraftJsImportPlugin will handle this
    }
    
    // Otherwise, treat it as HTML
    try {
      console.log('LexicalEditor: Converting HTML content');
      htmlToLexical(editor, initialContent);
      hasInitialized.current = true;
    } catch (e) {
      console.error('Error parsing HTML content:', e);
      console.log('LexicalEditor: Falling back to plain text');
      editor.update(() => {
        const root = $getRoot();
        root.clear();
        const paragraph = $createParagraphNode();
        paragraph.append($createTextNode(initialContent));
        root.append(paragraph);
      });
      hasInitialized.current = true;
    }
  }, [initialContent, isLoaded, forceReinitialize]);

  // Update editor content when content prop changes (for external updates)
  useEffect(() => {
    console.log('LexicalEditor content prop changed:', {
      hasEditor: !!editorRef.current,
      isLoaded,
      content,
      contentType: typeof content,
      contentLength: content?.length,
      contentPreview: content?.substring(0, 100)
    });
    
    if (!editorRef.current || !isLoaded) {
      console.log('LexicalEditor: Skipping content update - missing editor or not loaded');
      return;
    }
    
    // Allow empty content to be set (for clearing the editor)
    if (content === undefined || content === null) {
      console.log('LexicalEditor: Skipping content update - content is undefined/null');
      return;
    }

    const editor = editorRef.current;
    
    console.log('LexicalEditor: Processing content update');
    
    // Check if the content is a Lexical JSON state
    if (content.startsWith('{') && content.includes('"root":')) {
      try {
        console.log('LexicalEditor: Updating with Lexical JSON state');
        const editorState = editor.parseEditorState(content);
        editor.setEditorState(editorState);
        console.log('LexicalEditor: Successfully updated with Lexical JSON state');
        return;
      } catch (e) {
        console.error('Error parsing Lexical state for content update:', e);
      }
    }
    
    // Check if it's a DraftJS state and convert it
    if (isValidDraftJs(content)) {
      console.log('LexicalEditor: Content is DraftJS, letting DraftJsImportPlugin handle it');
      return; // DraftJsImportPlugin will handle this
    }
    
    // Otherwise, treat it as HTML
    try {
      console.log('LexicalEditor: Converting HTML content for update');
      htmlToLexical(editor, content);
    } catch (e) {
      console.error('Error parsing HTML content for update:', e);
      console.log('LexicalEditor: Falling back to plain text for update');
      editor.update(() => {
        const root = $getRoot();
        root.clear();
        const paragraph = $createParagraphNode();
        paragraph.append($createTextNode(content));
        root.append(paragraph);
      });
    }
  }, [content, isLoaded]);

  // Create initialization config for Lexical
  const initialConfig = {
    namespace: 'DynamicContentEditor',
    theme: {
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
        strikethrough: 'editor-text-strikethrough',
        underlineStrikethrough: 'editor-text-underlineStrikethrough',
        code: 'editor-text-code',
      },
      list: {
        ol: 'editor-list-ol',
        ul: 'editor-list-ul',
        listitem: 'editor-listitem',
        nested: {
          listitem: 'editor-nested-listitem',
        },
      },
      table: 'editor-table',
      tableCell: 'editor-tableCell',
      tableRow: 'editor-tableRow',
      checkbox: 'editor-checkbox',
      indent1: 'editor-indent-1',
      indent2: 'editor-indent-2',
      indent3: 'editor-indent-3',
      indent4: 'editor-indent-4',
      indent5: 'editor-indent-5',
      quote: 'editor-quote',
      link: 'editor-link',
      code: 'editor-code',
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
      SuggestionNode,
    ],
    onError: (error: Error) => {
      console.error('Lexical Editor Error:', error);
    },
    editable: !readOnly,
  };

  useEffect(() => {
    setIsLoaded(true);
    
    // Reset initialization flag when component unmounts
    return () => {
      hasInitialized.current = false;
    };
  }, []);

  return (
    <div 
      className={`lexical-editor-container ${readOnly ? 'read-only' : ''} ${className}`}
      onClick={handleEditorClick}
      onKeyDown={handleEditorKeyDown}
    >
      <div className="lexical-editor">
        <LexicalComposer initialConfig={initialConfig}>
          <EditorInitPlugin />
          {showToolbar && !readOnly && <ToolbarPlugin />}
          <div className="editor-content-wrapper">
            <RichTextPlugin
              contentEditable={
                <ContentEditable 
                  className="editor-input"
                  onClick={handleEditorClick}
                  onKeyDown={handleEditorKeyDown}
                />
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
          <ListPlugin />
          <TablePlugin />
          <CheckboxPlugin />
          <LinkPlugin />
          <MarkdownShortcutPlugin transformers={TRANSFORMERS} />
          {initialContent && isValidDraftJs(initialContent) && (
            <DraftJsImportPlugin initialContent={initialContent} />
          )}
          <ImagePlugin onImageSelect={onImageSelect} />
          <IndentationPlugin />
          <TextColorPlugin />
          <FontSizePlugin />
          <FontFamilyPlugin />
          <AlignmentPlugin />
          <QuotePlugin />
          {currentUserId && (
            <SuggestionPlugin
              currentUserId={currentUserId}
              onSuggestionCreate={onSuggestionCreate}
              onSuggestionApprove={onSuggestionApprove}
              onSuggestionReject={onSuggestionReject}
              canCreateSuggestions={canCreateSuggestions}
              canApproveSuggestions={canApproveSuggestions}
            />
          )}
          {isCollaborative && currentUserId && (
            <CollaborativeCursorPlugin
              remoteCursors={remoteCursors}
              currentUserId={currentUserId}
              onCursorUpdate={onCursorUpdate}
            />
          )}
        </LexicalComposer>
      </div>
    </div>
  );
};

export default LexicalEditorComponent;