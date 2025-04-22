// Shared types for the application

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
    id?: string; // Adding the id property that's used in the Blog component
    email: string;
    name: string;
    approved?: boolean;
    isAdmin?: boolean; // Keeping for backward compatibility
    userType?: UserType;
    groups?: string[]; // Array of group IDs the user belongs to
    notificationSettings?: {
        notifyOnReplies: boolean; // Notify when someone replies to posts or comments
        notifyOnGroupContent: boolean; // Notify when content is posted in groups
    };
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
    id: string;              // Unique identifier for the media item
    fileName: string;        // Name of the file
    fileType: string;        // MIME type of the file
    url: string;             // URL to access the full-sized media
    thumbnailUrl: string;    // URL to access the thumbnail version
    mediumUrl?: string;      // URL for medium-sized version (max 1024px)
    uploadedBy: string;      // Email/ID of the user who uploaded the item
    uploaderName?: string;   // Display name of the user who uploaded the item
    uploadedAt: string;      // ISO timestamp of when the item was uploaded
    takenBy?: string;        // Photographer or content creator name
    size: number;            // Size of the file in bytes
    isPublic: boolean;       // Whether the media is publicly accessible
    groupId?: string;        // ID of the group the media belongs to if not public
    groupName?: string;      // Name of the group for display purposes
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
    media?: MediaItem[];
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
    parentId?: string; // If this is a reply, this will point to the parent comment
    replies?: BlogComment[]; // Array of reply comments
    level: number; // Comment nesting level (0, 1, 2 for up to 3 levels)
}

export interface GalleryComment {
    id: string;
    mediaId: string;
    content: string;
    author: string;
    authorId: string;
    createdAt: string;
    isBlocked: boolean;
    parentId?: string; // If this is a reply, this will point to the parent comment
    replies?: GalleryComment[]; // Array of reply comments
    level: number; // Comment nesting level (0, 1, 2 for up to 3 levels)
}
