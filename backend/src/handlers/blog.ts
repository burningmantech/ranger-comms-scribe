import { AutoRouter, cors } from 'itty-router';
import { json } from 'itty-router-extras';
import { Env } from '../utils/sessionManager';
import { withAdminCheck, withAuthCheck } from '../authWrappers';
import { 
    getBlogPosts, 
    getBlogPost, 
    createBlogPost, 
    updateBlogPost, 
    deleteBlogPost,
    getComments,
    addComment,
    deleteComment,
    blockUser,
    unblockUser,
    getBlockedUsers
} from '../services/blogService';

const { preflight } = cors();

// Extend the Request interface to include user and params properties
interface ExtendedRequest extends Request {
    user?: string;
    userName?: string;
    params: Record<string, string>;
}

export const router = AutoRouter({ base: '/blog' });

router.options('*', preflight);

// Get all blog posts
router.get('/', async (request: ExtendedRequest, env: Env) => {
    try {
        console.log('GET /blog called');
        const userId = request.user;
        const posts = await getBlogPosts(env, userId);
        return json(posts);
    } catch (error) {
        console.error('Error fetching blog posts:', error);
        return json({ error: 'Error fetching blog posts' }, { status: 500 });
    }
});

// Get a single blog post
router.get('/:id', async (request: ExtendedRequest, env: Env) => {
    try {
        const { id } = request.params;
        console.log(`GET /blog/${id} called`);
        
        const post = await getBlogPost(id, env);
        if (!post) {
            return json({ error: 'Blog post not found' }, { status: 404 });
        }
        
        return json(post);
    } catch (error) {
        console.error('Error fetching blog post:', error);
        return json({ error: 'Error fetching blog post' }, { status: 500 });
    }
});

// Create a new blog post (admin only)
router.post('/', withAdminCheck, async (request: ExtendedRequest, env: Env) => {
    try {
        console.log('POST /blog called');
        
        if (!request.user) {
            return json({ error: 'User not authenticated' }, { status: 401 });
        }
        
        const { title, content, published, commentsEnabled, media, isPublic, groupId } = await request.json() as {
            title: string;
            content: string;
            published?: boolean;
            commentsEnabled?: boolean;
            media?: string[];
            isPublic?: boolean;
            groupId?: string;
        };
        
        if (!title || !content) {
            return json({ error: 'Title and content are required' }, { status: 400 });
        }
        
        // Get user name from session
        const userKey = `user:${request.user}`;
        const userObject = await env.R2.get(userKey);
        let userName = 'Admin';
        
        if (userObject) {
            const userData = await userObject.json() as { name?: string };
            if (userData.name) {
                userName = userData.name;
            }
        }
        
        const result = await createBlogPost(
            { 
                title, 
                content, 
                published: published ?? false, 
                commentsEnabled: commentsEnabled ?? true, 
                media,
                isPublic: isPublic ?? true, // Default to public
                groupId
            },
            request.user,
            userName,
            env
        );
        
        if (result.success) {
            return json(result, { status: 201 });
        } else {
            return json(result, { status: 400 });
        }
    } catch (error) {
        console.error('Error creating blog post:', error);
        return json({ error: 'Error creating blog post' }, { status: 500 });
    }
});

// Update a blog post (admin only)
router.put('/:id', withAdminCheck, async (request: ExtendedRequest, env: Env) => {
    try {
        const { id } = request.params;
        console.log(`PUT /blog/${id} called`);
        
        const updates = await request.json() as {
            title?: string;
            content?: string;
            published?: boolean;
            commentsEnabled?: boolean;
            media?: string[];
            isPublic?: boolean;
            groupId?: string;
        };
        
        const result = await updateBlogPost(id, updates, env);
        
        if (result.success) {
            return json(result);
        } else {
            return json(result, { status: 404 });
        }
    } catch (error) {
        console.error('Error updating blog post:', error);
        return json({ error: 'Error updating blog post' }, { status: 500 });
    }
});

// Delete a blog post (admin only)
router.delete('/:id', withAdminCheck, async (request: ExtendedRequest, env: Env) => {
    try {
        const { id } = request.params;
        console.log(`DELETE /blog/${id} called`);
        
        const result = await deleteBlogPost(id, env);
        
        if (result.success) {
            return json(result);
        } else {
            return json(result, { status: 404 });
        }
    } catch (error) {
        console.error('Error deleting blog post:', error);
        return json({ error: 'Error deleting blog post' }, { status: 500 });
    }
});

// Get comments for a blog post
router.get('/:id/comments', async (request: ExtendedRequest, env: Env) => {
    try {
        const { id } = request.params;
        console.log(`GET /blog/${id}/comments called`);
        
        const comments = await getComments(id, env);
        return json(comments);
    } catch (error) {
        console.error('Error fetching comments:', error);
        return json({ error: 'Error fetching comments' }, { status: 500 });
    }
});

// Add a comment to a blog post (authenticated users only)
router.post('/:id/comments', withAuthCheck, async (request: ExtendedRequest, env: Env) => {
    try {
        const { id } = request.params;
        console.log(`POST /blog/${id}/comments called`);
        
        if (!request.user) {
            return json({ error: 'User not authenticated' }, { status: 401 });
        }
        
        const { content } = await request.json() as { content: string };
        
        if (!content) {
            return json({ error: 'Comment content is required' }, { status: 400 });
        }
        
        // Get user name from session
        const userKey = `user:${request.user}`;
        const userObject = await env.R2.get(userKey);
        let userName = 'User';
        
        if (userObject) {
            const userData = await userObject.json() as { name?: string };
            if (userData.name) {
                userName = userData.name;
            }
        }
        
        const result = await addComment(id, content, request.user, userName, env);
        
        if (result.success) {
            return json(result, { status: 201 });
        } else {
            return json(result, { status: 400 });
        }
    } catch (error) {
        console.error('Error adding comment:', error);
        return json({ error: 'Error adding comment' }, { status: 500 });
    }
});

// Delete a comment (admin only)
router.delete('/:postId/comments/:commentId', withAdminCheck, async (request: ExtendedRequest, env: Env) => {
    try {
        const { postId, commentId } = request.params;
        console.log(`DELETE /blog/${postId}/comments/${commentId} called`);
        
        const result = await deleteComment(postId, commentId, env);
        
        if (result.success) {
            return json(result);
        } else {
            return json(result, { status: 404 });
        }
    } catch (error) {
        console.error('Error deleting comment:', error);
        return json({ error: 'Error deleting comment' }, { status: 500 });
    }
});

// Block a user from commenting (admin only)
router.post('/block-user/:userId', withAdminCheck, async (request: ExtendedRequest, env: Env) => {
    try {
        const { userId } = request.params;
        console.log(`POST /blog/block-user/${userId} called`);
        
        if (!request.user) {
            return json({ error: 'Admin not authenticated' }, { status: 401 });
        }
        
        const { reason } = await request.json() as { reason: string };
        
        const result = await blockUser(userId, request.user, reason || 'No reason provided', env);
        
        if (result.success) {
            return json(result);
        } else {
            return json(result, { status: 400 });
        }
    } catch (error) {
        console.error('Error blocking user:', error);
        return json({ error: 'Error blocking user' }, { status: 500 });
    }
});

// Unblock a user (admin only)
router.post('/unblock-user/:userId', withAdminCheck, async (request: ExtendedRequest, env: Env) => {
    try {
        const { userId } = request.params;
        console.log(`POST /blog/unblock-user/${userId} called`);
        
        const result = await unblockUser(userId, env);
        
        if (result.success) {
            return json(result);
        } else {
            return json(result, { status: 400 });
        }
    } catch (error) {
        console.error('Error unblocking user:', error);
        return json({ error: 'Error unblocking user' }, { status: 500 });
    }
});

// Get all blocked users (admin only)
router.get('/blocked-users', withAdminCheck, async (request: ExtendedRequest, env: Env) => {
    try {
        console.log('GET /blog/blocked-users called');
        
        const blockedUsers = await getBlockedUsers(env);
        return json(blockedUsers);
    } catch (error) {
        console.error('Error fetching blocked users:', error);
        return json({ error: 'Error fetching blocked users' }, { status: 500 });
    }
});
