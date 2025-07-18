import { AutoRouter } from 'itty-router';
import { json } from 'itty-router-extras';
import { withAuth } from '../authWrappers';
import { User } from '../types';
import {
  createDocument,
  getDocument,
  updateDocument,
  deleteDocument,
  listDocuments,
  addCollaborator,
  removeCollaborator,
  applyTextOperations,
  updateCursorPosition,
  getDocumentVersions,
  addComment,
  getComments,
  forkDocument,
  canViewDocument,
  canEditDocument
} from '../services/documentService';
import { broadcastToDocumentRoom } from './websocket';

export const router = AutoRouter({ base: '/api/documents' });

// Create a new document
router.post('/', withAuth, async (request: Request, env: any) => {
  try {
    const user = (request as any).user as User;
    const { title, content, richTextContent, permissions } = await request.json();

    const document = await createDocument(
      title,
      content || '',
      richTextContent || '',
      user,
      permissions || {},
      env
    );

    return json(document, { status: 201 });
  } catch (error) {
    console.error('Error creating document:', error);
    return json({ error: 'Failed to create document' }, { status: 500 });
  }
});

// Get all documents for current user
router.get('/', withAuth, async (request: Request, env: any) => {
  try {
    const user = (request as any).user as User;
    const documents = await listDocuments(user, env);
    return json(documents);
  } catch (error) {
    console.error('Error listing documents:', error);
    return json({ error: 'Failed to list documents' }, { status: 500 });
  }
});

// Get a specific document
router.get('/:id', withAuth, async (request: Request, env: any) => {
  try {
    const { id } = (request as any).params;
    const user = (request as any).user as User;
    
    const document = await getDocument(id, env);
    if (!document) {
      return json({ error: 'Document not found' }, { status: 404 });
    }

    // Check permissions
    if (!canViewDocument(document, user)) {
      return json({ error: 'Access denied' }, { status: 403 });
    }

    return json(document);
  } catch (error) {
    console.error('Error getting document:', error);
    return json({ error: 'Failed to get document' }, { status: 500 });
  }
});

// Update a document
router.put('/:id', withAuth, async (request: Request, env: any) => {
  try {
    const { id } = (request as any).params;
    const user = (request as any).user as User;
    const updates = await request.json();

    const updatedDocument = await updateDocument(id, updates, user, env);
    if (!updatedDocument) {
      return json({ error: 'Document not found' }, { status: 404 });
    }

    // Broadcast update to collaborators
    await broadcastToDocumentRoom(id, {
      type: 'content_updated',
      userId: user.id || user.email,
      userName: user.name,
      userEmail: user.email,
      data: {
        title: updatedDocument.title,
        content: updatedDocument.content,
        version: updatedDocument.version,
        changes: updates
      }
    }, env);

    return json(updatedDocument);
  } catch (error) {
    console.error('Error updating document:', error);
    if (error instanceof Error && error.message.includes('Insufficient permissions')) {
      return json({ error: error.message }, { status: 403 });
    }
    return json({ error: 'Failed to update document' }, { status: 500 });
  }
});

// Delete a document
router.delete('/:id', withAuth, async (request: Request, env: any) => {
  try {
    const { id } = (request as any).params;
    const user = (request as any).user as User;

    const success = await deleteDocument(id, user, env);
    if (!success) {
      return json({ error: 'Document not found' }, { status: 404 });
    }

    // Broadcast deletion to collaborators
    await broadcastToDocumentRoom(id, {
      type: 'content_updated',
      userId: user.id || user.email,
      userName: user.name,
      userEmail: user.email,
      data: {
        action: 'deleted'
      }
    }, env);

    return json({ success: true });
  } catch (error) {
    console.error('Error deleting document:', error);
    if (error instanceof Error && error.message.includes('Insufficient permissions')) {
      return json({ error: error.message }, { status: 403 });
    }
    return json({ error: 'Failed to delete document' }, { status: 500 });
  }
});

// Add a collaborator
router.post('/:id/collaborators', withAuth, async (request: Request, env: any) => {
  try {
    const { id } = (request as any).params;
    const user = (request as any).user as User;
    const { email, role } = await request.json();

    const updatedDocument = await addCollaborator(id, email, role, user, env);
    if (!updatedDocument) {
      return json({ error: 'Document not found' }, { status: 404 });
    }

    // Broadcast new collaborator to other users
    await broadcastToDocumentRoom(id, {
      type: 'user_joined',
      userId: user.id || user.email,
      userName: user.name,
      userEmail: user.email,
      data: {
        collaboratorEmail: email,
        role: role
      }
    }, env);

    return json(updatedDocument);
  } catch (error) {
    console.error('Error adding collaborator:', error);
    if (error instanceof Error && error.message.includes('Insufficient permissions')) {
      return json({ error: error.message }, { status: 403 });
    }
    return json({ error: 'Failed to add collaborator' }, { status: 500 });
  }
});

// Remove a collaborator
router.delete('/:id/collaborators/:collaboratorId', withAuth, async (request: Request, env: any) => {
  try {
    const { id, collaboratorId } = (request as any).params;
    const user = (request as any).user as User;

    const updatedDocument = await removeCollaborator(id, collaboratorId, user, env);
    if (!updatedDocument) {
      return json({ error: 'Document not found' }, { status: 404 });
    }

    // Broadcast collaborator removal
    await broadcastToDocumentRoom(id, {
      type: 'user_left',
      userId: user.id || user.email,
      userName: user.name,
      userEmail: user.email,
      data: {
        collaboratorId: collaboratorId
      }
    }, env);

    return json(updatedDocument);
  } catch (error) {
    console.error('Error removing collaborator:', error);
    if (error instanceof Error && error.message.includes('Insufficient permissions')) {
      return json({ error: error.message }, { status: 403 });
    }
    return json({ error: 'Failed to remove collaborator' }, { status: 500 });
  }
});

// Apply text operations
router.post('/:id/operations', withAuth, async (request: Request, env: any) => {
  try {
    const { id } = (request as any).params;
    const user = (request as any).user as User;
    const { operations } = await request.json();

    const updatedDocument = await applyTextOperations(id, operations, user, env);
    if (!updatedDocument) {
      return json({ error: 'Document not found' }, { status: 404 });
    }

    // Broadcast operations to other collaborators
    await broadcastToDocumentRoom(id, {
      type: 'text_operation',
      userId: user.id || user.email,
      userName: user.name,
      userEmail: user.email,
      data: {
        operations: operations,
        version: updatedDocument.version
      }
    }, env);

    return json(updatedDocument);
  } catch (error) {
    console.error('Error applying operations:', error);
    if (error instanceof Error && error.message.includes('Insufficient permissions')) {
      return json({ error: error.message }, { status: 403 });
    }
    return json({ error: 'Failed to apply operations' }, { status: 500 });
  }
});

// Update cursor position
router.post('/:id/cursor', withAuth, async (request: Request, env: any) => {
  try {
    const { id } = (request as any).params;
    const user = (request as any).user as User;
    const { position, selectionStart, selectionEnd } = await request.json();

    const cursor = {
      userId: user.id || user.email,
      userName: user.name,
      position,
      selectionStart,
      selectionEnd,
      timestamp: new Date().toISOString()
    };

    await updateCursorPosition(id, cursor, env);

    // Broadcast cursor position to other collaborators
    await broadcastToDocumentRoom(id, {
      type: 'cursor_position',
      userId: user.id || user.email,
      userName: user.name,
      userEmail: user.email,
      data: cursor
    }, env);

    return json({ success: true });
  } catch (error) {
    console.error('Error updating cursor:', error);
    return json({ error: 'Failed to update cursor' }, { status: 500 });
  }
});

// Get document versions
router.get('/:id/versions', withAuth, async (request: Request, env: any) => {
  try {
    const { id } = (request as any).params;
    const user = (request as any).user as User;

    // Check if user can view document
    const document = await getDocument(id, env);
    if (!document) {
      return json({ error: 'Document not found' }, { status: 404 });
    }

    if (!canViewDocument(document, user)) {
      return json({ error: 'Access denied' }, { status: 403 });
    }

    const versions = await getDocumentVersions(id, env);
    return json(versions);
  } catch (error) {
    console.error('Error getting versions:', error);
    return json({ error: 'Failed to get versions' }, { status: 500 });
  }
});

// Add a comment
router.post('/:id/comments', withAuth, async (request: Request, env: any) => {
  try {
    const { id } = (request as any).params;
    const user = (request as any).user as User;
    const { content, position } = await request.json();

    const comment = await addComment(id, content, user, env, position);
    if (!comment) {
      return json({ error: 'Document not found' }, { status: 404 });
    }

    // Broadcast comment to collaborators
    await broadcastToDocumentRoom(id, {
      type: 'comment_added',
      userId: user.id || user.email,
      userName: user.name,
      userEmail: user.email,
      data: comment
    }, env);

    return json(comment, { status: 201 });
  } catch (error) {
    console.error('Error adding comment:', error);
    if (error instanceof Error && error.message.includes('Insufficient permissions')) {
      return json({ error: error.message }, { status: 403 });
    }
    return json({ error: 'Failed to add comment' }, { status: 500 });
  }
});

// Get comments for a document
router.get('/:id/comments', withAuth, async (request: Request, env: any) => {
  try {
    const { id } = (request as any).params;
    const user = (request as any).user as User;

    // Check if user can view document
    const document = await getDocument(id, env);
    if (!document) {
      return json({ error: 'Document not found' }, { status: 404 });
    }

    if (!canViewDocument(document, user)) {
      return json({ error: 'Access denied' }, { status: 403 });
    }

    const comments = await getComments(id, env);
    return json(comments);
  } catch (error) {
    console.error('Error getting comments:', error);
    return json({ error: 'Failed to get comments' }, { status: 500 });
  }
});

// Fork a document
router.post('/:id/fork', withAuth, async (request: Request, env: any) => {
  try {
    const { id } = (request as any).params;
    const user = (request as any).user as User;
    const { title } = await request.json();

    const forkedDocument = await forkDocument(id, title, user, env);
    if (!forkedDocument) {
      return json({ error: 'Document not found or forking not allowed' }, { status: 404 });
    }

    return json(forkedDocument, { status: 201 });
  } catch (error) {
    console.error('Error forking document:', error);
    if (error instanceof Error && error.message.includes('not allowed')) {
      return json({ error: error.message }, { status: 403 });
    }
    return json({ error: 'Failed to fork document' }, { status: 500 });
  }
});

// Get document state for collaboration
router.get('/:id/state', withAuth, async (request: Request, env: any) => {
  try {
    const { id } = (request as any).params;
    const user = (request as any).user as User;

    const document = await getDocument(id, env);
    if (!document) {
      return json({ error: 'Document not found' }, { status: 404 });
    }

    if (!canViewDocument(document, user)) {
      return json({ error: 'Access denied' }, { status: 403 });
    }

    // Return minimal state for collaboration
    const state = {
      content: document.content,
      richTextContent: document.richTextContent,
      version: document.version,
      collaborators: document.collaborators.map(c => ({
        userId: c.userId,
        userName: c.userName,
        isOnline: c.isOnline,
        cursor: c.cursor
      }))
    };

    return json(state);
  } catch (error) {
    console.error('Error getting document state:', error);
    return json({ error: 'Failed to get document state' }, { status: 500 });
  }
}); 