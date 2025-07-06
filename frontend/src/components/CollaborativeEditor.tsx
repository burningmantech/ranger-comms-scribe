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
import { isLexicalJson } from '../utils/lexicalUtils';
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
      console.log('🔄 RemoteCursorPlugin: Force repositioning all cursors');
      
      const overlay = overlayRef.current;
      const editorElement = editor.getRootElement();
      if (!editorElement) return;
      
      // Reposition all existing cursors
      remoteCursors.forEach((cursor, userId) => {
        if (userId === currentUserId) return;
        
        const cursorElement = cursorsRef.current.get(userId);
        if (cursorElement) {
          console.log('🔄 RemoteCursorPlugin: Repositioning cursor for user:', userId);
          positionCursor(cursorElement, cursor, editorElement, overlay);
        }
      });
    }
  }, [needsRepositioning, remoteCursors, currentUserId, editor]);
  
  // Create cursor element with nice design
  const createCursorElement = (cursor: CursorPosition): HTMLElement => {
    const userColor = getUserColor(cursor.userId);
    const isSelection = cursor.position.type === 'selection';
    
    const cursorEl = document.createElement('div');
    cursorEl.className = 'lexical-remote-cursor';
    cursorEl.id = `cursor-${cursor.userId.replace(/[^a-zA-Z0-9]/g, '-')}`;
    
    // Cursor line
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
    
    // Selection highlight for selections
    if (isSelection) {
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
    }
    
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
            
            console.log('🎯 RemoteCursorPlugin: Positioning selection:', {
              anchorKey, anchorOffset, focusKey, focusOffset
            });
            
            // Check if it's a collapsed selection (just a cursor)
            const isCollapsed = anchorKey === focusKey && anchorOffset === focusOffset;
            
            if (!isCollapsed) {
              // Handle actual selection
              try {
                const anchorNode = editor.getEditorState()._nodeMap.get(anchorKey);
                const focusNode = editor.getEditorState()._nodeMap.get(focusKey);
                
                if (anchorNode && focusNode) {
                  const anchorDomElement = editor.getElementByKey(anchorKey);
                  const focusDomElement = editor.getElementByKey(focusKey);
                  
                  if (anchorDomElement && focusDomElement) {
                    const anchorTextNode = findTextNodeInElement(anchorDomElement, anchorOffset);
                    const focusTextNode = findTextNodeInElement(focusDomElement, focusOffset);
                    
                    if (anchorTextNode && focusTextNode) {
                      const range = document.createRange();
                      range.setStart(anchorTextNode.textNode, anchorTextNode.offset);
                      range.setEnd(focusTextNode.textNode, focusTextNode.offset);
                      
                      const rect = range.getBoundingClientRect();
                      const overlayRect = overlay.getBoundingClientRect();
                      
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
                          selection.style.display = 'block';
                        }
                        
                        positionLabel(cursorElement, left, top, overlay, cursor);
                        
                        console.log('✅ RemoteCursorPlugin: Positioned selection:', {
                          left, top, width: rect.width, height: rect.height
                        });
                        
                        return;
                      }
                    }
                  }
                }
              } catch (error) {
                console.log('⚠️ RemoteCursorPlugin: Selection positioning error:', error);
              }
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
                    
                    // Hide selection highlight for regular cursor
                    const selection = cursorElement.querySelector('.selection-highlight') as HTMLElement;
                    if (selection) {
                      selection.style.display = 'none';
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
          }
          
          // Fallback positioning - place at start of editor
          console.log('🎯 RemoteCursorPlugin: Using fallback positioning');
          
          cursorElement.style.left = '10px';
          cursorElement.style.top = '10px';
          cursorElement.style.opacity = '0.7';
          
          positionLabel(cursorElement, 10, 10, overlay, cursor);
          
        } catch (error) {
          console.error('❌ RemoteCursorPlugin: Lexical positioning error:', error);
          // Ultimate fallback
          cursorElement.style.left = '10px';
          cursorElement.style.top = '10px';
          cursorElement.style.opacity = '0.3';
          positionLabel(cursorElement, 10, 10, overlay, cursor);
        }
      });
      
    } catch (error) {
      console.error('❌ RemoteCursorPlugin: Positioning error:', error);
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
}> = ({ webSocketClient, currentUser, documentId, onCursorUpdate }) => {
  const [editor] = useLexicalComposerContext();
  
  useEffect(() => {
    console.log('🎯 CursorTrackingPlugin initialized:', {
      hasWebSocketClient: !!webSocketClient,
      documentId,
      userId: currentUser.id || currentUser.email
    });
    
    if (!webSocketClient) {
      console.log('⚠️ CursorTrackingPlugin: No WebSocket client provided');
      return;
    }
    
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
            userId: currentUser.id || currentUser.email,
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
    
    console.log('✅ CursorTrackingPlugin setup complete');
    
    return () => {
      console.log('🧹 CursorTrackingPlugin cleanup');
      removeSelectionListener();
    };
  }, [editor, webSocketClient, currentUser, documentId, onCursorUpdate]);
  
  return null;
};

export interface CollaborativeEditorProps {
  documentId: string;
  initialContent: string;
  onContentChange: (content: string) => void;
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
  
  const editorRef = useRef<LexicalEditor | null>(null);
  const contentChangedRef = useRef(false);
  const isInitializedRef = useRef(false);
  const webSocketClientRef = useRef<any>(null);
  const lastCursorPositionRef = useRef<CursorPosition | null>(null);
  const typingTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const isTypingRef = useRef(false);
  
  // Callback when content is updated (for cursor repositioning)
  const handleContentUpdated = useCallback(() => {
    console.log('🔄 CollaborativeEditor: Content updated, forcing cursor repositioning');
    
    // Force multiple repositioning attempts
    const triggerRepositioning = () => {
      setNeedsCursorRepositioning(true);
      setTimeout(() => setNeedsCursorRepositioning(false), 100);
    };
    
    triggerRepositioning();
    setTimeout(triggerRepositioning, 200);
    setTimeout(triggerRepositioning, 500);
    
    console.log('🔄 CollaborativeEditor: Scheduled cursor repositioning');
  }, []);
  
  // Remote content update function
  const applyRemoteContentUpdate = useCallback((content: string) => {
    console.log('🔄 CollaborativeEditor: Applying remote content update:', content.length);
    
    if (editorRef.current) {
      try {
        editorRef.current.update(() => {
          const root = $getRoot();
          root.clear();
          
          if (isLexicalJson(content)) {
            const parsedContent = JSON.parse(content);
            if (parsedContent.root) {
              // Import the content into the editor
              const importedState = editorRef.current!.parseEditorState(content);
              editorRef.current!.setEditorState(importedState);
              console.log('✅ CollaborativeEditor: Applied remote Lexical content');
            }
          } else {
            // Handle plain text
            const paragraph = $createParagraphNode();
            paragraph.append($createTextNode(content));
            root.append(paragraph);
            console.log('✅ CollaborativeEditor: Applied remote plain text content');
          }
          
          // Trigger cursor repositioning after content update
          setTimeout(() => {
            handleContentUpdated();
          }, 50);
        });
      } catch (error) {
        console.error('❌ CollaborativeEditor: Failed to apply remote content:', error);
      }
    }
  }, [handleContentUpdated]);
  
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
      webSocketClientRef.current.send({
        type: 'cursor_position',
        data: position
      });
      
      console.log('✅ Cursor position sent successfully');
    } else {
      console.log('❌ No WebSocket client available for cursor update');
    }
  }, []);
  
  // Handle remote cursor position updates
  const handleRemoteCursorUpdate = useCallback((message: WebSocketMessage) => {
    console.log('🖱️ handleRemoteCursorUpdate called with message:', message);
    
    if (message.data && message.data.position) {
      const cursorPosition: CursorPosition = message.data;
      console.log('🖱️ Processing cursor position:', cursorPosition);
      
      // Don't show our own cursor
      if (cursorPosition.userId === currentUser.id || cursorPosition.userId === currentUser.email) {
        console.log('🖱️ Ignoring own cursor position');
        return;
      }
      
      setRemoteCursors(prev => {
        const newCursors = new Map(prev);
        newCursors.set(cursorPosition.userId, cursorPosition);
        console.log('🖱️ Updated remote cursors map:', {
          userId: cursorPosition.userId,
          userName: cursorPosition.userName,
          totalCursors: newCursors.size,
          allCursorIds: Array.from(newCursors.keys())
        });
        return newCursors;
      });
    } else {
      console.log('🖱️ No cursor position data in message');
    }
  }, [currentUser.id, currentUser.email]);
  
  // Handle typing indicators
  const handleTypingStart = useCallback((message: any) => {
    console.log('⌨️ User started typing:', message);
    if (message.data && message.userId !== currentUser.id && message.userId !== currentUser.email) {
      console.log('⌨️ Adding user to typing list:', message.userId);
      setTypingUsers(prev => {
        const newTypingUsers = new Set(prev);
        newTypingUsers.add(message.userId);
        console.log('⌨️ Current typing users:', Array.from(newTypingUsers));
        return newTypingUsers;
      });
    }
  }, [currentUser.id, currentUser.email]);
  
  const handleTypingStop = useCallback((message: any) => {
    console.log('⌨️ User stopped typing:', message);
    if (message.data && message.userId !== currentUser.id && message.userId !== currentUser.email) {
      console.log('⌨️ Removing user from typing list:', message.userId);
      setTypingUsers(prev => {
        const newTypingUsers = new Set(prev);
        newTypingUsers.delete(message.userId);
        console.log('⌨️ Current typing users:', Array.from(newTypingUsers));
        return newTypingUsers;
      });
    }
  }, [currentUser.id, currentUser.email]);
  
  console.log('🔧 CollaborativeEditor state:', {
    connectionStatus,
    currentContentLength: currentContent?.length,
    lastSavedContentLength: lastSavedContent?.length,
    isInitialized: isInitializedRef.current,
    editorRefExists: !!editorRef.current
  });
  
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
          
          // Add raw message listener for debugging
          client.on('message', (rawMessage) => {
            console.log('📨 RAW MESSAGE RECEIVED:', rawMessage);
          });
          
          // Add debugging for each specific event handler
          const debugHandleRemoteCursorUpdate = (message: WebSocketMessage) => {
            console.log('🖱️ CURSOR_POSITION EVENT RECEIVED:', message);
            handleRemoteCursorUpdate(message);
          };
          
          const debugHandleTypingStart = (message: WebSocketMessage) => {
            console.log('⌨️ TYPING_START EVENT RECEIVED:', message);
            handleTypingStart(message);
          };
          
          const debugHandleTypingStop = (message: WebSocketMessage) => {
            console.log('⌨️ TYPING_STOP EVENT RECEIVED:', message);
            handleTypingStop(message);
          };
          
          client.on('connected', () => {
            setConnectionStatus('connected');
            console.log('✅ WebSocket connected successfully');
          });
          
          client.on('cursor_position', debugHandleRemoteCursorUpdate);
          client.on('typing_start', debugHandleTypingStart);
          client.on('typing_stop', debugHandleTypingStop);
          
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
          
          webSocketClientRef.current = client;
          setConnectionStatus('connected');
          
          // Notify parent that WebSocket client is ready
          if (onWebSocketClientReady) {
            onWebSocketClientReady(client);
          }
          
          // Register remote content update function
          if (onRemoteContentUpdate) {
            onRemoteContentUpdate(applyRemoteContentUpdate);
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
          
          client.on('error', () => {
            setConnectionStatus('error');
            console.error('❌ Document WebSocket connection error');
          });
          
          webSocketClientRef.current = client;
          setConnectionStatus('connected');
          
          // Notify parent that WebSocket client is ready
          if (onWebSocketClientReady) {
            onWebSocketClientReady(client);
          }
          
          // Register remote content update function
          if (onRemoteContentUpdate) {
            onRemoteContentUpdate(applyRemoteContentUpdate);
          }
          
          console.log('✅ Document WebSocket fully configured');
        }
      } catch (error) {
        console.error('❌ Failed to connect WebSocket:', error);
        setConnectionStatus('error');
      }
    };
    
    connectWebSocket();
    
    return () => {
      // Cleanup WebSocket connection
      console.log('🧹 Cleaning up WebSocket connection...');
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
          textContentLength: textContent.length
        });
        
        setCurrentContent(jsonContent);
        contentChangedRef.current = true;
        
        // Notify parent component with the full JSON
        onContentChange(jsonContent);
        
        // Notify other users of content changes via WebSocket
        if (webSocketClientRef.current) {
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
  
  const hasUnsavedChanges = currentContent !== lastSavedContent;
  
  return (
    <div className={`collaborative-editor ${className}`}>
      {/* Header with user presence and connection status */}
      <div className="collaborative-editor-header">
        <div className="editor-info">
          <span className="connection-status">
            {getConnectionStatusIcon()} {getConnectionStatusText()}
          </span>
          {hasUnsavedChanges && (
            <span className="unsaved-indicator">• Unsaved changes</span>
          )}
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
          
          {onSave && (
            <button 
              className="save-button"
              onClick={handleSave}
              disabled={!hasUnsavedChanges}
            >
              💾 Save Locally
            </button>
          )}
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
              <CursorTrackingPlugin 
                webSocketClient={webSocketClientRef.current}
                currentUser={currentUser}
                documentId={documentId}
                onCursorUpdate={handleCursorUpdate}
              />
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