import React from 'react';
import {
  DecoratorNode,
  EditorConfig,
  LexicalNode,
  NodeKey,
  SerializedLexicalNode,
  Spread,
} from 'lexical';

export interface DeletedTextPayload {
  changeId: string;
  deletedText: string;
  authorName?: string;
  authorColor?: string;
  isBlockLevel?: boolean;
}

export type SerializedDeletedTextNode = Spread<
  {
    changeId: string;
    deletedText: string;
    authorName?: string;
    authorColor?: string;
    isBlockLevel?: boolean;
    type: 'deleted-text';
    version: 1;
  },
  SerializedLexicalNode
>;

export class DeletedTextNode extends DecoratorNode<React.ReactElement> {
  __changeId: string;
  __deletedText: string;
  __authorName?: string;
  __authorColor?: string;
  __isBlockLevel: boolean;

  static getType(): string {
    return 'deleted-text';
  }

  static clone(node: DeletedTextNode): DeletedTextNode {
    return new DeletedTextNode(
      node.__changeId,
      node.__deletedText,
      node.__authorName,
      node.__authorColor,
      node.__isBlockLevel,
      node.__key,
    );
  }

  constructor(
    changeId: string,
    deletedText: string,
    authorName?: string,
    authorColor?: string,
    isBlockLevel?: boolean,
    key?: NodeKey,
  ) {
    super(key);
    this.__changeId = changeId;
    this.__deletedText = deletedText;
    this.__authorName = authorName;
    this.__authorColor = authorColor;
    this.__isBlockLevel = isBlockLevel || false;
  }

  static importJSON(serializedNode: SerializedDeletedTextNode): DeletedTextNode {
    return $createDeletedTextNode({
      changeId: serializedNode.changeId,
      deletedText: serializedNode.deletedText,
      authorName: serializedNode.authorName,
      authorColor: serializedNode.authorColor,
      isBlockLevel: serializedNode.isBlockLevel,
    });
  }

  exportJSON(): SerializedDeletedTextNode {
    return {
      changeId: this.__changeId,
      deletedText: this.__deletedText,
      authorName: this.__authorName,
      authorColor: this.__authorColor,
      isBlockLevel: this.__isBlockLevel,
      type: 'deleted-text',
      version: 1,
    };
  }

  createDOM(_config: EditorConfig): HTMLElement {
    const element = document.createElement(this.__isBlockLevel ? 'div' : 'span');
    element.className = 'tracked-deletion-wrapper';
    element.setAttribute('data-change-id', this.__changeId);
    element.setAttribute('spellcheck', 'false');
    // Set initial transition-ready properties for smooth acceptance animation.
    // opacity and max-height are animated by removeDecorationsForChangeAnimated().
    element.style.opacity = '1';
    element.style.overflow = 'visible';
    return element;
  }

  updateDOM(): false {
    return false;
  }

  isInline(): boolean {
    return true;
  }

  getTextContent(): string {
    // Return empty string so deleted text doesn't count toward char counts
    return '';
  }

  getChangeId(): string {
    return this.__changeId;
  }

  getDeletedText(): string {
    return this.__deletedText;
  }

  getAuthorName(): string | undefined {
    return this.__authorName;
  }

  decorate(): React.ReactElement {
    return (
      <DeletedTextComponent
        changeId={this.__changeId}
        deletedText={this.__deletedText}
        authorName={this.__authorName}
        authorColor={this.__authorColor}
        nodeKey={this.__key}
      />
    );
  }
}

interface DeletedTextComponentProps {
  changeId: string;
  deletedText: string;
  authorName?: string;
  authorColor?: string;
  nodeKey: NodeKey;
}

function DeletedTextComponent({
  changeId,
  deletedText,
  authorName,
  authorColor,
  nodeKey,
}: DeletedTextComponentProps): React.ReactElement {
  const handleClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    const element = document.querySelector(`[data-lexical-node-key="${nodeKey}"]`);
    if (element) {
      const event = new CustomEvent('tracked-change-click', {
        detail: { changeId },
        bubbles: true,
        cancelable: true,
      });
      element.dispatchEvent(event);
    }
  };

  // Split on newlines to render paragraph breaks as <br/> elements
  const parts = deletedText.split('\n');

  // Fall back to red if no authorColor provided (backward compat)
  const color = authorColor || '#d32f2f';
  const bgColor = color + '14'; // ~8% opacity hex suffix

  return (
    <span
      className={`tracked-deletion${parts.length > 1 ? ' tracked-deletion-block' : ''}`}
      data-change-id={changeId}
      contentEditable={false}
      spellCheck={false}
      onClick={handleClick}
      title={authorName ? `Deleted by ${authorName}` : 'Deleted text'}
      style={{ color, backgroundColor: bgColor }}
    >
      {parts.map((part, i) => (
        <React.Fragment key={i}>
          {part}
          {i < parts.length - 1 && <br />}
        </React.Fragment>
      ))}
    </span>
  );
}

export function $createDeletedTextNode(payload: DeletedTextPayload): DeletedTextNode {
  return new DeletedTextNode(
    payload.changeId,
    payload.deletedText,
    payload.authorName,
    payload.authorColor,
    payload.isBlockLevel,
  );
}

export function $isDeletedTextNode(node: LexicalNode | null | undefined): node is DeletedTextNode {
  return node instanceof DeletedTextNode;
}
