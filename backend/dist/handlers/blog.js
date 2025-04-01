"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.router = void 0;
const itty_router_1 = require("itty-router");
const itty_router_extras_1 = require("itty-router-extras");
const { preflight } = (0, itty_router_1.cors)();
exports.router = (0, itty_router_1.AutoRouter)({ base: '/blog' });
let blogPosts = [];
exports.router.options('/', preflight);
// Fetch all blog posts
exports.router.get('/', async () => {
    return (0, itty_router_extras_1.json)(blogPosts);
});
// Create a new blog post
exports.router.post('/', async (request) => {
    const { title, content, author } = await request.json();
    if (!title || !content || !author) {
        return (0, itty_router_extras_1.json)({ error: 'Title, content, and author are required' }, { status: 400 });
    }
    const newPost = { id: blogPosts.length + 1, title, content, author, approved: false };
    blogPosts.push(newPost);
    return (0, itty_router_extras_1.json)(newPost, { status: 201 });
});
// Approve a blog post
exports.router.post('/approve/:id', async (request) => {
    const { id } = request.params;
    const post = blogPosts.find(post => post.id === parseInt(id));
    if (post) {
        post.approved = true;
        return (0, itty_router_extras_1.json)(post);
    }
    return (0, itty_router_extras_1.json)({ error: 'Post not found' }, { status: 404 });
});
// Delete a blog post
exports.router.delete('/blog/:id', async (request) => {
    const { id } = request.params;
    const postIndex = blogPosts.findIndex(post => post.id === parseInt(id));
    if (postIndex !== -1) {
        const deletedPost = blogPosts.splice(postIndex, 1);
        return (0, itty_router_extras_1.json)(deletedPost[0]);
    }
    return (0, itty_router_extras_1.json)({ error: 'Post not found' }, { status: 404 });
});
