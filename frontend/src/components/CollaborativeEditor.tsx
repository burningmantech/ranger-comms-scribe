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

// Remote cursor overlay plugin
const RemoteCursorPlugin: React.FC<{
  remoteCursors: Map<string, CursorPosition>;
  currentUserId: string;
  needsRepositioning?: boolean;
}> = ({ remoteCursors, currentUserId, needsRepositioning }) => {
  const [editor] = useLexicalComposerContext();
  const cursorsRef = useRef<Map<string, HTMLElement>>(new Map());
  const overlayRef = useRef<HTMLElement | null>(null);
  
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
    
    // Add/update cursors
    remoteCursors.forEach((cursor, userId) => {
      if (userId === currentUserId) return; // Skip own cursor
      
      console.log('🎯 RemoteCursorPlugin: Processing cursor for user:', userId, cursor);
      
      // Get or create cursor element
      let cursorElement = cursorsRef.current.get(userId);
      if (!cursorElement) {
        cursorElement = createCursorElement(cursor);
        overlay.appendChild(cursorElement);
        cursorsRef.current.set(userId, cursorElement);
        console.log('✅ RemoteCursorPlugin: Created new cursor for user:', userId);
      }
      
      // Position the cursor
      positionCursor(cursorElement, cursor, editorElement, overlay);
    });
    
  }, [remoteCursors, currentUserId, editor]);
  
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
  
  // Position cursor at text offset
  const positionCursor = (
    cursorElement: HTMLElement, 
    cursor: CursorPosition, 
    editorElement: HTMLElement,
    overlay: HTMLElement
  ) => {
    try {
      const nodeKey = cursor.position.key;
      const nodeOffset = cursor.position.offset;
      const isSelection = cursor.position.type === 'selection';
      console.log('🎯 RemoteCursorPlugin: Positioning cursor for', cursor.userName, 'at node', nodeKey, 'offset', nodeOffset, 'isSelection:', isSelection);
      
      // Use Lexical node keys directly - much simpler and more accurate!
      editor.getEditorState().read(() => {
        try {
          // Handle selections differently
          if (isSelection && cursor.position.focus && cursor.position.anchor) {
            const anchorKey = cursor.position.anchor.key;
            const anchorOffset = cursor.position.anchor.offset;
            const focusKey = cursor.position.focus.key;
            const focusOffset = cursor.position.focus.offset;
            
            console.log('🎯 RemoteCursorPlugin: SELECTION DETECTED:', {
              anchorKey, anchorOffset, focusKey, focusOffset,
              hasAnchorKey: !!anchorKey,
              hasFocusKey: !!focusKey
            });
            
            // Check if it's a collapsed selection (just a cursor)
            const isCollapsed = anchorKey === focusKey && anchorOffset === focusOffset;
            
            console.log('🎯 RemoteCursorPlugin: Selection analysis:', {
              isCollapsed,
              anchorOffset,
              focusOffset,
              sameKey: anchorKey === focusKey
            });
            
            if (!isCollapsed) {
              console.log('🎯 RemoteCursorPlugin: Processing REAL selection...');
              // Handle actual selection
              try {
                const anchorNode = editor.getEditorState()._nodeMap.get(anchorKey);
                const focusNode = editor.getEditorState()._nodeMap.get(focusKey);
                
                console.log('🎯 RemoteCursorPlugin: Found nodes:', {
                  hasAnchorNode: !!anchorNode,
                  hasFocusNode: !!focusNode,
                  anchorNodeType: anchorNode?.getType(),
                  focusNodeType: focusNode?.getType()
                });
                
                if (anchorNode && focusNode) {
                  const anchorDomElement = editor.getElementByKey(anchorKey);
                  const focusDomElement = editor.getElementByKey(focusKey);
                  
                  console.log('🎯 RemoteCursorPlugin: Found DOM elements:', {
                    hasAnchorDOM: !!anchorDomElement,
                    hasFocusDOM: !!focusDomElement,
                    anchorDOMTag: anchorDomElement?.tagName,
                    focusDOMTag: focusDomElement?.tagName
                  });
                  
                  if (anchorDomElement && focusDomElement) {
                    const anchorTextNode = findTextNodeInElement(anchorDomElement, anchorOffset);
                    const focusTextNode = findTextNodeInElement(focusDomElement, focusOffset);
                    
                    console.log('🎯 RemoteCursorPlugin: Found text nodes:', {
                      hasAnchorText: !!anchorTextNode,
                      hasFocusText: !!focusTextNode,
                      anchorTextContent: anchorTextNode?.textNode.textContent?.substring(0, 50),
                      focusTextContent: focusTextNode?.textNode.textContent?.substring(0, 50),
                      anchorOffset: anchorTextNode?.offset,
                      focusOffset: focusTextNode?.offset
                    });
                    
                    if (anchorTextNode && focusTextNode) {
                      const range = document.createRange();
                      
                      // Ensure proper range direction
                      let startNode = anchorTextNode;
                      let endNode = focusTextNode;
                      
                      // For same text node, ensure start < end
                      if (anchorTextNode.textNode === focusTextNode.textNode) {
                        if (anchorTextNode.offset > focusTextNode.offset) {
                          startNode = focusTextNode;
                          endNode = anchorTextNode;
                        }
                      }
                      
                      range.setStart(startNode.textNode, startNode.offset);
                      range.setEnd(endNode.textNode, endNode.offset);
                      
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
                        console.log('🎯 RemoteCursorPlugin: Selection element found:', !!selection);
                        
                        if (selection) {
                          selection.style.width = `${rect.width}px`;
                          selection.style.height = `${rect.height}px`;
                          selection.style.left = '0px';
                          selection.style.top = '0px';
                          selection.style.display = 'block';
                          
                          console.log('🎨 SELECTION HIGHLIGHT APPLIED:', {
                            width: selection.style.width,
                            height: selection.style.height,
                            display: selection.style.display,
                            backgroundColor: selection.style.backgroundColor
                          });
                        }
                        
                        // Hide cursor line for selections
                        const line = cursorElement.querySelector('.cursor-line') as HTMLElement;
                        if (line) {
                          line.style.display = 'none';
                        }
                        
                        positionLabel(cursorElement, left, top, overlay, cursor);
                        
                        console.log('✅ RemoteCursorPlugin: SELECTION POSITIONED SUCCESSFULLY:', {
                          left, top, width: rect.width, height: rect.height,
                          selectionVisible: selection?.style.display === 'block'
                        });
                        
                        return;
                      } else {
                        console.log('⚠️ RemoteCursorPlugin: Invalid selection rect:', rect);
                      }
                    } else {
                      console.log('⚠️ RemoteCursorPlugin: Could not find text nodes for selection');
                    }
                  } else {
                    console.log('⚠️ RemoteCursorPlugin: Could not find DOM elements for selection');
                  }
                } else {
                  console.log('⚠️ RemoteCursorPlugin: Could not find Lexical nodes for selection');
                }
              } catch (error) {
                console.log('⚠️ RemoteCursorPlugin: Selection positioning error:', error);
              }
            } else {
              console.log('🎯 RemoteCursorPlugin: Collapsed selection, treating as cursor');
            }
          }
          
          // Handle regular cursor positioning (or fallback for selections)
          const lexicalNode = editor.getEditorState()._nodeMap.get(nodeKey);
          
          if (lexicalNode) {
            console.log('🎯 RemoteCursorPlugin: Found Lexical node:', {
              nodeKey,
              nodeType: lexicalNode.getType(),
              nodeTextContent: lexicalNode.getTextContent ? lexicalNode.getTextContent() : '[no text content]'
            });
            
            // Get the DOM element for this Lexical node
            const domElement = editor.getElementByKey(nodeKey);
            
            if (domElement) {
              console.log('🎯 RemoteCursorPlugin: Found DOM element:', domElement);
              
              // Find the text node within this DOM element at the correct offset
              const textNodeResult = findTextNodeInElement(domElement, nodeOffset);
              
              if (textNodeResult) {
                try {
                  const range = document.createRange();
                  range.setStart(textNodeResult.textNode, textNodeResult.offset);
                  range.setEnd(textNodeResult.textNode, textNodeResult.offset);
                  
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
                    
                    const line = cursorElement.querySelector('.cursor-line') as HTMLElement;
                    if (line) {
                      line.style.display = 'block';
                    }
                    
                    // Smart label positioning
                    positionLabel(cursorElement, left, top, overlay, cursor);
                    
                    console.log('✅ RemoteCursorPlugin: Positioned cursor using node key:', { 
                      left, 
                      top, 
                      nodeKey,
                      nodeOffset,
                      domTextNodeOffset: textNodeResult.offset,
                      targetChar: textNodeResult.textNode.textContent?.charAt(textNodeResult.offset) || '',
                    });
                    
                    return; // Successfully positioned
                  } else {
                    console.log('⚠️ RemoteCursorPlugin: Invalid rect dimensions:', rect);
                  }
                } catch (error) {
                  console.log('⚠️ RemoteCursorPlugin: Range positioning error:', error);
                }
              } else {
                console.log('⚠️ RemoteCursorPlugin: Could not find text node in DOM element');
              }
            } else {
              console.log('⚠️ RemoteCursorPlugin: Could not find DOM element for node key:', nodeKey);
            }
          } else {
            console.log('⚠️ RemoteCursorPlugin: Could not find Lexical node for key:', nodeKey);
            console.log('💡 RemoteCursorPlugin: This usually happens after content updates when node keys change');
            console.log('🚫 RemoteCursorPlugin: Hiding cursor instead of showing fallback (stale position)');
            
            // Hide the cursor instead of showing fallback - this prevents the upper left corner issue
            cursorElement.style.opacity = '0';
            return; // Exit early, don't show fallback
          }
          
          // Fallback positioning should only be reached if we can't find DOM elements for valid nodes
          console.log('🎯 RemoteCursorPlugin: Using fallback positioning for', cursor.userName);
          
          cursorElement.style.left = '10px';
          cursorElement.style.top = '10px';
          cursorElement.style.opacity = '0.7';
          
          // For fallback, show cursor line and hide selection
          const selection = cursorElement.querySelector('.selection-highlight') as HTMLElement;
          if (selection) {
            selection.style.display = 'none';
          }
          
          const line = cursorElement.querySelector('.cursor-line') as HTMLElement;
          if (line) {
            line.style.display = 'block';
          }
          
          positionLabel(cursorElement, 10, 10, overlay, cursor);
          
        } catch (error) {
          console.error('❌ RemoteCursorPlugin: Lexical positioning error:', error);
          console.log('🚫 RemoteCursorPlugin: Hiding cursor due to positioning error');
          // Hide cursor instead of showing fallback to prevent upper left corner positioning
          cursorElement.style.opacity = '0';
        }
      });
      
    } catch (error) {
      console.error('❌ RemoteCursorPlugin: Positioning error:', error);
      console.log('🚫 RemoteCursorPlugin: Hiding cursor due to outer positioning error');
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
  
  useEffect(() => {
    console.log('🎯 CursorTrackingPlugin initialized:', {
      hasWebSocketClient: !!webSocketClient,
      documentId,
      userId: currentUser.id || currentUser.email,
      webSocketClientType: typeof webSocketClient,
      webSocketClientMethods: webSocketClient ? Object.getOwnPropertyNames(webSocketClient) : []
    });
    
    if (!webSocketClient) {
      console.log('⚠️ CursorTrackingPlugin: No WebSocket client provided');
      return;
    }
    
    // Listen for cursor refresh requests
    const handleCursorRefreshRequest = (message: any) => {
      console.log('🔄 CursorTrackingPlugin: Received cursor refresh request:', message);
      // Force a fresh cursor position update
      setTimeout(() => {
        console.log('🔄 CursorTrackingPlugin: Triggering fresh cursor position after refresh request');
        handleSelectionChange();
      }, 150); // Small delay to ensure content is settled
    };
    
    // Register the refresh request handler
    webSocketClient.on('request_cursor_refresh', handleCursorRefreshRequest);
    
    const handleSelectionChange = () => {
      console.log('🎯 Selection change detected');
      editor.getEditorState().read(() => {
        const selection = $getSelection();
        console.log('🎯 Current selection:', selection);
        
        if ($isRangeSelection(selection)) {
          console.log('🎯 Range selection detected');
          const anchorNode = selection.anchor.getNode();
          const focusNode = selection.focus.getNode();
          
          console.log('🎯 Selection details:', {
            anchorKey: anchorNode.getKey(),
            anchorOffset: selection.anchor.offset,
            focusKey: focusNode.getKey(),
            focusOffset: selection.focus.offset,
            isCollapsed: selection.isCollapsed()
          });
          
          // Use Lexical node keys directly - much simpler!
          const position: CursorPosition = {
            userId: effectiveUserId,
            userName: currentUser.name || currentUser.email,
            userEmail: currentUser.email,
            position: {
              key: anchorNode.getKey(), // Use actual Lexical node key
              offset: selection.anchor.offset, // Use actual offset within that node
              type: selection.isCollapsed() ? 'cursor' : 'selection',
              anchor: {
                key: anchorNode.getKey(),
                offset: selection.anchor.offset
              },
              focus: {
                key: focusNode.getKey(),
                offset: selection.focus.offset
              }
            },
            timestamp: new Date().toISOString()
          };
          
          console.log('🎯 Calling onCursorUpdate with node-based position:', position);
          onCursorUpdate(position);
        } else {
          console.log('🎯 Non-range selection, ignoring');
        }
      });
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
        handleSelectionChange();
        return false;
      },
      1
    );
    
    // Add a document-level selection change listener as backup
    const handleDocumentSelectionChange = () => {
      console.log('🎯 Document selection change detected');
      handleSelectionChange();
    };
    
    document.addEventListener('selectionchange', handleDocumentSelectionChange);
    
    console.log('✅ CursorTrackingPlugin setup complete with multiple listeners');
    
    return () => {
      console.log('🧹 CursorTrackingPlugin cleanup');
      removeSelectionListener();
      removeCommandListener();
      document.removeEventListener('selectionchange', handleDocumentSelectionChange);
      webSocketClient.off('request_cursor_refresh', handleCursorRefreshRequest);
    };
  }, [editor, webSocketClient, currentUser, documentId, onCursorUpdate]);
  
  return null;
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
  
  // Cursor repositioning function
  const triggerRepositioning = useCallback(() => {
    setNeedsCursorRepositioning(true);
    setTimeout(() => setNeedsCursorRepositioning(false), 100);
  }, []);

  // Callback when content is updated (for cursor repositioning)
  const handleContentUpdated = useCallback(() => {
    console.log('🔄 CollaborativeEditor: Content updated, forcing cursor repositioning');
    
    // Force multiple repositioning attempts
    triggerRepositioning();
    setTimeout(triggerRepositioning, 200);
    setTimeout(triggerRepositioning, 500);
    
    console.log('🔄 CollaborativeEditor: Scheduled cursor repositioning');
  }, [triggerRepositioning]);
  
  // Remote content update function
  const applyRemoteContentUpdate = useCallback((content: string) => {
    console.log('🔄 CollaborativeEditor: Applying remote content update:', content.length, 'chars');
    console.log('🔄 CollaborativeEditor: Current remote cursors count before update:', remoteCursors.size);
    
    // Record the time of content update
    lastContentUpdateTime.current = Date.now();
    console.log('⏰ CollaborativeEditor: Recording content update time:', lastContentUpdateTime.current);
    
    // Clear remote cursors before applying content update since node keys will change
    console.log('🧹 CollaborativeEditor: Clearing remote cursors before content update');
    setRemoteCursors(new Map());
    
    // Also clear the last cursor position reference to prevent stale positions in auto-save
    lastCursorPositionRef.current = null;
    
    if (editorRef.current) {
      try {
        // Set flag to prevent auto-save during remote update
        isApplyingRemoteUpdate.current = true;
        console.log('🚫 CollaborativeEditor: Setting remote update flag to prevent auto-save');
        
        // Apply content update by setting the full editor state to preserve rich formatting
        if (isLexicalJson(content)) {
          try {
            console.log('🔄 CollaborativeEditor: Importing remote Lexical content with full formatting...');
            
            // Parse and set the full Lexical editor state to preserve rich text formatting
            const editorState = editorRef.current.parseEditorState(content);
            editorRef.current.setEditorState(editorState);
            
            console.log('✅ CollaborativeEditor: Applied remote Lexical content with full formatting preserved');
          } catch (error) {
            console.error('❌ Error parsing Lexical JSON, using text fallback:', error);
            
            // Fallback to text extraction if JSON parsing fails
            editorRef.current.update(() => {
              const root = $getRoot();
              root.clear();
              
              try {
                const textContent = extractTextFromLexical(content);
                if (textContent) {
                  const lines = textContent.split('\n');
                  for (const line of lines) {
                    const paragraph = $createParagraphNode();
                    if (line.trim()) {
                      paragraph.append($createTextNode(line));
                    }
                    root.append(paragraph);
                  }
                  console.log('✅ CollaborativeEditor: Applied remote content as text fallback');
                }
              } catch (fallbackError) {
                console.error('❌ Error in text fallback:', fallbackError);
                const paragraph = $createParagraphNode();
                paragraph.append($createTextNode('Error loading remote content'));
                root.append(paragraph);
              }
            });
          }
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
        
        console.log('✅ CollaborativeEditor: Content update complete, cursors cleared. Fresh cursor positions will be needed.');
        
        // Show temporary message about cursor clearing
        if (remoteCursors.size > 0) {
          console.log('ℹ️ CollaborativeEditor: Remote cursors cleared due to content update. Users will need to move their cursors to re-sync positions.');
        }
        
        // Request fresh cursor positions from all users after a brief delay
        // This ensures the content update is fully processed before requesting fresh positions
        setTimeout(() => {
          if (webSocketClientRef.current) {
            console.log('📡 Requesting fresh cursor positions from all users after content update');
            try {
              webSocketClientRef.current.send({
                type: 'request_cursor_refresh',
                data: {
                  reason: 'content_updated',
                  timestamp: new Date().toISOString()
                }
              });
            } catch (error) {
              console.error('❌ Failed to send cursor refresh request:', error);
            }
          }
        }, 200);
        
                // Force current user to send fresh cursor position after content update
        // This ensures cursor positions are based on the NEW node structure
        setTimeout(() => {
          console.log('🔄 CollaborativeEditor: Triggering fresh cursor position update after content update');
          
          // Also trigger refresh request handler for the current user's CursorTrackingPlugin
          if (webSocketClientRef.current) {
            console.log('🔄 Triggering cursor refresh for current user via plugin');
            // Simulate a cursor refresh request to the current user's plugin
            const fakeRefreshMessage = {
              type: 'request_cursor_refresh',
              data: {
                reason: 'content_updated_local',
                timestamp: new Date().toISOString()
              }
            };
            
            // Emit the refresh request to trigger the CursorTrackingPlugin's handler
            try {
              if (webSocketClientRef.current) {
                webSocketClientRef.current.emit('request_cursor_refresh', fakeRefreshMessage);
              } else {
                throw new Error('WebSocket client not available');
              }
            } catch (error) {
              console.log('⚠️ Could not emit refresh request to plugin, using fallback');
              
              // Fallback: directly read current selection and send position
              if (editorRef.current) {
                editorRef.current.getEditorState().read(() => {
                  const selection = $getSelection();
                  if ($isRangeSelection(selection)) {
                    const anchorNode = selection.anchor.getNode();
                    const focusNode = selection.focus.getNode();
                    
                    const position: CursorPosition = {
                      userId: effectiveUserId,
                      userName: currentUser.name || currentUser.email,
                      userEmail: currentUser.email,
                      position: {
                        key: anchorNode.getKey(),
                        offset: selection.anchor.offset,
                        type: selection.isCollapsed() ? 'cursor' : 'selection',
                        anchor: {
                          key: anchorNode.getKey(),
                          offset: selection.anchor.offset
                        },
                        focus: {
                          key: focusNode.getKey(),
                          offset: selection.focus.offset
                        }
                      },
                      timestamp: new Date().toISOString()
                    };
                    
                    console.log('📡 Sending fallback cursor position after remote content update');
                    if (webSocketClientRef.current) {
                      try {
                        webSocketClientRef.current.send({
                          type: 'cursor_position',
                          data: position
                        });
                        
                        lastCursorPositionRef.current = position;
                      } catch (error) {
                        console.error('❌ Failed to send fallback cursor position:', error);
                      }
                    } else {
                      console.log('⚠️ Cannot send fallback cursor position - WebSocket client not available');
                    }
                  }
                });
              }
            }
          }
        }, 400); // Longer delay to ensure content processing is complete
         
      } catch (error) {
        console.error('❌ CollaborativeEditor: Failed to apply remote content:', error);
      } finally {
        // Clear the flag after update is complete
        setTimeout(() => {
          isApplyingRemoteUpdate.current = false;
          console.log('✅ CollaborativeEditor: Cleared remote update flag');
        }, 200); // Small delay to ensure all change handlers have completed
      }
    } else {
      console.log('⚠️ CollaborativeEditor: No editor ref available for content update');
    }
  }, [remoteCursors.size, currentUser.id, currentUser.email, currentUser.name]);

  // Lightweight real-time content update that preserves cursors
  const applyRealTimeContentUpdate = useCallback((content: string) => {
    console.log('⚡ CollaborativeEditor: Applying real-time content update (lightweight):', content.length, 'chars');
    
    if (editorRef.current && isLexicalJson(content)) {
      try {
        // Set flag to prevent auto-save during remote update
        isApplyingRemoteUpdate.current = true;
        console.log('🚫 CollaborativeEditor: Setting remote update flag for real-time update');
        
        // For real-time updates, use setEditorState to preserve formatting
        const editorState = editorRef.current.parseEditorState(content);
        editorRef.current.setEditorState(editorState);
        
        console.log('✅ CollaborativeEditor: Applied real-time Lexical content, triggering cursor repositioning');
        
        // For real-time updates, trigger immediate cursor repositioning 
        // without updating lastContentUpdateTime to avoid blocking cursors
        if (remoteCursors.size > 0) {
          console.log('🎯 CollaborativeEditor: Triggering cursor repositioning for', remoteCursors.size, 'remote cursors');
          
          // Trigger repositioning after a brief delay to ensure DOM is updated
          setTimeout(() => {
            triggerRepositioning();
          }, 30); // Shorter delay for real-time updates
        }
        
        // Also send current user's cursor position to ensure it stays in sync
        if (webSocketClientRef.current) {
          setTimeout(() => {
            console.log('📍 Sending current user cursor position after real-time update');
            
            if (editorRef.current) {
              editorRef.current.getEditorState().read(() => {
                const selection = $getSelection();
                if ($isRangeSelection(selection)) {
                  const anchorNode = selection.anchor.getNode();
                  const focusNode = selection.focus.getNode();
                  
                  const position: CursorPosition = {
                    userId: effectiveUserId,
                    userName: currentUser.name || currentUser.email,
                    userEmail: currentUser.email,
                    position: {
                      key: anchorNode.getKey(),
                      offset: selection.anchor.offset,
                      type: selection.isCollapsed() ? 'cursor' : 'selection',
                      anchor: {
                        key: anchorNode.getKey(),
                        offset: selection.anchor.offset
                      },
                      focus: {
                        key: focusNode.getKey(),
                        offset: selection.focus.offset
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
              });
            }
          }, 100);
        }
        
      } catch (error) {
        console.error('❌ CollaborativeEditor: Failed to apply real-time content:', error);
      } finally {
        // Clear the flag after a short delay
        setTimeout(() => {
          isApplyingRemoteUpdate.current = false;
          console.log('✅ CollaborativeEditor: Cleared remote update flag (real-time)');
        }, 30); // Shorter delay for real-time updates
      }
    } else {
      console.log('⚠️ CollaborativeEditor: Invalid content for real-time update');
    }
  }, [remoteCursors.size, currentUser.id, currentUser.email, currentUser.name, triggerRepositioning]);
  
  // Handle cursor updates
  const handleCursorUpdate = useCallback((position: CursorPosition) => {
    console.log('🎯 handleCursorUpdate called with position:', position);
    
    if (webSocketClientRef.current) {
      console.log('🎯 Sending cursor position via WebSocket:', {
        hasWebSocketClient: !!webSocketClientRef.current,
        position: position,
        positionKey: position.position.key,
        positionOffset: position.position.offset,
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
  }, []);
  
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
            // Immediately send current cursor position if we have one
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
            // Register the full update function for regular updates
            onRemoteContentUpdate(applyRemoteContentUpdate);
            
            // Also store the real-time function for TrackedChangesEditor
            client.applyRealTimeUpdate = applyRealTimeContentUpdate;
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
          
          client.on('cursor_position', handleRemoteCursorUpdate);
          client.on('typing_start', handleTypingStart);
          client.on('typing_stop', handleTypingStop);
          
          client.on('request_cursor_refresh', (message: any) => {
            console.log('🔄 CURSOR_REFRESH_REQUEST RECEIVED (document):', message);
            // Immediately send current cursor position if we have one
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
            // Register the full update function for regular updates
            onRemoteContentUpdate(applyRemoteContentUpdate);
            
            // Also store the real-time function for TrackedChangesEditor
            client.applyRealTimeUpdate = applyRealTimeContentUpdate;
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
  }, [documentId, currentUser.id, currentUser.email, currentUser.name, useSubmissionWebSocket, handleRemoteCursorUpdate, handleTypingStart, handleTypingStop, onWebSocketClientReady, onRemoteContentUpdate, applyRemoteContentUpdate]);
  
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
        const selection = $getSelection();
        if ($isRangeSelection(selection)) {
          const anchorNode = selection.anchor.getNode();
          const focusNode = selection.focus.getNode();
          
          cursorPosition = {
            userId: effectiveUserId,
            userName: currentUser.name || currentUser.email,
            userEmail: currentUser.email,
            position: {
              key: anchorNode.getKey(),
              offset: selection.anchor.offset,
              type: selection.isCollapsed() ? 'cursor' : 'selection',
              anchor: {
                key: anchorNode.getKey(),
                offset: selection.anchor.offset
              },
              focus: {
                key: focusNode.getKey(),
                offset: selection.focus.offset
              }
            },
            timestamp: new Date().toISOString()
          };
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
            console.log('📡 Sending immediate fresh cursor position with new node keys:', {
              anchorKey: cursorPosition!.position.key,
              anchorOffset: cursorPosition!.position.offset
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
  }, [currentContent, onContentChange, documentId, currentUser.id, currentUser.email, currentUser.name]);
  
  // Handle save
  const handleSave = useCallback(() => {
    console.log('💾 Save button clicked');
    
    if (onSave) {
      console.log('📤 Calling onSave with content:', currentContent);
      onSave(currentContent);
      setLastSavedContent(currentContent);
      contentChangedRef.current = false;
    }
  }, [onSave, currentContent]);
  
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
          
          // Create a paragraph with the text content
          const paragraph = $createParagraphNode();
          const textNode = $createTextNode(initialContent);
          paragraph.append(textNode);
          root.append(paragraph);
          console.log('🔄 Added paragraph with text node to root');
          
          // Update current content state with JSON representation
          const jsonContent = JSON.stringify(editor.getEditorState());
          setCurrentContent(jsonContent);
          setLastSavedContent(jsonContent);
          console.log('🔄 Updated content state');
        } else {
          console.log('🔄 Initial content is empty, no content to load');
        }
      });
    } else {
      console.log('🔧 Editor initialization skipped:', {
        hasEditorRef: !!editorRef.current,
        hasInitialContent: !!initialContent,
        isInitialized: isInitializedRef.current
      });
    }
  }, [initialContent, editorRef.current]);
  
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
              {/* Only render CursorTrackingPlugin when WebSocket is connected */}
              {webSocketClientReady && webSocketClientRef.current && (
                <CursorTrackingPlugin 
                  webSocketClient={webSocketClientRef.current}
                  currentUser={currentUser}
                  documentId={documentId}
                  onCursorUpdate={handleCursorUpdate}
                  effectiveUserId={effectiveUserId}
                />
              )}
              <RemoteCursorPlugin
                remoteCursors={remoteCursors}
                currentUserId={currentUser.id || currentUser.email}
                needsRepositioning={needsCursorRepositioning}
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