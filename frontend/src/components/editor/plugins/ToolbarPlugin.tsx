import React, { useCallback, useState, useEffect } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  FORMAT_TEXT_COMMAND,
  FORMAT_ELEMENT_COMMAND,
  UNDO_COMMAND,
  REDO_COMMAND,
  $getSelection,
  $isRangeSelection,
  $createParagraphNode,
  $createTextNode,
  TextFormatType,
  $getRoot,
  ElementFormatType,
  NodeSelection,
  createCommand,
  LexicalCommand,
  COMMAND_PRIORITY_EDITOR,
  LexicalNode,
  $isElementNode,
  ElementNode,
  $getNodeByKey,
} from 'lexical';
import {
  $setBlocksType,
  $patchStyleText,
} from '@lexical/selection';
import {
  HeadingNode,
  QuoteNode,
} from '@lexical/rich-text';
import {
  INSERT_ORDERED_LIST_COMMAND,
  INSERT_UNORDERED_LIST_COMMAND,
  REMOVE_LIST_COMMAND,
  $isListItemNode,
  $createListNode,
  $createListItemNode,
  $isListNode,
  ListNode,
} from '@lexical/list';
import {
  $createTableNodeWithDimensions,
  TableNode,
  TableRowNode,
  TableCellNode,
  $isTableRowNode,
  $isTableCellNode,
} from '@lexical/table';
import { CheckboxNode, $createCheckboxNode, $isCheckboxNode } from '../nodes/CheckboxNode';
import { createPortal } from 'react-dom';
import { INSERT_IMAGE_COMMAND } from './ImagePlugin';
import { INDENT_COMMAND, OUTDENT_COMMAND } from './IndentationPlugin';
import { TEXT_COLOR_COMMAND } from './TextColorPlugin';
import { FONT_SIZE_COMMAND } from './FontSizePlugin';
import { FONT_FAMILY_COMMAND } from './FontFamilyPlugin';
import { ALIGNMENT_FORMAT } from './AlignmentPlugin';
import { QUOTE_COMMAND } from './QuotePlugin';
import {
  BoldIcon,
  ItalicIcon,
  UnderlineIcon,
  StrikethroughIcon,
  ListBulletIcon,
  ArrowPathIcon,
  ArrowUturnLeftIcon,
  ChatBubbleLeftIcon,
  ChevronDownIcon,
  DocumentTextIcon,
  DocumentDuplicateIcon,
  DocumentIcon,
} from '@heroicons/react/24/outline';
import './ToolbarPlugin.css';

// Define the heading tag type
type HeadingTagType = 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';

// Helper function to replace $findMatchingParent
function $findMatchingParent(node: any, predicate: (node: any) => boolean): any {
  let parent = node.getParent();
  while (parent !== null) {
    if (predicate(parent)) {
      return parent;
    }
    parent = parent.getParent();
  }
  return null;
}

// Define additional property for caching text in the checkbox node
interface ExtendedCheckboxNode extends CheckboxNode {
  __cachedText?: string;
}

// Helper function to parse CSS style string
const parseStyleString = (styleString: string): Record<string, string> => {
  const styles: Record<string, string> = {};
  if (!styleString) return styles;
  
  styleString.split(';').forEach(style => {
    const [property, value] = style.split(':').map(s => s.trim());
    if (property && value) {
      styles[property] = value;
    }
  });
  
  return styles;
};

// Helper function to get style value from style string
const getStyleValue = (styleString: string, property: string, defaultValue: string): string => {
  const styles = parseStyleString(styleString);
  return styles[property] || defaultValue;
};

export const ToolbarPlugin: React.FC = () => {
  const [editor] = useLexicalComposerContext();
  const [showTableModal, setShowTableModal] = useState(false);
  const [tableRows, setTableRows] = useState(3);
  const [tableColumns, setTableColumns] = useState(3);
  const [isUnorderedList, setIsUnorderedList] = useState(false);
  const [isOrderedList, setIsOrderedList] = useState(false);
  const [isLink, setIsLink] = useState(false);
  const [isTable, setIsTable] = useState(false);
  const [isImage, setIsImage] = useState(false);
  const [isColorPicker, setIsColorPicker] = useState(false);
  const [isFontSize, setIsFontSize] = useState(false);
  const [isFontFamily, setIsFontFamily] = useState(false);
  const [isBold, setIsBold] = useState(false);
  const [isItalic, setIsItalic] = useState(false);
  const [isUnderline, setIsUnderline] = useState(false);
  const [isStrikethrough, setIsStrikethrough] = useState(false);
  const [isList, setIsList] = useState(false);
  const [isQuote, setIsQuote] = useState(false);
  const [currentColor, setCurrentColor] = useState('#000000');
  const [currentFontSize, setCurrentFontSize] = useState('16px');
  const [currentFontFamily, setCurrentFontFamily] = useState('Arial');
  const [currentAlignment, setCurrentAlignment] = useState('left');
  
  // Track current selection state for proper toggling
  useEffect(() => {
    return editor.registerUpdateListener(({editorState}) => {
      editorState.read(() => {
        const selection = $getSelection();
        if ($isRangeSelection(selection)) {
          // Check if current selection is in a list
          const anchorNode = selection.anchor.getNode();
          const focusNode = selection.focus.getNode();
          
          const anchorListItem = $findMatchingParent(anchorNode, $isListItemNode);
          const focusListItem = $findMatchingParent(focusNode, $isListItemNode);
          
          // Check for list type
          let hasOrderedList = false;
          let hasUnorderedList = false;
          
          if (anchorListItem) {
            const parentList = anchorListItem.getParent();
            if (parentList && $isListNode(parentList)) {
              const listType = parentList.getListType();
              if (listType === 'number') hasOrderedList = true;
              if (listType === 'bullet') hasUnorderedList = true;
            }
          }
          
          setIsOrderedList(hasOrderedList);
          setIsUnorderedList(hasUnorderedList);
        }
      });
    });
  }, [editor]);

  const insertCheckbox = useCallback(() => {
    if (!editor) return;
    
    editor.update(() => {
      const selection = $getSelection();
      
      if ($isRangeSelection(selection)) {
        // Get the selected text or the text from the current line if no selection
        const selectedText = selection.getTextContent();
        
        // Get the top-level elements containing the selection
        const topLevelElements = selection.getNodes().map(node => {
          // Find the top-level element for this node
          let current = node;
          let parent = current.getParent();
          while (parent && parent !== $getRoot()) {
            current = parent;
            parent = current.getParent();
          }
          return current;
        });
        
        // Deduplicate the elements
        const uniqueElements = Array.from(new Set(topLevelElements));
        
        // If no selection was made, get the current paragraph
        if (uniqueElements.length === 0 || (selectedText.trim() === '' && uniqueElements.length === 1)) {
          const anchorNode = selection.anchor.getNode();
          const topLevelElement = anchorNode.getTopLevelElement();
          if (topLevelElement) {
            uniqueElements.push(topLevelElement);
          }
        }
        
        // Process each element
        uniqueElements.forEach(element => {
          if ($isElementNode(element)) {
            // Check if this element already has a checkbox as a direct child
            let hasCheckbox = false;
            const children = element.getChildren();
            
            for (let i = 0; i < children.length; i++) {
              const child = children[i];
              if ($isCheckboxNode(child)) {
                // Remove the checkbox if it already exists
                hasCheckbox = true;
                child.remove();
                break;
              }
            }
            
            // If there was no checkbox, add one
            if (!hasCheckbox) {
              // Get the text content of the element
              const text = element.getTextContent();
              
              // Clear the element and create a checkbox
              element.clear();
              const checkboxNode = $createCheckboxNode(false);
              
              // Add the text to the checkbox
              if (text.trim()) {
                const textNode = $createTextNode(text.trim());
                checkboxNode.append(textNode);
              }
              
              // Add the checkbox to the element
              element.append(checkboxNode);
            }
          }
        });
      }
    });
  }, [editor]);

  const insertLink = useCallback(() => {
    // Simple link insertion
    const url = prompt('Enter URL:');
    if (url) {
      // Just wrap the selected text with a link
      editor.update(() => {
        const selection = $getSelection();
        if ($isRangeSelection(selection)) {
          const selectedText = selection.getTextContent();
          const linkText = selectedText || url;
          const textNode = $createTextNode(linkText);
          textNode.setFormat('underline' as TextFormatType);
          selection.insertNodes([textNode]);
        }
      });
    }
  }, [editor]);

  const insertTable = useCallback(() => {
    setShowTableModal(true);
  }, []);

  const createTable = useCallback(() => {
    editor.update(() => {
      try {
        const selection = $getSelection();
        if ($isRangeSelection(selection)) {
          // Create table with properly initialized cells
          const tableNode = $createTableNodeWithDimensions(tableRows, tableColumns, true);
          
          // Make sure every cell has a paragraph node for editing
          const rows = tableNode.getChildren();
          rows.forEach(row => {
            if ($isTableRowNode(row)) {
              const cells = row.getChildren();
              cells.forEach(cell => {
                if ($isTableCellNode(cell)) {
                  const children = cell.getChildren();
                  if (children.length === 0) {
                    const paragraphNode = $createParagraphNode();
                    cell.append(paragraphNode);
                  }
                }
              });
            }
          });
          
          // Insert the table at the current selection
          selection.insertNodes([tableNode]);
          
          // Add a paragraph after the table for better editing experience
          const paragraphNode = $createParagraphNode();
          tableNode.insertAfter(paragraphNode);
          paragraphNode.select();
        }
      } catch (error) {
        console.error('Error creating table:', error);
      }
    });
    setShowTableModal(false);
  }, [editor, tableRows, tableColumns]);

  const formatHeading = useCallback(
    (headingTag: HeadingTagType) => {
      editor.update(() => {
        const selection = $getSelection();
        if ($isRangeSelection(selection)) {
          $setBlocksType(selection, () => new HeadingNode(headingTag));
        }
      });
    },
    [editor]
  );

  // List toggle handlers with proper toggling behavior
  const toggleUnorderedList = useCallback(() => {
    if (isUnorderedList) {
      // If already in an unordered list, remove it
      editor.dispatchCommand(REMOVE_LIST_COMMAND, undefined);
    } else {
      // If not in an unordered list, create one or convert the existing list
      editor.dispatchCommand(INSERT_UNORDERED_LIST_COMMAND, undefined);
    }
  }, [editor, isUnorderedList]);

  const toggleOrderedList = useCallback(() => {
    if (isOrderedList) {
      // If already in an ordered list, remove it
      editor.dispatchCommand(REMOVE_LIST_COMMAND, undefined);
    } else {
      // If not in an ordered list, create one or convert the existing list
      editor.dispatchCommand(INSERT_ORDERED_LIST_COMMAND, undefined);
    }
  }, [editor, isOrderedList]);

  // Indent/Outdent handlers - direct dispatching to our custom commands
  const indent = useCallback(() => {
    editor.dispatchCommand(INDENT_COMMAND, undefined);
  }, [editor]);

  const outdent = useCallback(() => {
    editor.dispatchCommand(OUTDENT_COMMAND, undefined);
  }, [editor]);

  // Helper function to handle formatting commands
  const formatText = (format: TextFormatType) => {
    editor.dispatchCommand(FORMAT_TEXT_COMMAND, format);
  };

  const formatParagraph = () => {
    editor.update(() => {
      const selection = $getSelection();
      if ($isRangeSelection(selection)) {
        $setBlocksType(selection, () => $createParagraphNode());
      }
    });
  };

  const formatQuote = () => {
    editor.update(() => {
      const selection = $getSelection();
      if ($isRangeSelection(selection)) {
        $setBlocksType(selection, () => new QuoteNode());
      }
    });
  };

  const formatList = (listType: 'number' | 'bullet') => {
    if (listType === 'number') {
      editor.dispatchCommand(INSERT_ORDERED_LIST_COMMAND, undefined);
    } else {
      editor.dispatchCommand(INSERT_UNORDERED_LIST_COMMAND, undefined);
    }
  };

  const formatElement = (format: ElementFormatType) => {
    editor.dispatchCommand(FORMAT_ELEMENT_COMMAND, format);
  };

  const insertImage = () => {
    editor.dispatchCommand(INSERT_IMAGE_COMMAND, {
      altText: 'Image',
      src: 'https://via.placeholder.com/150',
    });
  };

  const setTextColor = (color: string) => {
    editor.dispatchCommand(TEXT_COLOR_COMMAND, color);
  };

  const setFontSize = (size: string) => {
    editor.dispatchCommand(FONT_SIZE_COMMAND, size);
  };

  const setFontFamily = (font: string) => {
    editor.dispatchCommand(FONT_FAMILY_COMMAND, font);
  };

  const updateToolbar = useCallback(() => {
    const selection = $getSelection();
    if ($isRangeSelection(selection)) {
      setIsBold(selection.hasFormat('bold'));
      setIsItalic(selection.hasFormat('italic'));
      setIsUnderline(selection.hasFormat('underline'));
      setIsStrikethrough(selection.hasFormat('strikethrough'));
      setIsList($isListNode(selection.anchor.getNode().getParent()));
      setIsQuote(selection.anchor.getNode().getParent()?.getType() === 'quote');
      
      // Get style values from the selection
      const node = selection.anchor.getNode();
      const styleString = node.getStyle() || '';
      const color = getStyleValue(styleString, 'color', '#000000');
      const fontSize = getStyleValue(styleString, 'font-size', '16px');
      const fontFamily = getStyleValue(styleString, 'font-family', 'Arial');
      const alignment = getStyleValue(styleString, 'text-align', 'left');
      
      setCurrentColor(color);
      setCurrentFontSize(fontSize);
      setCurrentFontFamily(fontFamily);
      setCurrentAlignment(alignment);
    }
  }, []);

  const formatColor = (color: string) => {
    editor.update(() => {
      const selection = $getSelection();
      if ($isRangeSelection(selection)) {
        $patchStyleText(selection, {
          'color': color
        });
      }
    });
  };

  const formatFontSize = (size: string) => {
    editor.update(() => {
      const selection = $getSelection();
      if ($isRangeSelection(selection)) {
        $patchStyleText(selection, {
          'font-size': size
        });
      }
    });
  };

  const formatFontFamily = (family: string) => {
    editor.update(() => {
      const selection = $getSelection();
      if ($isRangeSelection(selection)) {
        $patchStyleText(selection, {
          'font-family': family
        });
      }
    });
  };

  const formatAlignment = (alignment: string) => {
    editor.update(() => {
      const selection = $getSelection();
      if ($isRangeSelection(selection)) {
        $patchStyleText(selection, {
          'text-align': alignment
        });
      }
    });
  };

  const colors = [
    '#000000', '#4A5568', '#718096', '#A0AEC0', '#E2E8F0',
    '#E53E3E', '#F56565', '#FC8181', '#FED7D7',
    '#DD6B20', '#ED8936', '#F6AD55', '#FEEBC8',
    '#D69E2E', '#ECC94B', '#F6E05E', '#FEFCBF',
    '#38A169', '#48BB78', '#68D391', '#C6F6D5',
    '#319795', '#4FD1C5', '#9AE6B4', '#B2F5EA',
    '#3182CE', '#4299E1', '#63B3ED', '#BEE3F8',
    '#5A67D8', '#667EEA', '#7F9CF5', '#C3DAFE',
    '#805AD5', '#9F7AEA', '#B794F4', '#E9D8FD',
  ];

  const fontSizes = [
    '12px', '14px', '16px', '18px', '20px', '24px', '28px', '32px', '36px', '48px'
  ];

  const fontFamilies = [
    'Arial', 'Times New Roman', 'Courier New', 'Georgia', 'Verdana',
    'Helvetica', 'Tahoma', 'Trebuchet MS', 'Impact', 'Comic Sans MS'
  ];

  return (
    <>
      <div className="lexical-editor-toolbar" aria-label="Formatting options">
        <div className="toolbar-group">
          <button
            onClick={() => formatParagraph()}
            className="toolbar-item"
            title="Paragraph"
          >
            <span className="text-sm">P</span>
          </button>
          <button
            onClick={() => formatHeading('h1')}
            className="toolbar-item"
            title="Heading 1"
          >
            <span className="text-sm font-bold">H1</span>
          </button>
          <button
            onClick={() => formatHeading('h2')}
            className="toolbar-item"
            title="Heading 2"
          >
            <span className="text-sm font-bold">H2</span>
          </button>
          <button
            onClick={() => formatHeading('h3')}
            className="toolbar-item"
            title="Heading 3"
          >
            <span className="text-sm font-bold">H3</span>
          </button>
        </div>

        <div className="toolbar-group">
          <button
            onClick={() => formatText('bold')}
            className={`toolbar-item ${isBold ? 'active' : ''}`}
            title="Bold"
          >
            <BoldIcon className="w-5 h-5" />
          </button>
          <button
            onClick={() => formatText('italic')}
            className={`toolbar-item ${isItalic ? 'active' : ''}`}
            title="Italic"
          >
            <ItalicIcon className="w-5 h-5" />
          </button>
          <button
            onClick={() => formatText('underline')}
            className={`toolbar-item ${isUnderline ? 'active' : ''}`}
            title="Underline"
          >
            <UnderlineIcon className="w-5 h-5" />
          </button>
          <button
            onClick={() => formatText('strikethrough')}
            className={`toolbar-item ${isStrikethrough ? 'active' : ''}`}
            title="Strikethrough"
          >
            <StrikethroughIcon className="w-5 h-5" />
          </button>
        </div>

        <div className="toolbar-group">
          <button
            onClick={() => formatList('bullet')}
            className={`toolbar-item ${isList ? 'active' : ''}`}
            title="Bullet List"
          >
            <ListBulletIcon className="w-5 h-5" />
          </button>
          <button
            onClick={() => formatList('number')}
            className={`toolbar-item ${isOrderedList ? 'active' : ''}`}
            title="Numbered List"
          >
            <DocumentDuplicateIcon className="w-5 h-5" />
          </button>
          <button
            onClick={() => formatQuote()}
            className={`toolbar-item ${isQuote ? 'active' : ''}`}
            title="Quote"
          >
            <ChatBubbleLeftIcon className="w-5 h-5" />
          </button>
        </div>

        <div className="toolbar-group">
          <div className="relative">
            <button
              onClick={() => setIsColorPicker(!isColorPicker)}
              className="toolbar-item"
              title="Text Color"
            >
              <div className="w-5 h-5 rounded-full border" style={{ backgroundColor: currentColor }} />
              <ChevronDownIcon className="w-4 h-4 ml-1" />
            </button>
            {isColorPicker && (
              <div className="color-picker-dropdown">
                {colors.map((color) => (
                  <button
                    key={color}
                    className="color-option"
                    style={{ backgroundColor: color }}
                    onClick={() => {
                      formatColor(color);
                      setIsColorPicker(false);
                    }}
                    title={color}
                  />
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="toolbar-group">
          <div className="relative">
            <button
              onClick={() => setIsFontSize(!isFontSize)}
              className="toolbar-item"
              title="Font Size"
            >
              <span className="text-sm">{currentFontSize}</span>
              <ChevronDownIcon className="w-4 h-4 ml-1" />
            </button>
            {isFontSize && (
              <div className="font-size-dropdown">
                {fontSizes.map((size) => (
                  <button
                    key={size}
                    className="font-size-option"
                    onClick={() => {
                      formatFontSize(size);
                      setIsFontSize(false);
                    }}
                    style={{ fontSize: size }}
                  >
                    {size}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="toolbar-group">
          <div className="relative">
            <button
              onClick={() => setIsFontFamily(!isFontFamily)}
              className="toolbar-item"
              title="Font Family"
            >
              <span className="text-sm">{currentFontFamily}</span>
              <ChevronDownIcon className="w-4 h-4 ml-1" />
            </button>
            {isFontFamily && (
              <div className="font-family-dropdown">
                {fontFamilies.map((family) => (
                  <button
                    key={family}
                    className="font-family-option"
                    onClick={() => {
                      formatFontFamily(family);
                      setIsFontFamily(false);
                    }}
                    style={{ fontFamily: family }}
                  >
                    {family}
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="toolbar-group">
          <button
            onClick={() => formatElement('left')}
            className={`toolbar-item ${currentAlignment === 'left' ? 'active' : ''}`}
            title="Align Left"
          >
            <DocumentTextIcon className="w-5 h-5" />
          </button>
          <button
            onClick={() => formatElement('center')}
            className={`toolbar-item ${currentAlignment === 'center' ? 'active' : ''}`}
            title="Align Center"
          >
            <DocumentIcon className="w-5 h-5" />
          </button>
          <button
            onClick={() => formatElement('right')}
            className={`toolbar-item ${currentAlignment === 'right' ? 'active' : ''}`}
            title="Align Right"
          >
            <DocumentTextIcon className="w-5 h-5 transform rotate-180" />
          </button>
        </div>

        <div className="toolbar-group">
          <button
            onClick={() => editor.dispatchCommand(UNDO_COMMAND, undefined)}
            className="toolbar-item"
            title="Undo"
          >
            <ArrowUturnLeftIcon className="w-5 h-5" />
          </button>
          <button
            onClick={() => editor.dispatchCommand(REDO_COMMAND, undefined)}
            className="toolbar-item"
            title="Redo"
          >
            <ArrowPathIcon className="w-5 h-5" />
          </button>
        </div>
      </div>

      {/* Table Modal */}
      {showTableModal && createPortal(
        <div className="table-modal-overlay" onClick={() => setShowTableModal(false)}>
          <div className="table-modal" onClick={(e) => e.stopPropagation()}>
            <h3>Insert Table</h3>
            <div className="table-size-controls">
              <label>
                Rows:
                <input
                  type="number"
                  min="1"
                  max="20"
                  value={tableRows}
                  onChange={(e) => setTableRows(Number(e.target.value))}
                />
              </label>
              <label>
                Columns:
                <input
                  type="number"
                  min="1"
                  max="10"
                  value={tableColumns}
                  onChange={(e) => setTableColumns(Number(e.target.value))}
                />
              </label>
            </div>
            <div className="table-controls">
              <button onClick={createTable} className="lexical-toolbar-button">Create</button>
              <button onClick={() => setShowTableModal(false)} className="lexical-toolbar-button">Cancel</button>
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  );
};