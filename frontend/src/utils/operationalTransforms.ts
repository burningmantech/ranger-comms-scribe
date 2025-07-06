import { TextOperation } from '../services/websocketService';

export interface TransformResult {
  transformedOp: TextOperation;
  transformedAgainst: TextOperation;
}

/**
 * Simplified Operational Transform implementation
 * In production, use a proper OT library like ShareJS or Yjs
 */

export function transformOperations(op1: TextOperation, op2: TextOperation): TransformResult {
  // Create transformed versions of both operations
  const transformedOp = { ...op1 };
  const transformedAgainst = { ...op2 };

  // Transform based on operation types
  if (op1.type === 'insert' && op2.type === 'insert') {
    return transformInsertInsert(transformedOp, transformedAgainst);
  } else if (op1.type === 'insert' && op2.type === 'delete') {
    return transformInsertDelete(transformedOp, transformedAgainst);
  } else if (op1.type === 'delete' && op2.type === 'insert') {
    return transformDeleteInsert(transformedOp, transformedAgainst);
  } else if (op1.type === 'delete' && op2.type === 'delete') {
    return transformDeleteDelete(transformedOp, transformedAgainst);
  } else if (op1.type === 'retain' || op2.type === 'retain') {
    return transformWithRetain(transformedOp, transformedAgainst);
  }

  // Default: return operations unchanged
  return {
    transformedOp,
    transformedAgainst
  };
}

function transformInsertInsert(op1: TextOperation, op2: TextOperation): TransformResult {
  // Two concurrent insertions
  if (op1.position <= op2.position) {
    // op1 happens first, adjust op2 position
    return {
      transformedOp: op1,
      transformedAgainst: {
        ...op2,
        position: op2.position + (op1.content?.length || 0)
      }
    };
  } else {
    // op2 happens first, adjust op1 position
    return {
      transformedOp: {
        ...op1,
        position: op1.position + (op2.content?.length || 0)
      },
      transformedAgainst: op2
    };
  }
}

function transformInsertDelete(op1: TextOperation, op2: TextOperation): TransformResult {
  // op1 is insert, op2 is delete
  if (op1.position <= op2.position) {
    // Insert happens before delete, adjust delete position
    return {
      transformedOp: op1,
      transformedAgainst: {
        ...op2,
        position: op2.position + (op1.content?.length || 0)
      }
    };
  } else if (op1.position >= op2.position + (op2.length || 0)) {
    // Insert happens after deleted range, adjust insert position
    return {
      transformedOp: {
        ...op1,
        position: op1.position - (op2.length || 0)
      },
      transformedAgainst: op2
    };
  } else {
    // Insert happens within deleted range
    return {
      transformedOp: {
        ...op1,
        position: op2.position
      },
      transformedAgainst: {
        ...op2,
        length: (op2.length || 0) + (op1.content?.length || 0)
      }
    };
  }
}

function transformDeleteInsert(op1: TextOperation, op2: TextOperation): TransformResult {
  // op1 is delete, op2 is insert
  const insertDeleteResult = transformInsertDelete(op2, op1);
  return {
    transformedOp: insertDeleteResult.transformedAgainst,
    transformedAgainst: insertDeleteResult.transformedOp
  };
}

function transformDeleteDelete(op1: TextOperation, op2: TextOperation): TransformResult {
  // Two concurrent deletions
  const op1End = op1.position + (op1.length || 0);
  const op2End = op2.position + (op2.length || 0);

  if (op1End <= op2.position) {
    // op1 deletion is completely before op2
    return {
      transformedOp: op1,
      transformedAgainst: {
        ...op2,
        position: op2.position - (op1.length || 0)
      }
    };
  } else if (op2End <= op1.position) {
    // op2 deletion is completely before op1
    return {
      transformedOp: {
        ...op1,
        position: op1.position - (op2.length || 0)
      },
      transformedAgainst: op2
    };
  } else {
    // Overlapping deletions - need to merge
    const newStart = Math.min(op1.position, op2.position);
    const newEnd = Math.max(op1End, op2End);
    const overlap = Math.min(op1End, op2End) - Math.max(op1.position, op2.position);
    
    return {
      transformedOp: {
        ...op1,
        position: newStart,
        length: (op1.length || 0) - Math.max(0, overlap)
      },
      transformedAgainst: {
        ...op2,
        position: newStart,
        length: (op2.length || 0) - Math.max(0, overlap)
      }
    };
  }
}

function transformWithRetain(op1: TextOperation, op2: TextOperation): TransformResult {
  // Simplified handling for retain operations
  // In a full implementation, retain operations would be more complex
  return {
    transformedOp: op1,
    transformedAgainst: op2
  };
}

/**
 * Apply a series of operations to determine the final state
 */
export function applyOperations(operations: TextOperation[]): TextOperation[] {
  const sortedOps = [...operations].sort((a, b) => a.version - b.version);
  const transformedOps: TextOperation[] = [];

  for (let i = 0; i < sortedOps.length; i++) {
    let currentOp = sortedOps[i];
    
    // Transform current operation against all previous operations
    for (let j = 0; j < transformedOps.length; j++) {
      const result = transformOperations(currentOp, transformedOps[j]);
      currentOp = result.transformedOp;
      transformedOps[j] = result.transformedAgainst;
    }
    
    transformedOps.push(currentOp);
  }

  return transformedOps;
}

/**
 * Create a text operation from a change
 */
export function createTextOperation(
  type: 'insert' | 'delete' | 'retain',
  position: number,
  content?: string,
  length?: number,
  version: number = 0,
  attributes?: Record<string, any>
): TextOperation {
  return {
    type,
    position,
    content,
    length,
    version,
    attributes
  };
}

/**
 * Merge consecutive operations of the same type
 */
export function mergeOperations(operations: TextOperation[]): TextOperation[] {
  if (operations.length <= 1) return operations;

  const merged: TextOperation[] = [];
  let current = operations[0];

  for (let i = 1; i < operations.length; i++) {
    const next = operations[i];
    
    // Try to merge if same type and consecutive positions
    if (current.type === next.type && 
        current.type === 'insert' && 
        current.position + (current.content?.length || 0) === next.position) {
      // Merge insert operations
      current = {
        ...current,
        content: (current.content || '') + (next.content || ''),
        version: Math.max(current.version, next.version)
      };
    } else if (current.type === next.type && 
               current.type === 'delete' && 
               current.position === next.position) {
      // Merge delete operations
      current = {
        ...current,
        length: (current.length || 0) + (next.length || 0),
        version: Math.max(current.version, next.version)
      };
    } else {
      // Can't merge, add current and move to next
      merged.push(current);
      current = next;
    }
  }
  
  merged.push(current);
  return merged;
}

/**
 * Check if two operations conflict
 */
export function operationsConflict(op1: TextOperation, op2: TextOperation): boolean {
  if (op1.type === 'retain' || op2.type === 'retain') {
    return false; // Retain operations don't conflict
  }

  const op1End = op1.position + (op1.type === 'insert' ? 0 : (op1.length || 0));
  const op2End = op2.position + (op2.type === 'insert' ? 0 : (op2.length || 0));

  // Check for overlap
  return !(op1End <= op2.position || op2End <= op1.position);
}

/**
 * Priority-based conflict resolution
 * In case of conflicts, the operation with higher priority wins
 */
export function resolveConflict(op1: TextOperation, op2: TextOperation, op1Priority: number = 0, op2Priority: number = 0): TextOperation {
  if (!operationsConflict(op1, op2)) {
    // No conflict, apply transformation
    return transformOperations(op1, op2).transformedOp;
  }

  // Conflict detected, use priority
  if (op1Priority > op2Priority) {
    return op1;
  } else if (op2Priority > op1Priority) {
    return op2;
  } else {
    // Equal priority, use version or timestamp as tiebreaker
    return op1.version >= op2.version ? op1 : op2;
  }
} 