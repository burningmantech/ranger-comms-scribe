import { Env } from '../utils/sessionManager';
import { BlogPost, BlogComment, BlockedUser, UserType } from '../types';
import { getUser, canAccessGroup } from '../services/userService';

// Get all blog posts
export const getBlogPosts = async (env: Env, userId?: string): Promise<BlogPost[]> => {
    try {
        // List all objects with the blog/posts/ prefix
        const objects = await env.R2.list({ prefix: 'blog/posts/' });
        
        // Create a list of promises to get each post's content
        const postPromises = objects.objects.map(async (object: { key: string }) => {
            const postObject = await env.R2.get(object.key);
            if (!postObject) return null;
            
            const post = await postObject.json() as BlogPost;
            return post;
        });
        
        // Wait for all promises to resolve and filter out null values
        let posts = (await Promise.all(postPromises)).filter((post: any): post is BlogPost => post !== null);
        
        // If userId is provided, filter posts based on access permissions
        if (userId) {
            const user = await getUser(userId, env);
            
            // If user is admin, they can see all posts
            if (user && user.userType === UserType.Admin) {
                // No filtering needed, admins see everything
            } else {
                // Filter posts based on access
                posts = await Promise.all(
                    posts.map(async (post: BlogPost) => {
                        // Public posts are visible to everyone
                        if (post.isPublic) return post;
                        
                        // Group posts require membership check
                        if (post.groupId && user) {
                            const canAccess = await canAccessGroup(userId, post.groupId, env);
                            if (canAccess) return post;
                        }
                        
                        return null;
                    })
                ).then(filteredPosts => filteredPosts.filter((post: any): post is BlogPost => post !== null));
            }
        } else {
            // No user ID provided, only return public posts
            posts = posts.filter((post: BlogPost) => post.isPublic);
        }
        
        // Sort posts by creation date (newest first)
        return posts.sort((a: BlogPost, b: BlogPost) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    } catch (error) {
        console.error('Error fetching blog posts from R2:', error);
        return [];
    }
};

// Get a single blog post by ID
export const getBlogPost = async (postId: string, env: Env): Promise<BlogPost | null> => {
    try {
        const postKey = `blog/posts/${postId}`;
        const postObject = await env.R2.get(postKey);
        
        if (!postObject) {
            return null;
        }
        
        const post = await postObject.json() as BlogPost;
        return post;
    } catch (error) {
        console.error('Error fetching blog post from R2:', error);
        return null;
    }
};

// Create a new blog post
export const createBlogPost = async (
    post: {
        title: string;
        content: string;
        published: boolean;
        commentsEnabled: boolean;
        media?: string[];
        isPublic?: boolean;
        groupId?: string;
    },
    userId: string,
    userName: string,
    env: Env
): Promise<{ success: boolean; message: string; post?: BlogPost }> => {
    try {
        // Generate a unique ID for the post
        // The optional chaining operator helps avoid errors in test environments where Date.now might be mocked improperly
        const timestamp = Date.now?.() || 1609459200000; // Fallback to fixed timestamp if Date.now is not a function
        const randomSuffix = Math.random().toString(36).substring(2, 9);
        const postId = `post_${timestamp}_${randomSuffix}`;
        const isoTimestamp = new Date().toISOString();
        
        // Create the blog post object
        const newPost: BlogPost = {
            id: postId,
            title: post.title,
            content: post.content,
            author: userName,
            authorId: userId,
            createdAt: isoTimestamp,
            updatedAt: isoTimestamp,
            published: post.published || false,
            commentsEnabled: post.commentsEnabled || true,
            media: post.media || [],
            isPublic: post.isPublic !== undefined ? post.isPublic : true, // Default to public
            groupId: post.groupId,
        };
        
        // Store the post in R2
        const postKey = `blog/posts/${postId}`;
        await env.R2.put(postKey, JSON.stringify(newPost), {
            httpMetadata: { contentType: 'application/json' },
            customMetadata: { 
                userId: userId,
                createdAt: isoTimestamp,
                type: 'blog-post',
            },
        });
        
        return { 
            success: true, 
            message: 'Blog post created successfully', 
            post: newPost 
        };
    } catch (error) {
        console.error('Error creating blog post in R2:', error);
        return { 
            success: false, 
            message: error instanceof Error ? error.message : 'Unknown error occurred during blog post creation' 
        };
    }
};

// Update an existing blog post
export const updateBlogPost = async (
    postId: string,
    updates: Partial<BlogPost>,
    env: Env
): Promise<{ success: boolean; message: string; post?: BlogPost }> => {
    try {
        // Get the existing post
        const existingPost = await getBlogPost(postId, env);
        
        if (!existingPost) {
            return { 
                success: false, 
                message: 'Blog post not found' 
            };
        }
        
        // Update the post with new values
        const updatedPost: BlogPost = {
            ...existingPost,
            ...updates,
            updatedAt: new Date().toISOString(),
        };
        
        // Store the updated post in R2
        const postKey = `blog/posts/${postId}`;
        await env.R2.put(postKey, JSON.stringify(updatedPost), {
            httpMetadata: { contentType: 'application/json' },
            customMetadata: { 
                userId: existingPost.authorId,
                updatedAt: updatedPost.updatedAt,
                type: 'blog-post',
            },
        });
        
        return { 
            success: true, 
            message: 'Blog post updated successfully', 
            post: updatedPost 
        };
    } catch (error) {
        console.error('Error updating blog post in R2:', error);
        return { 
            success: false, 
            message: error instanceof Error ? error.message : 'Unknown error occurred during blog post update' 
        };
    }
};

// Delete a blog post
export const deleteBlogPost = async (
    postId: string,
    env: Env
): Promise<{ success: boolean; message: string }> => {
    try {
        // Check if the post exists
        const postKey = `blog/posts/${postId}`;
        const postExists = await env.R2.head(postKey);
        
        if (!postExists) {
            return { 
                success: false, 
                message: 'Blog post not found' 
            };
        }
        
        // Delete the post
        await env.R2.delete(postKey);
        
        // Delete all comments for this post
        const commentsPrefix = `blog/comments/${postId}/`;
        const comments = await env.R2.list({ prefix: commentsPrefix });
        
        for (const comment of comments.objects) {
            await env.R2.delete(comment.key);
        }
        
        return { 
            success: true, 
            message: 'Blog post and associated comments deleted successfully' 
        };
    } catch (error) {
        console.error('Error deleting blog post from R2:', error);
        return { 
            success: false, 
            message: error instanceof Error ? error.message : 'Unknown error occurred during blog post deletion' 
        };
    }
};

// Get comments for a blog post
export const getComments = async (postId: string, env: Env): Promise<BlogComment[]> => {
    try {
        // List all objects with the blog/comments/postId/ prefix
        const objects = await env.R2.list({ prefix: `blog/comments/${postId}/` });
        
        // Create a list of promises to get each comment's content
        const commentPromises = objects.objects.map(async (object: { key: string }) => {
            const commentObject = await env.R2.get(object.key);
            if (!commentObject) return null;
            
            const comment = await commentObject.json() as BlogComment;
            return comment;
        });
        
        // Wait for all promises to resolve and filter out null values
        const comments = (await Promise.all(commentPromises)).filter((comment: any): comment is BlogComment => comment !== null);
        
        // Create a map to store comments by ID for easy lookup
        const commentsMap = new Map<string, BlogComment>();
        
        // Initialize comments map with all comments, adding an empty replies array
        comments.forEach(comment => {
            commentsMap.set(comment.id, {...comment, replies: []});
        });
        
        // Process comments to build the reply tree
        const rootComments: BlogComment[] = [];
        
        comments.forEach(comment => {
            if (comment.parentId) {
                // This is a reply, add it to its parent's replies array
                const parent = commentsMap.get(comment.parentId);
                if (parent && parent.replies) {
                    parent.replies.push(commentsMap.get(comment.id) || comment);
                }
            } else {
                // This is a root comment, add it to the result array
                rootComments.push(commentsMap.get(comment.id) || comment);
            }
        });
        
        // Sort root comments by creation date (oldest first)
        return rootComments.sort((a: BlogComment, b: BlogComment) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    } catch (error) {
        console.error('Error fetching comments from R2:', error);
        return [];
    }
};

// Add a comment to a blog post
export const addComment = async (
    postId: string,
    content: string,
    userId: string,
    userName: string,
    env: Env,
    parentId?: string
): Promise<{ success: boolean; message: string; comment?: BlogComment }> => {
    try {
        // Check if the post exists and comments are enabled
        const post = await getBlogPost(postId, env);
        
        if (!post) {
            return { 
                success: false, 
                message: 'Blog post not found' 
            };
        }
        
        if (!post.commentsEnabled) {
            return { 
                success: false, 
                message: 'Comments are disabled for this post' 
            };
        }
        
        // Check if the user is blocked
        const isBlocked = await isUserBlocked(userId, env);
        if (isBlocked) {
            return { 
                success: false, 
                message: 'You are not allowed to comment on blog posts' 
            };
        }
        
        // For replies, verify the parent comment exists and determine level
        let level = 0;
        if (parentId) {
            const commentKey = `blog/comments/${postId}/${parentId}`;
            const parentComment = await env.R2.get(commentKey);
            
            if (!parentComment) {
                return {
                    success: false,
                    message: 'Parent comment not found'
                };
            }
            
            // Parse parent comment to get its level
            const parentCommentData = await parentComment.json() as BlogComment;
            // Increment level for the reply (max level is 2 for up to 3 total levels including top level)
            level = Math.min(2, (parentCommentData.level || 0) + 1);
        }
        
        // Generate a unique ID for the comment
        const timestamp = Date.now?.() || 1609459200000; // Fallback to fixed timestamp if Date.now is not a function
        const randomSuffix = Math.random().toString(36).substring(2, 9);
        const commentId = `comment_${timestamp}_${randomSuffix}`;
        const isoTimestamp = new Date().toISOString();
        
        // Create the comment object
        const newComment: BlogComment = {
            id: commentId,
            postId: postId,
            content: content,
            author: userName,
            authorId: userId,
            createdAt: isoTimestamp,
            isBlocked: false,
            parentId: parentId,
            level: level
        };
        
        // Store the comment in R2
        const commentKey = `blog/comments/${postId}/${commentId}`;
        await env.R2.put(commentKey, JSON.stringify(newComment), {
            httpMetadata: { contentType: 'application/json' },
            customMetadata: { 
                userId: userId,
                createdAt: isoTimestamp,
                type: 'blog-comment',
                parentId: parentId || '',
                level: level.toString()
            },
        });
        
        return { 
            success: true, 
            message: 'Comment added successfully', 
            comment: newComment 
        };
    } catch (error) {
        console.error('Error adding comment to R2:', error);
        return { 
            success: false, 
            message: error instanceof Error ? error.message : 'Unknown error occurred while adding comment' 
        };
    }
};

// Delete a comment and all its replies
export const deleteComment = async (
    postId: string,
    commentId: string,
    env: Env
): Promise<{ success: boolean; message: string }> => {
    try {
        // Check if the comment exists
        const commentKey = `blog/comments/${postId}/${commentId}`;
        const commentExists = await env.R2.head(commentKey);
        
        if (!commentExists) {
            return { 
                success: false, 
                message: 'Comment not found' 
            };
        }
        
        // Get all comments for the post to find replies
        const objects = await env.R2.list({ prefix: `blog/comments/${postId}/` });
        
        // Load all comments to identify which ones are replies to the deleted comment
        const commentPromises = objects.objects.map(async (object: { key: string }) => {
            const commentObject = await env.R2.get(object.key);
            if (!commentObject) return null;
            
            const comment = await commentObject.json() as BlogComment;
            return comment;
        });
        
        const comments = (await Promise.all(commentPromises)).filter((comment: any): comment is BlogComment => comment !== null);
        
        // Identify all comments that need to be deleted (the target comment and all its descendants)
        const commentsToDelete = new Set<string>();
        commentsToDelete.add(commentId);
        
        // Helper function to recursively find child comments
        const findReplies = (parentId: string) => {
            comments.forEach(comment => {
                if (comment.parentId === parentId) {
                    commentsToDelete.add(comment.id);
                    // Recursively find replies to this reply
                    findReplies(comment.id);
                }
            });
        };
        
        // Find all replies to the comment we're deleting
        findReplies(commentId);
        
        // Delete the comment and all its replies
        const deletePromises = Array.from(commentsToDelete).map(id => {
            const key = `blog/comments/${postId}/${id}`;
            return env.R2.delete(key);
        });
        
        await Promise.all(deletePromises);
        
        return { 
            success: true, 
            message: 'Comment and all replies deleted successfully' 
        };
    } catch (error) {
        console.error('Error deleting comment from R2:', error);
        return { 
            success: false, 
            message: error instanceof Error ? error.message : 'Unknown error occurred during comment deletion' 
        };
    }
};

// Block a user from commenting
export const blockUser = async (
    userId: string,
    blockedBy: string,
    reason: string,
    env: Env
): Promise<{ success: boolean; message: string }> => {
    try {
        const timestamp = new Date().toISOString();
        
        // Create the blocked user object
        const blockedUser: BlockedUser = {
            userId: userId,
            blockedAt: timestamp,
            blockedBy: blockedBy,
            reason: reason,
        };
        
        // Store the blocked user in R2
        const blockedUserKey = `blog/blocked-users/${userId}`;
        await env.R2.put(blockedUserKey, JSON.stringify(blockedUser), {
            httpMetadata: { contentType: 'application/json' },
            customMetadata: { 
                blockedBy: blockedBy,
                blockedAt: timestamp,
                type: 'blocked-user',
            },
        });
        
        return { 
            success: true, 
            message: 'User blocked successfully' 
        };
    } catch (error) {
        console.error('Error blocking user in R2:', error);
        return { 
            success: false, 
            message: error instanceof Error ? error.message : 'Unknown error occurred while blocking user' 
        };
    }
};

// Unblock a user
export const unblockUser = async (
    userId: string,
    env: Env
): Promise<{ success: boolean; message: string }> => {
    try {
        // Check if the user is blocked
        const blockedUserKey = `blog/blocked-users/${userId}`;
        const blockedUserExists = await env.R2.head(blockedUserKey);
        
        if (!blockedUserExists) {
            return { 
                success: false, 
                message: 'User is not blocked' 
            };
        }
        
        // Delete the blocked user record
        await env.R2.delete(blockedUserKey);
        
        return { 
            success: true, 
            message: 'User unblocked successfully' 
        };
    } catch (error) {
        console.error('Error unblocking user in R2:', error);
        return { 
            success: false, 
            message: error instanceof Error ? error.message : 'Unknown error occurred while unblocking user' 
        };
    }
};

// Check if a user is blocked
export const isUserBlocked = async (userId: string, env: Env): Promise<boolean> => {
    try {
        const blockedUserKey = `blog/blocked-users/${userId}`;
        const blockedUserExists = await env.R2.head(blockedUserKey);
        
        return !!blockedUserExists;
    } catch (error) {
        console.error('Error checking if user is blocked:', error);
        return false;
    }
};

// Get all blocked users
export const getBlockedUsers = async (env: Env): Promise<BlockedUser[]> => {
    try {
        // List all objects with the blog/blocked-users/ prefix
        const objects = await env.R2.list({ prefix: 'blog/blocked-users/' });
        
        // Create a list of promises to get each blocked user's content
        const blockedUserPromises = objects.objects.map(async (object: { key: string }) => {
            const blockedUserObject = await env.R2.get(object.key);
            if (!blockedUserObject) return null;
            
            const blockedUser = await blockedUserObject.json() as BlockedUser;
            return blockedUser;
        });
        
        // Wait for all promises to resolve and filter out null values
        const blockedUsers = (await Promise.all(blockedUserPromises)).filter((user: any): user is BlockedUser => user !== null);
        
        // Sort blocked users by blocked date (newest first)
        return blockedUsers.sort((a: BlockedUser, b: BlockedUser) => new Date(b.blockedAt).getTime() - new Date(a.blockedAt).getTime());
    } catch (error) {
        console.error('Error fetching blocked users from R2:', error);
        return [];
    }
};
