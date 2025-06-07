import React, { useCallback, useEffect, useState } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  $getSelection,
  $isRangeSelection,
  $createTextNode,
  COMMAND_PRIORITY_HIGH,
  createCommand,
  LexicalCommand,
  $getNodeByKey,
  TextNode,
  SELECTION_CHANGE_COMMAND,
} from 'lexical';
import { 
  $createSuggestionNode, 
  $isSuggestionNode, 
  SuggestionNode,
  SuggestionPayload 
} from '../nodes/SuggestionNode';
import { SuggestedEdit } from '../../../types/content';
import ContextMenu from '../ContextMenu';

export const CREATE_SUGGESTION_COMMAND: LexicalCommand<{
  originalText: string;
  suggestedText: string;
  authorId: string;
}> = createCommand('createSuggestion');

export const APPROVE_SUGGESTION_COMMAND: LexicalCommand<{
  suggestionId: string;
  reason?: string;
}> = createCommand('approveSuggestion');

export const REJECT_SUGGESTION_COMMAND: LexicalCommand<{
  suggestionId: string;
  reason?: string;
}> = createCommand('rejectSuggestion');

interface SuggestionPluginProps {
  currentUserId: string;
  onSuggestionCreate?: (suggestion: SuggestedEdit) => void;
  onSuggestionApprove?: (suggestionId: string, reason?: string) => void;
  onSuggestionReject?: (suggestionId: string, reason?: string) => void;
  canCreateSuggestions?: boolean;
  canApproveSuggestions?: boolean;
}

export default function SuggestionPlugin({
  currentUserId,
  onSuggestionCreate,
  onSuggestionApprove,
  onSuggestionReject,
  canCreateSuggestions = true,
  canApproveSuggestions = false,
}: SuggestionPluginProps): React.ReactElement | null {
  const [editor] = useLexicalComposerContext();
  const [showContextMenu, setShowContextMenu] = useState(false);
  const [showSuggestionDialog, setShowSuggestionDialog] = useState(false);
  const [contextMenuPosition, setContextMenuPosition] = useState({ x: 0, y: 0 });
  const [selectedText, setSelectedText] = useState('');
  const [suggestionText, setSuggestionText] = useState('');
  const [selectionRange, setSelectionRange] = useState<{
    startOffset: number;
    endOffset: number;
    startKey: string;
    endKey: string;
  } | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);
  const [cursorPosition, setCursorPosition] = useState<{
    key: string;
    offset: number;
  } | null>(null);

  // Debug: Log component mount and all props
  useEffect(() => {
    console.log('🚀 SuggestionPlugin mounted with props:', {
      currentUserId,
      currentUserIdType: typeof currentUserId,
      currentUserIdIsUndefined: currentUserId === undefined,
      currentUserIdIsNull: currentUserId === null,
      currentUserIdIsFalsy: !currentUserId,
      onSuggestionCreate: !!onSuggestionCreate,
      onSuggestionApprove: !!onSuggestionApprove,
      onSuggestionReject: !!onSuggestionReject,
      canCreateSuggestions,
      canApproveSuggestions
    });
    
    // If currentUserId is falsy, the plugin won't work
    if (!currentUserId) {
      console.error('❌ CRITICAL: currentUserId is falsy, plugin will not work!');
      return;
    }
    
    console.log('✅ SuggestionPlugin fully initialized');
  }, [currentUserId, canCreateSuggestions, canApproveSuggestions, onSuggestionCreate, onSuggestionApprove, onSuggestionReject]);

  // Debug: Log component mount and permissions
  useEffect(() => {
    console.log('🚀 SuggestionPlugin mounted with:', {
      currentUserId,
      canCreateSuggestions,
      canApproveSuggestions
    });
  }, [currentUserId, canCreateSuggestions, canApproveSuggestions]);

  // Debug: Log dialog state changes
  useEffect(() => {
    console.log('💬 Dialog state changed:', {
      showContextMenu,
      showSuggestionDialog,
      selectedText,
      suggestionText
    });
  }, [showContextMenu, showSuggestionDialog, selectedText, suggestionText]);

  // Handle text selection for creating suggestions
  const handleTextSelection = useCallback(() => {
    console.log('🔍 handleTextSelection called, canCreateSuggestions:', canCreateSuggestions);
    
    if (!canCreateSuggestions) {
      console.log('❌ Cannot create suggestions - permission denied');
      return;
    }

    editor.getEditorState().read(() => {
      const selection = $getSelection();
      console.log('📝 Selection object:', selection);
      
      if ($isRangeSelection(selection)) {
        console.log('✅ Is range selection');
        console.log('📏 Selection collapsed?', selection.isCollapsed());
        
        const selectedText = selection.getTextContent();
        console.log('📖 Selected text:', `"${selectedText}"`);
        
        // Store selection range for later use
        const anchor = selection.anchor;
        const focus = selection.focus;
        
        if (selection.isCollapsed()) {
          // For insertions, store cursor position
          setCursorPosition({
            key: anchor.key,
            offset: anchor.offset
          });
          setSelectedText('');
          setSuggestionText('');
          setSelectionRange(null);
        } else {
          // For modifications/deletions, store selection range
          setSelectionRange({
            startOffset: Math.min(anchor.offset, focus.offset),
            endOffset: Math.max(anchor.offset, focus.offset),
            startKey: anchor.key,
            endKey: focus.key,
          });
          setSelectedText(selectedText);
          setSuggestionText(selectedText);
          setCursorPosition(null);
        }
      } else {
        console.log('❌ Not a range selection');
      }
    });
  }, [editor, canCreateSuggestions]);

  // Handle right-click for context menu
  const handleContextMenu = useCallback((event: MouseEvent) => {
    console.log('🖱️ Context menu event:', {
      canCreateSuggestions,
      selectedText: selectedText.trim(),
      event
    });

    if (!canCreateSuggestions) {
      console.log('❌ Cannot show context menu - no permission');
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    
    setContextMenuPosition({ x: event.clientX, y: event.clientY });
    setShowContextMenu(true);
  }, [canCreateSuggestions, selectedText]);

  // Listen for selection changes
  useEffect(() => {
    return editor.registerCommand(
      SELECTION_CHANGE_COMMAND,
      () => {
        // Small delay to ensure selection is stable
        setTimeout(handleTextSelection, 100);
        return false;
      },
      COMMAND_PRIORITY_HIGH
    );
  }, [editor, handleTextSelection]);

  // Add context menu event listener
  useEffect(() => {
    const editorElement = editor.getRootElement();
    if (editorElement) {
      console.log('🎯 Adding context menu listener to editor element');
      editorElement.addEventListener('contextmenu', handleContextMenu);
      return () => {
        console.log('🎯 Removing context menu listener from editor element');
        editorElement.removeEventListener('contextmenu', handleContextMenu);
      };
    }
  }, [editor, handleContextMenu]);

  // Create suggestion command handler
  useEffect(() => {
    return editor.registerCommand(
      CREATE_SUGGESTION_COMMAND,
      ({ originalText, suggestedText, authorId }) => {
        editor.update(() => {
          const selection = $getSelection();
          if (!$isRangeSelection(selection)) return;

          const suggestionId = crypto.randomUUID();
          const suggestionNode = $createSuggestionNode({
            id: suggestionId,
            originalText,
            suggestedText,
            authorId,
            status: 'PENDING',
          });

          if (selection.isCollapsed() && cursorPosition) {
            // For insertions, insert at cursor position
            const node = $getNodeByKey(cursorPosition.key);
            if (node) {
              selection.insertNodes([suggestionNode]);
            }
          } else {
            // For modifications/deletions, replace selected text
            selection.insertNodes([suggestionNode]);
          }

          // Create suggested edit for callback
          if (onSuggestionCreate) {
            const suggestedEdit: SuggestedEdit = {
              id: suggestionId,
              originalText,
              suggestedText,
              range: selectionRange || {
                startOffset: cursorPosition?.offset || 0,
                endOffset: cursorPosition?.offset || 0,
                startKey: cursorPosition?.key || '',
                endKey: cursorPosition?.key || '',
              },
              authorId,
              createdAt: new Date(),
              status: 'PENDING',
            };
            onSuggestionCreate(suggestedEdit);
          }
        });
        return true;
      },
      COMMAND_PRIORITY_HIGH
    );
  }, [editor, onSuggestionCreate, selectionRange, cursorPosition]);

  // Approve suggestion command handler
  useEffect(() => {
    return editor.registerCommand(
      APPROVE_SUGGESTION_COMMAND,
      ({ suggestionId, reason }) => {
        editor.update(() => {
          const nodeMap = editor.getEditorState()._nodeMap;
          for (const [, node] of nodeMap) {
            if ($isSuggestionNode(node) && node.getId() === suggestionId) {
              const suggestionNode = node as SuggestionNode;
              suggestionNode.setStatus('APPROVED');
              if (reason) {
                suggestionNode.setReason(reason);
              }
              break;
            }
          }
        });
        
        if (onSuggestionApprove) {
          onSuggestionApprove(suggestionId, reason);
        }
        return true;
      },
      COMMAND_PRIORITY_HIGH
    );
  }, [editor, onSuggestionApprove]);

  // Reject suggestion command handler
  useEffect(() => {
    return editor.registerCommand(
      REJECT_SUGGESTION_COMMAND,
      ({ suggestionId, reason }) => {
        editor.update(() => {
          const nodeMap = editor.getEditorState()._nodeMap;
          for (const [, node] of nodeMap) {
            if ($isSuggestionNode(node) && node.getId() === suggestionId) {
              const suggestionNode = node as SuggestionNode;
              suggestionNode.setStatus('REJECTED');
              if (reason) {
                suggestionNode.setReason(reason);
              }
              break;
            }
          }
        });
        
        if (onSuggestionReject) {
          onSuggestionReject(suggestionId, reason);
        }
        return true;
      },
      COMMAND_PRIORITY_HIGH
    );
  }, [editor, onSuggestionReject]);

  // Handle custom events from suggestion nodes
  useEffect(() => {
    const handleSuggestionAction = (event: CustomEvent) => {
      console.log('🎬 Suggestion action received:', event.detail);
      const { id, action, reason } = event.detail;
      
      if (action === 'approve') {
        console.log('✅ Dispatching approve command for suggestion:', id);
        editor.dispatchCommand(APPROVE_SUGGESTION_COMMAND, { suggestionId: id, reason });
      } else if (action === 'reject') {
        console.log('❌ Dispatching reject command for suggestion:', id);
        editor.dispatchCommand(REJECT_SUGGESTION_COMMAND, { suggestionId: id, reason });
      }
    };

    document.addEventListener('suggestionAction', handleSuggestionAction as EventListener);
    return () => {
      document.removeEventListener('suggestionAction', handleSuggestionAction as EventListener);
    };
  }, [editor]);

  // Handle mouse up for text selection (backup method)
  useEffect(() => {
    const handleMouseUp = (event: MouseEvent) => {
      // Prevent if clicking on buttons or controls
      const target = event.target as HTMLElement;
      if (target.closest('.suggestion-controls') || target.closest('button')) {
        return;
      }
      
      setTimeout(handleTextSelection, 10);
    };

    const editorElement = editor.getRootElement();
    if (editorElement) {
      editorElement.addEventListener('mouseup', handleMouseUp);
      return () => {
        editorElement.removeEventListener('mouseup', handleMouseUp);
      };
    }
  }, [editor, handleTextSelection]);

  const handleEditClick = useCallback(() => {
    console.log('🎯 Edit clicked:', {
      selectedText,
      suggestionText,
      canCreateSuggestions
    });
    setIsDeleting(false);
    setShowContextMenu(false);
    setShowSuggestionDialog(true);
  }, [selectedText, suggestionText, canCreateSuggestions]);

  const handleDeleteClick = useCallback(() => {
    console.log('🗑️ Delete clicked:', {
      selectedText,
      canCreateSuggestions,
      selectionRange
    });
    
    if (!selectedText.trim()) {
      console.log('❌ No text selected for deletion');
      return;
    }
    
    setIsDeleting(true);
    setShowContextMenu(false);
    setShowSuggestionDialog(true);
  }, [selectedText, canCreateSuggestions, selectionRange]);

  const handleCreateSuggestion = useCallback(() => {
    console.log('📝 Creating suggestion:', {
      selectedText,
      suggestionText,
      currentUserId,
      isDeleting,
      cursorPosition,
      selectionRange
    });
    
    if (isDeleting) {
      // For deletion, we suggest empty text
      if (selectedText.trim()) {
        console.log('🗑️ Creating deletion suggestion:', {
          originalText: selectedText,
          suggestedText: '',
          authorId: currentUserId
        });
        
        editor.update(() => {
          const selection = $getSelection();
          if (!$isRangeSelection(selection)) {
            console.log('❌ Not a range selection');
            return;
          }

          const suggestionId = crypto.randomUUID();
          const suggestionNode = $createSuggestionNode({
            id: suggestionId,
            originalText: selectedText,
            suggestedText: '',
            authorId: currentUserId,
            status: 'PENDING',
          });

          // Replace selected text with suggestion node
          selection.insertNodes([suggestionNode]);

          // Create suggested edit for callback
          if (onSuggestionCreate) {
            const suggestedEdit: SuggestedEdit = {
              id: suggestionId,
              originalText: selectedText,
              suggestedText: '',
              range: selectionRange || {
                startOffset: 0,
                endOffset: 0,
                startKey: '',
                endKey: '',
              },
              authorId: currentUserId,
              createdAt: new Date(),
              status: 'PENDING',
            };
            onSuggestionCreate(suggestedEdit);
          }
        });
      }
    } else if (cursorPosition) {
      // For insertion, we suggest new text at cursor position
      if (suggestionText.trim()) {
        editor.dispatchCommand(CREATE_SUGGESTION_COMMAND, {
          originalText: '',
          suggestedText: suggestionText,
          authorId: currentUserId,
        });
      }
    } else {
      // For modification
      if (suggestionText.trim() && selectedText !== suggestionText) {
        editor.dispatchCommand(CREATE_SUGGESTION_COMMAND, {
          originalText: selectedText,
          suggestedText: suggestionText,
          authorId: currentUserId,
        });
      }
    }
    
    setShowSuggestionDialog(false);
    setShowContextMenu(false);
    setSelectedText('');
    setSuggestionText('');
    setSelectionRange(null);
    setCursorPosition(null);
    setIsDeleting(false);
  }, [editor, selectedText, suggestionText, currentUserId, isDeleting, cursorPosition, selectionRange, onSuggestionCreate]);

  const handleCancelSuggestion = useCallback(() => {
    console.log('❌ Cancelling suggestion');
    setShowSuggestionDialog(false);
    setShowContextMenu(false);
    setSelectedText('');
    setSuggestionText('');
    setSelectionRange(null);
    setIsDeleting(false);
  }, []);

  return (
    <>
      {showContextMenu && (
        <ContextMenu
          x={contextMenuPosition.x}
          y={contextMenuPosition.y}
          onClose={handleCancelSuggestion}
          onEdit={handleEditClick}
          onDelete={selectedText.trim() ? handleDeleteClick : undefined}
          canEdit={canCreateSuggestions}
          canDelete={canCreateSuggestions && !!selectedText.trim()}
        />
      )}
      {showSuggestionDialog && (
        <div className="suggestion-dialog-overlay" onClick={handleCancelSuggestion}>
          <div className="suggestion-dialog" onClick={e => e.stopPropagation()}>
            <div className="suggestion-dialog-header">
              <h3>{isDeleting ? 'Suggest Deletion' : 'Suggest Edit'}</h3>
              <button 
                className="suggestion-dialog-close"
                onClick={handleCancelSuggestion}
              >
                ×
              </button>
            </div>
            <div className="suggestion-dialog-body">
              {selectedText.trim() && (
                <div className="suggestion-field">
                  <label>Text to {isDeleting ? 'Delete' : 'Modify'}:</label>
                  <div className="original-text-display">{selectedText}</div>
                </div>
              )}
              {!isDeleting && (
                <div className="suggestion-field">
                  <label>Suggested Text:</label>
                  <textarea
                    value={suggestionText}
                    onChange={(e) => setSuggestionText(e.target.value)}
                    rows={3}
                    className="suggestion-textarea"
                    placeholder={selectedText.trim() ? "Enter your suggested text..." : "Enter text to insert..."}
                  />
                </div>
              )}
            </div>
            <div className="suggestion-dialog-footer">
              <button 
                className="btn btn-tertiary"
                onClick={handleCreateSuggestion}
                disabled={isDeleting ? !selectedText.trim() : !suggestionText.trim()}
              >
                {isDeleting ? 'Suggest Deletion' : 'Create Suggestion'}
              </button>
              <button 
                className="btn btn-neutral"
                onClick={handleCancelSuggestion}
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
} 