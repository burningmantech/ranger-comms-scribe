import React, { useCallback, useEffect, useState } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  $getSelection,
  $isRangeSelection,
  COMMAND_PRIORITY_LOW,
  SELECTION_CHANGE_COMMAND,
  LexicalNode,
} from 'lexical';
import { 
  $isTableNode, 
  $isTableCellNode, 
  TableNode,
  TableCellNode
} from '@lexical/table';
import {
  ADD_TABLE_COLUMN_COMMAND,
  ADD_TABLE_ROW_COMMAND,
  DELETE_TABLE_COLUMN_COMMAND,
  DELETE_TABLE_ROW_COMMAND
} from './TablePlugin';
import '../styles/TableControlsPlugin.css';

function $findTableNodeFromCellNode(cellNode: TableCellNode): TableNode | null {
  const node = cellNode.getParent()?.getParent();
  return $isTableNode(node) ? node as TableNode : null;
}

export function TableControlsPlugin(): React.ReactElement | null {
  const [editor] = useLexicalComposerContext();
  const [activeTableNode, setActiveTableNode] = useState<TableNode | null>(null);
  const [selectedCellNode, setSelectedCellNode] = useState<TableCellNode | null>(null);
  const [tableControlsVisible, setTableControlsVisible] = useState<boolean>(false);
  const [controlsPosition, setControlsPosition] = useState<{
    left: number;
    top: number;
  }>({ left: 0, top: 0 });

  const updateTableControlsPosition = useCallback(() => {
    if (!selectedCellNode) return;

    const tableCellDOM = editor.getElementByKey(selectedCellNode.getKey());
    if (!tableCellDOM) return;

    const rect = tableCellDOM.getBoundingClientRect();
    const editorElem = editor.getRootElement();
    const editorRect = editorElem?.getBoundingClientRect();

    if (!editorRect) return;

    setControlsPosition({
      left: rect.right - editorRect.left,
      top: rect.top - editorRect.top,
    });
    
    setTableControlsVisible(true);
  }, [editor, selectedCellNode]);

  const hideTableControls = useCallback(() => {
    setTableControlsVisible(false);
    setActiveTableNode(null);
    setSelectedCellNode(null);
  }, []);

  // Find table and cell when selection changes
  useEffect(() => {
    return editor.registerCommand(
      SELECTION_CHANGE_COMMAND,
      () => {
        const selection = $getSelection();
        
        if (!$isRangeSelection(selection)) {
          hideTableControls();
          return false;
        }

        const node = selection.anchor.getNode();
        let cellNode: LexicalNode | null = node;
        
        while (cellNode && !$isTableCellNode(cellNode)) {
          cellNode = cellNode.getParent();
        }
        
        if (!cellNode) {
          hideTableControls();
          return false;
        }
        
        const tableNode = $findTableNodeFromCellNode(cellNode as TableCellNode);
        
        if (!tableNode) {
          hideTableControls();
          return false;
        }
        
        setActiveTableNode(tableNode);
        setSelectedCellNode(cellNode as TableCellNode);
        updateTableControlsPosition();
        
        return false;
      },
      COMMAND_PRIORITY_LOW
    );
  }, [editor, hideTableControls, updateTableControlsPosition]);

  // Update position when window is resized
  useEffect(() => {
    const updatePosition = () => {
      if (selectedCellNode) {
        updateTableControlsPosition();
      }
    };

    window.addEventListener('resize', updatePosition);
    return () => {
      window.removeEventListener('resize', updatePosition);
    };
  }, [selectedCellNode, updateTableControlsPosition]);

  // Row manipulation handlers
  const addRowAbove = useCallback(() => {
    if (!activeTableNode) return;
    
    editor.dispatchCommand(ADD_TABLE_ROW_COMMAND, { 
      tableNode: activeTableNode, 
      insertAfter: false 
    });
  }, [editor, activeTableNode]);

  const addRowBelow = useCallback(() => {
    if (!activeTableNode) return;
    
    editor.dispatchCommand(ADD_TABLE_ROW_COMMAND, {
      tableNode: activeTableNode,
      insertAfter: true
    });
  }, [editor, activeTableNode]);

  const deleteRow = useCallback(() => {
    if (!activeTableNode) return;
    
    editor.dispatchCommand(DELETE_TABLE_ROW_COMMAND, {
      tableNode: activeTableNode
    });
  }, [editor, activeTableNode]);

  // Column manipulation handlers
  const addColumnLeft = useCallback(() => {
    if (!activeTableNode) return;
    
    editor.dispatchCommand(ADD_TABLE_COLUMN_COMMAND, {
      tableNode: activeTableNode,
      insertAfter: false
    });
  }, [editor, activeTableNode]);

  const addColumnRight = useCallback(() => {
    if (!activeTableNode) return;
    
    editor.dispatchCommand(ADD_TABLE_COLUMN_COMMAND, {
      tableNode: activeTableNode,
      insertAfter: true
    });
  }, [editor, activeTableNode]);

  const deleteColumn = useCallback(() => {
    if (!activeTableNode) return;
    
    editor.dispatchCommand(DELETE_TABLE_COLUMN_COMMAND, {
      tableNode: activeTableNode
    });
  }, [editor, activeTableNode]);

  const deleteTable = useCallback(() => {
    if (!activeTableNode) return;
    
    editor.update(() => {
      // Create a paragraph to replace the table
      const paragraph = document.createElement('p');
      
      // Remove the table
      activeTableNode.remove();
      hideTableControls();
    });
  }, [editor, activeTableNode, hideTableControls]);

  if (!tableControlsVisible || !activeTableNode) {
    return null;
  }

  return (
    <div 
      className="table-controls-plugin" 
      style={{
        position: 'absolute',
        left: `${controlsPosition.left}px`,
        top: `${controlsPosition.top}px`
      }}
    >
      <div className="table-controls-menu">
        <div className="table-controls-section">
          <button className="table-control-button" onClick={addRowAbove} title="Add row above">
            <span>➕ Row ↑</span>
          </button>
          <button className="table-control-button" onClick={addRowBelow} title="Add row below">
            <span>➕ Row ↓</span>
          </button>
          <button className="table-control-button" onClick={deleteRow} title="Delete row">
            <span>❌ Row</span>
          </button>
        </div>
        <div className="table-controls-section">
          <button className="table-control-button" onClick={addColumnLeft} title="Add column left">
            <span>➕ Col ←</span>
          </button>
          <button className="table-control-button" onClick={addColumnRight} title="Add column right">
            <span>➕ Col →</span>
          </button>
          <button className="table-control-button" onClick={deleteColumn} title="Delete column">
            <span>❌ Col</span>
          </button>
        </div>
        <div className="table-controls-section delete-table">
          <button className="table-control-button delete-table" onClick={deleteTable} title="Delete table">
            <span>❌ Table</span>
          </button>
        </div>
      </div>
    </div>
  );
}