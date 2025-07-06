import React, { useEffect, useState, useCallback, useRef } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  $getSelection,
  $isRangeSelection,
  SELECTION_CHANGE_COMMAND,
  COMMAND_PRIORITY_HIGH,
  LexicalEditor,
  NodeKey,
  $getNodeByKey,
  $createTextNode
} from 'lexical';
import { CursorPosition } from '../../../services/websocketService';
import './CollaborativeCursorPlugin.css';

export interface RemoteCursor {
  userId: string;
  userName: string;
  userEmail: string;
  position: {
    key: string;
    offset: number;
    type: 'cursor' | 'selection';
    anchor?: { key: string; offset: number };
    focus?: { key: string; offset: number };
  };
  timestamp: string;
  color?: string;
}

interface CollaborativeCursorPluginProps {
  remoteCursors: RemoteCursor[];
  currentUserId: string;
  onCursorUpdate?: (position: CursorPosition) => void;
}

// Color palette for different users
const USER_COLORS = [
  '#1a73e8', // Blue
  '#f5576c', // Pink
  '#00f2fe', // Cyan
  '#9c27b0', // Purple
  '#ff9800', // Orange
  '#4caf50', // Green
  '#ff5722', // Deep Orange
  '#3f51b5', // Indigo
  '#e91e63', // Pink
  '#009688', // Teal
];

function getColorForUser(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = userId.charCodeAt(i) + ((hash << 5) - hash);
  }
  return USER_COLORS[Math.abs(hash) % USER_COLORS.length];
}

export default function CollaborativeCursorPlugin({
  remoteCursors,
  currentUserId,
  onCursorUpdate,
}: CollaborativeCursorPluginProps): React.ReactElement {
  const [editor] = useLexicalComposerContext();
  const [cursorElements, setCursorElements] = useState<Map<string, HTMLElement>>(new Map());
  const selectionRef = useRef<any>(null);
  const lastPositionRef = useRef<CursorPosition | null>(null);

  // Track selection changes and broadcast cursor position
  useEffect(() => {
    const handleSelectionChange = () => {
      if (!onCursorUpdate) return;

      editor.getEditorState().read(() => {
        const selection = $getSelection();
        
        if ($isRangeSelection(selection)) {
          const anchor = selection.anchor;
          const focus = selection.focus;
          
          try {
            const cursorPosition: CursorPosition = {
              userId: currentUserId,
              userName: '', // Will be filled by the parent component
              userEmail: '', // Will be filled by the parent component
              position: {
                key: anchor.key,
                offset: anchor.offset,
                type: selection.isCollapsed() ? 'cursor' : 'selection',
                anchor: selection.isCollapsed() ? undefined : {
                  key: anchor.key,
                  offset: anchor.offset
                },
                focus: selection.isCollapsed() ? undefined : {
                  key: focus.key,
                  offset: focus.offset
                }
              },
              timestamp: new Date().toISOString()
            };

            // Only send if position changed significantly
            if (!lastPositionRef.current || 
                lastPositionRef.current.position.key !== cursorPosition.position.key ||
                lastPositionRef.current.position.offset !== cursorPosition.position.offset ||
                lastPositionRef.current.position.type !== cursorPosition.position.type) {
              
              onCursorUpdate(cursorPosition);
              lastPositionRef.current = cursorPosition;
            }
          } catch (error) {
            console.error('Error tracking cursor position:', error);
          }
        }
      });
    };

    // Register selection change listener
    const unregister = editor.registerCommand(
      SELECTION_CHANGE_COMMAND,
      () => {
        // Debounce selection updates
        clearTimeout(selectionRef.current);
        selectionRef.current = setTimeout(handleSelectionChange, 100);
        return false;
      },
      COMMAND_PRIORITY_HIGH
    );

    return () => {
      unregister();
      if (selectionRef.current) {
        clearTimeout(selectionRef.current);
      }
    };
  }, [editor, currentUserId, onCursorUpdate]);

  // Update remote cursor positions
  const updateCursorPositions = useCallback(() => {
    const editorElement = editor.getRootElement();
    if (!editorElement) return;

    const newCursorElements = new Map<string, HTMLElement>();

    remoteCursors.forEach(cursor => {
      if (cursor.userId === currentUserId) return; // Don't show our own cursor

      try {
        editor.getEditorState().read(() => {
          const node = $getNodeByKey(cursor.position.key);
          if (!node) return;

          // Get the DOM element for this node
          const nodeElement = editor.getElementByKey(cursor.position.key);
          if (!nodeElement) return;

          // Calculate cursor position
          const range = document.createRange();
          const textNode = getTextNodeAtOffset(nodeElement, cursor.position.offset);
          
          if (textNode) {
            range.setStart(textNode.node, textNode.offset);
            range.setEnd(textNode.node, textNode.offset);
            
            const rect = range.getBoundingClientRect();
            const editorRect = editorElement.getBoundingClientRect();
            
            // Create or update cursor element
            let cursorElement = cursorElements.get(cursor.userId);
            if (!cursorElement) {
              cursorElement = createCursorElement(cursor);
              editorElement.appendChild(cursorElement);
            } else {
              updateCursorElement(cursorElement, cursor);
            }

            // Position the cursor
            const left = rect.left - editorRect.left;
            const top = rect.top - editorRect.top;
            
            cursorElement.style.left = `${left}px`;
            cursorElement.style.top = `${top}px`;
            cursorElement.style.height = `${rect.height || 20}px`;

            newCursorElements.set(cursor.userId, cursorElement);

            // Handle selections
            if (cursor.position.type === 'selection' && cursor.position.anchor && cursor.position.focus) {
              updateSelectionHighlight(cursor, editorElement, editorRect);
            }
          }
        });
      } catch (error) {
        console.error('Error positioning cursor for user', cursor.userId, ':', error);
      }
    });

    // Remove cursors for users who are no longer present
    cursorElements.forEach((element, userId) => {
      if (!newCursorElements.has(userId)) {
        element.remove();
      }
    });

    setCursorElements(newCursorElements);
  }, [editor, remoteCursors, currentUserId, cursorElements]);

  // Helper function to find text node at specific offset
  const getTextNodeAtOffset = (element: Element, offset: number): { node: Text; offset: number } | null => {
    let currentOffset = 0;
    
    const walker = document.createTreeWalker(
      element,
      NodeFilter.SHOW_TEXT
    );

    let textNode: Text | null = walker.nextNode() as Text;
    while (textNode) {
      const nodeLength = textNode.textContent?.length || 0;
      
      if (currentOffset + nodeLength >= offset) {
        return {
          node: textNode,
          offset: offset - currentOffset
        };
      }
      
      currentOffset += nodeLength;
      textNode = walker.nextNode() as Text;
    }

    // If offset is beyond text, use the last text node
    const lastTextNode = walker.previousNode() as Text;
    if (lastTextNode) {
      return {
        node: lastTextNode,
        offset: lastTextNode.textContent?.length || 0
      };
    }

    return null;
  };

  // Create cursor element
  const createCursorElement = (cursor: RemoteCursor): HTMLElement => {
    const cursorElement = document.createElement('div');
    cursorElement.className = 'remote-cursor-marker';
    cursorElement.setAttribute('data-user-id', cursor.userId);
    
    const color = getColorForUser(cursor.userId);
    
    cursorElement.innerHTML = `
      <div class="cursor-line" style="background-color: ${color}"></div>
      <div class="cursor-label" style="background-color: ${color}">
        ${cursor.userName}
      </div>
    `;

    return cursorElement;
  };

  // Update cursor element
  const updateCursorElement = (element: HTMLElement, cursor: RemoteCursor): void => {
    const color = getColorForUser(cursor.userId);
    const cursorLine = element.querySelector('.cursor-line') as HTMLElement;
    const cursorLabel = element.querySelector('.cursor-label') as HTMLElement;
    
    if (cursorLine) {
      cursorLine.style.backgroundColor = color;
    }
    
    if (cursorLabel) {
      cursorLabel.style.backgroundColor = color;
      cursorLabel.textContent = cursor.userName;
    }
  };

  // Update selection highlight
  const updateSelectionHighlight = (cursor: RemoteCursor, editorElement: HTMLElement, editorRect: DOMRect): void => {
    if (!cursor.position.anchor || !cursor.position.focus) return;

    try {
      // Remove existing selection highlight for this user
      const existingHighlight = editorElement.querySelector(`.selection-highlight[data-user-id="${cursor.userId}"]`);
      if (existingHighlight) {
        existingHighlight.remove();
      }

      // Create new selection highlight
      const selectionElement = document.createElement('div');
      selectionElement.className = 'selection-highlight';
      selectionElement.setAttribute('data-user-id', cursor.userId);
      selectionElement.setAttribute('data-user-name', cursor.userName);
      
      const color = getColorForUser(cursor.userId);
      selectionElement.style.backgroundColor = `${color}20`; // 20% opacity
      selectionElement.style.borderLeft = `2px solid ${color}`;
      
      // Calculate selection bounds (simplified)
      // In a real implementation, you'd need to handle multi-line selections
      const range = document.createRange();
      
      editor.getEditorState().read(() => {
        const anchorNode = $getNodeByKey(cursor.position.anchor!.key);
        const focusNode = $getNodeByKey(cursor.position.focus!.key);
        
        if (anchorNode && focusNode) {
          const anchorElement = editor.getElementByKey(cursor.position.anchor!.key);
          const focusElement = editor.getElementByKey(cursor.position.focus!.key);
          
          if (anchorElement && focusElement) {
            const anchorTextNode = getTextNodeAtOffset(anchorElement, cursor.position.anchor!.offset);
            const focusTextNode = getTextNodeAtOffset(focusElement, cursor.position.focus!.offset);
            
            if (anchorTextNode && focusTextNode) {
              range.setStart(anchorTextNode.node, anchorTextNode.offset);
              range.setEnd(focusTextNode.node, focusTextNode.offset);
              
              const rects = range.getClientRects();
              
              // Create highlight elements for each rect (handles multi-line selections)
              for (let i = 0; i < rects.length; i++) {
                const rect = rects[i];
                const highlightRect = document.createElement('div');
                highlightRect.className = 'selection-rect';
                highlightRect.style.position = 'absolute';
                highlightRect.style.left = `${rect.left - editorRect.left}px`;
                highlightRect.style.top = `${rect.top - editorRect.top}px`;
                highlightRect.style.width = `${rect.width}px`;
                highlightRect.style.height = `${rect.height}px`;
                highlightRect.style.backgroundColor = `${color}20`;
                highlightRect.style.pointerEvents = 'none';
                highlightRect.style.zIndex = '1';
                
                selectionElement.appendChild(highlightRect);
              }
              
              editorElement.appendChild(selectionElement);
            }
          }
        }
      });
    } catch (error) {
      console.error('Error creating selection highlight:', error);
    }
  };

  // Update cursor positions when remote cursors change
  useEffect(() => {
    updateCursorPositions();
  }, [updateCursorPositions]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cursorElements.forEach(element => {
        element.remove();
      });
    };
  }, []);

  return <></>; // This plugin doesn't render anything directly
} 