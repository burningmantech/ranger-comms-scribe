// Shared types for the backend

export enum UserType {
  Public = 'Public',
  Member = 'Member',
  Lead = 'Lead',
  Admin = 'Admin'
}

export interface Page {
  id: string;
  title: string;
  slug: string;
  content: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  published: boolean;
  isPublic: boolean;
  groupId?: string; // Optional group ID if not public
  order: number; // For ordering in navigation
  showInNavigation: boolean; // Whether to show in main navigation
}

export interface User {
  id: string;
  name: string;
  email: string;
  approved: boolean;
  isAdmin: boolean; // Keeping for backward compatibility
  userType: UserType;
  groups: string[]; // Array of group IDs the user belongs to
}

export interface Group {
  id: string;
  name: string;
  description: string;
  createdBy: string; // User ID of creator
  createdAt: string;
  updatedAt: string;
  members: string[]; // Array of user IDs
}

export interface MediaItem {
  id: string;
  fileName: string;
  fileType: string;
  url: string;
  thumbnailUrl: string;
  uploadedBy: string;
  uploadedAt: string;
  size: number;
  isPublic: boolean;
  groupId?: string; // Optional group ID if not public
}

export interface BlogPost {
  id: string;
  title: string;
  content: string;
  author: string;
  authorId: string;
  createdAt: string;
  updatedAt: string;
  published: boolean;
  commentsEnabled: boolean;
  media?: string[]; // Array of media item IDs
  isPublic: boolean;
  groupId?: string; // Optional group ID if not public
}

export interface BlogComment {
  id: string;
  postId: string;
  content: string;
  author: string;
  authorId: string;
  createdAt: string;
  isBlocked: boolean;
  parentId?: string; // If this is a reply, this points to the parent comment
  replies?: BlogComment[]; // Array of reply comments
  level?: number; // Comment nesting level (0, 1, 2 for up to 3 levels)
}

export interface BlockedUser {
  userId: string;
  blockedAt: string;
  blockedBy: string;
  reason?: string;
}

export interface GalleryComment {
  id: string;
  mediaId: string;
  content: string;
  author: string;
  authorId: string;
  createdAt: string;
  isBlocked: boolean;
  parentId?: string; // If this is a reply, this points to the parent comment
  replies?: GalleryComment[]; // Array of reply comments
  level: number; // Comment nesting level (0, 1, 2 for up to 3 levels)
}
