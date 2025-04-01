import { AutoRouter, cors } from 'itty-router';
import { json } from 'itty-router-extras';

const { preflight } = cors();

export const router = AutoRouter({ base : '/blog' });

// In-memory storage for blog posts (for demonstration purposes)
interface BlogPost {
    id: number;
    title: string;
    content: string;
    author: string;
    approved: boolean;
}

let blogPosts: BlogPost[] = [];

router.options('/', preflight);

// Fetch all blog posts
router.get('/', async () => {
    return json(blogPosts);
});

// Create a new blog post
router.post('/', async (request) => {
    const { title, content, author } = await request.json() as { title: string; content: string; author: string };
    if (!title || !content || !author) {
        return json({ error: 'Title, content, and author are required' }, { status: 400 });
    }
    const newPost = { id: blogPosts.length + 1, title, content, author, approved: false };
    blogPosts.push(newPost);
    return json(newPost, { status: 201 });
});

// Approve a blog post
router.post('/approve/:id', async (request) => {
    const { id } = request.params;
    const post = blogPosts.find(post => post.id === parseInt(id));
    if (post) {
        post.approved = true;
        return json(post);
    }
    return json({ error: 'Post not found' }, { status: 404 });
});

// Delete a blog post
router.delete('/blog/:id', async (request) => {
    const { id } = request.params;
    const postIndex = blogPosts.findIndex(post => post.id === parseInt(id));
    if (postIndex !== -1) {
        const deletedPost = blogPosts.splice(postIndex, 1);
        return json(deletedPost[0]);
    }
    return json({ error: 'Post not found' }, { status: 404 });
});