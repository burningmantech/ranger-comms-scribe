import { 
  CollaborativeDocument, 
  DocumentPermissions, 
  DocumentCollaborator, 
  DocumentVersion, 
  DocumentComment, 
  DocumentOperation, 
  TextOperation,
  CursorPosition,
  User,
  UserType 
} from '../types';
import { Env } from '../utils/sessionManager';
import { 
  getObject, 
  putObject, 
  deleteObject, 
  listObjects, 
  getFromCache, 
  setInCache, 
  removeFromCache 
} from './cacheService';
import { v4 as uuidv4 } from 'uuid';

// Cache TTL for documents (1 hour)
const DOCUMENT_CACHE_TTL = 3600;

/**
 * Create a new collaborative document
 */
export async function createDocument(
  title: string,
  content: string,
  richTextContent: string,
  user: User,
  permissions: Partial<DocumentPermissions> = {},
  env: Env
): Promise<CollaborativeDocument> {
  const documentId = uuidv4();
  const now = new Date().toISOString();
  
  const document: CollaborativeDocument = {
    id: documentId,
    title,
    content,
    richTextContent,
    createdBy: user.id || user.email,
    createdAt: now,
    lastModifiedBy: user.id || user.email,
    lastModifiedAt: now,
    version: 1,
    permissions: {
      owner: user.id || user.email,
      editors: permissions.editors || [],
      viewers: permissions.viewers || [],
      commenters: permissions.commenters || [],
      isPublic: permissions.isPublic || false,
      allowFork: permissions.allowFork || false,
      allowComments: permissions.allowComments || true,
      ...permissions
    },
    collaborators: [{
      userId: user.id || user.email,
      userName: user.name,
      userEmail: user.email,
      role: 'owner',
      joinedAt: now,
      lastActiveAt: now,
      isOnline: true
    }],
    isPublic: permissions.isPublic || false,
    groupId: undefined,
    tags: [],
    metadata: {},
    status: 'draft'
  };

  // Store the document
  await putObject(`documents/${documentId}`, document, env);
  
  // Create initial version
  const initialVersion: DocumentVersion = {
    id: uuidv4(),
    documentId,
    version: 1,
    content,
    richTextContent,
    createdBy: user.id || user.email,
    createdAt: now,
    changeDescription: 'Initial version',
    operations: [],
    parentVersionId: undefined
  };
  
  await putObject(`document_versions/${documentId}/${initialVersion.id}`, initialVersion, env);
  
  // Cache the document
  await setInCache(`doc_${documentId}`, document, env, DOCUMENT_CACHE_TTL);
  
  return document;
}

/**
 * Get a document by ID
 */
export async function getDocument(documentId: string, env: Env): Promise<CollaborativeDocument | null> {
  try {
    // Try cache first
    const cached = await getFromCache(`doc_${documentId}`, env);
    if (cached) {
      return cached as CollaborativeDocument;
    }
    
    // Get from storage
    const document = await getObject<CollaborativeDocument>(`documents/${documentId}`, env);
    
    if (document) {
      // Cache for future requests
      await setInCache(`doc_${documentId}`, document, env, DOCUMENT_CACHE_TTL);
    }
    
    return document;
  } catch (error) {
    console.error('Error getting document:', error);
    return null;
  }
}

/**
 * Update a document
 */
export async function updateDocument(
  documentId: string,
  updates: Partial<CollaborativeDocument>,
  user: User,
  env: Env
): Promise<CollaborativeDocument | null> {
  const document = await getDocument(documentId, env);
  if (!document) {
    return null;
  }

  // Check permissions
  if (!canEditDocument(document, user)) {
    throw new Error('Insufficient permissions to edit document');
  }

  const now = new Date().toISOString();
  const updatedDocument: CollaborativeDocument = {
    ...document,
    ...updates,
    lastModifiedBy: user.id || user.email,
    lastModifiedAt: now,
    version: document.version + 1
  };

  // Store the updated document
  await putObject(`documents/${documentId}`, updatedDocument, env);
  
  // Update cache
  await setInCache(`doc_${documentId}`, updatedDocument, env, DOCUMENT_CACHE_TTL);
  
  return updatedDocument;
}

/**
 * Delete a document
 */
export async function deleteDocument(documentId: string, user: User, env: Env): Promise<boolean> {
  const document = await getDocument(documentId, env);
  if (!document) {
    return false;
  }

  // Check permissions (only owner or admin can delete)
  if (document.permissions.owner !== (user.id || user.email) && user.userType !== UserType.Admin) {
    throw new Error('Insufficient permissions to delete document');
  }

  // Delete the document
  await deleteObject(`documents/${documentId}`, env);
  
  // Remove from cache
  await removeFromCache(`doc_${documentId}`, env);
  
  // TODO: Also delete all versions, comments, and operations
  
  return true;
}

/**
 * List documents accessible to a user
 */
export async function listDocuments(user: User, env: Env): Promise<CollaborativeDocument[]> {
  try {
    const documentsResponse = await listObjects('documents/', env);
    const documents: CollaborativeDocument[] = [];
    
    // Process each document
    for (const obj of documentsResponse.objects) {
      const document = await getObject<CollaborativeDocument>(obj.key, env);
      if (document && canViewDocument(document, user)) {
        documents.push(document);
      }
    }
    
    // Sort by last modified date
    return documents.sort((a, b) => 
      new Date(b.lastModifiedAt).getTime() - new Date(a.lastModifiedAt).getTime()
    );
  } catch (error) {
    console.error('Error listing documents:', error);
    return [];
  }
}

/**
 * Add a collaborator to a document
 */
export async function addCollaborator(
  documentId: string,
  collaboratorEmail: string,
  role: 'editor' | 'viewer' | 'commenter',
  user: User,
  env: Env
): Promise<CollaborativeDocument | null> {
  const document = await getDocument(documentId, env);
  if (!document) {
    return null;
  }

  // Check permissions (only owner or editors can add collaborators)
  if (!canManageCollaborators(document, user)) {
    throw new Error('Insufficient permissions to add collaborators');
  }

  // Check if collaborator already exists
  const existingCollaborator = document.collaborators.find(c => c.userEmail === collaboratorEmail);
  if (existingCollaborator) {
    // Update existing collaborator role
    existingCollaborator.role = role;
    existingCollaborator.lastActiveAt = new Date().toISOString();
  } else {
    // Add new collaborator
    document.collaborators.push({
      userId: collaboratorEmail, // We'll update this when the user joins
      userName: collaboratorEmail.split('@')[0], // Placeholder
      userEmail: collaboratorEmail,
      role,
      joinedAt: new Date().toISOString(),
      lastActiveAt: new Date().toISOString(),
      isOnline: false
    });
  }

  // Update permissions based on role
  const userId = collaboratorEmail;
  switch (role) {
    case 'editor':
      if (!document.permissions.editors.includes(userId)) {
        document.permissions.editors.push(userId);
      }
      break;
    case 'viewer':
      if (!document.permissions.viewers.includes(userId)) {
        document.permissions.viewers.push(userId);
      }
      break;
    case 'commenter':
      if (!document.permissions.commenters.includes(userId)) {
        document.permissions.commenters.push(userId);
      }
      break;
  }

  return await updateDocument(documentId, document, user, env);
}

/**
 * Remove a collaborator from a document
 */
export async function removeCollaborator(
  documentId: string,
  collaboratorId: string,
  user: User,
  env: Env
): Promise<CollaborativeDocument | null> {
  const document = await getDocument(documentId, env);
  if (!document) {
    return null;
  }

  // Check permissions
  if (!canManageCollaborators(document, user)) {
    throw new Error('Insufficient permissions to remove collaborators');
  }

  // Remove from collaborators list
  document.collaborators = document.collaborators.filter(c => c.userId !== collaboratorId);

  // Remove from permissions
  document.permissions.editors = document.permissions.editors.filter(id => id !== collaboratorId);
  document.permissions.viewers = document.permissions.viewers.filter(id => id !== collaboratorId);
  document.permissions.commenters = document.permissions.commenters.filter(id => id !== collaboratorId);

  return await updateDocument(documentId, document, user, env);
}

/**
 * Apply text operations to a document
 */
export async function applyTextOperations(
  documentId: string,
  operations: TextOperation[],
  user: User,
  env: Env
): Promise<CollaborativeDocument | null> {
  const document = await getDocument(documentId, env);
  if (!document) {
    return null;
  }

  // Check permissions
  if (!canEditDocument(document, user)) {
    throw new Error('Insufficient permissions to edit document');
  }

  // Apply operations to content
  let newContent = document.content;
  let newRichTextContent = document.richTextContent;

  // For simplicity, we'll just update the content directly
  // In a production system, you'd apply the operations properly
  for (const operation of operations) {
    if (operation.type === 'insert' && operation.content) {
      newContent = newContent.slice(0, operation.position) + 
                   operation.content + 
                   newContent.slice(operation.position);
    } else if (operation.type === 'delete' && operation.length) {
      newContent = newContent.slice(0, operation.position) + 
                   newContent.slice(operation.position + operation.length);
    }
  }

  // Create operation record
  const operationRecord: DocumentOperation = {
    id: uuidv4(),
    documentId,
    version: document.version + 1,
    operations,
    createdBy: user.id || user.email,
    createdAt: new Date().toISOString(),
    applied: true,
    transformedAgainst: []
  };

  // Store operation
  await putObject(`document_operations/${documentId}/${operationRecord.id}`, operationRecord, env);

  // Update document
  return await updateDocument(documentId, {
    content: newContent,
    richTextContent: newRichTextContent
  }, user, env);
}

/**
 * Update user cursor position
 */
export async function updateCursorPosition(
  documentId: string,
  cursor: CursorPosition,
  env: Env
): Promise<void> {
  const document = await getDocument(documentId, env);
  if (!document) {
    return;
  }

  // Update collaborator cursor position
  const collaborator = document.collaborators.find(c => c.userId === cursor.userId);
  if (collaborator) {
    collaborator.cursor = cursor;
    collaborator.lastActiveAt = new Date().toISOString();
    collaborator.isOnline = true;
    
    // Update document
    await putObject(`documents/${documentId}`, document, env);
    await setInCache(`doc_${documentId}`, document, env, DOCUMENT_CACHE_TTL);
  }
}

/**
 * Get document versions
 */
export async function getDocumentVersions(documentId: string, env: Env): Promise<DocumentVersion[]> {
  try {
    const versionsResponse = await listObjects(`document_versions/${documentId}/`, env);
    const versions: DocumentVersion[] = [];
    
    for (const obj of versionsResponse.objects) {
      const version = await getObject<DocumentVersion>(obj.key, env);
      if (version) {
        versions.push(version);
      }
    }
    
    return versions.sort((a, b) => b.version - a.version);
  } catch (error) {
    console.error('Error getting document versions:', error);
    return [];
  }
}

/**
 * Add a comment to a document
 */
export async function addComment(
  documentId: string,
  content: string,
  user: User,
  env: Env,
  position?: { startOffset: number; endOffset: number; startKey: string; endKey: string }
): Promise<DocumentComment | null> {
  const document = await getDocument(documentId, env);
  if (!document) {
    return null;
  }

  // Check permissions
  if (!canCommentOnDocument(document, user)) {
    throw new Error('Insufficient permissions to comment on document');
  }

  const comment: DocumentComment = {
    id: uuidv4(),
    documentId,
    content,
    authorId: user.id || user.email,
    authorName: user.name,
    authorEmail: user.email,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    resolved: false,
    position
  };

  // Store comment
  await putObject(`document_comments/${documentId}/${comment.id}`, comment, env);
  
  return comment;
}

/**
 * Get comments for a document
 */
export async function getComments(documentId: string, env: Env): Promise<DocumentComment[]> {
  try {
    const commentsResponse = await listObjects(`document_comments/${documentId}/`, env);
    const comments: DocumentComment[] = [];
    
    for (const obj of commentsResponse.objects) {
      const comment = await getObject<DocumentComment>(obj.key, env);
      if (comment) {
        comments.push(comment);
      }
    }
    
    return comments.sort((a, b) => 
      new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
    );
  } catch (error) {
    console.error('Error getting comments:', error);
    return [];
  }
}

// Permission helper functions
export function canViewDocument(document: CollaborativeDocument, user: User): boolean {
  if (document.isPublic) return true;
  if (document.permissions.owner === (user.id || user.email)) return true;
  if (user.userType === UserType.Admin) return true;
  
  const userId = user.id || user.email;
  return document.permissions.editors.includes(userId) ||
         document.permissions.viewers.includes(userId) ||
         document.permissions.commenters.includes(userId);
}

export function canEditDocument(document: CollaborativeDocument, user: User): boolean {
  if (document.permissions.owner === (user.id || user.email)) return true;
  if (user.userType === UserType.Admin) return true;
  
  const userId = user.id || user.email;
  return document.permissions.editors.includes(userId);
}

export function canCommentOnDocument(document: CollaborativeDocument, user: User): boolean {
  if (!document.permissions.allowComments) return false;
  if (document.permissions.owner === (user.id || user.email)) return true;
  if (user.userType === UserType.Admin) return true;
  
  const userId = user.id || user.email;
  return document.permissions.editors.includes(userId) ||
         document.permissions.commenters.includes(userId);
}

export function canManageCollaborators(document: CollaborativeDocument, user: User): boolean {
  if (document.permissions.owner === (user.id || user.email)) return true;
  if (user.userType === UserType.Admin) return true;
  
  const userId = user.id || user.email;
  return document.permissions.editors.includes(userId);
}

/**
 * Fork a document (create a copy)
 */
export async function forkDocument(
  documentId: string,
  newTitle: string,
  user: User,
  env: Env
): Promise<CollaborativeDocument | null> {
  const originalDocument = await getDocument(documentId, env);
  if (!originalDocument) {
    return null;
  }

  // Check if forking is allowed
  if (!originalDocument.permissions.allowFork) {
    throw new Error('Forking is not allowed for this document');
  }

  // Create new document
  const forkedDocument = await createDocument(
    newTitle,
    originalDocument.content,
    originalDocument.richTextContent,
    user,
    {
      isPublic: false, // Forked documents are private by default
      allowFork: true,
      allowComments: true
    },
    env
  );

  // Update forked document to reference original
  return await updateDocument(forkedDocument.id, {
    forkFromDocumentId: documentId,
    tags: [...originalDocument.tags, 'forked']
  }, user, env);
} 