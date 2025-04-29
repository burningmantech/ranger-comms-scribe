/**
 * IndentationPlugin.tsx - Improved implementation with proper persistence
 */
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { useEffect } from 'react';
import {
  $getSelection,
  $isRangeSelection,
  $isParagraphNode,
  $isElementNode,
  COMMAND_PRIORITY_HIGH,
  COMMAND_PRIORITY_EDITOR,
  COMMAND_PRIORITY_CRITICAL,
  createCommand,
  LexicalCommand,
  LexicalNode,
  ElementNode,
  $getRoot,
  KEY_TAB_COMMAND,
  KEY_MODIFIER_COMMAND,
  TextNode,
} from 'lexical';
import { $isListItemNode, $isListNode } from '@lexical/list';
import { mergeRegister } from '@lexical/utils';

// Create commands
export const INDENT_COMMAND: LexicalCommand<void> = createCommand('INDENT_COMMAND');
export const OUTDENT_COMMAND: LexicalCommand<void> = createCommand('OUTDENT_COMMAND');

// Indentation size in pixels
const INDENT_SIZE = 40;
const MAX_INDENT_LEVEL = 5;

// Helper to safely get an attribute with type checking
function getNodeIndent(node: ElementNode): number {
  try {
    // Try using the standard Lexical API first
    if (typeof node.getIndent === 'function') {
      return node.getIndent() || 0;
    }
    
    // Fallback to attribute-based approach
    const indentAttr = (node as any).getAttributes?.()?.['indent'];
    return indentAttr ? parseInt(indentAttr, 10) : 0;
  } catch (e) {
    console.error('Error getting indent attribute:', e);
    return 0;
  }
}

// Helper to safely set indent attribute
function setNodeIndent(node: ElementNode, level: number): void {
  try {
    if (typeof node.setIndent === 'function') {
      node.setIndent(level);
    } else if (typeof (node as any).getAttributes === 'function' && typeof (node as any).setAttributes === 'function') {
      // Fallback method if setIndent isn't available
      const existingAttrs = (node as any).getAttributes() || {};
      const newAttrs = { ...existingAttrs };
      
      if (level <= 0) {
        delete newAttrs['indent'];
        delete newAttrs['data-indent'];
      } else {
        newAttrs['indent'] = level;
        newAttrs['data-indent'] = `${level}`;
      }
      
      (node as any).setAttributes(newAttrs);
      
      // Force re-render to make the indentation visible
      const key = node.getKey();
      if (key) {
        setTimeout(() => {
          const element = document.querySelector(`[data-lexical-node-key="${key}"]`);
          if (element && element instanceof HTMLElement) {
            element.style.paddingLeft = level <= 0 ? '' : `${level * INDENT_SIZE}px`;
            element.setAttribute('data-indent', `${level}`);
          }
        }, 0);
      }
    }
  } catch (e) {
    console.error('Error setting indent attribute:', e);
  }
}

// Find the indentable element (paragraph, list item, etc.)
function findIndentableElement(node: LexicalNode): ElementNode | null {
  let currentNode: LexicalNode | null = node;
  
  while (currentNode !== null) {
    if ($isElementNode(currentNode)) {
      // Check for specific node types that can be indented
      if (
        $isParagraphNode(currentNode) || 
        $isListItemNode(currentNode) ||
        // Handle the CheckboxNode case - check if it has a "type" that includes "checkbox"
        ((currentNode as any).getType && (currentNode as any).getType() === 'checkbox')
      ) {
        return currentNode;
      }
    }
    currentNode = currentNode.getParent();
  }
  
  return null;
}

export function IndentationPlugin(): null {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    // Add CSS stylesheet for indentation
    const styleEl = document.createElement('style');
    styleEl.textContent = `
      /* Indentation styles with highest specificity */
      /* Apply to all elements with data-indent attribute */
      [data-lexical-editor] [data-indent="1"],
      [data-lexical-editor] li[data-indent="1"],
      [data-lexical-editor] p[data-indent="1"],
      [data-indent="1"] {
        padding-left: ${INDENT_SIZE}px !important;
        margin-left: 0 !important;
      }
      
      [data-lexical-editor] [data-indent="2"],
      [data-lexical-editor] li[data-indent="2"],
      [data-lexical-editor] p[data-indent="2"],
      [data-indent="2"] {
        padding-left: ${INDENT_SIZE * 2}px !important;
        margin-left: 0 !important;
      }
      
      [data-lexical-editor] [data-indent="3"],
      [data-lexical-editor] li[data-indent="3"],
      [data-lexical-editor] p[data-indent="3"],
      [data-indent="3"] {
        padding-left: ${INDENT_SIZE * 3}px !important;
        margin-left: 0 !important;
      }
      
      [data-lexical-editor] [data-indent="4"],
      [data-lexical-editor] li[data-indent="4"],
      [data-lexical-editor] p[data-indent="4"],
      [data-indent="4"] {
        padding-left: ${INDENT_SIZE * 4}px !important;
        margin-left: 0 !important;
      }
      
      [data-lexical-editor] [data-indent="5"],
      [data-lexical-editor] li[data-indent="5"],
      [data-lexical-editor] p[data-indent="5"],
      [data-indent="5"] {
        padding-left: ${INDENT_SIZE * 5}px !important;
        margin-left: 0 !important;
      }
      
      /* Specific styles for list items */
      [data-lexical-editor] ul li[data-indent],
      [data-lexical-editor] ol li[data-indent] {
        margin-left: ${INDENT_SIZE}px !important;
      }

      /* Specific styles for checkboxes */
      [data-lexical-editor] .checkbox[data-indent="1"],
      .checkbox[data-indent="1"] {
        padding-left: ${INDENT_SIZE}px !important;
        margin-left: 0 !important;
      }
      
      [data-lexical-editor] .checkbox[data-indent="2"],
      .checkbox[data-indent="2"] {
        padding-left: ${INDENT_SIZE * 2}px !important;
        margin-left: 0 !important;
      }
      
      [data-lexical-editor] .checkbox[data-indent="3"],
      .checkbox[data-indent="3"] {
        padding-left: ${INDENT_SIZE * 3}px !important;
        margin-left: 0 !important;
      }
      
      [data-lexical-editor] .checkbox[data-indent="4"],
      .checkbox[data-indent="4"] {
        padding-left: ${INDENT_SIZE * 4}px !important;
        margin-left: 0 !important;
      }
      
      [data-lexical-editor] .checkbox[data-indent="5"],
      .checkbox[data-indent="5"] {
        padding-left: ${INDENT_SIZE * 5}px !important;
        margin-left: 0 !important;
      }
      
      /* Ensure these styles work for classic editor indentation attribute as well */
      [data-lexical-editor] [class*="indent"],
      [data-lexical-editor] .editor-indent-1 {
        padding-left: ${INDENT_SIZE}px !important;
      }
      
      [data-lexical-editor] .editor-indent-2 {
        padding-left: ${INDENT_SIZE * 2}px !important;
      }
      
      [data-lexical-editor] .editor-indent-3 {
        padding-left: ${INDENT_SIZE * 3}px !important;
      }
      
      [data-lexical-editor] .editor-indent-4 {
        padding-left: ${INDENT_SIZE * 4}px !important;
      }
      
      [data-lexical-editor] .editor-indent-5 {
        padding-left: ${INDENT_SIZE * 5}px !important;
      }
    `;
    document.head.appendChild(styleEl);

    // Indent command implementation
    function onIndent() {
      editor.update(() => {
        const selection = $getSelection();
        
        if (!$isRangeSelection(selection)) {
          return false;
        }
        
        const selectedNodes = selection.getNodes();
        
        if (selectedNodes.length === 0) {
          const anchorNode = selection.anchor.getNode();
          
          if (anchorNode) {
            // Find an indentable element (paragraph, list item, checkbox, etc.)
            const elementNode = findIndentableElement(anchorNode);
            
            if (elementNode) {
              const currentIndent = getNodeIndent(elementNode);
              const newIndent = Math.min(currentIndent + 1, MAX_INDENT_LEVEL);
              
              setNodeIndent(elementNode, newIndent);
              return true;
            }
          }
          
          return false;
        }

        // Handle multiple selected nodes
        let success = false;
        selectedNodes.forEach(node => {
          // Find an indentable element
          const elementNode = findIndentableElement(node);
          
          if (elementNode) {
            const currentIndent = getNodeIndent(elementNode);
            const newIndent = Math.min(currentIndent + 1, MAX_INDENT_LEVEL);
            
            setNodeIndent(elementNode, newIndent);
            success = true;
          }
        });

        return success;
      });
      
      return true;
    }

    // Outdent command implementation
    function onOutdent() {
      editor.update(() => {
        const selection = $getSelection();
        
        if (!$isRangeSelection(selection)) {
          return false;
        }
        
        const selectedNodes = selection.getNodes();
        
        if (selectedNodes.length === 0) {
          const anchorNode = selection.anchor.getNode();
          
          if (anchorNode) {
            // Find an indentable element
            const elementNode = findIndentableElement(anchorNode);
            
            if (elementNode) {
              const currentIndent = getNodeIndent(elementNode);
              
              if (currentIndent > 0) {
                setNodeIndent(elementNode, currentIndent - 1);
                return true;
              }
            }
          }
          
          return false;
        }

        // Handle multiple selected nodes
        let success = false;
        selectedNodes.forEach(node => {
          // Find an indentable element
          const elementNode = findIndentableElement(node);
          
          if (elementNode) {
            const currentIndent = getNodeIndent(elementNode);
            
            if (currentIndent > 0) {
              setNodeIndent(elementNode, currentIndent - 1);
              success = true;
            }
          }
        });

        return success;
      });
      
      return true;
    }

    // Function to handle keyboard events directly
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!event.target) {
        return false;
      }
      
      const target = event.target as Element;
      const isInEditor = target.closest('[contenteditable="true"]') !== null;
      
      if (!isInEditor) {
        return false;
      }
      
      if (event.metaKey || event.ctrlKey) {
        if (event.key === ']') {
          event.preventDefault();
          event.stopPropagation();
          onIndent();
          return true;
        } else if (event.key === '[') {
          event.preventDefault();
          event.stopPropagation();
          onOutdent();
          return true;
        }
      } else if (event.key === 'Tab') {
        if (event.shiftKey) {
          event.preventDefault();
          event.stopPropagation();
          onOutdent();
          return true;
        } else {
          event.preventDefault();
          event.stopPropagation();
          onIndent();
          return true;
        }
      }
      
      return false;
    };

    // Add event listener with capture phase to ensure we get the event first
    document.addEventListener('keydown', handleKeyDown, true);

    // Register commands
    const removeListeners = mergeRegister(
      // INDENT_COMMAND 
      editor.registerCommand(
        INDENT_COMMAND,
        () => {
          return onIndent();
        },
        COMMAND_PRIORITY_CRITICAL
      ),
      
      // OUTDENT_COMMAND
      editor.registerCommand(
        OUTDENT_COMMAND,
        () => {
          return onOutdent();
        },
        COMMAND_PRIORITY_CRITICAL
      ),
      
      // TAB key
      editor.registerCommand(
        KEY_TAB_COMMAND,
        (event: KeyboardEvent) => {
          if (event.shiftKey) {
            event.preventDefault();
            return onOutdent();
          } else {
            event.preventDefault();
            return onIndent();
          }
        },
        COMMAND_PRIORITY_CRITICAL
      ),
      
      // MODIFIER keys (Cmd/Ctrl + [ or ])
      editor.registerCommand(
        KEY_MODIFIER_COMMAND,
        (payload) => {
          const event = payload as KeyboardEvent;
          
          if (event.metaKey || event.ctrlKey) {
            if (event.key === ']') {
              event.preventDefault();
              return onIndent();
            } else if (event.key === '[') {
              event.preventDefault();
              return onOutdent();
            }
          }
          return false;
        },
        COMMAND_PRIORITY_CRITICAL
      )
    );

    return () => {
      removeListeners();
      document.removeEventListener('keydown', handleKeyDown, true);
      if (styleEl.parentNode) document.head.removeChild(styleEl);
    };
  }, [editor]);

  return null;
}