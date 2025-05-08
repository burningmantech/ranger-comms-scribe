import { Env } from '../utils/sessionManager';
import { BlogPost, BlogComment, BlockedUser, UserType } from '../types';
import { getUser, canAccessGroup } from '../services/userService';
import { getObject, putObject, deleteObject, listObjects } from './cacheService';

// Get all blog posts
export const getBlogPosts = async (env: Env, userId?: string): Promise<BlogPost[]> => {
    try {
        // Cache key for all blog posts
        const cacheKey = 'all_blog_posts';
        
        // Try to get all posts from cache first
        let allPosts = await getObject<BlogPost[]>(cacheKey, env);
        
        // If not in cache, fetch from R2
        if (!allPosts) {
            // List all objects with the blog/posts/ prefix
            const objects = await listObjects('blog/posts/', env);
            
            // Create a list of promises to get each post's content
            const postPromises = objects.objects.map(async (object: { key: string }) => {
                // Check cache for individual post
                const postCacheKey = `post:${object.key}`;
                const cachedPost = await getObject<BlogPost>(postCacheKey, env);
                
                if (cachedPost) {
                    return cachedPost;
                }
                
                // If not in cache, get from R2
                const postObject = await env.R2.get(object.key);
                if (!postObject) return null;
                
                const post = await postObject.json() as BlogPost;
                
                // Cache individual post
                await putObject(postCacheKey, post, env, undefined, 3600); // Cache for 1 hour
                
                return post;
            });
            
            // Wait for all promises to resolve and filter out null values
            allPosts = (await Promise.all(postPromises)).filter((post: any): post is BlogPost => post !== null);
            
            // Cache all posts
            await putObject(cacheKey, allPosts, env, undefined, 300); // Cache for 5 minutes
        }
        
        let posts = [...allPosts];
        
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
        console.error('Error fetching blog posts:', error);
        return [];
    }
};

// Get a single blog post by ID
export const getBlogPost = async (postId: string, env: Env): Promise<BlogPost | null> => {
    try {
        const postKey = `blog/posts/${postId}`;
        
        // Try to get post from cache first
        const cacheKey = `post:${postKey}`;
        const cachedPost = await getObject<BlogPost>(cacheKey, env);
        
        if (cachedPost) {
            return cachedPost;
        }
        
        // If not in cache, get from R2
        const postObject = await env.R2.get(postKey);
        
        if (!postObject) {
            return null;
        }
        
        const post = await postObject.json() as BlogPost;
        
        // Cache the post
        await putObject(cacheKey, post, env, undefined, 3600); // Cache for 1 hour
        
        return post;
    } catch (error) {
        console.error('Error fetching blog post:', error);
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
        
        // Store the post in R2 and cache
        const postKey = `blog/posts/${postId}`;
        await putObject(postKey, newPost, env);
        
        // Also cache it individually
        const cacheKey = `post:${postKey}`;
        await putObject(cacheKey, newPost, env, undefined, 3600); // Cache for 1 hour
        
        // Invalidate the all_blog_posts cache so the new post will be included in listings
        await deleteObject('all_blog_posts', env);
        
        return { 
            success: true, 
            message: 'Blog post created successfully', 
            post: newPost 
        };
    } catch (error) {
        console.error('Error creating blog post:', error);
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
        
        try {
            // Store the updated post in R2 and cache
            const postKey = `blog/posts/${postId}`;
            await putObject(postKey, updatedPost, env, {
                httpMetadata: { contentType: 'application/json' },
                customMetadata: { 
                    userId: existingPost.authorId,
                    updatedAt: updatedPost.updatedAt,
                    type: 'blog-post',
                },
            });
            
            // Update the individual post cache
            const cacheKey = `post:${postKey}`;
            await putObject(cacheKey, updatedPost, env, undefined, 3600); // Cache for 1 hour
            
            // Invalidate the all_blog_posts cache so the updated post will be included in listings
            await deleteObject('all_blog_posts', env);
            
            return { 
                success: true, 
                message: 'Blog post updated successfully', 
                post: updatedPost 
            };
        } catch (putError) {
            // If putObject fails, make sure to propagate the original R2 error message
            console.error('Error in putObject during blog post update:', putError);
            throw putError;  // Re-throw to be caught by the outer catch block
        }
    } catch (error) {
        console.error('Error updating blog post:', error);
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
        const cacheKey = `post:${postKey}`;
        
        // Check cache first
        const cachedPost = await getObject<BlogPost>(cacheKey, env);
        
        // If not in cache, check R2
        if (!cachedPost) {
            const postExists = await env.R2.head(postKey);
            if (!postExists) {
                return { 
                    success: false, 
                    message: 'Blog post not found' 
                };
            }
        }
        
        // Delete the post from both R2 and cache
        await deleteObject(postKey, env);
        await deleteObject(cacheKey, env);
        
        // Delete all comments for this post and their cache entries
        const commentsPrefix = `blog/comments/${postId}/`;
        const comments = await listObjects(commentsPrefix, env);
        
        const deletePromises = comments.objects.map(async (comment: { key: string }) => {
            // Delete the comment from R2
            await deleteObject(comment.key, env);
            
            // Also delete from cache if it exists there
            await deleteObject(`comment:${comment.key}`, env);
        });
        
        await Promise.all(deletePromises);
        
        // Invalidate the all_blog_posts cache
        await deleteObject('all_blog_posts', env);
        
        return { 
            success: true, 
            message: 'Blog post and associated comments deleted successfully' 
        };
    } catch (error) {
        console.error('Error deleting blog post:', error);
        return { 
            success: false, 
            message: error instanceof Error ? error.message : 'Unknown error occurred during blog post deletion' 
        };
    }
};

// Get comments for a blog post
export const getComments = async (postId: string, env: Env): Promise<BlogComment[]> => {
    try {
        // Cache key for all comments of this post
        const cacheKey = `blog_comments:${postId}`;
        
        // Try to get all comments from cache first
        const cachedComments = await getObject<BlogComment[]>(cacheKey, env);
        if (cachedComments) {
            return cachedComments;
        }
        
        // If not in cache, fetch from R2
        // List all objects with the blog/comments/postId/ prefix
        const objects = await listObjects(`blog/comments/${postId}/`, env);
        
        // Create a list of promises to get each comment's content
        const commentPromises = objects.objects.map(async (object: { key: string }) => {
            // Check cache first for individual comment
            const commentCacheKey = `comment:${object.key}`;
            const cachedComment = await getObject<BlogComment>(commentCacheKey, env);
            
            if (cachedComment) {
                return cachedComment;
            }
            
            // If not in cache, get from R2
            const commentObject = await env.R2.get(object.key);
            if (!commentObject) return null;
            
            const comment = await commentObject.json() as BlogComment;
            
            // Cache individual comment
            await putObject(commentCacheKey, comment, env, undefined, 3600); // Cache for 1 hour
            
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
        const sortedComments = rootComments.sort((a: BlogComment, b: BlogComment) => 
            new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime()
        );
        
        // Cache the fully processed comment tree
        await putObject(cacheKey, sortedComments, env, undefined, 300); // Cache for 5 minutes
        
        return sortedComments;
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
): Promise<{ 
    success: boolean; 
    message: string; 
    comment?: BlogComment;
    parentAuthorId?: string; // Adding parentAuthorId to the return type
    postAuthorId?: string;   // Adding postAuthorId to the return type
}> => {
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
        let parentAuthorId: string | undefined;
        
        if (parentId) {
            const commentKey = `blog/comments/${postId}/${parentId}`;
            
            // Check cache first
            const commentCacheKey = `comment:${commentKey}`;
            let parentComment = await getObject<BlogComment>(commentCacheKey, env);
            
            if (!parentComment) {
                // If not in cache, get from R2
                const parentCommentObj = await env.R2.get(commentKey);
                
                if (!parentCommentObj) {
                    return {
                        success: false,
                        message: 'Parent comment not found'
                    };
                }
                
                // Parse parent comment to get its level and author
                parentComment = await parentCommentObj.json() as BlogComment;
            }
            
            parentAuthorId = parentComment.authorId;
            
            // Increment level for the reply (max level is 2 for up to 3 total levels including top level)
            level = Math.min(2, (parentComment.level || 0) + 1);
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
        
        try {
            // Store the comment in R2 and cache
            const commentKey = `blog/comments/${postId}/${commentId}`;
            await putObject(commentKey, newComment, env, {
                httpMetadata: { contentType: 'application/json' },
                customMetadata: { 
                    userId: userId,
                    createdAt: isoTimestamp,
                    type: 'blog-comment',
                    parentId: parentId || '',
                    level: level.toString()
                },
            });
            
            // Cache the individual comment
            const commentCacheKey = `comment:${commentKey}`;
            await putObject(commentCacheKey, newComment, env, undefined, 3600); // Cache for 1 hour
            
            // Invalidate the comments cache for this post to ensure the new comment is included
            await deleteObject(`blog_comments:${postId}`, env);
            
            const postAuthorId = post.authorId;
            
            return { 
                success: true, 
                message: 'Comment added successfully', 
                comment: newComment,
                parentAuthorId,   // Include the parent comment author's ID if this is a reply
                postAuthorId      // Include the post author's ID for all comments
            };
        } catch (putError) {
            // If putObject fails, make sure to propagate the original R2 error message
            console.error('Error in putObject during comment addition:', putError);
            throw putError;  // Re-throw to be caught by the outer catch block
        }
    } catch (error) {
        console.error('Error adding comment:', error);
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
        
        // Check cache first
        const commentCacheKey = `comment:${commentKey}`;
        const cachedComment = await getObject<BlogComment>(commentCacheKey, env);
        
        let commentExists = !!cachedComment;
        
        // If not in cache, check R2
        if (!commentExists) {
            commentExists = !!(await env.R2.head(commentKey));
            if (!commentExists) {
                return { 
                    success: false, 
                    message: 'Comment not found' 
                };
            }
        }
        
        // Get all comments for the post to find replies
        const objects = await listObjects(`blog/comments/${postId}/`, env);
        
        // Load all comments to identify which ones are replies to the deleted comment
        const commentPromises = objects.objects.map(async (object: { key: string }) => {
            // Try cache first
            const replyCacheKey = `comment:${object.key}`;
            const cachedReply = await getObject<BlogComment>(replyCacheKey, env);
            
            if (cachedReply) {
                return cachedReply;
            }
            
            // If not in cache, get from R2
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
        
        // Delete the comment and all its replies from both R2 and cache
        const deletePromises = Array.from(commentsToDelete).map(id => {
            const key = `blog/comments/${postId}/${id}`;
            // Delete from R2
            const r2Promise = deleteObject(key, env);
            
            // Delete from cache
            const cachePromise = deleteObject(`comment:${key}`, env);
            
            return Promise.all([r2Promise, cachePromise]);
        });
        
        await Promise.all(deletePromises);
        
        // Invalidate the comments cache for this post
        await deleteObject(`blog_comments:${postId}`, env);
        
        return { 
            success: true, 
            message: 'Comment and all replies deleted successfully' 
        };
    } catch (error) {
        console.error('Error deleting comment:', error);
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
        
        // Store the blocked user in R2 and cache
        const blockedUserKey = `blog/blocked-users/${userId}`;
        await putObject(blockedUserKey, blockedUser, env, {
            httpMetadata: { contentType: 'application/json' },
            customMetadata: { 
                blockedBy: blockedBy,
                blockedAt: timestamp,
                type: 'blocked-user',
            },
        });
        
        // Also cache with a specific key format
        await putObject(`blocked:${userId}`, blockedUser, env);
        
        // Invalidate any cache of all blocked users
        await deleteObject('all_blocked_users', env);
        
        return { 
            success: true, 
            message: 'User blocked successfully' 
        };
    } catch (error) {
        console.error('Error blocking user:', error);
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
        
        // Check cache first
        const cachedBlockedUser = await getObject<BlockedUser>(`blocked:${userId}`, env);
        
        // If not in cache, check R2
        if (!cachedBlockedUser) {
            const blockedUserExists = await env.R2.head(blockedUserKey);
            
            if (!blockedUserExists) {
                return { 
                    success: false, 
                    message: 'User is not blocked' 
                };
            }
        }
        
        // Delete the blocked user record from both R2 and cache
        await deleteObject(blockedUserKey, env);
        await deleteObject(`blocked:${userId}`, env);
        
        // Invalidate any cache of all blocked users
        await deleteObject('all_blocked_users', env);
        
        return { 
            success: true, 
            message: 'User unblocked successfully' 
        };
    } catch (error) {
        console.error('Error unblocking user:', error);
        return { 
            success: false, 
            message: error instanceof Error ? error.message : 'Unknown error occurred while unblocking user' 
        };
    }
};

// Check if a user is blocked
export const isUserBlocked = async (userId: string, env: Env): Promise<boolean> => {
    try {
        // Check cache first
        const cachedBlockedUser = await getObject<BlockedUser>(`blocked:${userId}`, env);
        if (cachedBlockedUser) {
            return true;
        }
        
        // If not in cache, check R2
        const blockedUserKey = `blog/blocked-users/${userId}`;
        const blockedUserExists = await env.R2.head(blockedUserKey);
        
        // If found in R2 but not in cache, add to cache for future checks
        if (blockedUserExists) {
            const blockedUserObj = await env.R2.get(blockedUserKey);
            if (blockedUserObj) {
                const blockedUser = await blockedUserObj.json() as BlockedUser;
                await putObject(`blocked:${userId}`, blockedUser, env, undefined, 3600); // Cache for 1 hour
            }
        }
        
        return !!blockedUserExists;
    } catch (error) {
        console.error('Error checking if user is blocked:', error);
        return false;
    }
};

// Get all blocked users
export const getBlockedUsers = async (env: Env): Promise<BlockedUser[]> => {
    try {
        // Cache key for all blocked users
        const cacheKey = 'all_blocked_users';
        
        // Try to get all blocked users from cache first
        const cachedBlockedUsers = await getObject<BlockedUser[]>(cacheKey, env);
        if (cachedBlockedUsers) {
            return cachedBlockedUsers;
        }
        
        // If not in cache, fetch from R2
        // List all objects with the blog/blocked-users/ prefix
        const objects = await listObjects('blog/blocked-users/', env);
        
        // Create a list of promises to get each blocked user's content
        const blockedUserPromises = objects.objects.map(async (object: { key: string }) => {
            // Check cache for individual blocked user
            const userId = object.key.split('/').pop() || '';
            const blockedCacheKey = `blocked:${userId}`;
            
            const cachedBlockedUser = await getObject<BlockedUser>(blockedCacheKey, env);
            if (cachedBlockedUser) {
                return cachedBlockedUser;
            }
            
            // If not in cache, get from R2
            const blockedUserObject = await env.R2.get(object.key);
            if (!blockedUserObject) return null;
            
            const blockedUser = await blockedUserObject.json() as BlockedUser;
            
            // Cache individual blocked user
            await putObject(blockedCacheKey, blockedUser, env, undefined, 3600); // Cache for 1 hour
            
            return blockedUser;
        });
        
        // Wait for all promises to resolve and filter out null values
        const blockedUsers = (await Promise.all(blockedUserPromises)).filter((user: any): user is BlockedUser => user !== null);
        
        // Sort blocked users by blocked date (newest first)
        const sortedBlockedUsers = blockedUsers.sort((a: BlockedUser, b: BlockedUser) => 
            new Date(b.blockedAt).getTime() - new Date(a.blockedAt).getTime()
        );
        
        // Cache all blocked users
        await putObject(cacheKey, sortedBlockedUsers, env, undefined, 300); // Cache for 5 minutes
        
        return sortedBlockedUsers;
    } catch (error) {
        console.error('Error fetching blocked users:', error);
        return [];
    }
};
