/**
 * DeletionInterceptionPlugin
 *
 * In tracked-changes mode, the user should never actually delete text from the
 * Lexical editor.  Instead, when they press Backspace / Delete (or select-all +
 * delete, etc.), we:
 *
 *   1. Read the selected text (or the character that *would* be deleted).
 *   2. Wrap that text in a DeletedTextNode — a DecoratorNode that renders the
 *      original text with a strikethrough style.
 *   3. Move the cursor past the DeletedTextNode so subsequent typing is normal.
 *   4. Return `true` from the command handler so Lexical does NOT remove the text.
 *
 * IMPORTANT: Tree-mutating operations (splitText, insertBefore, remove) are
 * deferred to a clean `editor.update()` via `setTimeout(…, 0)` because:
 *   – On macOS, `event.preventDefault()` on `keydown` does NOT reliably prevent
 *     the `beforeinput` event from firing.
 *   – If we modify the tree inside the command handler AND `beforeinput` fires,
 *     Lexical attempts a second DOM reconciliation on the already-modified tree,
 *     causing error #19.
 *   – By deferring to the next microtask, the modification happens in a fresh
 *     update cycle after all native events have been processed.
 */

import { useEffect } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
    $getSelection,
    $isRangeSelection,
    $isTextNode,
    $getNodeByKey,
    $isElementNode,
    KEY_BACKSPACE_COMMAND,
    KEY_DELETE_COMMAND,
    DELETE_CHARACTER_COMMAND,
    DELETE_WORD_COMMAND,
    DELETE_LINE_COMMAND,
    COMMAND_PRIORITY_HIGH,
    LexicalNode,
    ElementNode,
} from 'lexical';
import {
    $createDeletedTextNode,
    $isDeletedTextNode,
} from '../nodes/DeletedTextNode';
import { getUserColor } from '../../../utils/userColors';

interface DeletionInterceptionPluginProps {
    enabled: boolean;
    currentUserName?: string;
    currentUserId?: string;
    onDeletionIntercepted?: (deletedText: string) => void;
}

export default function DeletionInterceptionPlugin({
    enabled,
    currentUserName,
    currentUserId,
    onDeletionIntercepted,
}: DeletionInterceptionPluginProps): null {
    const [editor] = useLexicalComposerContext();

    useEffect(() => {
        if (!enabled) return;

        const authorColor = currentUserId ? getUserColor(currentUserId) : undefined;

        /**
         * Capture what the user intends to delete from the current editor state,
         * then schedule the tree mutation in a deferred `editor.update()`.
         *
         * @param isForward  true = Delete key direction, false = Backspace direction
         */
        const handleDeletion = (isForward: boolean) => {
            // Read the current state synchronously (we're inside a command handler
            // which runs inside editor.read/update context).
            const selection = $getSelection();
            if (!$isRangeSelection(selection)) return;

            // --- Case 1: Non-collapsed selection ---
            if (!selection.isCollapsed()) {
                // Capture info we need for the deferred update.
                // selection.getNodes() returns the Lexical nodes touched by the selection.
                const anchor = selection.anchor;
                const focus = selection.focus;
                const isBackwards = selection.isBackward();
                const startPoint = isBackwards ? { key: focus.key, offset: focus.offset, type: focus.type } : { key: anchor.key, offset: anchor.offset, type: anchor.type };
                const endPoint = isBackwards ? { key: anchor.key, offset: anchor.offset, type: anchor.type } : { key: focus.key, offset: focus.offset, type: focus.type };

                // Collect the keys and text slices for each TextNode in the selection.
                const nodeSlices: Array<{ key: string; sliceStart: number; sliceEnd: number; text: string }> = [];
                const nodes = selection.getNodes();
                let isInside = false;
                for (const node of nodes) {
                    if ($isDeletedTextNode(node)) continue;
                    if ($isTextNode(node)) {
                        const nodeKey = node.getKey();
                        const text = node.getTextContent();
                        const textLen = text.length;
                        let sliceStart = 0;
                        let sliceEnd = textLen;

                        if (nodeKey === startPoint.key) {
                            sliceStart = startPoint.offset;
                            isInside = true;
                        }
                        if (nodeKey === endPoint.key) {
                            sliceEnd = endPoint.offset;
                        }
                        if (!isInside && nodeKey !== startPoint.key) continue;

                        const deletedSlice = text.slice(sliceStart, sliceEnd);
                        if (deletedSlice) {
                            nodeSlices.push({ key: nodeKey, sliceStart, sliceEnd, text });
                        }
                        if (nodeKey === endPoint.key) break;
                    }
                }

                if (nodeSlices.length === 0) return;

                const selectedText = nodeSlices.map(s => s.text.slice(s.sliceStart, s.sliceEnd)).join('');

                // Defer the tree mutation
                setTimeout(() => {
                    editor.update(() => {
                        // Process in reverse order so earlier node offsets aren't affected
                        for (let i = nodeSlices.length - 1; i >= 0; i--) {
                            const { key, sliceStart, sliceEnd, text } = nodeSlices[i];
                            const liveNode = $getNodeByKey(key);
                            if (!liveNode || !$isTextNode(liveNode)) continue;

                            const currentText = liveNode.getTextContent();
                            // If the text has changed since we captured, skip
                            if (currentText !== text) continue;

                            const deletedSlice = text.slice(sliceStart, sliceEnd);
                            const textLen = text.length;

                            if (sliceStart === 0 && sliceEnd >= textLen) {
                                // Entire node is selected
                                const deletedNode = $createDeletedTextNode({
                                    changeId: '__pending_deletion__',
                                    deletedText: deletedSlice,
                                    authorName: currentUserName,
                                    authorColor,
                                });
                                liveNode.insertBefore(deletedNode);
                                liveNode.remove();
                            } else if (sliceEnd < textLen && sliceStart > 0) {
                                // Middle of node
                                const parts = liveNode.splitText(sliceStart, sliceEnd);
                                const selectedNode = parts[1];
                                if (selectedNode) {
                                    const deletedNode = $createDeletedTextNode({
                                        changeId: '__pending_deletion__',
                                        deletedText: deletedSlice,
                                        authorName: currentUserName,
                                        authorColor,
                                    });
                                    selectedNode.insertBefore(deletedNode);
                                    selectedNode.remove();
                                }
                            } else if (sliceStart === 0) {
                                // From start of node
                                const parts = liveNode.splitText(sliceEnd);
                                const selectedNode = parts[0];
                                if (selectedNode) {
                                    const deletedNode = $createDeletedTextNode({
                                        changeId: '__pending_deletion__',
                                        deletedText: deletedSlice,
                                        authorName: currentUserName,
                                        authorColor,
                                    });
                                    selectedNode.insertBefore(deletedNode);
                                    selectedNode.remove();
                                }
                            } else {
                                // To end of node
                                const parts = liveNode.splitText(sliceStart);
                                const selectedNode = parts[1];
                                if (selectedNode) {
                                    const deletedNode = $createDeletedTextNode({
                                        changeId: '__pending_deletion__',
                                        deletedText: deletedSlice,
                                        authorName: currentUserName,
                                        authorColor,
                                    });
                                    selectedNode.insertBefore(deletedNode);
                                    selectedNode.remove();
                                }
                            }
                        }
                    });
                }, 0);

                if (onDeletionIntercepted) {
                    onDeletionIntercepted(selectedText);
                }
                return;
            }

            // --- Case 2: Collapsed cursor (single character) ---
            const anchor = selection.anchor;
            const anchorNode = anchor.getNode();
            if (!$isTextNode(anchorNode)) return;
            if ($isDeletedTextNode(anchorNode)) return;

            const text = anchorNode.getTextContent();
            const offset = anchor.offset;
            const nodeKey = anchorNode.getKey();

            let charToDelete: string;
            let deleteOffset: number;

            if (isForward) {
                if (offset >= text.length) return;
                charToDelete = text[offset];
                deleteOffset = offset;
            } else {
                if (offset === 0) return;
                charToDelete = text[offset - 1];
                deleteOffset = offset - 1;
            }

            // Defer the tree mutation
            setTimeout(() => {
                editor.update(() => {
                    const liveNode = $getNodeByKey(nodeKey);
                    if (!liveNode || !$isTextNode(liveNode)) return;

                    const currentText = liveNode.getTextContent();
                    if (currentText !== text) return; // text changed, skip

                    if (currentText.length === 1) {
                        // Only character in the node
                        const deletedNode = $createDeletedTextNode({
                            changeId: '__pending_deletion__',
                            deletedText: charToDelete,
                            authorName: currentUserName,
                            authorColor,
                        });
                        liveNode.insertBefore(deletedNode);
                        liveNode.remove();
                    } else {
                        const parts = liveNode.splitText(deleteOffset, deleteOffset + 1);
                        const charNode = deleteOffset > 0 ? parts[1] : parts[0];
                        if (charNode) {
                            const deletedNode = $createDeletedTextNode({
                                changeId: '__pending_deletion__',
                                deletedText: charToDelete,
                                authorName: currentUserName,
                                authorColor,
                            });
                            charNode.insertBefore(deletedNode);
                            charNode.remove();
                        }
                    }
                });
            }, 0);

            if (onDeletionIntercepted) {
                onDeletionIntercepted(charToDelete);
            }
        };

        // --- Register command handlers ---
        // We return `true` from ALL handlers to prevent Lexical's default deletion.
        // The actual tree mutation is deferred to avoid error #19 from
        // double-reconciliation when beforeinput fires after keydown.

        const unregisterBackspace = editor.registerCommand(
            KEY_BACKSPACE_COMMAND,
            (event: KeyboardEvent) => {
                event.preventDefault();
                handleDeletion(false);
                return true;
            },
            COMMAND_PRIORITY_HIGH,
        );

        const unregisterDelete = editor.registerCommand(
            KEY_DELETE_COMMAND,
            (event: KeyboardEvent) => {
                event.preventDefault();
                handleDeletion(true);
                return true;
            },
            COMMAND_PRIORITY_HIGH,
        );

        const unregisterDeleteChar = editor.registerCommand(
            DELETE_CHARACTER_COMMAND,
            (_isForward: boolean) => {
                // Already handled by KEY_BACKSPACE/KEY_DELETE — just block.
                return true;
            },
            COMMAND_PRIORITY_HIGH,
        );

        const unregisterDeleteWord = editor.registerCommand(
            DELETE_WORD_COMMAND,
            (_isForward: boolean) => {
                return true; // Block word-level deletions for now
            },
            COMMAND_PRIORITY_HIGH,
        );

        const unregisterDeleteLine = editor.registerCommand(
            DELETE_LINE_COMMAND,
            (_isForward: boolean) => {
                return true; // Block line-level deletions for now
            },
            COMMAND_PRIORITY_HIGH,
        );

        return () => {
            unregisterBackspace();
            unregisterDelete();
            unregisterDeleteChar();
            unregisterDeleteWord();
            unregisterDeleteLine();
        };
    }, [editor, enabled, currentUserName, currentUserId, onDeletionIntercepted]);

    return null;
}
