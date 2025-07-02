import React from 'react';
import {
  DecoratorNode,
  EditorConfig,
  LexicalNode,
  NodeKey,
  SerializedLexicalNode,
  Spread,
} from 'lexical';

export interface SuggestionPayload {
  id: string;
  originalText: string;
  suggestedText: string;
  authorId: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  reason?: string;
}

export type SerializedSuggestionNode = Spread<
  {
    id: string;
    originalText: string;
    suggestedText: string;
    authorId: string;
    status: 'PENDING' | 'APPROVED' | 'REJECTED';
    reason?: string;
    type: 'suggestion';
    version: 1;
  },
  SerializedLexicalNode
>;

export class SuggestionNode extends DecoratorNode<React.ReactElement> {
  __id: string;
  __originalText: string;
  __suggestedText: string;
  __authorId: string;
  __status: 'PENDING' | 'APPROVED' | 'REJECTED';
  __reason?: string;

  static getType(): string {
    return 'suggestion';
  }

  static clone(node: SuggestionNode): SuggestionNode {
    return new SuggestionNode(
      node.__id,
      node.__originalText,
      node.__suggestedText,
      node.__authorId,
      node.__status,
      node.__reason,
      node.__key,
    );
  }

  constructor(
    id: string,
    originalText: string,
    suggestedText: string,
    authorId: string,
    status: 'PENDING' | 'APPROVED' | 'REJECTED',
    reason?: string,
    key?: NodeKey,
  ) {
    super(key);
    this.__id = id;
    this.__originalText = originalText;
    this.__suggestedText = suggestedText;
    this.__authorId = authorId;
    this.__status = status;
    this.__reason = reason;
  }

  static importJSON(serializedNode: SerializedSuggestionNode): SuggestionNode {
    const { id, originalText, suggestedText, authorId, status, reason } = serializedNode;
    return $createSuggestionNode({
      id,
      originalText,
      suggestedText,
      authorId,
      status,
      reason,
    });
  }

  exportJSON(): SerializedSuggestionNode {
    return {
      id: this.__id,
      originalText: this.__originalText,
      suggestedText: this.__suggestedText,
      authorId: this.__authorId,
      status: this.__status,
      reason: this.__reason,
      type: 'suggestion',
      version: 1,
    };
  }

  createDOM(config: EditorConfig): HTMLElement {
    const element = document.createElement('span');
    element.className = `suggestion-node suggestion-${this.__status.toLowerCase()}`;
    return element;
  }

  updateDOM(): false {
    return false;
  }

  getId(): string {
    return this.__id;
  }

  getOriginalText(): string {
    return this.__originalText;
  }

  getSuggestedText(): string {
    return this.__suggestedText;
  }

  getAuthorId(): string {
    return this.__authorId;
  }

  getStatus(): 'PENDING' | 'APPROVED' | 'REJECTED' {
    return this.__status;
  }

  getReason(): string | undefined {
    return this.__reason;
  }

  setStatus(status: 'PENDING' | 'APPROVED' | 'REJECTED'): void {
    const writableNode = this.getWritable();
    writableNode.__status = status;
  }

  setReason(reason: string): void {
    const writableNode = this.getWritable();
    writableNode.__reason = reason;
  }

  decorate(): React.ReactElement {
    return <SuggestionComponent 
      id={this.__id}
      originalText={this.__originalText}
      suggestedText={this.__suggestedText}
      authorId={this.__authorId}
      status={this.__status}
      reason={this.__reason}
      nodeKey={this.__key}
    />;
  }
}

interface SuggestionComponentProps {
  id: string;
  originalText: string;
  suggestedText: string;
  authorId: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  reason?: string;
  nodeKey: NodeKey;
}

function SuggestionComponent({
  id,
  originalText,
  suggestedText,
  authorId,
  status,
  reason,
  nodeKey,
}: SuggestionComponentProps): React.ReactElement {
  const handleSuggestionAction = (action: 'approve' | 'reject', newReason?: string) => {
    const suggestionElement = document.querySelector(`[data-lexical-node-key="${nodeKey}"]`);
    if (suggestionElement) {
      const event = new CustomEvent('suggestionAction', {
        detail: { 
          nodeKey, 
          id, 
          action, 
          reason: newReason,
          originalText,
          suggestedText 
        },
        bubbles: true,
        cancelable: true,
      });
      suggestionElement.dispatchEvent(event);
    }
  };

  if (status === 'APPROVED') {
    return (
      <span className="suggestion-approved" title={`Suggestion approved: ${reason || ''}`}>
        {suggestedText}
      </span>
    );
  }

  if (status === 'REJECTED') {
    return (
      <span className="suggestion-rejected" title={`Suggestion rejected: ${reason || ''}`}>
        {originalText}
      </span>
    );
  }

  return (
    <span className="suggestion-pending" title={`Suggested edit by ${authorId}`}>
      <span className="original-text">{originalText}</span>
      <span className="suggestion-arrow">→</span>
      <span className="suggested-text">{suggestedText}</span>
      <span className="suggestion-controls">
        <button 
          className="btn-suggestion-approve"
          onClick={() => handleSuggestionAction('approve')}
          title="Approve suggestion"
        >
          ✓
        </button>
        <button 
          className="btn-suggestion-reject"
          onClick={() => handleSuggestionAction('reject')}
          title="Reject suggestion"
        >
          ✗
        </button>
      </span>
    </span>
  );
}

export function $createSuggestionNode(payload: SuggestionPayload): SuggestionNode {
  return new SuggestionNode(
    payload.id,
    payload.originalText,
    payload.suggestedText,
    payload.authorId,
    payload.status,
    payload.reason,
  );
}

export function $isSuggestionNode(node: LexicalNode | null | undefined): node is SuggestionNode {
  return node instanceof SuggestionNode;
} 