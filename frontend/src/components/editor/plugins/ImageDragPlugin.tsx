import { useEffect, useRef } from 'react';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  DRAGSTART_COMMAND,
  DRAGOVER_COMMAND,
  DROP_COMMAND,
  DRAGEND_COMMAND,
  COMMAND_PRIORITY_HIGH,
  $getNodeByKey,
  $getNearestNodeFromDOMNode,
  LexicalNode,
} from 'lexical';
import { $isImageNode } from '../nodes/ImageNode';

export default function ImageDragPlugin(): null {
  const [editor] = useLexicalComposerContext();
  const draggedNodeKeyRef = useRef<string | null>(null);
  const dropIndicatorRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const removeDropIndicator = () => {
      if (dropIndicatorRef.current) {
        dropIndicatorRef.current.remove();
        dropIndicatorRef.current = null;
      }
    };

    const getDropIndicator = (): HTMLElement => {
      if (!dropIndicatorRef.current) {
        const indicator = document.createElement('div');
        indicator.className = 'editor-image-drop-indicator';
        dropIndicatorRef.current = indicator;
      }
      return dropIndicatorRef.current;
    };

    const findBlockElementAtY = (
      editorRoot: HTMLElement,
      y: number,
    ): { element: HTMLElement; position: 'before' | 'after' } | null => {
      const children = editorRoot.children;
      let closest: { element: HTMLElement; position: 'before' | 'after' } | null = null;
      let closestDistance = Infinity;

      for (let i = 0; i < children.length; i++) {
        const child = children[i] as HTMLElement;
        const rect = child.getBoundingClientRect();
        const midY = rect.top + rect.height / 2;
        const distance = Math.abs(y - midY);

        if (distance < closestDistance) {
          closestDistance = distance;
          closest = {
            element: child,
            position: y < midY ? 'before' : 'after',
          };
        }
      }

      return closest;
    };

    const unregisterDragStart = editor.registerCommand(
      DRAGSTART_COMMAND,
      (event: DragEvent) => {
        const target = event.target as HTMLElement;
        const imageKey = target.dataset?.lexicalImageKey;

        if (!imageKey) {
          return false;
        }

        draggedNodeKeyRef.current = imageKey;
        event.dataTransfer?.setData('text/plain', imageKey);

        // Add dragging visual class
        target.classList.add('editor-image-dragging');

        // Return true to stop propagation — RichTextPlugin's default handler
        // would call preventDefault() and cancel the native drag
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );

    const unregisterDragOver = editor.registerCommand(
      DRAGOVER_COMMAND,
      (event: DragEvent) => {
        if (!draggedNodeKeyRef.current) {
          return false;
        }

        event.preventDefault();

        const editorRoot = editor.getRootElement();
        if (!editorRoot) {
          return false;
        }

        const result = findBlockElementAtY(editorRoot, event.clientY);
        if (!result) {
          return false;
        }

        const indicator = getDropIndicator();
        const rootRect = editorRoot.getBoundingClientRect();
        const targetRect = result.element.getBoundingClientRect();

        const topOffset =
          result.position === 'before'
            ? targetRect.top - rootRect.top
            : targetRect.bottom - rootRect.top;

        indicator.style.top = `${topOffset}px`;

        if (!indicator.parentElement) {
          editorRoot.appendChild(indicator);
        }

        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );

    const unregisterDrop = editor.registerCommand(
      DROP_COMMAND,
      (event: DragEvent) => {
        const draggedKey = draggedNodeKeyRef.current;
        if (!draggedKey) {
          return false;
        }

        event.preventDefault();
        removeDropIndicator();
        draggedNodeKeyRef.current = null;

        const editorRoot = editor.getRootElement();
        if (!editorRoot) {
          return false;
        }

        const result = findBlockElementAtY(editorRoot, event.clientY);
        if (!result) {
          return false;
        }

        editor.update(() => {
          const draggedNode = $getNodeByKey(draggedKey);
          if (!draggedNode || !$isImageNode(draggedNode)) {
            return;
          }

          const targetLexicalNode = $getNearestNodeFromDOMNode(result.element);
          if (!targetLexicalNode) {
            return;
          }

          // Find the top-level block node
          let targetBlock: LexicalNode = targetLexicalNode;
          while (targetBlock.getParent() && targetBlock.getParent()?.getParent()) {
            targetBlock = targetBlock.getParent()!;
          }

          // Don't move if dropping on self
          if (targetBlock.getKey() === draggedNode.getKey()) {
            return;
          }

          // Remove from current position and insert at target
          draggedNode.remove();
          if (result.position === 'before') {
            targetBlock.insertBefore(draggedNode);
          } else {
            targetBlock.insertAfter(draggedNode);
          }
        });

        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );

    const unregisterDragEnd = editor.registerCommand(
      DRAGEND_COMMAND,
      (event: DragEvent) => {
        removeDropIndicator();
        draggedNodeKeyRef.current = null;

        // Remove dragging class from the source element
        const target = event.target as HTMLElement;
        target.classList?.remove('editor-image-dragging');

        // Also clean up any stale dragging classes
        const editorRoot = editor.getRootElement();
        if (editorRoot) {
          editorRoot
            .querySelectorAll('.editor-image-dragging')
            .forEach((el) => el.classList.remove('editor-image-dragging'));
        }

        return false;
      },
      COMMAND_PRIORITY_HIGH,
    );

    return () => {
      unregisterDragStart();
      unregisterDragOver();
      unregisterDrop();
      unregisterDragEnd();
      removeDropIndicator();
    };
  }, [editor]);

  return null;
}
