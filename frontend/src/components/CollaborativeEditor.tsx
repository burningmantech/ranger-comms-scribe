import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { $getRoot, $getSelection, $isRangeSelection, $createTextNode, $createParagraphNode, $createRangeSelection, $setSelection } from 'lexical';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin';
import { OnChangePlugin } from '@lexical/react/LexicalOnChangePlugin';
import { EditorState, LexicalEditor } from 'lexical';
import { EditorRefPlugin } from '@lexical/react/LexicalEditorRefPlugin';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { HeadingNode, QuoteNode } from '@lexical/rich-text';
import { ListItemNode, ListNode } from '@lexical/list';
import { CodeHighlightNode, CodeNode } from '@lexical/code';
import { TableNode, TableCellNode, TableRowNode } from '@lexical/table';
import { LinkNode } from '@lexical/link';
import { ListPlugin } from '@lexical/react/LexicalListPlugin';
import { LinkPlugin } from '@lexical/react/LexicalLinkPlugin';
import { ToolbarPlugin } from './editor/plugins/ToolbarPlugin';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { UserPresence, UserPresenceData } from './UserPresence';
import { User } from '../types/content';
import { WebSocketManager, CursorPosition, WebSocketMessage } from '../services/websocketService';
import { isLexicalJson, extractTextFromLexical } from '../utils/lexicalUtils';
import './CollaborativeEditor.css';

// User color assignment function
const getUserColor = (userId: string): string => {
  // Generate consistent colors based on user ID
  const colors = [
    '#1a73e8', // Blue
    '#ea4335', // Red  
    '#34a853', // Green
    '#fbbc04', // Yellow
    '#ff6d01', // Orange
    '#9c27b0', // Purple
    '#00bcd4', // Cyan
    '#795548', // Brown
    '#607d8b', // Blue Grey
    '#e91e63', // Pink
  ];
  
  // Simple hash function to get consistent color for user
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = ((hash << 5) - hash + userId.charCodeAt(i)) & 0xffffffff;
  }
  return colors[Math.abs(hash) % colors.length];
};

// Line/Position utility functions
const getLinePositionFromDOMSelection = (editorElement: HTMLElement, selection: Range): { line: number; column: number } | null => {
  try {
    const startContainer = selection.startContainer;
    const startOffset = selection.startOffset;
    
    // Find which paragraph/block element contains the selection
    let targetParagraph = startContainer.nodeType === Node.TEXT_NODE ? startContainer.parentElement : startContainer as Element;
    
    // Walk up to find the paragraph element
    while (targetParagraph && targetParagraph !== editorElement) {
      if (targetParagraph.tagName === 'P' || targetParagraph.tagName === 'DIV' || 
          targetParagraph.classList?.contains('paragraph') ||
          targetParagraph.getAttribute('data-lexical-paragraph') !== null) {
        break;
      }
      targetParagraph = targetParagraph.parentElement;
    }
    
    if (!targetParagraph || targetParagraph === editorElement) {
      console.warn('⚠️ Could not find paragraph element for selection');
      return null;
    }
    
    // Count which line (paragraph) this is
    let currentLine = 0;
    const paragraphs = editorElement.querySelectorAll('p, div[data-lexical-paragraph], .paragraph');
    
    for (let i = 0; i < paragraphs.length; i++) {
      if (paragraphs[i] === targetParagraph) {
        currentLine = i;
        break;
      }
    }
    
    // Calculate column position within this paragraph
    let currentColumn = 0;
    const walker = document.createTreeWalker(
      targetParagraph,
      NodeFilter.SHOW_TEXT
    );
    
    let node;
    let found = false;
    
    while (node = walker.nextNode()) {
      if (node === startContainer) {
        currentColumn += startOffset;
        found = true;
        break;
      }
      
      const textContent = node.textContent || '';
      currentColumn += textContent.length;
    }
    
    if (!found) {
      console.warn('⚠️ Could not find text node within paragraph');
      return null;
    }
    
    console.log('📍 Line/Column calculated:', { line: currentLine, column: currentColumn, paragraphCount: paragraphs.length });
    return { line: currentLine, column: currentColumn };
  } catch (error) {
    console.error('❌ Error getting line/position from DOM selection:', error);
    return null;
  }
};

const getDOMPositionFromLinePosition = (editorElement: HTMLElement, line: number, column: number): { textNode: Node; offset: number } | null => {
  try {
    // Find all paragraph elements
    const paragraphs = editorElement.querySelectorAll('p, div[data-lexical-paragraph], .paragraph');
    
    if (line >= paragraphs.length) {
      console.warn('⚠️ Line number exceeds available paragraphs:', { requestedLine: line, totalParagraphs: paragraphs.length });
      // Fall back to last paragraph
      if (paragraphs.length > 0) {
        const lastParagraph = paragraphs[paragraphs.length - 1];
        const walker = document.createTreeWalker(lastParagraph, NodeFilter.SHOW_TEXT);
        let lastNode = null;
        let node;
        while (node = walker.nextNode()) {
          lastNode = node;
        }
        if (lastNode) {
          return { textNode: lastNode, offset: (lastNode.textContent || '').length };
        }
      }
      return null;
    }
    
    const targetParagraph = paragraphs[line] as HTMLElement;
    
    // Walk through text nodes in this paragraph to find the column position
    let currentColumn = 0;
    const walker = document.createTreeWalker(
      targetParagraph,
      NodeFilter.SHOW_TEXT
    );
    
    let node;
    while (node = walker.nextNode()) {
      const textContent = node.textContent || '';
      
      if (currentColumn + textContent.length >= column) {
        // Found the text node containing our target column
        const offsetInNode = column - currentColumn;
        console.log('🎯 RemoteCursorPlugin: Found DOM position:', {
          line,
          column,
          textNodeContent: textContent,
          offset: offsetInNode
        });
        return { textNode: node, offset: offsetInNode };
      }
      
      currentColumn += textContent.length;
    }
    
    // If column is beyond the text content, position at the end of the paragraph
    const walker2 = document.createTreeWalker(targetParagraph, NodeFilter.SHOW_TEXT);
    let lastNode = null;
    let lastNodeInParagraph;
    while (lastNodeInParagraph = walker2.nextNode()) {
      lastNode = lastNodeInParagraph;
    }
    
    if (lastNode) {
      console.log('🎯 RemoteCursorPlugin: Column beyond text, positioning at end of paragraph:', {
        line,
        column,
        textContent: lastNode.textContent,
        endPosition: (lastNode.textContent || '').length
      });
      return { textNode: lastNode, offset: (lastNode.textContent || '').length };
    }
    
    return null;
  } catch (error) {
    console.error('❌ Error getting DOM position from line/position:', error);
    return null;
  }
};

const getLexicalSelectionLinePosition = (editor: LexicalEditor): { line: number; column: number } | null => {
  try {
    return editor.getEditorState().read(() => {
      const selection = $getSelection();
      if (!$isRangeSelection(selection)) {
        return null;
      }
      
      const editorElement = editor.getRootElement();
      if (!editorElement) {
        return null;
      }
      
      // Create a range from the selection
      const range = document.createRange();
      const anchorNode = selection.anchor.getNode();
      const anchorOffset = selection.anchor.offset;
      
      // Find the DOM node corresponding to the Lexical node
      const anchorDOMElement = editor.getElementByKey(anchorNode.getKey());
      if (!anchorDOMElement) {
        return null;
      }
      
      // Find the text node within the DOM element
      const textNodeResult = findTextNodeInElement(anchorDOMElement, anchorOffset);
      if (!textNodeResult) {
        return null;
      }
      
      range.setStart(textNodeResult.textNode, textNodeResult.offset);
      range.setEnd(textNodeResult.textNode, textNodeResult.offset);
      
      return getLinePositionFromDOMSelection(editorElement, range);
    });
  } catch (error) {
    console.error('❌ Error getting Lexical selection line/position:', error);
    return null;
  }
};

const setLexicalSelectionFromLinePosition = (editor: LexicalEditor, line: number, column: number): boolean => {
  try {
    const editorElement = editor.getRootElement();
    if (!editorElement) {
      return false;
    }
    
    const domPosition = getDOMPositionFromLinePosition(editorElement, line, column);
    if (!domPosition) {
      return false;
    }
    
    // Create a range at the DOM position
    const range = document.createRange();
    range.setStart(domPosition.textNode, domPosition.offset);
    range.setEnd(domPosition.textNode, domPosition.offset);
    
    // Convert DOM range to Lexical selection
    const selection = window.getSelection();
    if (selection) {
      selection.removeAllRanges();
      selection.addRange(range);
      
      // Focus the editor to ensure selection is visible
      editorElement.focus();
      
      return true;
    }
    
    return false;
  } catch (error) {
    console.error('❌ Error setting Lexical selection from line/position:', error);
    return false;
  }
};

const findTextNodeInElement = (element: Element, targetOffset: number): { textNode: Node; offset: number } | null => {
  const walker = document.createTreeWalker(
    element,
    NodeFilter.SHOW_TEXT
  );
  
  let currentOffset = 0;
  let node;
  
  while (node = walker.nextNode()) {
    const textContent = node.textContent || '';
    if (currentOffset + textContent.length >= targetOffset) {
      return {
        textNode: node,
        offset: targetOffset - currentOffset
      };
    }
    currentOffset += textContent.length;
  }
  
  return null;
};

// Remote cursor overlay plugin
const RemoteCursorPlugin: React.FC<{
  remoteCursors: Map<string, CursorPosition>;
  currentUserCursor: CursorPosition | null;
  currentUserId: string;
  needsRepositioning?: boolean;
  webSocketClient?: any;
}> = ({ remoteCursors, currentUserCursor, currentUserId, needsRepositioning, webSocketClient }) => {
  const [editor] = useLexicalComposerContext();
  const cursorsRef = useRef<Map<string, HTMLElement>>(new Map());
  const overlayRef = useRef<HTMLElement | null>(null);
  const sentRefreshRequests = useRef<Map<string, number>>(new Map());
  
  // Create overlay container
  useEffect(() => {
    const editorElement = editor.getRootElement();
    if (!editorElement) return;
    
    // Create overlay if it doesn't exist
    if (!overlayRef.current) {
      const overlay = document.createElement('div');
      overlay.id = 'lexical-remote-cursors';
      overlay.style.cssText = `
        position: absolute;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        pointer-events: none;
        z-index: 10;
      `;
      
      const container = editorElement.parentElement;
      if (container) {
        if (window.getComputedStyle(container).position === 'static') {
          container.style.position = 'relative';
        }
        container.appendChild(overlay);
        overlayRef.current = overlay;
        console.log('✅ RemoteCursorPlugin: Created overlay container');
      }
    }
    
    return () => {
      if (overlayRef.current) {
        overlayRef.current.remove();
        overlayRef.current = null;
      }
    };
  }, [editor]);
  
  // Update cursors when remoteCursors changes
  useEffect(() => {
    if (!overlayRef.current) return;
    
    const overlay = overlayRef.current;
    const editorElement = editor.getRootElement();
    if (!editorElement) return;
    
    console.log('🎯 RemoteCursorPlugin: Updating cursors:', {
      totalCursors: remoteCursors.size,
      cursorIds: Array.from(remoteCursors.keys())
    });
    
    // Remove cursors that no longer exist
    const currentCursorIds = new Set(remoteCursors.keys());
    for (const [userId, cursorElement] of cursorsRef.current) {
      if (!currentCursorIds.has(userId) || userId === currentUserId) {
        console.log('🧹 RemoteCursorPlugin: Removing cursor for user:', userId);
        cursorElement.remove();
        cursorsRef.current.delete(userId);
      }
    }
    
    // Add/update remote cursors
    remoteCursors.forEach((cursor, userId) => {
      if (userId === currentUserId) return; // Skip own cursor in remote cursors
      
      console.log('🎯 RemoteCursorPlugin: Processing remote cursor for user:', userId, cursor);
      
      // Get or create cursor element
      let cursorElement = cursorsRef.current.get(userId);
      if (!cursorElement) {
        cursorElement = createCursorElement(cursor);
        overlay.appendChild(cursorElement);
        cursorsRef.current.set(userId, cursorElement);
        console.log('✅ RemoteCursorPlugin: Created new remote cursor for user:', userId);
      }
      
      // Position the cursor
      positionCursor(cursorElement, cursor, editorElement, overlay);
    });
    
    // Add/update current user's cursor
    if (currentUserCursor) {
      console.log('🎯 RemoteCursorPlugin: Processing current user cursor:', currentUserCursor);
      
      const userId = currentUserCursor.userId;
      let cursorElement = cursorsRef.current.get(userId);
      if (!cursorElement) {
        cursorElement = createCursorElement(currentUserCursor);
        overlay.appendChild(cursorElement);
        cursorsRef.current.set(userId, cursorElement);
        console.log('✅ RemoteCursorPlugin: Created new current user cursor');
      }
      
      // Position the current user's cursor
      positionCursor(cursorElement, currentUserCursor, editorElement, overlay);
    }
    
  }, [remoteCursors, currentUserCursor, currentUserId, editor]);
  
  // Force repositioning when needed
  useEffect(() => {
    if (needsRepositioning && overlayRef.current) {
      console.log('🔄 RemoteCursorPlugin: Force repositioning all cursors, total cursors:', remoteCursors.size);
      
      const overlay = overlayRef.current;
      const editorElement = editor.getRootElement();
      if (!editorElement) {
        console.log('❌ RemoteCursorPlugin: No editor element found for repositioning');
        return;
      }
      
      // Small delay to ensure DOM is fully updated after content changes
      setTimeout(() => {
        console.log('🔄 RemoteCursorPlugin: Starting delayed repositioning...');
        
        // Reposition all existing cursors
        remoteCursors.forEach((cursor, userId) => {
          if (userId === currentUserId) return;
          
          const cursorElement = cursorsRef.current.get(userId);
          if (cursorElement) {
            console.log('🔄 RemoteCursorPlugin: Repositioning cursor for user:', userId, cursor.position);
            positionCursor(cursorElement, cursor, editorElement, overlay);
          } else {
            console.log('⚠️ RemoteCursorPlugin: No cursor element found for user:', userId);
          }
        });
        
        console.log('✅ RemoteCursorPlugin: Completed repositioning attempt');
      }, 100);
    }
  }, [needsRepositioning, remoteCursors, currentUserId, editor]);
  
  // Create cursor element with nice design
  const createCursorElement = (cursor: CursorPosition): HTMLElement => {
    const userColor = getUserColor(cursor.userId);
    const isSelection = cursor.position.type === 'selection';
    
    console.log('🎨 CreateCursorElement DEBUG:', {
      userId: cursor.userId,
      positionType: cursor.position.type,
      isSelection,
      hasAnchor: !!cursor.position.anchor,
      hasFocus: !!cursor.position.focus,
      anchor: cursor.position.anchor,
      focus: cursor.position.focus
    });
    
    const cursorEl = document.createElement('div');
    cursorEl.className = 'lexical-remote-cursor';
    cursorEl.id = `cursor-${cursor.userId.replace(/[^a-zA-Z0-9]/g, '-')}`;
    
    // Cursor line - always create
    const line = document.createElement('div');
    line.className = 'cursor-line';
    line.style.cssText = `
      width: 2px;
      height: 20px;
      background-color: ${userColor};
      position: absolute;
      border-radius: 1px;
      animation: cursor-blink 1.5s infinite;
      box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.8), 0 0 4px rgba(0, 0, 0, 0.3);
      z-index: 101;
    `;
    cursorEl.appendChild(line);
    
    // Selection highlight for selections - always create it, hide by default
    const selection = document.createElement('div');
    selection.className = 'selection-highlight';
    selection.style.cssText = `
      background-color: ${userColor}30;
      border: 1px solid ${userColor}80;
      border-radius: 2px;
      position: absolute;
      pointer-events: none;
      z-index: 99;
      display: none;
      min-width: 1px;
      min-height: 16px;
    `;
    cursorEl.appendChild(selection);
    
    console.log('🎨 Created cursor element:', {
      isSelection,
      hasSelectionElement: !!cursorEl.querySelector('.selection-highlight'),
      hasLineElement: !!cursorEl.querySelector('.cursor-line')
    });
    
    // User label
    const label = document.createElement('div');
    label.className = 'cursor-label';
    label.textContent = cursor.userName;
    label.style.cssText = `
      position: absolute;
      top: -26px;
      left: 0;
      background-color: ${userColor};
      color: white;
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 11px;
      font-weight: 500;
      white-space: nowrap;
      box-shadow: 0 2px 4px rgba(0,0,0,0.2);
      transform: translateX(-50%);
      z-index: 1001;
      max-width: 120px;
      text-overflow: ellipsis;
      overflow: hidden;
    `;
    
    // Small triangle pointer
    const triangle = document.createElement('div');
    triangle.style.cssText = `
      position: absolute;
      top: -2px;
      left: 50%;
      transform: translateX(-50%);
      width: 0;
      height: 0;
      border-left: 4px solid transparent;
      border-right: 4px solid transparent;
      border-top: 4px solid ${userColor};
    `;
    
    cursorEl.style.cssText = `
      position: absolute;
      pointer-events: none;
      z-index: 100;
      transition: left 0.1s ease, top 0.1s ease;
    `;
    
    label.appendChild(triangle);
    cursorEl.appendChild(line);
    cursorEl.appendChild(label);
    
    return cursorEl;
  };
  
  // Position cursor at line/column position
  const positionCursor = (
    cursorElement: HTMLElement, 
    cursor: CursorPosition, 
    editorElement: HTMLElement,
    overlay: HTMLElement
  ) => {
    try {
      const line = cursor.position.line;
      const column = cursor.position.column;
      const isSelection = cursor.position.type === 'selection';
      console.log('🎯 RemoteCursorPlugin: Positioning cursor for', cursor.userName, 'at line', line, 'column', column, 'isSelection:', isSelection);
      
      // Handle selections differently
      if (isSelection && cursor.position.focus && cursor.position.anchor) {
        const anchorLine = cursor.position.anchor.line;
        const anchorColumn = cursor.position.anchor.column;
        const focusLine = cursor.position.focus.line;
        const focusColumn = cursor.position.focus.column;
        
        console.log('🎯 RemoteCursorPlugin: SELECTION DETECTED:', {
          anchorLine, anchorColumn, focusLine, focusColumn
        });
        
        // Check if it's a collapsed selection (just a cursor)
        const isCollapsed = anchorLine === focusLine && anchorColumn === focusColumn;
        
        if (!isCollapsed) {
          console.log('🎯 RemoteCursorPlugin: Processing REAL selection...');
          // Handle actual selection
          try {
            const anchorDOMPosition = getDOMPositionFromLinePosition(editorElement, anchorLine, anchorColumn);
            const focusDOMPosition = getDOMPositionFromLinePosition(editorElement, focusLine, focusColumn);
            
            if (anchorDOMPosition && focusDOMPosition) {
              const range = document.createRange();
              
              // Ensure proper range direction
              let startPosition = anchorDOMPosition;
              let endPosition = focusDOMPosition;
              
              // For same text node, ensure start < end
              if (anchorDOMPosition.textNode === focusDOMPosition.textNode) {
                if (anchorDOMPosition.offset > focusDOMPosition.offset) {
                  startPosition = focusDOMPosition;
                  endPosition = anchorDOMPosition;
                }
              }
              
              range.setStart(startPosition.textNode, startPosition.offset);
              range.setEnd(endPosition.textNode, endPosition.offset);
              
              const rect = range.getBoundingClientRect();
              const overlayRect = overlay.getBoundingClientRect();
              
              console.log('🎯 RemoteCursorPlugin: Range rect:', {
                width: rect.width,
                height: rect.height,
                left: rect.left,
                top: rect.top,
                overlayLeft: overlayRect.left,
                overlayTop: overlayRect.top
              });
              
              if (rect.width > 0 && rect.height > 0) {
                const left = rect.left - overlayRect.left;
                const top = rect.top - overlayRect.top;
                
                // Position cursor element
                cursorElement.style.left = `${left}px`;
                cursorElement.style.top = `${top}px`;
                cursorElement.style.opacity = '1';
                
                // Show selection highlight
                const selection = cursorElement.querySelector('.selection-highlight') as HTMLElement;
                if (selection) {
                  selection.style.width = `${rect.width}px`;
                  selection.style.height = `${rect.height}px`;
                  selection.style.left = '0px';
                  selection.style.top = '0px';
                  selection.style.display = 'block';
                }
                
                // Hide cursor line for selections
                const lineElement = cursorElement.querySelector('.cursor-line') as HTMLElement;
                if (lineElement) {
                  lineElement.style.display = 'none';
                }
                
                positionLabel(cursorElement, left, top, overlay, cursor);
                
                console.log('✅ RemoteCursorPlugin: SELECTION POSITIONED SUCCESSFULLY:', {
                  left, top, width: rect.width, height: rect.height
                });
                
                return;
              } else {
                console.log('⚠️ RemoteCursorPlugin: Invalid selection rect:', rect);
              }
            } else {
              console.log('⚠️ RemoteCursorPlugin: Could not find DOM positions for selection');
            }
          } catch (error) {
            console.log('⚠️ RemoteCursorPlugin: Selection positioning error:', error);
          }
        } else {
          console.log('🎯 RemoteCursorPlugin: Collapsed selection, treating as cursor');
        }
      }
      
      // Handle regular cursor positioning (or fallback for selections)
      const domPosition = getDOMPositionFromLinePosition(editorElement, line, column);
      
      if (domPosition) {
        console.log('🎯 RemoteCursorPlugin: Found DOM position:', {
          line, column,
          textNodeContent: domPosition.textNode.textContent?.substring(0, 50),
          offset: domPosition.offset
        });
        
        try {
          const range = document.createRange();
          range.setStart(domPosition.textNode, domPosition.offset);
          range.setEnd(domPosition.textNode, domPosition.offset);
          
          const rect = range.getBoundingClientRect();
          const overlayRect = overlay.getBoundingClientRect();
          
          if (rect.height > 0) {
            const left = rect.left - overlayRect.left;
            const top = rect.top - overlayRect.top;
            
            // Position the cursor
            cursorElement.style.left = `${left}px`;
            cursorElement.style.top = `${top}px`;
            cursorElement.style.opacity = '1';
            
            // Hide selection highlight for regular cursor and show cursor line
            const selection = cursorElement.querySelector('.selection-highlight') as HTMLElement;
            if (selection) {
              selection.style.display = 'none';
            }
            
            const lineElement = cursorElement.querySelector('.cursor-line') as HTMLElement;
            if (lineElement) {
              lineElement.style.display = 'block';
            }
            
            // Smart label positioning
            positionLabel(cursorElement, left, top, overlay, cursor);
            
            console.log('✅ RemoteCursorPlugin: Positioned cursor using line/position:', { 
              left, 
              top, 
              line,
              column,
              targetChar: domPosition.textNode.textContent?.charAt(domPosition.offset) || '',
            });
            
            return; // Successfully positioned
          } else {
            console.log('⚠️ RemoteCursorPlugin: Invalid rect dimensions:', rect);
          }
        } catch (error) {
          console.log('⚠️ RemoteCursorPlugin: Range positioning error:', error);
        }
      } else {
        console.log('⚠️ RemoteCursorPlugin: Could not find DOM position for line/column:', line, column);
        console.log('💡 RemoteCursorPlugin: This may happen if content has changed');
        console.log('🚫 RemoteCursorPlugin: Hiding cursor and requesting fresh position for:', cursor.userName);
        
        // Hide the cursor instead of showing fallback - this prevents the upper left corner issue
        cursorElement.style.opacity = '0';
        
        // Request a fresh cursor position from this user to update their stale position
        if (webSocketClient) {
          const now = Date.now();
          const userRequestKey = `${cursor.userId}_recent`;
          const lastRequestTime = sentRefreshRequests.current.get(userRequestKey) || 0;
          const timeSinceLastRequest = now - lastRequestTime;
          
          // Rate limit: don't send requests to the same user more than once every 3 seconds
          if (timeSinceLastRequest > 3000) {
            try {
              console.log('📡 Sending cursor refresh request:', {
                fromUserId: currentUserId,
                targetUserId: cursor.userId,
                targetUserName: cursor.userName,
                staleCursorPosition: [line, column],
                reason: 'stale_line_position'
              });
              
              webSocketClient.send({
                type: 'request_cursor_refresh',
                targetUserId: cursor.userId,
                requestingUserId: currentUserId,
                data: {
                  reason: 'stale_line_position',
                  staleCursorPosition: [line, column],
                  timestamp: new Date().toISOString()
                }
              });
              console.log('📡 Requested fresh cursor position from:', cursor.userName);
              
              // Track this request to prevent duplicates
              sentRefreshRequests.current.set(userRequestKey, now);
              
              // Clean up after 10 seconds
              setTimeout(() => {
                sentRefreshRequests.current.delete(userRequestKey);
              }, 10000);
              
            } catch (error) {
              console.error('❌ Failed to request cursor refresh:', error);
            }
          } else {
            console.log('🚫 Skipping duplicate cursor refresh request for:', cursor.userName, `(${timeSinceLastRequest}ms since last request)`);
          }
        }
        
        return; // Exit early, don't show fallback
      }
      
      // Fallback positioning should only be reached if we can't find DOM positions
      console.log('🎯 RemoteCursorPlugin: Using fallback positioning for', cursor.userName);
      
      cursorElement.style.left = '10px';
      cursorElement.style.top = '10px';
      cursorElement.style.opacity = '0.7';
      
      // For fallback, show cursor line and hide selection
      const selection = cursorElement.querySelector('.selection-highlight') as HTMLElement;
      if (selection) {
        selection.style.display = 'none';
      }
      
      const cursorLineElement = cursorElement.querySelector('.cursor-line') as HTMLElement;
      if (cursorLineElement) {
        cursorLineElement.style.display = 'block';
      }
      
      positionLabel(cursorElement, 10, 10, overlay, cursor);
      
    } catch (error) {
      console.error('❌ RemoteCursorPlugin: Positioning error:', error);
      console.log('🚫 RemoteCursorPlugin: Hiding cursor due to positioning error');
      cursorElement.style.opacity = '0';
    }
  };
  
  // Helper function to find text node within a DOM element at specific character offset
  const findTextNodeInElement = (element: Element, targetOffset: number): { textNode: Node; offset: number } | null => {
    let currentOffset = 0;
    
    const walker = document.createTreeWalker(
      element,
      NodeFilter.SHOW_TEXT,
      null
    );
    
    let textNode: Node | null = null;
    while (textNode = walker.nextNode()) {
      const textContent = textNode.textContent || '';
      const nodeEndOffset = currentOffset + textContent.length;
      
      if (nodeEndOffset >= targetOffset) {
        const nodeOffset = targetOffset - currentOffset;
        return { textNode, offset: Math.min(nodeOffset, textContent.length) };
      }
      
      currentOffset += textContent.length;
    }
    
    return null;
  };
  
  // Smart label positioning to keep within bounds
  const positionLabel = (cursorElement: HTMLElement, cursorLeft: number, cursorTop: number, overlay: HTMLElement, cursor: CursorPosition) => {
    const label = cursorElement.querySelector('.cursor-label') as HTMLElement;
    if (!label) return;
    
    const overlayRect = overlay.getBoundingClientRect();
    const labelWidth = Math.min(120, label.offsetWidth || 80); // Use actual width or estimate
    const labelHeight = 26; // Label height including triangle
    
    // Reset to default position first
    label.style.top = '-26px';
    label.style.left = '0';
    label.style.transform = 'translateX(-50%)';
    
    // Reset triangle to default
    const triangle = label.querySelector('div') as HTMLElement;
    if (triangle) {
      triangle.style.borderTop = `4px solid ${getUserColor(cursor.userId)}`;
      triangle.style.borderBottom = 'none';
      triangle.style.top = '-2px';
    }
    
    // Check if label would go off the top
    if (cursorTop < labelHeight + 10) {
      // Position below cursor instead
      label.style.top = '25px';
      
      // Flip the triangle
      if (triangle) {
        triangle.style.borderTop = 'none';
        triangle.style.borderBottom = `4px solid ${getUserColor(cursor.userId)}`;
        triangle.style.top = '-6px';
      }
    }
    
    // Check horizontal positioning
    const labelLeftEdge = cursorLeft - labelWidth / 2;
    const labelRightEdge = cursorLeft + labelWidth / 2;
    
    if (labelLeftEdge < 5) {
      // Would go off the left side
      const adjustment = 5 - labelLeftEdge;
      label.style.left = `${adjustment}px`;
      label.style.transform = 'translateX(-50%)';
    } else if (labelRightEdge > overlayRect.width - 5) {
      // Would go off the right side
      const adjustment = labelRightEdge - (overlayRect.width - 5);
      label.style.left = `${-adjustment}px`;
      label.style.transform = 'translateX(-50%)';
    }
    
    console.log('🎯 RemoteCursorPlugin: Positioned label:', {
      cursorLeft,
      cursorTop,
      labelWidth,
      overlayWidth: overlayRect.width,
      labelLeftEdge,
      labelRightEdge,
      finalTransform: label.style.transform,
      finalLeft: label.style.left,
      finalTop: label.style.top
    });
  };
  
  // Add CSS animation for cursor blinking
  const addCursorStyles = () => {
    const styleId = 'lexical-cursor-styles';
    if (document.getElementById(styleId)) return;
    
    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = `
      @keyframes cursor-blink {
        0%, 50% { opacity: 1; }
        51%, 100% { opacity: 0.4; }
      }
      
      .lexical-remote-cursor {
        transition: left 0.15s ease-out, top 0.15s ease-out, opacity 0.2s ease;
      }
      
      .lexical-remote-cursor:hover .cursor-label {
        opacity: 1 !important;
        transform: translateX(-50%) scale(1.05);
      }
      
      .lexical-remote-cursor .cursor-line {
        will-change: opacity;
      }
      
      .lexical-remote-cursor .cursor-label {
        will-change: transform;
        transition: transform 0.2s ease, opacity 0.2s ease;
      }
      
      /* Improve text rendering */
      .lexical-remote-cursor .cursor-label {
        -webkit-font-smoothing: antialiased;
        -moz-osx-font-smoothing: grayscale;
        text-rendering: optimizeLegibility;
      }
      
      /* Ensure proper stacking */
      .lexical-remote-cursor {
        contain: layout style;
      }
    `;
    document.head.appendChild(style);
  };

  // Initialize styles
  addCursorStyles();

  return null;
};

// Cursor tracking plugin
const CursorTrackingPlugin: React.FC<{
  webSocketClient: any;
  currentUser: User;
  documentId: string;
  onCursorUpdate: (position: CursorPosition) => void;
  effectiveUserId: string;
}> = ({ webSocketClient, currentUser, documentId, onCursorUpdate, effectiveUserId }) => {
  const [editor] = useLexicalComposerContext();
  const selectionTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  
  useEffect(() => {
    console.log('🎯 CursorTrackingPlugin initialized:', {
      hasWebSocketClient: !!webSocketClient,
      documentId,
      userId: currentUser.id || currentUser.email,
      webSocketClientType: typeof webSocketClient,
      webSocketClientMethods: webSocketClient ? Object.getOwnPropertyNames(webSocketClient) : []
    });
    
    if (!webSocketClient) {
      console.log('⚠️ CursorTrackingPlugin: No WebSocket client provided, waiting...');
      return;
    }
    
    // Listen for cursor refresh requests
    const handleCursorRefreshRequest = (message: any) => {
      console.log('🔄 CursorTrackingPlugin: Received cursor refresh request:', message);
      console.log('🔄 CursorTrackingPlugin: Current user info:', {
        currentUserId: currentUser.id,
        currentUserEmail: currentUser.email,
        effectiveUserId: effectiveUserId,
        targetUserId: message.targetUserId
      });
      
      // Only respond if this request is targeted at the current user
      if (message.targetUserId === effectiveUserId) {
        console.log('✅ CursorTrackingPlugin: Refresh request is targeted at current user - responding');
        
        // Force a fresh cursor position update
        setTimeout(() => {
          console.log('🔄 CursorTrackingPlugin: Triggering fresh cursor position after refresh request');
          handleSelectionChange();
        }, 150); // Small delay to ensure content is settled
      } else {
        console.log('🚫 CursorTrackingPlugin: Ignoring refresh request - not targeted at current user:', {
          targetUserId: message.targetUserId,
          currentEffectiveUserId: effectiveUserId
        });
      }
    };
    
    // Register the refresh request handler
    webSocketClient.on('request_cursor_refresh', handleCursorRefreshRequest);
    
    const handleSelectionChange = () => {
      console.log('🎯 Selection change detected');
      
      // This function is now always called from within editor.read() context
      const selection = $getSelection();
      console.log('🎯 Current selection:', selection);
      
      if ($isRangeSelection(selection)) {
        console.log('🎯 Range selection detected');
        
        // Get line/position coordinates for the selection
        const anchorLinePosition = getLexicalSelectionLinePosition(editor);
        if (!anchorLinePosition) {
          console.log('⚠️ Could not get line/position for selection');
          return;
        }
        
        const isCollapsed = selection.isCollapsed();
        let focusLinePosition = anchorLinePosition;
        
        // For selections (not just cursors), we need to get focus position too
        if (!isCollapsed) {
          // Calculate the actual focus position for selections
          const focusNode = selection.focus.getNode();
          const focusOffset = selection.focus.offset;
          const editorElement = editor.getRootElement();
          
          if (editorElement) {
            // Find the DOM element for the focus node
            const focusDOMElement = editor.getElementByKey(focusNode.getKey());
            if (focusDOMElement) {
              const focusTextNodeResult = findTextNodeInElement(focusDOMElement, focusOffset);
              if (focusTextNodeResult) {
                const focusRange = document.createRange();
                focusRange.setStart(focusTextNodeResult.textNode, focusTextNodeResult.offset);
                focusRange.setEnd(focusTextNodeResult.textNode, focusTextNodeResult.offset);
                
                const calculatedFocusPosition = getLinePositionFromDOMSelection(editorElement, focusRange);
                if (calculatedFocusPosition) {
                  focusLinePosition = calculatedFocusPosition;
                  console.log('🎯 Calculated focus position for selection:', focusLinePosition);
                }
              }
            }
          }
        }
        
        console.log('🎯 Selection details:', {
          anchorLine: anchorLinePosition.line,
          anchorColumn: anchorLinePosition.column,
          focusLine: focusLinePosition.line,
          focusColumn: focusLinePosition.column,
          isCollapsed
        });
        
        // Create cursor position using line/column coordinates
        const position: CursorPosition = {
          userId: effectiveUserId,
          userName: currentUser.name || currentUser.email,
          userEmail: currentUser.email,
          position: {
            line: anchorLinePosition.line,
            column: anchorLinePosition.column,
            type: isCollapsed ? 'cursor' : 'selection',
            anchor: {
              line: anchorLinePosition.line,
              column: anchorLinePosition.column
            },
            focus: {
              line: focusLinePosition.line,
              column: focusLinePosition.column
            }
          },
          timestamp: new Date().toISOString()
        };
        
        console.log('🎯 Calling onCursorUpdate with line/position:', {
          userId: effectiveUserId,
          userName: currentUser.name || currentUser.email,
          userEmail: currentUser.email,
          line: anchorLinePosition.line,
          column: anchorLinePosition.column,
          type: isCollapsed ? 'cursor' : 'selection'
        });
        onCursorUpdate(position);
      } else {
        console.log('🎯 Non-range selection, ignoring');
      }
    };
    
    console.log('🎯 Registering update listener...');
    const removeSelectionListener = editor.registerUpdateListener(({ editorState }) => {
      console.log('🎯 Editor update listener triggered');
      editorState.read(() => {
        handleSelectionChange();
      });
    });
    
    // Also register a command listener for selections
    const removeCommandListener = editor.registerCommand(
      'SELECTION_CHANGE_COMMAND' as any,
      () => {
        console.log('🎯 Selection command triggered');
        // Properly wrap in editor context
        editor.getEditorState().read(() => {
          handleSelectionChange();
        });
        return false;
      },
      1
    );
    
    // Add a document-level selection change listener as backup
    const handleDocumentSelectionChange = () => {
      console.log('🎯 Document selection change detected');
      // Debounce document selection changes to avoid excessive updates
      if (selectionTimeoutRef.current) {
        clearTimeout(selectionTimeoutRef.current);
      }
      selectionTimeoutRef.current = setTimeout(() => {
        // Properly wrap in editor context
        editor.getEditorState().read(() => {
          handleSelectionChange();
        });
      }, 100);
    };
    
    document.addEventListener('selectionchange', handleDocumentSelectionChange);
    
    console.log('✅ CursorTrackingPlugin setup complete with multiple listeners');
    
    return () => {
      console.log('🧹 CursorTrackingPlugin cleanup');
      removeSelectionListener();
      removeCommandListener();
      document.removeEventListener('selectionchange', handleDocumentSelectionChange);
      webSocketClient.off('request_cursor_refresh', handleCursorRefreshRequest);
      if (selectionTimeoutRef.current) {
        clearTimeout(selectionTimeoutRef.current);
      }
    };
  }, [editor, webSocketClient, currentUser.id, currentUser.email, currentUser.name, documentId, effectiveUserId]); // Stabilized dependencies
  
  return null;
};

// Cursor transformation utilities
const transformCursorPosition = (
  editor: LexicalEditor,
  oldPosition: CursorPosition,
  oldContent: string,
  newContent: string
): CursorPosition | null => {
  try {
    console.log('🔄 Transforming cursor position:', {
      userId: oldPosition.userId,
      oldLine: oldPosition.position.line,
      oldColumn: oldPosition.position.column,
      positionType: oldPosition.position.type
    });
    
    // Extract text from both versions to find the equivalent position
    const oldText = extractTextFromLexical(oldContent);
    const newText = extractTextFromLexical(newContent);
    
    if (!oldText || !newText) {
      console.log('⚠️ Could not extract text for cursor transformation');
      return null;
    }
    
    // Convert line/column to text position in the old document
    const oldTextPosition = getTextPositionFromLineColumn(oldText, oldPosition.position.line, oldPosition.position.column);
    if (oldTextPosition === null) {
      console.log('⚠️ Could not get text position from old line/column');
      return null;
    }
    
    // Transform the text position to the new document
    const newTextPosition = transformTextPosition(oldText, newText, oldTextPosition);
    if (newTextPosition === null) {
      console.log('⚠️ Could not transform text position');
      return null;
    }
    
    // Convert the new text position back to line/column
    const newLineColumn = getLineColumnFromTextPosition(newText, newTextPosition);
    if (!newLineColumn) {
      console.log('⚠️ Could not convert text position to line/column');
      return null;
    }
    
    // Create the transformed cursor position
    const transformedPosition: CursorPosition = {
      ...oldPosition,
      position: {
        line: newLineColumn.line,
        column: newLineColumn.column,
        type: oldPosition.position.type,
        anchor: oldPosition.position.type === 'selection' && oldPosition.position.anchor ? {
          line: newLineColumn.line,
          column: newLineColumn.column
        } : undefined,
        focus: oldPosition.position.type === 'selection' && oldPosition.position.focus ? {
          line: newLineColumn.line,
          column: newLineColumn.column
        } : undefined
      },
      timestamp: new Date().toISOString()
    };
    
    console.log('✅ Transformed cursor position:', {
      userId: transformedPosition.userId,
      newLine: transformedPosition.position.line,
      newColumn: transformedPosition.position.column,
      oldTextPosition,
      newTextPosition
    });
    
    return transformedPosition;
    
  } catch (error) {
    console.error('❌ Error transforming cursor position:', error);
    return null;
  }
};

// Convert line/column coordinates to linear text position
const getTextPositionFromLineColumn = (text: string, line: number, column: number): number | null => {
  try {
    let currentLine = 0;
    let currentColumn = 0;
    
    for (let i = 0; i < text.length; i++) {
      if (currentLine === line && currentColumn === column) {
        return i;
      }
      
      if (text[i] === '\n') {
        currentLine++;
        currentColumn = 0;
      } else {
        currentColumn++;
      }
    }
    
    // Check if we're at the end of the target line
    if (currentLine === line && currentColumn === column) {
      return text.length;
    }
    
    return null;
  } catch (error) {
    console.error('❌ Error converting line/column to text position:', error);
    return null;
  }
};

// Convert linear text position to line/column coordinates  
const getLineColumnFromTextPosition = (text: string, position: number): { line: number; column: number } | null => {
  try {
    if (position < 0 || position > text.length) {
      return null;
    }
    
    let line = 0;
    let column = 0;
    
    for (let i = 0; i < position; i++) {
      if (text[i] === '\n') {
        line++;
        column = 0;
      } else {
        column++;
      }
    }
    
    return { line, column };
  } catch (error) {
    console.error('❌ Error converting text position to line/column:', error);
    return null;
  }
};

// Legacy function - kept for compatibility but updated to work with line/column
const getTextPositionFromLexicalPosition = (lexicalContent: string, position: any): number | null => {
  try {
    // If position has line/column, use those directly
    if (typeof position.line === 'number' && typeof position.column === 'number') {
      const text = extractTextFromLexical(lexicalContent);
      if (!text) return null;
      return getTextPositionFromLineColumn(text, position.line, position.column);
    }
    
    // Legacy support for old key/offset format
    const editorState = JSON.parse(lexicalContent);
    let textPosition = 0;
    let found = false;
    
    const traverseNode = (node: any): boolean => {
      if (found) return true;
      
      // Legacy support - this function is deprecated
      // TODO: Remove this function or update it to handle new line/column format
      /*
      if (node.type === 'text' && node.key === position.key) {
        textPosition += position.offset;
        found = true;
        return true;
      }
      */
      
      if (node.type === 'text') {
        textPosition += (node.text || '').length;
      } else if (node.type === 'linebreak') {
        textPosition += 1;
      } else if (node.type === 'paragraph') {
        if (node.children) {
          for (const child of node.children) {
            if (traverseNode(child)) return true;
          }
        }
        textPosition += 1; // Add newline for paragraph
      } else if (node.children) {
        for (const child of node.children) {
          if (traverseNode(child)) return true;
        }
      }
      
      return false;
    };
    
    if (editorState.root && editorState.root.children) {
      for (const child of editorState.root.children) {
        if (traverseNode(child)) break;
      }
    }
    
    return found ? textPosition : null;
  } catch (error) {
    console.error('❌ Error getting text position from Lexical:', error);
    return null;
  }
};

// Transform text position from old to new content
const transformTextPosition = (oldText: string, newText: string, oldPosition: number): number | null => {
  try {
    // Simple transformation - try to find the closest position in the new text
    // This is a basic implementation - in production, you'd want more sophisticated diff-based transformation
    
    // If the position is beyond the old text length, clamp it
    const clampedOldPosition = Math.min(oldPosition, oldText.length);
    
    // If the new text is shorter, clamp the position to the new text length
    const newPosition = Math.min(clampedOldPosition, newText.length);
    
    // Try to find a better position by looking for context around the cursor
    const contextLength = 10;
    const contextStart = Math.max(0, clampedOldPosition - contextLength);
    const contextEnd = Math.min(oldText.length, clampedOldPosition + contextLength);
    const context = oldText.substring(contextStart, contextEnd);
    
    if (context.length > 0) {
      const contextIndex = newText.indexOf(context);
      if (contextIndex !== -1) {
        const relativePosition = clampedOldPosition - contextStart;
        const betterPosition = contextIndex + relativePosition;
        if (betterPosition >= 0 && betterPosition <= newText.length) {
          return betterPosition;
        }
      }
    }
    
    return newPosition;
  } catch (error) {
    console.error('❌ Error transforming text position:', error);
    return null;
  }
};

// Get Lexical position from text position
const getLexicalPositionFromTextPosition = (lexicalContent: string, textPosition: number): { key: string; offset: number } | null => {
  try {
    const editorState = JSON.parse(lexicalContent);
    let currentTextPosition = 0;
    let targetKey = '';
    let targetOffset = 0;
    
    const traverseNode = (node: any): boolean => {
      if (node.type === 'text') {
        const nodeText = node.text || '';
        const nodeEndPosition = currentTextPosition + nodeText.length;
        
        if (textPosition >= currentTextPosition && textPosition <= nodeEndPosition) {
          targetKey = node.key;
          targetOffset = textPosition - currentTextPosition;
          return true;
        }
        
        currentTextPosition += nodeText.length;
      } else if (node.type === 'linebreak') {
        if (textPosition === currentTextPosition) {
          // Handle position at linebreak
          targetKey = node.key;
          targetOffset = 0;
          return true;
        }
        currentTextPosition += 1;
      } else if (node.type === 'paragraph') {
        if (node.children) {
          for (const child of node.children) {
            if (traverseNode(child)) return true;
          }
        }
        
        // If position is at the end of paragraph, use the last text node
        if (textPosition === currentTextPosition && node.children && node.children.length > 0) {
          const lastChild = node.children[node.children.length - 1];
          if (lastChild.type === 'text') {
            targetKey = lastChild.key;
            targetOffset = (lastChild.text || '').length;
            return true;
          }
        }
        
        currentTextPosition += 1; // Add newline for paragraph
      } else if (node.children) {
        for (const child of node.children) {
          if (traverseNode(child)) return true;
        }
      }
      
      return false;
    };
    
    if (editorState.root && editorState.root.children) {
      for (const child of editorState.root.children) {
        if (traverseNode(child)) break;
      }
    }
    
    // If we didn't find a match, try to find the closest text node
    if (!targetKey && editorState.root && editorState.root.children) {
      const findLastTextNode = (node: any): string | null => {
        if (node.type === 'text') {
          return node.key;
        }
        if (node.children) {
          for (let i = node.children.length - 1; i >= 0; i--) {
            const result = findLastTextNode(node.children[i]);
            if (result) return result;
          }
        }
        return null;
      };
      
      for (let i = editorState.root.children.length - 1; i >= 0; i--) {
        const lastKey = findLastTextNode(editorState.root.children[i]);
        if (lastKey) {
          targetKey = lastKey;
          targetOffset = 0; // Default to start of node
          break;
        }
      }
    }
    
    return targetKey ? { key: targetKey, offset: targetOffset } : null;
  } catch (error) {
    console.error('❌ Error getting Lexical position from text position:', error);
    return null;
  }
};

export interface CollaborativeEditorProps {
  documentId: string;
  initialContent: string;
  onContentChange: (content: string, cursorPosition?: CursorPosition) => void;
  onSave?: (content: string) => void;
  onWebSocketClientReady?: (client: any) => void;
  onRemoteContentUpdate?: (updateFn: (content: string) => void) => void;
  currentUser: User;
  placeholder?: string;
  useSubmissionWebSocket?: boolean;
  className?: string;
  readOnly?: boolean;
  showToolbar?: boolean;
}

export const CollaborativeEditor: React.FC<CollaborativeEditorProps> = ({
  documentId,
  initialContent,
  onContentChange,
  onSave,
  onWebSocketClientReady,
  onRemoteContentUpdate,
  currentUser,
  placeholder = 'Start typing...',
  useSubmissionWebSocket = false,
  className = '',
  readOnly = false,
  showToolbar = true
}) => {
  // Create a unique browser session identifier for collaborative editing
  const browserSessionId = useMemo(() => {
    const stored = localStorage.getItem('collaborativeSessionId');
    if (stored) {
      return stored;
    }
    const newSessionId = `session_${Date.now()}_${Math.random().toString(36).substring(2, 15)}`;
    localStorage.setItem('collaborativeSessionId', newSessionId);
    console.log('🆔 Generated new browser session ID:', newSessionId);
    return newSessionId;
  }, []);
  
  // Create effective user ID that includes browser session for cursor tracking
  const effectiveUserId = useMemo(() => {
    const baseUserId = currentUser.id || currentUser.email;
    return `${baseUserId}_${browserSessionId}`;
  }, [currentUser.id, currentUser.email, browserSessionId]);
  console.log('🔧 CollaborativeEditor received props:', {
    documentId,
    initialContentLength: initialContent?.length,
    initialContentType: typeof initialContent,
    initialContentPreview: initialContent?.substring(0, 200),
    initialContentIsEmpty: !initialContent || initialContent.trim() === '',
    currentUser: currentUser?.name,
    placeholder,
    readOnly,
    showToolbar
  });

  const [users, setUsers] = useState<UserPresenceData[]>([]);
  const [connectionStatus, setConnectionStatus] = useState<'connecting' | 'connected' | 'disconnected' | 'error'>('disconnected');
  const [currentContent, setCurrentContent] = useState('');
  const [lastSavedContent, setLastSavedContent] = useState('');
  const [showPresencePanel, setShowPresencePanel] = useState(false);
  const [remoteCursors, setRemoteCursors] = useState<Map<string, CursorPosition>>(new Map());
  const [currentUserCursor, setCurrentUserCursor] = useState<CursorPosition | null>(null);
  const [typingUsers, setTypingUsers] = useState<Set<string>>(new Set());
  const [needsCursorRepositioning, setNeedsCursorRepositioning] = useState(false);
  const [webSocketClientReady, setWebSocketClientReady] = useState(false);
  
  const editorRef = useRef<LexicalEditor | null>(null);
  const contentChangedRef = useRef(false);
  const isInitializedRef = useRef(false);
  const webSocketClientRef = useRef<any>(null);
  const lastCursorPositionRef = useRef<CursorPosition | null>(null);
  const typingTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const isTypingRef = useRef(false);
  const lastContentUpdateTime = useRef<number>(0);
  const isApplyingRemoteUpdate = useRef<boolean>(false);
  const lastCursorRefreshRequestTime = useRef<number>(0);
  
  // Preserve cursors during real-time updates to prevent loss during state changes
  const preservedCursorsRef = useRef<Map<string, CursorPosition>>(new Map());
  
  // Keep preserved cursors ref in sync with state
  useEffect(() => {
    preservedCursorsRef.current = new Map(remoteCursors);
  }, [remoteCursors]);
  
  // Cursor repositioning function - memoized to prevent re-renders
  const triggerRepositioning = useCallback(() => {
    setNeedsCursorRepositioning(true);
    setTimeout(() => setNeedsCursorRepositioning(false), 100);
  }, []); // Empty dependency array to keep it stable

  // Callback when content is updated (for cursor repositioning)
  const handleContentUpdated = useCallback(() => {
    console.log('🔄 CollaborativeEditor: Content updated, forcing cursor repositioning');
    
    // Force multiple repositioning attempts
    triggerRepositioning();
    setTimeout(triggerRepositioning, 200);
    setTimeout(triggerRepositioning, 500);
    
    console.log('🔄 CollaborativeEditor: Scheduled cursor repositioning');
  }, [triggerRepositioning]); // Depends on stable triggerRepositioning
  
  // Remote content update function
  const applyRemoteContentUpdate = useCallback((content: string) => {
    console.log('🔄 CollaborativeEditor: Applying remote content update with cursor transformation:', content.length, 'chars');
    
    if (editorRef.current && content) {
      // Store current content and cursor positions before update
      const oldContent = editorRef.current.getEditorState().read(() => {
        return JSON.stringify(editorRef.current?.getEditorState());
      });
      
      // Save current user's cursor position before the update
      let currentUserCursorPosition: CursorPosition | null = null;
      try {
        // Wrap the entire cursor position saving in editor context
        if (editorRef.current) {
          editorRef.current.getEditorState().read(() => {
            const selection = $getSelection();
            if ($isRangeSelection(selection)) {
              const linePosition = getLexicalSelectionLinePosition(editorRef.current!);
              if (linePosition) {
                currentUserCursorPosition = {
                  userId: effectiveUserId,
                  userName: currentUser.name || currentUser.email,
                  userEmail: currentUser.email,
                  position: {
                    line: linePosition.line,
                    column: linePosition.column,
                    type: selection.isCollapsed() ? 'cursor' : 'selection',
                    anchor: {
                      line: linePosition.line,
                      column: linePosition.column
                    },
                    focus: {
                      line: linePosition.line,
                      column: linePosition.column
                    }
                  },
                  timestamp: new Date().toISOString()
                };
              }
            }
          });
        }
      } catch (error) {
        console.error('❌ Failed to save current user cursor position:', error);
      }
      
      const cursorsToTransform = new Map(preservedCursorsRef.current);
      
      console.log('📸 Captured cursors before update (from preserved ref):', {
        cursorCount: cursorsToTransform.size,
        oldContentLength: oldContent?.length || 0,
        newContentLength: content?.length || 0
      });
      
      try {
        // Set flag to prevent auto-save during remote update
        isApplyingRemoteUpdate.current = true;
        console.log('🚫 CollaborativeEditor: Setting remote update flag');
        
        // Clear remote cursors temporarily to prevent positioning with stale keys
        setRemoteCursors(new Map());
        
        // Apply content update
        if (isLexicalJson(content)) {
          console.log('📝 Applying Lexical content with full formatting...');
          
          // Parse and set the full Lexical editor state to preserve rich text formatting
          const editorState = editorRef.current.parseEditorState(content);
          editorRef.current.setEditorState(editorState);
          
          console.log('✅ CollaborativeEditor: Applied remote Lexical content with full formatting preserved');
        } else {
          // Handle plain text by updating within editor
          editorRef.current.update(() => {
            const root = $getRoot();
            root.clear();
            
            const lines = content.split('\n');
            for (const line of lines) {
              const paragraph = $createParagraphNode();
              if (line.trim()) {
                paragraph.append($createTextNode(line));
              }
              root.append(paragraph);
            }
            console.log('✅ CollaborativeEditor: Applied remote plain text content');
          });
        }
        
        // Transform cursor positions after content update
        console.log('🔄 Starting cursor transformation...');
        
        setTimeout(() => {
          const transformedCursors = new Map<string, CursorPosition>();
          
          cursorsToTransform.forEach((cursor, userId) => {
            const transformedCursor = transformCursorPosition(
              editorRef.current!,
              cursor,
              oldContent,
              content
            );
            
            if (transformedCursor) {
              transformedCursors.set(userId, transformedCursor);
              console.log('✅ Transformed cursor for user:', cursor.userName);
            } else {
              console.log('⚠️ Could not transform cursor for user:', cursor.userName);
            }
          });
          
          // Apply transformed cursors
          setRemoteCursors(transformedCursors);
          // Also update the preserved cursors ref to keep it in sync
          preservedCursorsRef.current = new Map(transformedCursors);
          console.log('✅ Applied transformed cursors:', {
            originalCount: cursorsToTransform.size,
            transformedCount: transformedCursors.size
          });
          
          // Restore current user's cursor position after content update
          if (currentUserCursorPosition && editorRef.current) {
            console.log('🔄 Restoring current user cursor position:', currentUserCursorPosition.position);
            try {
              editorRef.current.update(() => {
                const restored = setLexicalSelectionFromLinePosition(
                  editorRef.current!,
                  currentUserCursorPosition!.position.line,
                  currentUserCursorPosition!.position.column
                );
                if (restored) {
                  console.log('✅ Successfully restored current user cursor position');
                } else {
                  console.log('⚠️ Could not restore current user cursor position');
                }
              });
            } catch (error) {
              console.error('❌ Failed to restore cursor position:', error);
            }
          }
          
          // Trigger repositioning to ensure cursors are properly positioned
          setTimeout(() => {
            triggerRepositioning();
          }, 100);
          
        }, 200); // Wait for DOM to update
        
        // Also send current user's cursor position with new node keys
        if (webSocketClientRef.current) {
          setTimeout(() => {
            console.log('📍 Sending current user cursor position after content update');
            
            if (editorRef.current) {
              // Wrap cursor position logic in proper editor context
              editorRef.current.getEditorState().read(() => {
                const selection = $getSelection();
                if ($isRangeSelection(selection)) {
                  const linePosition = getLexicalSelectionLinePosition(editorRef.current!);
                  if (linePosition) {
                    const isCollapsed = selection.isCollapsed();
                    
                    const position: CursorPosition = {
                      userId: effectiveUserId,
                      userName: currentUser.name || currentUser.email,
                      userEmail: currentUser.email,
                      position: {
                        line: linePosition.line,
                        column: linePosition.column,
                        type: isCollapsed ? 'cursor' : 'selection',
                        anchor: {
                          line: linePosition.line,
                          column: linePosition.column
                        },
                        focus: {
                          line: linePosition.line,
                          column: linePosition.column
                        }
                      },
                      timestamp: new Date().toISOString()
                    };
                    
                    if (webSocketClientRef.current) {
                      try {
                        webSocketClientRef.current.send({
                          type: 'cursor_position',
                          data: position
                        });
                        
                        lastCursorPositionRef.current = position;
                        console.log('📡 Sent updated cursor position after content update');
                      } catch (error) {
                        console.error('❌ Failed to send cursor position after content update:', error);
                      }
                    }
                  }
                }
              });
            }
          }, 400);
        }
        
      } catch (error) {
        console.error('❌ CollaborativeEditor: Failed to apply remote content:', error);
      } finally {
        // Clear the flag after update is complete
        setTimeout(() => {
          isApplyingRemoteUpdate.current = false;
          console.log('✅ CollaborativeEditor: Cleared remote update flag');
        }, 500);
      }
    } else {
      console.log('⚠️ CollaborativeEditor: No editor ref available for content update');
    }
  }, [remoteCursors, currentUser.id, currentUser.email, currentUser.name, triggerRepositioning, effectiveUserId]);

  // Lightweight real-time content update that preserves cursors
  const applyRealTimeContentUpdate = useCallback((content: string) => {
    console.log('⚡ CollaborativeEditor: Applying real-time content update with cursor transformation:', content.length, 'chars');
    
    if (editorRef.current && isLexicalJson(content)) {
      // Store current content and cursor positions before update
      const oldContent = editorRef.current.getEditorState().read(() => {
        return JSON.stringify(editorRef.current?.getEditorState());
      });
      
      // Save current user's cursor position before the update
      let currentUserCursorPosition: CursorPosition | null = null;
      try {
        // Wrap the entire cursor position saving in editor context
        if (editorRef.current) {
          editorRef.current.getEditorState().read(() => {
            const selection = $getSelection();
            if ($isRangeSelection(selection)) {
              const linePosition = getLexicalSelectionLinePosition(editorRef.current!);
              if (linePosition) {
                currentUserCursorPosition = {
                  userId: effectiveUserId,
                  userName: currentUser.name || currentUser.email,
                  userEmail: currentUser.email,
                  position: {
                    line: linePosition.line,
                    column: linePosition.column,
                    type: selection.isCollapsed() ? 'cursor' : 'selection',
                    anchor: {
                      line: linePosition.line,
                      column: linePosition.column
                    },
                    focus: {
                      line: linePosition.line,
                      column: linePosition.column
                    }
                  },
                  timestamp: new Date().toISOString()
                };
              }
            }
          });
        }
      } catch (error) {
        console.error('❌ Failed to save current user cursor position (real-time):', error);
      }
      
      // IMPORTANT: Use preserved cursors ref to avoid losing cursors during state changes
      const cursorsToTransform = new Map(preservedCursorsRef.current);
      
      console.log('📸 Captured cursors for real-time update (from preserved ref):', {
        cursorCount: cursorsToTransform.size,
        oldContentLength: oldContent?.length || 0,
        newContentLength: content?.length || 0,
        cursorIds: Array.from(cursorsToTransform.keys())
      });
      
      try {
        // Set flag to prevent auto-save during remote update
        isApplyingRemoteUpdate.current = true;
        console.log('🚫 CollaborativeEditor: Setting remote update flag for real-time update');
        
        // Clear remote cursors temporarily to prevent positioning with stale keys
        setRemoteCursors(new Map());
        
        // For real-time updates, use setEditorState to preserve formatting
        const editorState = editorRef.current.parseEditorState(content);
        editorRef.current.setEditorState(editorState);
        
        console.log('✅ CollaborativeEditor: Applied real-time Lexical content, starting cursor transformation');
        
        // Transform cursor positions after real-time update
        setTimeout(() => {
          const transformedCursors = new Map<string, CursorPosition>();
          
          cursorsToTransform.forEach((cursor, userId) => {
            const transformedCursor = transformCursorPosition(
              editorRef.current!,
              cursor,
              oldContent,
              content
            );
            
            if (transformedCursor) {
              transformedCursors.set(userId, transformedCursor);
              console.log('✅ Transformed cursor for user (real-time):', cursor.userName);
            } else {
              console.log('⚠️ Could not transform cursor for user (real-time):', cursor.userName);
            }
          });
          
          // Apply transformed cursors
          setRemoteCursors(transformedCursors);
          // Also update the preserved cursors ref to keep it in sync
          preservedCursorsRef.current = new Map(transformedCursors);
          console.log('✅ Applied transformed cursors (real-time):', {
            originalCount: cursorsToTransform.size,
            transformedCount: transformedCursors.size
          });
          
          // Restore current user's cursor position after real-time update
          if (currentUserCursorPosition && editorRef.current) {
            console.log('🔄 Restoring current user cursor position (real-time):', currentUserCursorPosition.position);
            try {
              editorRef.current.update(() => {
                const restored = setLexicalSelectionFromLinePosition(
                  editorRef.current!,
                  currentUserCursorPosition!.position.line,
                  currentUserCursorPosition!.position.column
                );
                if (restored) {
                  console.log('✅ Successfully restored current user cursor position (real-time)');
                } else {
                  console.log('⚠️ Could not restore current user cursor position (real-time)');
                }
              });
            } catch (error) {
              console.error('❌ Failed to restore cursor position (real-time):', error);
            }
          }
          
          // Trigger repositioning to ensure cursors are properly positioned
          setTimeout(() => {
            triggerRepositioning();
          }, 50); // Shorter delay for real-time updates
          
        }, 100); // Shorter delay for real-time updates
        
        // Also send current user's cursor position to ensure it stays in sync
        if (webSocketClientRef.current) {
          setTimeout(() => {
            console.log('📍 Sending current user cursor position after real-time update');
            
            if (editorRef.current) {
              // Wrap cursor position logic in proper editor context
              editorRef.current.getEditorState().read(() => {
                const selection = $getSelection();
                if ($isRangeSelection(selection)) {
                  const linePosition = getLexicalSelectionLinePosition(editorRef.current!);
                  if (linePosition) {
                    const isCollapsed = selection.isCollapsed();
                    
                    const position: CursorPosition = {
                      userId: effectiveUserId,
                      userName: currentUser.name || currentUser.email,
                      userEmail: currentUser.email,
                      position: {
                        line: linePosition.line,
                        column: linePosition.column,
                        type: isCollapsed ? 'cursor' : 'selection',
                        anchor: {
                          line: linePosition.line,
                          column: linePosition.column
                        },
                        focus: {
                          line: linePosition.line,
                          column: linePosition.column
                        }
                      },
                      timestamp: new Date().toISOString()
                    };
                    
                    if (webSocketClientRef.current) {
                      try {
                        webSocketClientRef.current.send({
                          type: 'cursor_position',
                          data: position
                        });
                        
                        lastCursorPositionRef.current = position;
                        console.log('📡 Sent updated cursor position after real-time update');
                      } catch (error) {
                        console.error('❌ Failed to send cursor position after real-time update:', error);
                      }
                    }
                  }
                }
              });
            }
          }, 150);
        }
        
      } catch (error) {
        console.error('❌ CollaborativeEditor: Failed to apply real-time content:', error);
      } finally {
        // Clear the flag after a short delay
        setTimeout(() => {
          isApplyingRemoteUpdate.current = false;
          console.log('✅ CollaborativeEditor: Cleared remote update flag (real-time)');
        }, 200); // Shorter delay for real-time updates
      }
    } else {
      console.log('⚠️ CollaborativeEditor: Invalid content for real-time update');
    }
  }, [remoteCursors, currentUser.id, currentUser.email, currentUser.name, triggerRepositioning, effectiveUserId]);
  
  // Handle cursor updates - memoized to prevent re-renders
  const handleCursorUpdate = useCallback((position: CursorPosition) => {
    console.log('🎯 handleCursorUpdate called with position:', position);
    
    // Update current user's cursor position for display
    setCurrentUserCursor(position);
    
    if (webSocketClientRef.current) {
      console.log('🎯 Sending cursor position via WebSocket:', {
        hasWebSocketClient: !!webSocketClientRef.current,
        position: position,
        positionLine: position.position.line,
        positionColumn: position.position.column,
        userId: position.userId
      });
      
      // Send cursor position to other users
      try {
        webSocketClientRef.current.send({
          type: 'cursor_position',
          data: position
        });
        console.log('✅ Cursor position sent successfully');
      } catch (error) {
        console.error('❌ Failed to send cursor position:', error);
      }
    } else {
      console.log('❌ No WebSocket client available for cursor update');
    }
  }, []); // Empty dependency array to keep it stable
  
  // Track processed messages to prevent duplicates
  const processedMessagesRef = useRef<Set<string>>(new Set());
  
  // Handle remote cursor position updates
  const handleRemoteCursorUpdate = useCallback((message: WebSocketMessage) => {
    
    if (message.data && message.data.position) {
      const cursorPosition: CursorPosition = message.data;
      
      // Extract session ID from the effectiveUserId (format: baseUserId_sessionId)
      const sessionId = localStorage.getItem('sessionId') || 'unknown';
      const cursorSessionId = cursorPosition.userId.includes('_') ? 
                         cursorPosition.userId.split('_').pop() : 
                         null;
      
      // Extract base user ID from the effectiveUserId
      const baseUserId = cursorPosition.userId.includes('_') ? 
                        cursorPosition.userId.split('_')[0] : 
                        cursorPosition.userId;
      
      // Check if this is our own cursor by comparing both base user ID and session ID
      const isOwnCursor = (baseUserId === currentUser.id || baseUserId === currentUser.email) &&
                         cursorSessionId === sessionId;
      
      if (isOwnCursor) {
        console.log('🖱️ Ignoring own cursor (same user and session)');
        return;
      }
      
      // Check if we recently updated content - if so, briefly ignore cursor updates
      // This prevents positioning cursors with stale node keys after content updates
      const now = Date.now();
      const timeSinceUpdate = now - lastContentUpdateTime.current;
      
      // Also check the timestamp of the cursor position itself
      const cursorTimestamp = new Date(cursorPosition.timestamp).getTime();
      const timeSinceCursorUpdate = now - cursorTimestamp;
      
      // Ignore cursor updates if they're much older than 15 seconds or very recent content update
      if (timeSinceUpdate < 150 || timeSinceCursorUpdate > 15000) {
        if (timeSinceUpdate < 150) {
          console.log('🚫 Briefly ignoring cursor update due to recent content update');
        }
        return;
      }
      
      setRemoteCursors(prev => {
        const newCursors = new Map(prev);
        newCursors.set(cursorPosition.userId, cursorPosition);
        // Also update the preserved cursors ref to keep it in sync
        preservedCursorsRef.current.set(cursorPosition.userId, cursorPosition);
        console.log('🖱️ Updated cursor for:', cursorPosition.userName, '(total:', newCursors.size, ')');
        return newCursors;
      });
    }
  }, [currentUser.id, currentUser.email]);
  
  // Handle typing indicators
  const handleTypingStart = useCallback((message: any) => {
    if (message.data && message.userId !== currentUser.id && message.userId !== currentUser.email) {
      setTypingUsers(prev => {
        const newTypingUsers = new Set(prev);
        newTypingUsers.add(message.userId);
        return newTypingUsers;
      });
    }
  }, [currentUser.id, currentUser.email]);
  
  const handleTypingStop = useCallback((message: any) => {
    if (message.data && message.userId !== currentUser.id && message.userId !== currentUser.email) {
      setTypingUsers(prev => {
        const newTypingUsers = new Set(prev);
        newTypingUsers.delete(message.userId);
        return newTypingUsers;
      });
    }
  }, [currentUser.id, currentUser.email]);
  
  // Remove excessive state logging
  
  // Create stable editor config with initial content
  const editorConfig = useMemo(() => ({
    namespace: `collaborative-editor-${documentId}`,
    theme: {
      paragraph: 'collaborative-editor-paragraph',
      text: {
        bold: 'collaborative-editor-bold',
        italic: 'collaborative-editor-italic',
        underline: 'collaborative-editor-underline',
      },
    },
    nodes: [
      HeadingNode,
      QuoteNode,
      ListItemNode,
      ListNode,
      CodeHighlightNode,
      CodeNode,
      TableNode,
      TableCellNode,
      TableRowNode,
      LinkNode,
    ],
    onError: (error: Error) => {
      console.error('Lexical editor error:', error);
    },
    editorState: null, // Let the editor manage its own state
  }), [documentId]);
  
  // WebSocket connection management
  const webSocketManagerRef = useRef<WebSocketManager | null>(null);
  
  useEffect(() => {
    if (!useSubmissionWebSocket) {
      setConnectionStatus('disconnected');
      console.log('🚫 WebSocket disabled for this editor');
      return;
    }
    
    // Show connecting status immediately when starting to connect
    setConnectionStatus('connecting');
    console.log('🔌 Starting WebSocket connection process...');
    
    // Initialize WebSocket manager
    if (!webSocketManagerRef.current) {
      webSocketManagerRef.current = new WebSocketManager();
      console.log('✅ WebSocketManager initialized');
    }
    
    const connectWebSocket = async () => {
      try {
        setConnectionStatus('connecting');
        console.log('🔄 Attempting WebSocket connection...');
        console.log('📋 Connection parameters:', {
          documentId,
          userId: currentUser.id || currentUser.email,
          userName: currentUser.name || currentUser.email,
          userEmail: currentUser.email,
          useSubmissionWebSocket
        });
        
        if (useSubmissionWebSocket) {
          console.log('📡 Connecting to submission WebSocket...');
          // Connect to submission WebSocket
          const client = await webSocketManagerRef.current!.connectToSubmission(
            documentId,
            currentUser.id || currentUser.email,
            currentUser.name || currentUser.email,
            currentUser.email
          );
          
          console.log('✅ Submission WebSocket client created');
          
          // Add event handlers without excessive logging
          
          client.on('connected', () => {
            setConnectionStatus('connected');
            console.log('✅ WebSocket connected successfully');
          });
          
          client.on('cursor_position', handleRemoteCursorUpdate);
          client.on('typing_start', handleTypingStart);
          client.on('typing_stop', handleTypingStop);
          
          client.on('request_cursor_refresh', (message: any) => {
            console.log('🔄 CURSOR_REFRESH_REQUEST RECEIVED:', message);
            console.log('🔄 Current user info:', {
              currentUserId: currentUser.id,
              currentUserEmail: currentUser.email,
              effectiveUserId: effectiveUserId,
              targetUserId: message.targetUserId
            });
            
            // Only respond if this request is targeted at the current user
            if (message.targetUserId === effectiveUserId) {
              console.log('✅ Cursor refresh request is targeted at current user - responding');
              
              // Rate limit responses to prevent spam
              const now = Date.now();
              if (now - lastCursorRefreshRequestTime.current > 1000) { // At most once per second
                lastCursorRefreshRequestTime.current = now;
                
                // Send current cursor position if we have one
                if (editorRef.current && lastCursorPositionRef.current) {
                  console.log('📡 Sending current cursor position in response to refresh request');
                  setTimeout(() => {
                    // Re-send the last known cursor position
                    client.send({
                      type: 'cursor_position',
                      data: lastCursorPositionRef.current
                    });
                  }, 100); // Small delay to ensure the request is processed
                } else {
                  console.log('⚠️ No current cursor position to send in response to refresh request');
                  // Try to get current cursor position from editor
                  if (editorRef.current) {
                    editorRef.current.getEditorState().read(() => {
                      const selection = $getSelection();
                      if ($isRangeSelection(selection)) {
                        const anchorNode = selection.anchor.getNode();
                        const focusNode = selection.focus.getNode();
                        
                        const linePosition = editorRef.current ? getLexicalSelectionLinePosition(editorRef.current) : null;
                        if (linePosition) {
                          const position: CursorPosition = {
                            userId: effectiveUserId,
                            userName: currentUser.name || currentUser.email,
                            userEmail: currentUser.email,
                            position: {
                              line: linePosition.line,
                              column: linePosition.column,
                              type: selection.isCollapsed() ? 'cursor' : 'selection',
                              anchor: selection.isCollapsed() ? undefined : {
                                line: linePosition.line,
                                column: linePosition.column
                              },
                              focus: selection.isCollapsed() ? undefined : {
                                line: linePosition.line,
                                column: linePosition.column
                              }
                            },
                            timestamp: new Date().toISOString()
                          };
                        
                          console.log('📡 Sending fresh cursor position in response to refresh request:', position);
                          client.send({
                            type: 'cursor_position',
                            data: position
                          });
                        } else {
                          console.log('⚠️ No valid selection available for cursor refresh response');
                        }
                      } else {
                        console.log('⚠️ No valid selection available for cursor refresh response');
                      }
                    });
                  }
                }
              } else {
                console.log('🚫 Skipping cursor refresh response due to rate limit');
              }
            } else {
              console.log('🚫 Ignoring cursor refresh request - not targeted at current user:', {
                targetUserId: message.targetUserId,
                currentEffectiveUserId: effectiveUserId
              });
            }
          });
          
          client.on('user_joined', (message) => {
            console.log('👤 User joined:', message.userName);
            setUsers(prev => {
              const existingUser = prev.find(u => u.userId === message.userId);
              if (!existingUser) {
                return [...prev, {
                  userId: message.userId,
                  userName: message.userName,
                  userEmail: message.userEmail,
                  status: 'online' as const,
                  lastSeen: message.timestamp,
                  currentActivity: 'viewing' as const
                }];
              }
              return prev;
            });
          });
          
          client.on('user_left', (message) => {
            console.log('👤 User left:', message.userName);
            setUsers(prev => prev.filter(u => u.userId !== message.userId));
          });
          
          client.on('room_state', (message) => {
            console.log('📊 Room state update:', message);
            if (message.users) {
              setUsers(message.users.map(user => ({
                userId: user.userId,
                userName: user.userName,
                userEmail: user.userEmail,
                status: 'online' as const,
                lastSeen: user.connectedAt,
                currentActivity: 'viewing' as const
              })));
            }
          });
          
          client.on('content_updated', (message) => {
            console.log('📝 Content updated by remote user:', message);
            // Don't update our own content to avoid infinite loops
            if (message.userId !== (currentUser.id || currentUser.email)) {
              console.log('📝 Updating content from remote user');
              // Note: We might want to implement operational transforms here
              // For now, just log that we received an update
            }
          });

          client.on('realtime_content_update', (message) => {
            console.log('⚡ Real-time content update by remote user:', message);
            // Don't update our own content to avoid infinite loops
            if (message.userId !== (currentUser.id || currentUser.email)) {
              console.log('⚡ Applying real-time content update from remote user:', message.userId);
              
              if (message.data && message.data.lexicalContent) {
                const { lexicalContent, cursorPosition } = message.data;
                
                console.log('⚡ CollaborativeEditor: Processing real-time update:', {
                  lexicalContentLength: lexicalContent?.length,
                  hasCursorPosition: !!cursorPosition,
                  isValidLexical: isLexicalJson(lexicalContent)
                });
                
                // Validate the content before applying
                if (isLexicalJson(lexicalContent)) {
                  console.log('⚡ CollaborativeEditor: Applying real-time content update (lightweight)');
                  applyRealTimeContentUpdate(lexicalContent);
                } else {
                  console.error('❌ CollaborativeEditor: Invalid Lexical content in real-time update');
                }
              } else {
                console.error('❌ CollaborativeEditor: No lexical content in real-time update');
              }
            }
          });
          
          webSocketClientRef.current = client;
          setConnectionStatus('connected');
          setWebSocketClientReady(true);
          console.log('🔌 WebSocket client ready, enabling cursor tracking');
          
          // Notify parent that WebSocket client is ready
          if (onWebSocketClientReady) {
            onWebSocketClientReady(client);
          }
          
          // Register remote content update functions
          if (onRemoteContentUpdate) {
            // Register the full update function for regular updates using closure
            onRemoteContentUpdate((content: string) => {
              applyRemoteContentUpdate(content);
            });
            
            // Also store the real-time function for TrackedChangesEditor using closure
            client.applyRealTimeUpdate = (content: string) => {
              applyRealTimeContentUpdate(content);
            };
          }
          
          console.log('✅ Submission WebSocket fully configured');
          
        } else {
          console.log('📡 Connecting to document WebSocket...');
          // Connect to document WebSocket
          const client = await webSocketManagerRef.current!.connectToDocument(
            documentId,
            currentUser.id || currentUser.email,
            currentUser.name || currentUser.email,
            currentUser.email
          );
          
          console.log('✅ Document WebSocket client created');
          
          client.on('connected', () => {
            setConnectionStatus('connected');
            console.log('✅ Document WebSocket connected successfully');
          });
          
          client.on('cursor_position', (message: WebSocketMessage) => {
            handleRemoteCursorUpdate(message);
          });
          client.on('typing_start', (message: any) => {
            handleTypingStart(message);
          });
          client.on('typing_stop', (message: any) => {
            handleTypingStop(message);
          });
          
          client.on('request_cursor_refresh', (message: any) => {
            console.log('🔄 CURSOR_REFRESH_REQUEST RECEIVED (document):', message);
            console.log('🔄 Current user info (document):', {
              currentUserId: currentUser.id,
              currentUserEmail: currentUser.email,
              effectiveUserId: effectiveUserId,
              targetUserId: message.targetUserId
            });
            
            // Only respond if this request is targeted at the current user
            if (message.targetUserId === effectiveUserId) {
              console.log('✅ Cursor refresh request is targeted at current user - responding (document)');
              
              // Rate limit responses to prevent spam
              const now = Date.now();
              if (now - lastCursorRefreshRequestTime.current > 1000) { // At most once per second
                lastCursorRefreshRequestTime.current = now;
                
                // Send current cursor position if we have one
                if (editorRef.current && lastCursorPositionRef.current) {
                  console.log('📡 Sending current cursor position in response to refresh request (document)');
                  setTimeout(() => {
                    // Re-send the last known cursor position
                    client.send({
                      type: 'cursor_position',
                      data: lastCursorPositionRef.current
                    });
                  }, 100); // Small delay to ensure the request is processed
                } else {
                  console.log('⚠️ No current cursor position to send in response to refresh request (document)');
                  // Try to get current cursor position from editor
                  if (editorRef.current) {
                    editorRef.current.getEditorState().read(() => {
                      const selection = $getSelection();
                      if ($isRangeSelection(selection)) {
                        const anchorNode = selection.anchor.getNode();
                        const focusNode = selection.focus.getNode();
                        
                        const linePosition = editorRef.current ? getLexicalSelectionLinePosition(editorRef.current) : null;
                        if (linePosition) {
                          const position: CursorPosition = {
                            userId: effectiveUserId,
                            userName: currentUser.name || currentUser.email,
                            userEmail: currentUser.email,
                            position: {
                              line: linePosition.line,
                              column: linePosition.column,
                              type: selection.isCollapsed() ? 'cursor' : 'selection',
                              anchor: selection.isCollapsed() ? undefined : {
                                line: linePosition.line,
                                column: linePosition.column
                              },
                              focus: selection.isCollapsed() ? undefined : {
                                line: linePosition.line,
                                column: linePosition.column
                              }
                            },
                            timestamp: new Date().toISOString()
                          };
                        
                          console.log('📡 Sending fresh cursor position in response to refresh request (document):', position);
                          client.send({
                            type: 'cursor_position',
                            data: position
                          });
                        } else {
                          console.log('⚠️ No valid selection available for cursor refresh response (document)');
                        }
                      } else {
                        console.log('⚠️ No valid selection available for cursor refresh response (document)');
                      }
                    });
                  }
                }
              } else {
                console.log('🚫 Skipping cursor refresh response due to rate limit (document)');
              }
            } else {
              console.log('🚫 Ignoring cursor refresh request - not targeted at current user (document):', {
                targetUserId: message.targetUserId,
                currentEffectiveUserId: effectiveUserId
              });
            }
          });
          
          client.on('error', () => {
            setConnectionStatus('error');
            console.error('❌ Document WebSocket connection error');
          });
          
          webSocketClientRef.current = client;
          setConnectionStatus('connected');
          setWebSocketClientReady(true);
          console.log('🔌 WebSocket client ready, enabling cursor tracking');
          
          // Notify parent that WebSocket client is ready
          if (onWebSocketClientReady) {
            onWebSocketClientReady(client);
          }
          
          // Register remote content update functions
          if (onRemoteContentUpdate) {
            // Register the full update function for regular updates using closure
            onRemoteContentUpdate((content: string) => {
              applyRemoteContentUpdate(content);
            });
            
            // Also store the real-time function for TrackedChangesEditor using closure
            client.applyRealTimeUpdate = (content: string) => {
              applyRealTimeContentUpdate(content);
            };
          }
          
          console.log('✅ Document WebSocket fully configured');
        }
      } catch (error) {
        console.error('❌ Failed to connect WebSocket:', error);
        setConnectionStatus('error');
        setWebSocketClientReady(false);
        webSocketClientRef.current = null;
      }
    };
    
    connectWebSocket();
    
    return () => {
      // Cleanup WebSocket connection
      console.log('🧹 Cleaning up WebSocket connection...');
      setWebSocketClientReady(false);
      webSocketClientRef.current = null;
      if (webSocketManagerRef.current) {
        if (useSubmissionWebSocket) {
          webSocketManagerRef.current.disconnectFromSubmission(documentId, currentUser.id || currentUser.email);
        } else {
          webSocketManagerRef.current.disconnectFromDocument(documentId, currentUser.id || currentUser.email);
        }
      }
      console.log('✅ WebSocket cleanup completed');
    };
  }, [documentId, currentUser.id, currentUser.email, currentUser.name, useSubmissionWebSocket]); // Removed callback dependencies to prevent re-render loops
  
  // Handle content changes
  const handleEditorChange = useCallback((editorState: EditorState) => {
    editorState.read(() => {
      const root = $getRoot();
      const textContent = root.getTextContent();
      
      console.log('📝 Editor content changed:', textContent.length, 'chars');
      
      // Get the full JSON representation for rich text
      const jsonContent = JSON.stringify(editorState);
      
      // Only update if content actually changed
      if (jsonContent !== currentContent) {
        console.log('🔄 Content changed, updating state');
        console.log('📊 Content comparison:', {
          oldContentLength: currentContent?.length || 0,
          newContentLength: jsonContent?.length || 0,
          textContentLength: textContent.length,
          isRemoteUpdate: isApplyingRemoteUpdate.current
        });
        
        setCurrentContent(jsonContent);
        contentChangedRef.current = true;
        
        // Get cursor position information before notifying parent
        let cursorPosition: CursorPosition | undefined;
        // Wrap cursor position logic in proper editor context
        if (editorRef.current) {
          editorRef.current.getEditorState().read(() => {
            const selection = $getSelection();
            if ($isRangeSelection(selection)) {
              const anchorNode = selection.anchor.getNode();
              const focusNode = selection.focus.getNode();
              
              const linePosition = editorRef.current ? getLexicalSelectionLinePosition(editorRef.current) : null;
              if (linePosition) {
                cursorPosition = {
                  userId: effectiveUserId,
                  userName: currentUser.name || currentUser.email,
                  userEmail: currentUser.email,
                  position: {
                    line: linePosition.line,
                    column: linePosition.column,
                    type: selection.isCollapsed() ? 'cursor' : 'selection',
                    anchor: selection.isCollapsed() ? undefined : {
                      line: linePosition.line,
                      column: linePosition.column
                    },
                    focus: selection.isCollapsed() ? undefined : {
                      line: linePosition.line,
                      column: linePosition.column
                    }
                  },
                  timestamp: new Date().toISOString()
                };
              }
            }
          });
        }
        
        // Only notify parent component if this is NOT a remote update
        // This prevents auto-save from triggering when remote content is applied
        if (!isApplyingRemoteUpdate.current) {
          console.log('📤 Notifying parent component of content change (local edit) with cursor position:', {
            hasCursorPosition: !!cursorPosition,
            cursorType: cursorPosition?.position.type
          });
          onContentChange(jsonContent, cursorPosition);
        } else {
          console.log('🚫 Skipping parent notification (remote update)');
        }
        
        // After content change, send fresh cursor position to other users
        // This ensures that after any content update, other users get updated cursor positions
        if (webSocketClientRef.current && cursorPosition) {
          console.log('📍 Sending fresh cursor position after content change');
          
          // Send immediately with fresh node keys
          setTimeout(() => {
            console.log('📡 Sending immediate fresh cursor position with new line/column:', {
              line: cursorPosition!.position.line,
              column: cursorPosition!.position.column
            });
            
            if (webSocketClientRef.current) {
              try {
                webSocketClientRef.current.send({
                  type: 'cursor_position',
                  data: cursorPosition
                });
              } catch (error) {
                console.error('❌ Failed to send immediate cursor position:', error);
              }
            } else {
              console.log('⚠️ Cannot send cursor position - WebSocket client not available');
            }
          }, 100); // Small delay to ensure content processing is complete
        }
        
        // Notify other users of content changes via WebSocket
        if (webSocketClientRef.current) {
          try {
            console.log('📤 Sending content update to WebSocket...');
            webSocketClientRef.current.send({
              type: 'content_updated',
              documentId: documentId,
              data: {
                content: jsonContent,
                timestamp: new Date().toISOString()
              }
            });
            console.log('✅ Content update sent');
            
            // Handle typing indicators
            if (!isTypingRef.current) {
              isTypingRef.current = true;
              console.log('⌨️ Sending typing_start indicator...');
              webSocketClientRef.current.send({
                type: 'typing_start',
                documentId: documentId,
                data: {
                  userId: currentUser.id || currentUser.email,
                  userName: currentUser.name || currentUser.email,
                  timestamp: new Date().toISOString()
                }
              });
              console.log('✅ Typing start sent');
            }
          } catch (error) {
            console.error('❌ Failed to send content update or typing indicator:', error);
          }
          
          // Clear previous timeout
          if (typingTimeoutRef.current) {
            clearTimeout(typingTimeoutRef.current);
          }
          
          // Set new timeout to stop typing indicator
          typingTimeoutRef.current = setTimeout(() => {
            if (isTypingRef.current) {
              isTypingRef.current = false;
              console.log('⌨️ Sending typing_stop indicator...');
              webSocketClientRef.current?.send({
                type: 'typing_stop',
                documentId: documentId,
                data: {
                  userId: currentUser.id || currentUser.email,
                  userName: currentUser.name || currentUser.email,
                  timestamp: new Date().toISOString()
                }
              });
              console.log('✅ Typing stop sent');
            }
          }, 2000); // Stop typing indicator after 2 seconds of inactivity
        } else {
          console.log('❌ No WebSocket client available for content update');
        }
      } else {
        console.log('📝 Content unchanged, skipping update');
      }
    });
  }, [currentContent, onContentChange, documentId, currentUser.id, currentUser.email, currentUser.name, effectiveUserId]);
  
  // Handle save - memoized to prevent re-renders
  const handleSave = useCallback(() => {
    console.log('💾 Save button clicked');
    
    if (onSave) {
      console.log('📤 Calling onSave with content:', currentContent);
      onSave(currentContent);
      setLastSavedContent(currentContent);
      contentChangedRef.current = false;
    }
  }, [onSave, currentContent]); // Depends on onSave prop and currentContent state
  
  // Initialize editor content when it becomes available
  useEffect(() => {
    console.log('🔧 Editor initialization effect triggered:', {
      hasEditorRef: !!editorRef.current,
      hasInitialContent: !!initialContent,
      initialContentLength: initialContent?.length,
      isInitialized: isInitializedRef.current,
      initialContentPreview: initialContent?.substring(0, 100)
    });
    
    if (editorRef.current && initialContent && !isInitializedRef.current) {
      console.log('🔄 Initializing editor with content:', initialContent.length, 'chars');
      
      // Set flag to prevent re-initialization
      isInitializedRef.current = true;
      
      const editor = editorRef.current;
      
      // Check if the initialContent is a Lexical JSON state
      if (isLexicalJson(initialContent)) {
        try {
          console.log('🔄 Setting Lexical JSON state');
          const editorState = editor.parseEditorState(initialContent);
          editor.setEditorState(editorState);
          console.log('🔄 Successfully set editor state');
          
          // Update current content state with JSON representation
          setCurrentContent(initialContent);
          setLastSavedContent(initialContent);
          return;
        } catch (e) {
          console.error('Error parsing Lexical state:', e);
        }
      }
      
      // Check if content contains HTML or rich text formatting
      // Only treat as HTML if it starts with HTML tags, not if it just contains them
      const isHtml = typeof initialContent === 'string' && 
                     initialContent.trim().startsWith('<') && 
                     !isLexicalJson(initialContent);
      
      if (isHtml) {
        console.log('🔄 Processing HTML/rich text content');
        
        // For HTML content, use the browser's parsing to preserve formatting
        editor.update(() => {
          const root = $getRoot();
          root.clear();
          
          // Create a temporary element to parse the HTML
          const tempDiv = document.createElement('div');
          tempDiv.innerHTML = initialContent;
          
                     // Convert HTML structure to Lexical nodes
           const processHtmlNode = (htmlNode: Node, currentParagraph?: any): any => {
             if (htmlNode.nodeType === Node.TEXT_NODE) {
               const text = htmlNode.textContent || '';
               if (text.trim()) {
                 const textNode = $createTextNode(text);
                 if (currentParagraph) {
                   currentParagraph.append(textNode);
                   return currentParagraph;
                 } else {
                   const paragraph = $createParagraphNode();
                   paragraph.append(textNode);
                   root.append(paragraph);
                   return paragraph;
                 }
               }
             } else if (htmlNode.nodeType === Node.ELEMENT_NODE) {
               const element = htmlNode as HTMLElement;
               const tagName = element.tagName.toLowerCase();
               
               if (tagName === 'p' || tagName === 'div') {
                 const paragraph = $createParagraphNode();
                 
                 // Process child nodes within this paragraph
                 Array.from(element.childNodes).forEach(child => {
                   processHtmlNode(child, paragraph);
                 });
                 
                 // Only add paragraph if it has content
                 if (paragraph.getTextContent().trim()) {
                   root.append(paragraph);
                 }
                 return paragraph;
               } else if (tagName === 'br') {
                 const paragraph = $createParagraphNode();
                 root.append(paragraph);
                 return paragraph;
               } else if (tagName === 'strong' || tagName === 'b') {
                 // Handle bold text
                 const text = element.textContent || '';
                 if (text.trim()) {
                   const textNode = $createTextNode(text);
                   // Note: In a full implementation, you'd set formatting here
                   if (currentParagraph) {
                     currentParagraph.append(textNode);
                     return currentParagraph;
                   } else {
                     const paragraph = $createParagraphNode();
                     paragraph.append(textNode);
                     root.append(paragraph);
                     return paragraph;
                   }
                 }
               } else if (tagName === 'em' || tagName === 'i') {
                 // Handle italic text
                 const text = element.textContent || '';
                 if (text.trim()) {
                   const textNode = $createTextNode(text);
                   // Note: In a full implementation, you'd set formatting here
                   if (currentParagraph) {
                     currentParagraph.append(textNode);
                     return currentParagraph;
                   } else {
                     const paragraph = $createParagraphNode();
                     paragraph.append(textNode);
                     root.append(paragraph);
                     return paragraph;
                   }
                 }
               } else {
                 // For other elements, extract text content and process children
                 Array.from(element.childNodes).forEach(child => {
                   processHtmlNode(child, currentParagraph);
                 });
                 
                 // If no children processed and has text, create a text node
                 if (element.childNodes.length === 0) {
                   const text = element.textContent || '';
                   if (text.trim()) {
                     const textNode = $createTextNode(text);
                     if (currentParagraph) {
                       currentParagraph.append(textNode);
                       return currentParagraph;
                     } else {
                       const paragraph = $createParagraphNode();
                       paragraph.append(textNode);
                       root.append(paragraph);
                       return paragraph;
                     }
                   }
                 }
               }
             }
             return currentParagraph;
           };
          
          // Process all child nodes
          Array.from(tempDiv.childNodes).forEach(processHtmlNode);
          
          // If no content was added, create a single paragraph with the raw content
          if (root.getChildren().length === 0) {
            const paragraph = $createParagraphNode();
            const textNode = $createTextNode(initialContent);
            paragraph.append(textNode);
            root.append(paragraph);
          }
          
          console.log('🔄 Added HTML content to editor');
        });
      } else {
        // For plain text content, create a proper editor state
        editor.update(() => {
          const root = $getRoot();
          root.clear();
          
          console.log('🔄 Editor update callback started, root cleared');
          
          if (initialContent.trim()) {
            console.log('🔄 Processing plain text content:', {
              contentType: typeof initialContent,
              contentLength: initialContent.length,
              contentPreview: initialContent.substring(0, 100)
            });
            
            // Split by line breaks and create paragraphs
            const lines = initialContent.split('\n');
            
            lines.forEach(line => {
              const paragraph = $createParagraphNode();
              if (line.trim()) {
                const textNode = $createTextNode(line);
                paragraph.append(textNode);
              }
              root.append(paragraph);
            });
            
            console.log('🔄 Added plain text content to editor');
          } else {
            console.log('🔄 Initial content is empty, no content to load');
          }
        });
      }
      
      // Update current content state with JSON representation after content is set
      setTimeout(() => {
        const jsonContent = JSON.stringify(editor.getEditorState());
        setCurrentContent(jsonContent);
        setLastSavedContent(jsonContent);
        console.log('🔄 Updated content state with processed content');
      }, 100);
    } else {
      console.log('🔧 Editor initialization skipped:', {
        hasEditorRef: !!editorRef.current,
        hasInitialContent: !!initialContent,
        isInitialized: isInitializedRef.current
      });
    }
  }, [initialContent]); // Removed editorRef.current dependency to prevent re-initialization loops
  
  // Reset initialization flag when initialContent changes
  useEffect(() => {
    isInitializedRef.current = false;
    // Also reset the saved content tracking when initialContent changes
    setLastSavedContent('');
  }, [initialContent]);
  
  // Connection status indicator
  const getConnectionStatusIcon = () => {
    switch (connectionStatus) {
      case 'connected':
        return '🟢';
      case 'connecting':
        return '🟡';
      case 'disconnected':
        return '📝';
      case 'error':
        return '🔴';
      default:
        return '⚪';
    }
  };
  
  const getConnectionStatusText = () => {
    switch (connectionStatus) {
      case 'connected':
        return 'Connected';
      case 'connecting':
        return 'Connecting...';
      case 'disconnected':
        return 'Working offline';
      case 'error':
        return 'Connection error';
      default:
        return 'Unknown';
    }
  };
  
  // Remove the separate save logic since TrackedChangesEditor handles all saving via auto-save
  // const hasUnsavedChanges = currentContent !== lastSavedContent;
  
  return (
    <div className={`collaborative-editor ${className}`}>
      {/* Header with user presence and connection status */}
      <div className="collaborative-editor-header">
        <div className="editor-info">
          <span className="connection-status">
            {getConnectionStatusIcon()} {getConnectionStatusText()}
          </span>
          {/* Removed unsaved changes indicator - handled by TrackedChangesEditor auto-save */}
          {/* Typing indicators */}
          {typingUsers.size > 0 && (
            <div className="typing-indicators">
              <span className="typing-text">
                {Array.from(typingUsers).slice(0, 3).map(userId => 
                  users.find(u => u.userId === userId)?.userName || userId
                ).join(', ')} 
                {typingUsers.size > 3 && ` and ${typingUsers.size - 3} others`}
                {typingUsers.size === 1 ? ' is' : ' are'} typing
              </span>
              <div className="typing-dots">
                <div className="dot"></div>
                <div className="dot"></div>
                <div className="dot"></div>
              </div>
            </div>
          )}
        </div>
        
        <div className="editor-actions">
          <UserPresence 
            users={users}
            currentUser={currentUser}
            compact={true}
            onUserClick={() => setShowPresencePanel(!showPresencePanel)}
          />
          
          {/* Removed Save Locally button - TrackedChangesEditor handles all saving via auto-save */}
        </div>
      </div>
      
      {/* Expandable user presence panel */}
      {showPresencePanel && (
        <div className="presence-panel">
          <UserPresence 
            users={users}
            currentUser={currentUser}
            compact={false}
          />
        </div>
      )}
      
      {/* Lexical Editor */}
      <LexicalComposer initialConfig={editorConfig}>
        <div className="collaborative-editor-container">
          {showToolbar && (
            <div className="collaborative-toolbar-container">
              <ToolbarPlugin />
            </div>
          )}
          <div className="collaborative-input-container">
            <div className="collaborative-editor-wrapper">
              <RichTextPlugin
                contentEditable={<ContentEditable className="collaborative-editor-input" />}
                placeholder={<div className="collaborative-editor-placeholder">{placeholder}</div>}
                ErrorBoundary={LexicalErrorBoundary}
              />
              <OnChangePlugin onChange={handleEditorChange} />
              <HistoryPlugin />
              <ListPlugin />
              <LinkPlugin />
              <EditorRefPlugin editorRef={editorRef} />
              {/* Always render CursorTrackingPlugin but let it handle WebSocket client internally */}
              <CursorTrackingPlugin 
                webSocketClient={webSocketClientRef.current}
                currentUser={currentUser}
                documentId={documentId}
                onCursorUpdate={handleCursorUpdate}
                effectiveUserId={effectiveUserId}
              />
              <RemoteCursorPlugin
                remoteCursors={remoteCursors}
                currentUserCursor={currentUserCursor}
                currentUserId={currentUser.id || currentUser.email}
                needsRepositioning={needsCursorRepositioning}
                webSocketClient={webSocketClientRef.current}
              />
            </div>
          </div>
        </div>
      </LexicalComposer>
      
      {/* Connection status and user presence */}
      <div className="collaborative-editor-status">
        <div className="connection-status">
          <span className={`status-indicator ${connectionStatus}`}>
            {getConnectionStatusIcon()}
          </span>
          <span className="status-text">{getConnectionStatusText()}</span>
        </div>
        
        {users.length > 0 && (
          <div className="user-presence">
            <button
              className="presence-toggle"
              onClick={() => setShowPresencePanel(!showPresencePanel)}
            >
              👥 {users.length} {users.length === 1 ? 'user' : 'users'} online
            </button>
            {showPresencePanel && (
              <UserPresence 
                users={users} 
                currentUser={currentUser}
              />
            )}
          </div>
        )}
      </div>
      
      {/* Typing indicators */}
      {typingUsers.size > 0 && (
        <div className="typing-indicators">
          {Array.from(typingUsers).map(userId => (
            <div key={userId} className="typing-indicator">
              <span className="typing-user">{userId}</span>
              <span className="typing-dots">
                <span>•</span><span>•</span><span>•</span>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}; 