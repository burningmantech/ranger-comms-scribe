import React from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { TableNode, TableCellNode, TableRowNode } from '@lexical/table';
import { useEffect } from 'react';
import {
  $createParagraphNode,
  $insertNodes,
  $isRangeSelection,
  COMMAND_PRIORITY_EDITOR,
  createCommand,
  LexicalCommand,
  $getNodeByKey,
  ElementNode,
  TextNode,
  RangeSelection,
} from 'lexical';
import { 
  $createTableNodeWithDimensions, 
  $isTableNode,
  $isTableCellNode,
  $isTableRowNode
} from '@lexical/table';
import { INSERT_TABLE_COMMAND } from '@lexical/table';
import { mergeRegister } from '@lexical/utils';
import { $getSelection, $setSelection } from 'lexical';

export type InsertTableCommandPayload = {
  columns: number;
  rows: number;
  includeHeaders?: boolean;
};

// Add these missing functions
function $createTableRowNode(): TableRowNode {
  return new TableRowNode();
}

function $createTableCellNode(headerState: boolean): TableCellNode {
  // Convert boolean to number (0 = false, 1 = true) as the constructor expects a number
  const cellNode = new TableCellNode(headerState ? 1 : 0);
  return cellNode;
}

// Command for adding a column to a table
export const ADD_TABLE_COLUMN_COMMAND: LexicalCommand<{
  tableNode: TableNode;
  insertAfter: boolean;
}> = createCommand();

// Command for adding a row to a table
export const ADD_TABLE_ROW_COMMAND: LexicalCommand<{
  tableNode: TableNode;
  insertAfter: boolean;
}> = createCommand();

// Command for deleting a column from a table
export const DELETE_TABLE_COLUMN_COMMAND: LexicalCommand<{
  tableNode: TableNode;
}> = createCommand();

// Command for deleting a row from a table
export const DELETE_TABLE_ROW_COMMAND: LexicalCommand<{
  tableNode: TableNode;
}> = createCommand();

export function TablePlugin(): React.ReactElement | null {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    if (
      !editor.hasNodes([TableNode, TableCellNode, TableRowNode])
    ) {
      throw new Error('TablePlugin: TableNode, TableCellNode, or TableRowNode not registered on editor');
    }

    return mergeRegister(
      // Register the INSERT_TABLE_COMMAND
      editor.registerCommand<InsertTableCommandPayload>(
        INSERT_TABLE_COMMAND,
        ({ columns, rows, includeHeaders }) => {
          const tableNode = $createTableNodeWithDimensions(
            rows,
            columns,
            includeHeaders ?? true
          );
          
          const selection = $isRangeSelection($getSelection())
            ? $getSelection() as RangeSelection
            : null;
            
          if (selection !== null) {
            const focusNode = selection.focus.getNode();
            focusNode.insertAfter(tableNode);
            const paragraphNode = $createParagraphNode();
            tableNode.insertAfter(paragraphNode);
            paragraphNode.select();
          }
          
          return true;
        },
        COMMAND_PRIORITY_EDITOR
      ),
      
      // Register command to add a column to a table
      editor.registerCommand(
        ADD_TABLE_COLUMN_COMMAND,
        ({tableNode, insertAfter}) => {
          editor.update(() => {
            const rows = tableNode.getChildren();
            
            rows.forEach((row) => {
              if (!$isTableRowNode(row)) {
                return;
              }
              
              const cells = row.getChildren();
              const cellCount = cells.length;
              
              if (cellCount === 0) {
                return;
              }
              
              const refCell = insertAfter ? cells.at(cellCount - 1) : cells.at(0);
              
              if (!refCell || !$isTableCellNode(refCell)) {
                return;
              }
              
              const newCell = $createTableCellNode(
                // Convert the header style number to boolean
                refCell.getHeaderStyles() === 1
              );
              
              newCell.append($createParagraphNode());
              
              if (insertAfter) {
                refCell.insertAfter(newCell);
              } else {
                refCell.insertBefore(newCell);
              }
            });
          });
          
          return true;
        },
        COMMAND_PRIORITY_EDITOR
      ),
      
      // Register command to add a row to a table
      editor.registerCommand(
        ADD_TABLE_ROW_COMMAND,
        ({tableNode, insertAfter}) => {
          editor.update(() => {
            const rows = tableNode.getChildren();
            const rowCount = rows.length;
            
            if (rowCount === 0) {
              return;
            }
            
            const refRow = insertAfter ? rows.at(rowCount - 1) : rows.at(0);
            
            if (!refRow || !$isTableRowNode(refRow)) {
              return;
            }
            
            const newRow = $createTableRowNode();
            
            refRow.getChildren().forEach((cell) => {
              if (!$isTableCellNode(cell)) {
                return;
              }
              
              const newCell = $createTableCellNode(
                // Don't copy header state when creating a new row
                // Convert the header style number to boolean
                insertAfter ? false : cell.getHeaderStyles() === 1
              );
              
              newCell.append($createParagraphNode());
              newRow.append(newCell);
            });
            
            if (insertAfter) {
              refRow.insertAfter(newRow);
            } else {
              refRow.insertBefore(newRow);
            }
          });
          
          return true;
        },
        COMMAND_PRIORITY_EDITOR
      ),
      
      // Register command to delete a column from a table
      editor.registerCommand(
        DELETE_TABLE_COLUMN_COMMAND,
        ({tableNode}) => {
          editor.update(() => {
            const selection = $getSelection();
            if (!$isRangeSelection(selection) || !selection.anchor.getNode) {
              return false;
            }
            
            let anchorCell = selection.anchor.getNode() as ElementNode | TextNode;
            while (anchorCell !== null && !$isTableCellNode(anchorCell)) {
              const parent = anchorCell.getParent();
              if (parent === null) break;
              anchorCell = parent;
            }
            
            if (!$isTableCellNode(anchorCell)) {
              return false;
            }
            
            const rows = tableNode.getChildren();
            const columnIndex = anchorCell.getIndexWithinParent();
            
            rows.forEach((row) => {
              if (!$isTableRowNode(row)) {
                return;
              }
              
              const cells = row.getChildren();
              if (cells.length <= 1) {
                // Don't delete the last column
                return;
              }
              
              const cell = cells.at(columnIndex);
              if (cell) {
                cell.remove();
              }
            });
          });
          
          return true;
        },
        COMMAND_PRIORITY_EDITOR
      ),
      
      // Register command to delete a row from a table
      editor.registerCommand(
        DELETE_TABLE_ROW_COMMAND,
        ({tableNode}) => {
          editor.update(() => {
            const selection = $getSelection();
            if (!$isRangeSelection(selection) || !selection.anchor.getNode) {
              return false;
            }
            
            let anchorCell = selection.anchor.getNode() as ElementNode | TextNode;
            while (anchorCell !== null && !$isTableCellNode(anchorCell)) {
              const parent = anchorCell.getParent();
              if (parent === null) break;
              anchorCell = parent;
            }
            
            if (!$isTableCellNode(anchorCell)) {
              return false;
            }
            
            const rows = tableNode.getChildren();
            if (rows.length <= 1) {
              // Don't delete the last row
              return false;
            }
            
            const row = anchorCell.getParent();
            if ($isTableRowNode(row)) {
              row.remove();
            }
          });
          
          return true;
        },
        COMMAND_PRIORITY_EDITOR
      )
    );
  }, [editor]);

  return null;
}