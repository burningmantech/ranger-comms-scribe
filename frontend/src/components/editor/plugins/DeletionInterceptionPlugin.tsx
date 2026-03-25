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
    $getRoot,
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
    FormattedSegment,
} from '../nodes/DeletedTextNode';
import { getUserColor } from '../../../utils/userColors';

interface DeletionInterceptionPluginProps {
    enabled: boolean;
    currentUserName?: string;
    currentUserId?: string;
    onDeletionIntercepted?: (deletedText: string) => void;
    getBeforeText?: () => string | null;
}

export default function DeletionInterceptionPlugin({
    enabled,
    currentUserName,
    currentUserId,
    onDeletionIntercepted,
    getBeforeText,
}: DeletionInterceptionPluginProps): null {
    const [editor] = useLexicalComposerContext();

    useEffect(() => {
        if (!enabled) return;

        const authorColor = currentUserId ? getUserColor(currentUserId) : undefined;

        // When KEY_BACKSPACE/DELETE allows a deletion through (returns false),
        // the subsequent DELETE_CHARACTER_COMMAND must also allow it through.
        let skipNextDeleteCommand = false;

        /**
         * Get the text content of the paragraph (top-level block) containing
         * a given text node, by concatenating all its descendant text nodes.
         */
        const getParagraphText = (textNode: LexicalNode): string => {
            let parent = textNode.getParent();
            // Walk up to the top-level block (direct child of root)
            while (parent && parent.getParent() && parent.getParent() !== $getRoot()) {
                parent = parent.getParent();
            }
            if (!parent) return textNode.getTextContent();
            return parent.getTextContent();
        };

        /**
         * Get the offset of a text node within its paragraph by summing
         * preceding sibling/descendant text node lengths.
         */
        const getOffsetInParagraph = (textNode: LexicalNode): number => {
            let parent = textNode.getParent();
            while (parent && parent.getParent() && parent.getParent() !== $getRoot()) {
                parent = parent.getParent();
            }
            if (!parent) return 0;

            let offset = 0;
            const walk = (node: LexicalNode): boolean => {
                if (node === textNode) return true; // found it
                if ($isTextNode(node)) {
                    offset += node.getTextContent().length;
                } else if ($isElementNode(node)) {
                    for (const child of node.getChildren()) {
                        if (walk(child)) return true;
                    }
                }
                return false;
            };
            walk(parent);
            return offset;
        };

        /**
         * Find the paragraph index (0-based) of the top-level block
         * containing a given text node.
         */
        const getParagraphIndex = (textNode: LexicalNode): number => {
            let parent = textNode.getParent();
            while (parent && parent.getParent() && parent.getParent() !== $getRoot()) {
                parent = parent.getParent();
            }
            if (!parent) return 0;
            const root = $getRoot();
            const children = root.getChildren();
            for (let i = 0; i < children.length; i++) {
                if (children[i] === parent) return i;
            }
            return 0;
        };

        /**
         * Check if the character about to be deleted is newly added text
         * (typed in the current editing session, not present in beforeSnapshot).
         *
         * Works at the paragraph level to avoid text-format mismatches between
         * extractTextFromLexical (\n) and $getRoot().getTextContent() (\n\n).
         *
         * Returns true if the deletion target is entirely new text.
         */
        const isNewlyAddedText = (isForward: boolean): boolean => {
            if (!getBeforeText) return false;
            const beforeText = getBeforeText();
            if (beforeText === null) return false;

            const selection = $getSelection();
            if (!$isRangeSelection(selection)) return false;

            // beforeText uses single \n between paragraphs (from extractTextFromLexical)
            const beforeParagraphs = beforeText.split('\n');

            if (selection.isCollapsed()) {
                const anchor = selection.anchor;
                const anchorNode = anchor.getNode();
                if (!$isTextNode(anchorNode)) return false;

                const paraIndex = getParagraphIndex(anchorNode);
                const beforePara = beforeParagraphs[paraIndex];
                if (beforePara === undefined) return true; // Entirely new paragraph

                const currentPara = getParagraphText(anchorNode);
                if (currentPara === beforePara) return false; // No changes in this paragraph
                if (currentPara.length <= beforePara.length) return false; // No additions

                // Compute added range within this paragraph
                let addStart = 0;
                while (addStart < beforePara.length && beforePara[addStart] === currentPara[addStart]) {
                    addStart++;
                }
                let beforeEnd = beforePara.length - 1;
                let currentEnd = currentPara.length - 1;
                while (beforeEnd >= addStart && currentEnd >= addStart && beforePara[beforeEnd] === currentPara[currentEnd]) {
                    beforeEnd--;
                    currentEnd--;
                }
                const addEnd = currentEnd + 1;
                if (addEnd <= addStart) return false;

                // Cursor position within paragraph
                const offsetInPara = getOffsetInParagraph(anchorNode) + anchor.offset;
                const deletePos = isForward ? offsetInPara : offsetInPara - 1;
                return deletePos >= addStart && deletePos < addEnd;
            } else {
                // Non-collapsed: check if entire selection is within one paragraph's added range
                const anchor = selection.anchor;
                const focus = selection.focus;
                const anchorNode = anchor.getNode();
                const focusNode = focus.getNode();
                if (!$isTextNode(anchorNode) || !$isTextNode(focusNode)) return false;

                const anchorParaIdx = getParagraphIndex(anchorNode);
                const focusParaIdx = getParagraphIndex(focusNode);
                if (anchorParaIdx !== focusParaIdx) return false; // Cross-paragraph selection

                const beforePara = beforeParagraphs[anchorParaIdx];
                if (beforePara === undefined) return true;

                const currentPara = getParagraphText(anchorNode);
                if (currentPara.length <= beforePara.length) return false;

                let addStart = 0;
                while (addStart < beforePara.length && beforePara[addStart] === currentPara[addStart]) {
                    addStart++;
                }
                let beforeEnd = beforePara.length - 1;
                let currentEnd = currentPara.length - 1;
                while (beforeEnd >= addStart && currentEnd >= addStart && beforePara[beforeEnd] === currentPara[currentEnd]) {
                    beforeEnd--;
                    currentEnd--;
                }
                const addEnd = currentEnd + 1;
                if (addEnd <= addStart) return false;

                const anchorAbs = getOffsetInParagraph(anchorNode) + anchor.offset;
                const focusAbs = getOffsetInParagraph(focusNode) + focus.offset;
                const selStart = Math.min(anchorAbs, focusAbs);
                const selEnd = Math.max(anchorAbs, focusAbs);
                return selStart >= addStart && selEnd <= addEnd;
            }
        };

        /**
         * Check if the cursor is at the very start of a paragraph (backspace)
         * or the very end (forward delete). In these cases Lexical should
         * handle the paragraph merge natively.
         */
        const isAtParagraphBoundary = (isForward: boolean): boolean => {
            const selection = $getSelection();
            if (!$isRangeSelection(selection) || !selection.isCollapsed()) return false;

            const anchor = selection.anchor;
            const anchorNode = anchor.getNode();

            // Empty paragraph (anchor is on the ElementNode itself) — always a boundary
            if ($isElementNode(anchorNode) && anchorNode.getTextContent().trim() === '') {
                return true;
            }

            if (!$isTextNode(anchorNode)) return false;

            if (!isForward && anchor.offset !== 0) return false;
            if (isForward && anchor.offset < anchorNode.getTextContent().length) return false;

            // Walk siblings in the relevant direction to check for preceding/following
            // real text content within the same paragraph.
            let sibling: LexicalNode | null = anchorNode;
            while (true) {
                sibling = isForward ? sibling.getNextSibling() : sibling.getPreviousSibling();
                if (!sibling) break;
                if ($isDeletedTextNode(sibling)) continue; // skip deleted nodes
                if ($isTextNode(sibling) && sibling.getTextContent().length > 0) return false;
                if ($isElementNode(sibling)) return false;
            }

            // Also walk up: if the text node is inside an inline element (e.g. <strong>),
            // check the parent's siblings too.
            let parent = anchorNode.getParent();
            while (parent && parent.getParent() && parent.getParent() !== $getRoot()) {
                let parentSibling: LexicalNode | null = parent;
                while (true) {
                    parentSibling = isForward ? parentSibling.getNextSibling() : parentSibling.getPreviousSibling();
                    if (!parentSibling) break;
                    if ($isDeletedTextNode(parentSibling)) continue;
                    if ($isTextNode(parentSibling) && parentSibling.getTextContent().length > 0) return false;
                    if ($isElementNode(parentSibling)) return false;
                }
                parent = parent.getParent();
            }

            return true; // truly at paragraph boundary
        };

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

                            // Capture format from the source TextNode
                            const nodeFormat = $isTextNode(liveNode) ? liveNode.getFormat() : 0;
                            const nodeStyle = $isTextNode(liveNode) ? liveNode.getStyle() : '';
                            const segments: FormattedSegment[] | undefined = nodeFormat
                                ? [{ text: deletedSlice, format: nodeFormat, style: nodeStyle }]
                                : undefined;

                            if (sliceStart === 0 && sliceEnd >= textLen) {
                                // Entire node is selected
                                const deletedNode = $createDeletedTextNode({
                                    changeId: '__pending_deletion__',
                                    deletedText: deletedSlice,
                                    authorName: currentUserName,
                                    authorColor,
                                    formattedSegments: segments,
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
                                        formattedSegments: segments,
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
                                        formattedSegments: segments,
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
                                        formattedSegments: segments,
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
                if (offset >= text.length) {
                    // Not at paragraph boundary (handled earlier), so
                    // there must be a next text node in the same paragraph.
                    let next: LexicalNode | null = anchorNode.getNextSibling();
                    if (!next) {
                        let parent = anchorNode.getParent();
                        while (parent && parent.getParent() && parent.getParent() !== $getRoot()) {
                            next = parent.getNextSibling();
                            if (next) break;
                            parent = parent.getParent();
                        }
                    }
                    while (next && $isDeletedTextNode(next)) {
                        next = next.getNextSibling();
                    }
                    while (next && $isElementNode(next)) {
                        const children = (next as ElementNode).getChildren();
                        next = children.length > 0 ? children[0] : null;
                    }
                    if (!next || !$isTextNode(next) || $isDeletedTextNode(next)) return;
                    const nextText = next.getTextContent();
                    if (nextText.length === 0) return;
                    const nextKey = next.getKey();
                    const nextChar = nextText[0];
                    setTimeout(() => {
                        editor.update(() => {
                            const liveNode = $getNodeByKey(nextKey);
                            if (!liveNode || !$isTextNode(liveNode)) return;
                            const currentText = liveNode.getTextContent();
                            if (currentText !== nextText) return;
                            if (currentText.length === 1) {
                                const deletedNode = $createDeletedTextNode({
                                    changeId: '__pending_deletion__',
                                    deletedText: nextChar,
                                    authorName: currentUserName,
                                    authorColor,
                                });
                                liveNode.insertBefore(deletedNode);
                                liveNode.remove();
                            } else {
                                const parts = liveNode.splitText(0, 1);
                                const charNode = parts[0];
                                if (charNode) {
                                    const deletedNode = $createDeletedTextNode({
                                        changeId: '__pending_deletion__',
                                        deletedText: nextChar,
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
                        onDeletionIntercepted(nextChar);
                    }
                    return;
                }
                charToDelete = text[offset];
                deleteOffset = offset;
            } else {
                if (offset === 0) {
                    // Not at paragraph boundary (that's handled earlier), so
                    // there must be a previous text node in the same paragraph.
                    // Find it and delete its last character.
                    let prev: LexicalNode | null = anchorNode.getPreviousSibling();
                    // Walk up through inline parents if needed
                    if (!prev) {
                        let parent = anchorNode.getParent();
                        while (parent && parent.getParent() && parent.getParent() !== $getRoot()) {
                            prev = parent.getPreviousSibling();
                            if (prev) break;
                            parent = parent.getParent();
                        }
                    }
                    // Skip over DeletedTextNodes
                    while (prev && $isDeletedTextNode(prev)) {
                        prev = prev.getPreviousSibling();
                    }
                    // Descend into element nodes to find the last text node
                    while (prev && $isElementNode(prev)) {
                        const children = (prev as ElementNode).getChildren();
                        prev = children.length > 0 ? children[children.length - 1] : null;
                    }
                    if (!prev || !$isTextNode(prev) || $isDeletedTextNode(prev)) return;
                    const prevText = prev.getTextContent();
                    if (prevText.length === 0) return;
                    const prevKey = prev.getKey();
                    const prevChar = prevText[prevText.length - 1];
                    const prevOffset = prevText.length - 1;
                    setTimeout(() => {
                        editor.update(() => {
                            const liveNode = $getNodeByKey(prevKey);
                            if (!liveNode || !$isTextNode(liveNode)) return;
                            const currentText = liveNode.getTextContent();
                            if (currentText !== prevText) return;
                            if (currentText.length === 1) {
                                const deletedNode = $createDeletedTextNode({
                                    changeId: '__pending_deletion__',
                                    deletedText: prevChar,
                                    authorName: currentUserName,
                                    authorColor,
                                });
                                liveNode.insertBefore(deletedNode);
                                liveNode.remove();
                            } else {
                                const parts = liveNode.splitText(prevOffset, prevOffset + 1);
                                const charNode = prevOffset > 0 ? parts[1] : parts[0];
                                if (charNode) {
                                    const deletedNode = $createDeletedTextNode({
                                        changeId: '__pending_deletion__',
                                        deletedText: prevChar,
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
                        onDeletionIntercepted(prevChar);
                    }
                    return;
                }
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

                    // Capture format from source TextNode
                    const fmt = liveNode.getFormat();
                    const sty = liveNode.getStyle();
                    const fmtSegs: FormattedSegment[] | undefined = fmt
                        ? [{ text: charToDelete, format: fmt, style: sty }]
                        : undefined;

                    if (currentText.length === 1) {
                        // Only character in the node
                        const deletedNode = $createDeletedTextNode({
                            changeId: '__pending_deletion__',
                            deletedText: charToDelete,
                            authorName: currentUserName,
                            authorColor,
                            formattedSegments: fmtSegs,
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
                                formattedSegments: fmtSegs,
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
                if (isNewlyAddedText(false)) {
                    skipNextDeleteCommand = true;
                    return false; // Let Lexical delete normally
                }
                // At paragraph boundary — let Lexical merge paragraphs natively
                if (isAtParagraphBoundary(false)) {
                    skipNextDeleteCommand = true;
                    return false;
                }
                event.preventDefault();
                handleDeletion(false);
                return true;
            },
            COMMAND_PRIORITY_HIGH,
        );

        const unregisterDelete = editor.registerCommand(
            KEY_DELETE_COMMAND,
            (event: KeyboardEvent) => {
                if (isNewlyAddedText(true)) {
                    skipNextDeleteCommand = true;
                    return false; // Let Lexical delete normally
                }
                // At paragraph boundary — let Lexical merge paragraphs natively
                if (isAtParagraphBoundary(true)) {
                    skipNextDeleteCommand = true;
                    return false;
                }
                event.preventDefault();
                handleDeletion(true);
                return true;
            },
            COMMAND_PRIORITY_HIGH,
        );

        const unregisterDeleteChar = editor.registerCommand(
            DELETE_CHARACTER_COMMAND,
            (_isForward: boolean) => {
                if (skipNextDeleteCommand) {
                    skipNextDeleteCommand = false;
                    return false; // Allow through — newly added text
                }
                return true;
            },
            COMMAND_PRIORITY_HIGH,
        );

        const unregisterDeleteWord = editor.registerCommand(
            DELETE_WORD_COMMAND,
            (_isForward: boolean) => {
                if (skipNextDeleteCommand) {
                    skipNextDeleteCommand = false;
                    return false;
                }
                return true; // Block word-level deletions for now
            },
            COMMAND_PRIORITY_HIGH,
        );

        const unregisterDeleteLine = editor.registerCommand(
            DELETE_LINE_COMMAND,
            (_isForward: boolean) => {
                if (skipNextDeleteCommand) {
                    skipNextDeleteCommand = false;
                    return false;
                }
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
    }, [editor, enabled, currentUserName, currentUserId, onDeletionIntercepted, getBeforeText]);

    return null;
}
