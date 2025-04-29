import React, { useEffect, useState, useRef } from 'react';
import { API_URL } from '../config';
import { BlogPost, BlogComment, User, Group, UserType } from '../types';
import { Link, useLocation } from 'react-router-dom';
import LexicalEditorComponent from './editor/LexicalEditor';
import { isValidDraftJs } from './editor/utils/serialization';
import { LexicalEditor } from 'lexical';
import { INSERT_IMAGE_COMMAND } from './editor/plugins/ImagePlugin';
import { INDENT_COMMAND, OUTDENT_COMMAND } from './editor/plugins/IndentationPlugin';
import { convertFromRaw } from 'draft-js';
import { stateToHTML } from 'draft-js-export-html';

interface BlogProps {
    isAdmin?: boolean;
    skipNavbar?: boolean;
}

const Blog: React.FC<BlogProps> = ({ isAdmin = false, skipNavbar }) => {
    const [posts, setPosts] = useState<BlogPost[]>([]);
    const [selectedPost, setSelectedPost] = useState<BlogPost | null>(null);
    const [comments, setComments] = useState<BlogComment[]>([]);
    const [newComment, setNewComment] = useState<string>('');
    const [commentStatus, setCommentStatus] = useState<{ success: boolean; message: string } | null>(null);
    const [replyingTo, setReplyingTo] = useState<string | null>(null);
    const [loading, setLoading] = useState<boolean>(true);
    const [error, setError] = useState<string | null>(null);
    const [user, setUser] = useState<User | null>(null);
    const [groups, setGroups] = useState<Group[]>([]);
    const [showNewPostForm, setShowNewPostForm] = useState<boolean>(false);
    const [newPost, setNewPost] = useState<{ 
        title: string; 
        content: string; 
        commentsEnabled: boolean;
        isPublic: boolean;
        groupId?: string;
    }>({
        title: '',
        content: '',
        commentsEnabled: true,
        isPublic: true
    });
    const [postStatus, setPostStatus] = useState<{ success: boolean; message: string } | null>(null);
    const [editingPost, setEditingPost] = useState<BlogPost | null>(null);
    const [isSmallScreen, setIsSmallScreen] = useState<boolean>(false);
    const allPostsRef = useRef<HTMLDivElement>(null);

    // State for Lexical editor
    const [editorState, setEditorState] = useState<any | null>(null);
    const [editorInstance, setEditorInstance] = useState<LexicalEditor | null>(null);
    const [contentAsJson, setContentAsJson] = useState('');

    // State to track comment to be deleted (for confirmation)
    const [commentToDelete, setCommentToDelete] = useState<string | null>(null);

    // State to track highlighted comment from URL
    const [highlightedCommentId, setHighlightedCommentId] = useState<string | null>(null);
    const location = useLocation();

    // State for gallery modal
    const [showGalleryModal, setShowGalleryModal] = useState(false);
    const [galleryImages, setGalleryImages] = useState<any[]>([]);

    // Open gallery modal
    const openGalleryModal = async () => {
        setShowGalleryModal(true);
        // Fetch images from gallery
        try {
            const res = await fetch(`${API_URL}/gallery`, {
                headers: { 'Authorization': `Bearer ${localStorage.getItem('sessionId')}` }
            });
            if (res.ok) {
                const data = await res.json();
                setGalleryImages(data.filter((img: any) => img.fileType && img.fileType.startsWith('image/')));
            }
        } catch {}
    };

    // Add key handler for indentation shortcuts
    useEffect(() => {
        // Add keyboard shortcuts for Cmd+[ and Cmd+] to control indentation
        const handleKeyDown = (e: KeyboardEvent) => {
            if (!editorInstance || !showNewPostForm) return;
            
            if (e.metaKey || e.ctrlKey) {
                if (e.key === ']') {
                    e.preventDefault();
                    editorInstance.dispatchCommand(INDENT_COMMAND, undefined);
                } else if (e.key === '[') {
                    e.preventDefault();
                    editorInstance.dispatchCommand(OUTDENT_COMMAND, undefined);
                }
            }
        };

        document.addEventListener('keydown', handleKeyDown);
        return () => {
            document.removeEventListener('keydown', handleKeyDown);
        };
    }, [editorInstance, showNewPostForm]);

    // Close gallery modal
    const closeGalleryModal = () => setShowGalleryModal(false);
    
    // Handle gallery image selection
    const handleGalleryImageSelect = (img: any) => {
        const mediumUrl = img.mediumUrl || img.url;
        
        // Insert the image into Lexical editor
        if (editorInstance) {
            editorInstance.dispatchCommand(INSERT_IMAGE_COMMAND, {
                src: mediumUrl,
                altText: img.fileName || 'Gallery image',
                fullSizeSrc: img.url,
            });
            setShowGalleryModal(false);
        }
    };

    // Check if screen is small
    useEffect(() => {
        const checkScreenSize = () => {
            setIsSmallScreen(window.innerWidth <= 768);
        };
        
        // Initial check
        checkScreenSize();
        
        // Add event listener for window resize
        window.addEventListener('resize', checkScreenSize);
        
        // Clean up
        return () => {
            window.removeEventListener('resize', checkScreenSize);
        };
    }, []);

    // Effect to fetch comments for all posts
    useEffect(() => {
        if (posts.length > 0) {
            // For each post, fetch its comments
            posts.forEach(post => {
                fetchComments(post.id);
            });
            
            // Scroll to the top when all posts are loaded
            window.scrollTo(0, 0);
        }
    }, [posts]);

    useEffect(() => {
        // Check if user is logged in
        const userJson = localStorage.getItem('user');
        if (userJson) {
            try {
                const userData = JSON.parse(userJson);
                setUser(userData);
                
                // If user is admin or lead, fetch groups
                if (userData.isAdmin || userData.userType === UserType.Lead || userData.userType === UserType.Admin) {
                    fetchGroups();
                }
            } catch (err) {
                console.error('Error parsing user data:', err);
            }
        }

        fetchPosts();
    }, []);

    // Parse URL query parameters for comment ID
    useEffect(() => {
        const searchParams = new URLSearchParams(location.search);
        const commentId = searchParams.get('comment');
        const hash = location.hash.replace('#', '');
        
        // If we have a comment ID from either query params or hash, set it as highlighted
        if (commentId || hash) {
            setHighlightedCommentId(commentId || hash);
            
            // If we have a comment ID but no selected post, find and select the post
            if (!selectedPost && (commentId || hash)) {
                const targetCommentId = commentId || hash;
                const postWithComment = findPostForComment(targetCommentId);
                if (postWithComment) {
                    handlePostClick(postWithComment);
                }
            }
        }
    }, [location, posts]);

    // Effect to scroll to highlighted comment when comments are loaded
    useEffect(() => {
        if (highlightedCommentId && comments.length > 0) {
            // Use timeout to ensure DOM has rendered the comments
            setTimeout(() => {
                // First, try to find a direct element with the ID
                const commentElement = document.getElementById(`comment-${highlightedCommentId}`);
                
                if (commentElement) {
                    // Scroll the comment into view
                    commentElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    
                    // Add a highlighting effect
                    commentElement.classList.add('highlighted-comment');
                    
                    // Remove highlighting after a few seconds
                    setTimeout(() => {
                        commentElement.classList.remove('highlighted-comment');
                    }, 5000);
                } else {
                    // As a fallback, try finding comment by its class name
                    const commentElements = document.querySelectorAll(`.comment-item[data-comment-id="${highlightedCommentId}"]`);
                    if (commentElements.length > 0) {
                        const element = commentElements[0];
                        element.scrollIntoView({ behavior: 'smooth', block: 'center' });
                        element.classList.add('highlighted-comment');
                        
                        setTimeout(() => {
                            element.classList.remove('highlighted-comment');
                        }, 5000);
                    }
                }
            }, 500);
        }
    }, [highlightedCommentId, comments]);

    const fetchGroups = async () => {
        try {
            const response = await fetch(`${API_URL}/admin/groups`, {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${localStorage.getItem('sessionId')}`,
                },
            });
            
            if (!response.ok) {
                throw new Error(`Failed to fetch groups: ${response.status}`);
            }
            
            const data = await response.json();
            setGroups(data.groups);
        } catch (err) {
            console.error('Error fetching groups:', err);
            setGroups([]);
        }
    };

    const fetchPosts = async () => {
        try {
            setLoading(true);
            const response = await fetch(`${API_URL}/blog`, {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${localStorage.getItem('sessionId')}`,
                },
            });
            
            if (!response.ok) {
                throw new Error(`Failed to fetch posts: ${response.status}`);
            }
            
            const data = await response.json();
            setPosts(data);
        } catch (err) {
            console.error('Error fetching posts:', err);
            if (err instanceof Error) {
                setError(err.message);
            } else {
                setError('An unknown error occurred');
            }
        } finally {
            setLoading(false);
        }
    };

    const fetchComments = async (postId: string) => {
        try {
            const response = await fetch(`${API_URL}/blog/${postId}/comments`, {
                method: 'GET',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${localStorage.getItem('sessionId')}`,
                },
            });
            
            if (!response.ok) {
                throw new Error(`Failed to fetch comments: ${response.status}`);
            }
            
            const data = await response.json();
            setComments(data);
        } catch (err) {
            console.error('Error fetching comments:', err);
            setComments([]);
        }
    };

    const handlePostClick = async (post: BlogPost) => {
        setSelectedPost(post);
        await fetchComments(post.id);
    };

    const handleCommentSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        
        if (!selectedPost || !newComment.trim() || !user) {
            setCommentStatus({
                success: false,
                message: 'Please enter a comment and make sure you are logged in'
            });
            return;
        }
        
        try {
            const response = await fetch(`${API_URL}/blog/${selectedPost.id}/comments`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${localStorage.getItem('sessionId')}`,
                },
                body: JSON.stringify({ 
                    content: newComment,
                    parentId: replyingTo
                }),
            });
            
            const result = await response.json();
            
            if (response.ok) {
                setCommentStatus({
                    success: true,
                    message: 'Comment added successfully'
                });
                
                // Refresh comments to get the updated structure with replies
                await fetchComments(selectedPost.id);
                
                // Clear the comment form and reset reply state
                setNewComment('');
                setReplyingTo(null);
            } else {
                setCommentStatus({
                    success: false,
                    message: result.message || 'Failed to add comment'
                });
            }
        } catch (err) {
            console.error('Error adding comment:', err);
            setCommentStatus({
                success: false,
                message: 'An error occurred while adding the comment'
            });
        }
    };

    const handleNewPostSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        
        if (!newPost.title.trim() || !contentAsJson.trim() || !isAdmin) {
            setPostStatus({
                success: false,
                message: 'Please enter a title and content'
            });
            return;
        }
        
        try {
            const response = await fetch(`${API_URL}/blog`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${localStorage.getItem('sessionId')}`,
                },
                body: JSON.stringify({
                    title: newPost.title,
                    content: contentAsJson,
                    published: true,
                    commentsEnabled: newPost.commentsEnabled,
                    isPublic: newPost.isPublic,
                    groupId: !newPost.isPublic ? newPost.groupId : undefined
                }),
            });
            
            const result = await response.json();
            
            if (response.ok) {
                setPostStatus({
                    success: true,
                    message: 'Post created successfully'
                });
                
                // Add the new post to the list
                if (result.post) {
                    setPosts([result.post, ...posts]);
                }
                
                // Clear the form and hide it
                setNewPost({
                    title: '',
                    content: '',
                    commentsEnabled: true,
                    isPublic: true,
                    groupId: undefined
                });
                setShowNewPostForm(false);
            } else {
                setPostStatus({
                    success: false,
                    message: result.message || 'Failed to create post'
                });
            }
        } catch (err) {
            console.error('Error creating post:', err);
            setPostStatus({
                success: false,
                message: 'An error occurred while creating the post'
            });
        }
    };

    const handleEditPost = (post: BlogPost) => {
        setEditingPost(post);
        setNewPost({
            title: post.title,
            content: post.content,
            commentsEnabled: post.commentsEnabled,
            isPublic: post.isPublic !== undefined ? post.isPublic : true,
            groupId: post.groupId
        });
        setShowNewPostForm(true);
    };

    const handleUpdatePost = async (e: React.FormEvent) => {
        e.preventDefault();
        
        if (!editingPost || !newPost.title.trim() || !contentAsJson.trim() || !isAdmin) {
            setPostStatus({
                success: false,
                message: 'Please enter a title and content'
            });
            return;
        }
        
        try {
            const response = await fetch(`${API_URL}/blog/${editingPost.id}`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${localStorage.getItem('sessionId')}`,
                },
                body: JSON.stringify({
                    title: newPost.title,
                    content: contentAsJson,
                    commentsEnabled: newPost.commentsEnabled,
                    isPublic: newPost.isPublic,
                    groupId: !newPost.isPublic ? newPost.groupId : undefined
                }),
            });
            
            const result = await response.json();
            
            if (response.ok) {
                setPostStatus({
                    success: true,
                    message: 'Post updated successfully'
                });
                
                // Update the post in the list
                if (result.post) {
                    setPosts(posts.map(p => p.id === editingPost.id ? result.post : p));
                    
                    // If this is the selected post, update it
                    if (selectedPost && selectedPost.id === editingPost.id) {
                        setSelectedPost(result.post);
                    }
                }
                
                // Clear the form and hide it
                setNewPost({
                    title: '',
                    content: '',
                    commentsEnabled: true,
                    isPublic: true,
                    groupId: undefined
                });
                setEditingPost(null);
                setShowNewPostForm(false);
            } else {
                setPostStatus({
                    success: false,
                    message: result.message || 'Failed to update post'
                });
            }
        } catch (err) {
            console.error('Error updating post:', err);
            setPostStatus({
                success: false,
                message: 'An error occurred while updating the post'
            });
        }
    };

    const renderPostContent = (content: string) => {
        try {
            // Check if content is in Lexical format
            const isLexical = content.includes('"root"') && 
                             content.includes('"children"') && 
                             content.includes('"type"');
            
            if (isLexical) {
                return (
                    <LexicalEditorComponent 
                        initialContent={content}
                        showToolbar={false}
                        readOnly={true}
                        className="read-only-content"
                    />
                );
            }
            
            // Try to parse as Draft.js JSON
            if (isValidDraftJs(content)) {
                try {
                    const raw = JSON.parse(content);
                    const contentState = convertFromRaw(raw);
                    return <div dangerouslySetInnerHTML={{ __html: stateToHTML(contentState) }} />;
                } catch (e) {
                    console.error("Error parsing Draft.js content:", e);
                }
            }
        } catch {
            // Fallback: treat as HTML if parsing fails
        }
        
        // Simple HTML content
        return <div dangerouslySetInnerHTML={{ __html: content }} />;
    };

    const handleEditorChange = (editor: LexicalEditor, json: string) => {
        if (editor && json) {
            setEditorInstance(editor);
            setContentAsJson(json);
        }
    };

    const findPostForComment = (commentId: string) => {
        // Find the post that contains the comment with the given ID
        // This is a placeholder implementation
        return null;
    };

    if (loading && posts.length === 0) {
        return <div>Loading...</div>;
    }

    return (
        <>
            <div className="blog-container">
                <div className="blog-header">
                    <h1 className="blog-title">Blog</h1>
                    {isAdmin && user && (
                        <button 
                            className="new-post-button"
                            onClick={() => {
                                setEditingPost(null);
                                setNewPost({
                                    title: '',
                                    content: '',
                                    commentsEnabled: true,
                                    isPublic: true,
                                    groupId: undefined
                                });
                                setShowNewPostForm(!showNewPostForm);
                            }}
                        >
                            {showNewPostForm ? 'Cancel' : 'New Post'}
                        </button>
                    )}
                </div>

                {error && <div className="error-message">{error}</div>}
                
                {postStatus && (
                    <div className={postStatus.success ? 'success-message' : 'error-message'}>
                        {postStatus.message}
                    </div>
                )}

                {showNewPostForm && isAdmin && (
                    <form className="post-form" onSubmit={editingPost ? handleUpdatePost : handleNewPostSubmit}>
                        <h2>{editingPost ? 'Edit Post' : 'New Post'}</h2>
                        <div className="form-group">
                            <label htmlFor="post-title">Title:</label>
                            <input
                                id="post-title"
                                type="text"
                                value={newPost.title}
                                onChange={(e) => setNewPost({...newPost, title: e.target.value})}
                                required
                            />
                        </div>
                        <div className="form-group">
                            <label>Content:</label>
                            <div className="editor-container">
                                <LexicalEditorComponent
                                    initialContent={editingPost?.content || ""}
                                    onChange={(editor, json) => {
                                        handleEditorChange(editor, json);
                                    }}
                                    showToolbar={true}
                                    placeholder="Write your blog post content here..."
                                    onImageSelect={openGalleryModal}
                                    galleryImages={galleryImages}
                                />
                            </div>
                        </div>
                        <div className="form-group">
                            <div className="custom-checkbox">
                                <input
                                    type="checkbox"
                                    id="commentsEnabled"
                                    checked={newPost.commentsEnabled}
                                    onChange={(e) => setNewPost({...newPost, commentsEnabled: e.target.checked})}
                                />
                                <span className="checkbox-icon"></span>
                                <label htmlFor="commentsEnabled">Enable comments</label>
                            </div>
                        </div>
                        <div className="form-group">
                            <div className="custom-checkbox">
                                <input
                                    type="checkbox"
                                    id="isPublic"
                                    checked={newPost.isPublic}
                                    onChange={(e) => setNewPost({...newPost, isPublic: e.target.checked})}
                                />
                                <span className="checkbox-icon"></span>
                                <label htmlFor="isPublic">Public (visible to everyone)</label>
                            </div>
                        </div>
                        
                        {!newPost.isPublic && (
                            <div className="form-group">
                                <label htmlFor="post-group">Group:</label>
                                <select
                                    id="post-group"
                                    value={newPost.groupId || ''}
                                    onChange={(e) => setNewPost({...newPost, groupId: e.target.value || undefined})}
                                    required={!newPost.isPublic}
                                >
                                    <option value="">Select a group</option>
                                    {groups.map(group => (
                                        <option key={group.id} value={group.id}>{group.name}</option>
                                    ))}
                                </select>
                            </div>
                        )}
                        
                        <button type="submit" className="submit-button">
                            {editingPost ? 'Update Post' : 'Create Post'}
                        </button>
                    </form>
                )}

                <div className="blog-content">
                    {!isSmallScreen && (
                        <div className="posts-list">
                            <h2>Posts</h2>
                            {posts.length === 0 ? (
                                <p>No posts available.</p>
                            ) : (
                                <ul>
                                    {posts.map((post) => (
                                        <li 
                                            key={post.id} 
                                            className={`post-item ${selectedPost?.id === post.id ? 'selected' : ''}`}
                                            onClick={() => handlePostClick(post)}
                                        >
                                            <h3>{post.title}</h3>
                                            <p className="post-meta">
                                                By {post.author} on {new Date(post.createdAt).toLocaleDateString()}
                                                {post.isPublic === false && <span className="private-badge"> (Private)</span>}
                                            </p>
                                        </li>
                                    ))}
                                </ul>
                            )}
                        </div>
                    )}

                    <div ref={allPostsRef} className={isSmallScreen ? "all-posts-container" : "all-posts-container large-screen"}>
                        {posts.length === 0 ? (
                            <p>No posts available.</p>
                        ) : (
                            posts.map(post => (
                                <div key={post.id} className="post-detail">
                                    <h2>{post.title}</h2>
                                    <p className="post-meta">
                                        By {post.author} on {new Date(post.createdAt).toLocaleDateString()}
                                        {post.updatedAt !== post.createdAt && 
                                            ` (Updated: ${new Date(post.updatedAt).toLocaleDateString()})`}
                                        {post.isPublic === false && post.groupId && 
                                            ` - Group: ${groups.find(g => g.id === post.groupId)?.name || 'Private Group'}`}
                                    </p>
                                    <div className="post-content">
                                        {renderPostContent(post.content)}
                                    </div>
                                </div>
                            ))
                        )}
                    </div>
                </div>
            </div>

            {/* Gallery Modal for image selection */}
            {showGalleryModal && (
                <div className="modal" style={{zIndex: 1000, position: 'fixed', top:0, left:0, right:0, bottom:0, background: 'rgba(0,0,0,0.5)'}}>
                    <div style={{background: '#fff', margin: '40px auto', padding: 20, maxWidth: 600, borderRadius: 8}}>
                        <h3>Select an image from the gallery</h3>
                        <div style={{display: 'flex', flexWrap: 'wrap', gap: 10, maxHeight: 300, overflowY: 'auto'}}>
                            {galleryImages.map(img => (
                                <img key={img.id} src={img.thumbnailUrl || img.url} alt={img.fileName} style={{width: 100, height: 100, objectFit: 'cover', cursor: 'pointer', border: '2px solid #eee'}} onClick={() => handleGalleryImageSelect(img)} />
                            ))}
                        </div>
                        <button onClick={closeGalleryModal} style={{marginTop: 20}}>Cancel</button>
                    </div>
                </div>
            )}
        </>
    );
};

export default Blog;
