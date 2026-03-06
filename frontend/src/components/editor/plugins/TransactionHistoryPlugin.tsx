/**
 * TransactionHistoryPlugin — a custom Lexical plugin that wraps the built-in
 * HistoryPlugin and intercepts Ctrl+Z / Ctrl+Y to delegate to the
 * TransactionManager when the user is idle (no active transaction).
 *
 * Behavior:
 * - While a transaction is active (user is typing): Ctrl+Z/Y works at
 *   keystroke-level via Lexical's native HistoryPlugin.
 * - When no transaction is active (idle):
 *   - Ctrl+Z pops the most recent transaction from the TransactionManager's
 *     undo stack, reverts editor state to the pre-transaction snapshot,
 *     removes decorations, and fires the onTransactionUndone callback.
 *   - Ctrl+Y re-applies the undone transaction, restores editor state to the
 *     post-transaction snapshot, re-applies decorations, and fires the
 *     onTransactionRedone callback.
 * - Only affects current user's transactions from the current session.
 */

import { useEffect } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin';
import {
  UNDO_COMMAND,
  REDO_COMMAND,
  COMMAND_PRIORITY_HIGH,
} from 'lexical';
import { TransactionManager, Transaction } from '../../../services/transactionManager';
import {
  removeDecorationsForChange,
  addDecorationsForChange,
  TrackedChange,
} from './TrackedChangesPlugin';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface TransactionHistoryPluginProps {
  /** The TransactionManager instance managing the current editing session. */
  transactionManager: TransactionManager | null;

  /**
   * Optional callback fired after a transaction-level undo succeeds.
   * The parent can use this to broadcast a WebSocket event.
   */
  onTransactionUndone?: (transaction: Transaction) => void;

  /**
   * Optional callback fired after a transaction-level redo succeeds.
   * The parent can use this to broadcast a WebSocket event.
   */
  onTransactionRedone?: (transaction: Transaction) => void;
}

// ---------------------------------------------------------------------------
// Inner hook that registers Lexical command handlers
// ---------------------------------------------------------------------------

function useTransactionHistory({
  transactionManager,
  onTransactionUndone,
  onTransactionRedone,
}: TransactionHistoryPluginProps): void {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    if (!transactionManager) {
      return;
    }

    // Register UNDO handler at HIGH priority so it fires before the
    // built-in HistoryPlugin's NORMAL priority handler.
    const removeUndoListener = editor.registerCommand(
      UNDO_COMMAND,
      () => {
        // If there is an active transaction, let Lexical's native history
        // handle keystroke-level undo.
        if (transactionManager.getActiveTransaction() !== null) {
          return false;
        }

        // No active transaction — attempt transaction-level undo.
        const undoneTransaction = transactionManager.undo();
        if (!undoneTransaction) {
          // Nothing on the undo stack — let Lexical handle it (may be a no-op).
          return false;
        }

        // Revert editor state to the pre-transaction snapshot.
        const beforeState = undoneTransaction.beforeSnapshot.lexicalState;
        const stateJson =
          typeof beforeState === 'string'
            ? beforeState
            : JSON.stringify(beforeState);

        try {
          const editorState = editor.parseEditorState(stateJson);
          editor.setEditorState(editorState);
        } catch (err) {
          console.error(
            'TransactionHistoryPlugin: failed to revert editor state on undo',
            err,
          );
        }

        // Remove decorations for the undone change.
        if (undoneTransaction.remoteChangeId) {
          removeDecorationsForChange(undoneTransaction.remoteChangeId);
        }

        // Notify parent (e.g. for WebSocket broadcast).
        onTransactionUndone?.(undoneTransaction);

        // Return true to prevent Lexical's built-in HistoryPlugin from
        // also handling this undo command.
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );

    // Register REDO handler at HIGH priority.
    const removeRedoListener = editor.registerCommand(
      REDO_COMMAND,
      () => {
        // If there is an active transaction, let Lexical's native history
        // handle keystroke-level redo.
        if (transactionManager.getActiveTransaction() !== null) {
          return false;
        }

        // No active transaction — attempt transaction-level redo.
        const redoneTransaction = transactionManager.redo();
        if (!redoneTransaction) {
          // Nothing on the redo stack — let Lexical handle it.
          return false;
        }

        // Restore editor state to the post-transaction snapshot.
        const afterSnapshot = redoneTransaction.afterSnapshot;
        if (afterSnapshot) {
          const afterState = afterSnapshot.lexicalState;
          const stateJson =
            typeof afterState === 'string'
              ? afterState
              : JSON.stringify(afterState);

          try {
            const editorState = editor.parseEditorState(stateJson);
            editor.setEditorState(editorState);
          } catch (err) {
            console.error(
              'TransactionHistoryPlugin: failed to restore editor state on redo',
              err,
            );
          }
        }

        // Re-apply decorations for the redone change.
        if (redoneTransaction.remoteChangeId && redoneTransaction.afterSnapshot) {
          const change: TrackedChange = {
            id: redoneTransaction.remoteChangeId,
            field: redoneTransaction.field,
            oldValue: redoneTransaction.beforeSnapshot.text,
            newValue: redoneTransaction.afterSnapshot.text,
            changedBy: '', // Current user — decorations will pick up color from context
            status: 'pending',
          };
          addDecorationsForChange(change, editor);
        }

        // Notify parent (e.g. for WebSocket broadcast).
        onTransactionRedone?.(redoneTransaction);

        // Return true to prevent Lexical's built-in HistoryPlugin.
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );

    return () => {
      removeUndoListener();
      removeRedoListener();
    };
  }, [editor, transactionManager, onTransactionUndone, onTransactionRedone]);
}

// ---------------------------------------------------------------------------
// Plugin component
// ---------------------------------------------------------------------------

/**
 * TransactionHistoryPlugin — drop-in replacement for Lexical's HistoryPlugin.
 *
 * Renders the built-in HistoryPlugin internally (for keystroke-level history
 * during active transactions) and layers transaction-level undo/redo on top
 * via HIGH-priority command handlers.
 *
 * When transactionManager is null (e.g. read-only mode or no tracked changes),
 * this behaves identically to the built-in HistoryPlugin.
 */
export default function TransactionHistoryPlugin(
  props: TransactionHistoryPluginProps,
): JSX.Element {
  useTransactionHistory(props);

  // Render the built-in HistoryPlugin so that keystroke-level undo/redo
  // still works during active editing. Our HIGH-priority handlers only
  // intercept when no transaction is active.
  return <HistoryPlugin />;
}
