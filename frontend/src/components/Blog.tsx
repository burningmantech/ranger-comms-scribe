import React, { useEffect, useState, useRef, useCallback } from 'react';
import { API_URL } from '../config';
import { BlogPost, BlogComment, User, Group, UserType } from '../types';
import { Link, useLocation } from 'react-router-dom';
import { Editor, EditorState, RichUtils, convertToRaw, convertFromRaw, DraftHandleValue, ContentState, Modifier } from 'draft-js';
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
    const [editorState, setEditorState] = useState<EditorState>(() => EditorState.createEmpty());

    // State to track comment to be deleted (for confirmation)
    const [commentToDelete, setCommentToDelete] = useState<string | null>(null);

    // State to track highlighted comment from URL
    const [highlightedCommentId, setHighlightedCommentId] = useState<string | null>(null);
    const location = useLocation();

    // State for gallery modal
    const [showGalleryModal, setShowGalleryModal] = useState(false);
    const [galleryImages, setGalleryImages] = useState<any[]>([]);

    // Helper: convert editorState to raw JSON
    const getRawContent = (state: EditorState) => JSON.stringify(convertToRaw(state.getCurrentContent()));
    // Helper: convert raw JSON to editorState
    const getEditorStateFromRaw = (raw: string) => {
        try {
            return EditorState.createWithContent(convertFromRaw(JSON.parse(raw)));
        } catch {
            return EditorState.createEmpty();
        }
    };
    // Helper: convert editorState to HTML for preview/render with clickable images
    const getHTMLFromEditorState = (state: EditorState) => {
        const options = {
            entityStyleFn: (entity: any) => {
                const entityType = entity.get('type').toLowerCase();
                if (entityType === 'image') {
                    const data = entity.getData();
                    const fullSizeSrc = data.fullSizeSrc || data.src;
                    return {
                        element: 'img',
                        attributes: {
                            src: data.src,
                            class: 'clickable-image',
                            'data-full-src': fullSizeSrc,
                            style: {
                                maxWidth: '100%',
                                cursor: 'pointer',
                            },
                            onClick: `(function(){
                                const modal = document.createElement('div');
                                modal.className = 'image-modal';
                                modal.style.position = 'fixed';
                                modal.style.top = '0';
                                modal.style.left = '0';
                                modal.style.width = '100%';
                                modal.style.height = '100%';
                                modal.style.background = 'rgba(0,0,0,0.85)';
                                modal.style.display = 'flex';
                                modal.style.alignItems = 'center';
                                modal.style.justifyContent = 'center';
                                modal.style.zIndex = '1000';
                                modal.onclick = function() { document.body.removeChild(modal); };
                                
                                const img = document.createElement('img');
                                img.src = '${fullSizeSrc}';
                                img.className = 'image-modal-content';
                                img.style.maxWidth = '95%';
                                img.style.maxHeight = '95%';
                                img.style.boxShadow = '0 0 20px rgba(0,0,0,0.7)';
                                
                                const closeBtn = document.createElement('span');
                                closeBtn.className = 'image-modal-close';
                                closeBtn.innerHTML = '×';
                                closeBtn.style.position = 'absolute';
                                closeBtn.style.top = '20px';
                                closeBtn.style.right = '30px';
                                closeBtn.style.color = 'white';
                                closeBtn.style.fontSize = '40px';
                                closeBtn.style.fontWeight = 'bold';
                                closeBtn.style.cursor = 'pointer';
                                
                                modal.appendChild(img);
                                modal.appendChild(closeBtn);
                                document.body.appendChild(modal);
                            })()`
                        }
                    };
                }
                return undefined; // Return undefined instead of null to match RenderConfig | undefined
            }
        };
        return stateToHTML(state.getCurrentContent(), options);
    };

    // Formatting handlers
    const handleKeyCommand = (command: string, state: EditorState): DraftHandleValue => {
        const newState = RichUtils.handleKeyCommand(state, command);
        if (newState) {
            setEditorState(newState);
            return 'handled';
        }
        return 'not-handled';
    };
    const onTab = (e: React.KeyboardEvent) => {
        setEditorState(RichUtils.onTab(e, editorState, 4));
    };
    const toggleBlockType = (blockType: string) => {
        setEditorState(RichUtils.toggleBlockType(editorState, blockType));
    };
    const toggleInlineStyle = (inlineStyle: string) => {
        setEditorState(RichUtils.toggleInlineStyle(editorState, inlineStyle));
    };
    // Insert link
    const promptForLink = () => {
        const selection = editorState.getSelection();
        const url = window.prompt('Enter a URL');
        if (!url) return;
        const content = editorState.getCurrentContent();
        const contentWithEntity = content.createEntity('LINK', 'MUTABLE', { url });
        const entityKey = contentWithEntity.getLastCreatedEntityKey();
        let newState = EditorState.set(editorState, { currentContent: contentWithEntity });
        newState = RichUtils.toggleLink(newState, selection, entityKey);
        setEditorState(newState);
    };
    // Insert image with size controls
    const insertImage = (src: string, mediumSrc: string) => {
        // Create entity with size information and full-size link
        const contentState = editorState.getCurrentContent();
        const contentStateWithEntity = contentState.createEntity('IMAGE', 'IMMUTABLE', { 
            src: mediumSrc, // Use medium image by default
            fullSizeSrc: src, // Store full-size URL
            width: '100%', // Use responsive width
            style: { maxWidth: '100%' },
            className: 'clickable-image' // Add class for styling
        });
        
        const entityKey = contentStateWithEntity.getLastCreatedEntityKey();
        let newContentState = Modifier.insertText(
            contentStateWithEntity,
            editorState.getSelection(),
            '🖼️ ', // Image placeholder icon
            undefined,
            entityKey
        );
        setEditorState(EditorState.push(editorState, newContentState, 'insert-characters'));
    };

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

    // Close gallery modal
    const closeGalleryModal = () => setShowGalleryModal(false);

    // Handle gallery image selection
    const handleGalleryImageSelect = (img: any) => {
        // Use medium URL if available, otherwise fall back to full image
        const mediumUrl = img.mediumUrl || img.url;
        insertImage(img.url, mediumUrl);
        setShowGalleryModal(false);
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

    // When editing a post, load its content into the editor
    useEffect(() => {
        if (showNewPostForm) {
            if (editingPost) {
                setEditorState(getEditorStateFromRaw(editingPost.content));
            } else {
                setEditorState(EditorState.createEmpty());
            }
        }
    }, [showNewPostForm, editingPost]);

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

    // Fix comment deletion to properly handle the backend response
    const handleDeleteComment = async (commentId: string) => {
        if (!selectedPost || !isAdmin) return;
        
        try {
            console.log(`Deleting comment: ${commentId} from post: ${selectedPost.id}`);
            
            const response = await fetch(`${API_URL}/blog/${selectedPost.id}/comments/${commentId}`, {
                method: 'DELETE',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${localStorage.getItem('sessionId')}`,
                },
            });
            
            if (response.ok) {
                // Force a full refresh of comments from the server
                await fetchComments(selectedPost.id);
                
                setCommentStatus({
                    success: true,
                    message: 'Comment deleted successfully'
                });
                
                // Clear comment to delete
                setCommentToDelete(null);
            } else {
                const result = await response.json();
                console.error('Error response from delete comment API:', result);
                setCommentStatus({
                    success: false,
                    message: result.message || 'Failed to delete comment'
                });
            }
        } catch (err) {
            console.error('Error deleting comment:', err);
            setCommentStatus({
                success: false,
                message: 'An error occurred while deleting the comment'
            });
        }
    };

    const handleBlockUser = async (userId: string) => {
        if (!isAdmin) return;
        
        try {
            const response = await fetch(`${API_URL}/blog/block-user/${userId}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${localStorage.getItem('sessionId')}`,
                },
                body: JSON.stringify({ reason: 'Inappropriate comments' }),
            });
            
            if (response.ok) {
                setCommentStatus({
                    success: true,
                    message: 'User blocked successfully'
                });
                
                // Refresh comments to show the changes
                if (selectedPost) {
                    await fetchComments(selectedPost.id);
                }
            } else {
                const result = await response.json();
                setCommentStatus({
                    success: false,
                    message: result.message || 'Failed to block user'
                });
            }
        } catch (err) {
            console.error('Error blocking user:', err);
            setCommentStatus({
                success: false,
                message: 'An error occurred while blocking the user'
            });
        }
    };

    const handleNewPostSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        
        if (!newPost.title.trim() || !getRawContent(editorState).trim() || !isAdmin) {
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
                    content: getRawContent(editorState),
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
        
        if (!editingPost || !newPost.title.trim() || !getRawContent(editorState).trim() || !isAdmin) {
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
                    content: getRawContent(editorState),
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

    const handleDeletePost = async (postId: string) => {
        if (!isAdmin) return;
        
        try {
            const response = await fetch(`${API_URL}/blog/${postId}`, {
                method: 'DELETE',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${localStorage.getItem('sessionId')}`,
                },
            });
            
            if (response.ok) {
                // Remove the deleted post from the list
                setPosts(posts.filter(post => post.id !== postId));
                
                // If this is the selected post, clear it
                if (selectedPost && selectedPost.id === postId) {
                    setSelectedPost(null);
                    setComments([]);
                }
                
                setPostStatus({
                    success: true,
                    message: 'Post deleted successfully'
                });
            } else {
                const result = await response.json();
                setPostStatus({
                    success: false,
                    message: result.message || 'Failed to delete post'
                });
            }
        } catch (err) {
            console.error('Error deleting post:', err);
            setPostStatus({
                success: false,
                message: 'An error occurred while deleting the post'
            });
        }
    };

    const toggleCommentsForPost = async (post: BlogPost) => {
        if (!isAdmin) return;
        
        try {
            const response = await fetch(`${API_URL}/blog/${post.id}`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${localStorage.getItem('sessionId')}`,
                },
                body: JSON.stringify({
                    commentsEnabled: !post.commentsEnabled
                }),
            });
            
            const result = await response.json();
            
            if (response.ok) {
                // Update the post in the list
                if (result.post) {
                    setPosts(posts.map(p => p.id === post.id ? result.post : p));
                    
                    // If this is the selected post, update it
                    if (selectedPost && selectedPost.id === post.id) {
                        setSelectedPost(result.post);
                    }
                }
                
                setPostStatus({
                    success: true,
                    message: `Comments ${post.commentsEnabled ? 'disabled' : 'enabled'} successfully`
                });
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

    // Helper function to render a comment and its replies
    const renderComment = (comment: BlogComment, postId: string) => {
        return (
            <li key={comment.id} id={`comment-${comment.id}`} data-comment-id={comment.id} className={`comment-item level-${comment.level || 0} ${highlightedCommentId === comment.id ? 'highlighted-comment' : ''}`}>
                <div className="comment-meta">
                    <span>{comment.author} on {new Date(comment.createdAt).toLocaleDateString()}</span>
                </div>
                <p className="comment-content" dangerouslySetInnerHTML={{ __html: comment.content }} />
                <div className="comment-actions">
                    {user && (!comment.level || comment.level < 2) && (
                        <button 
                            className="reply-button"
                            onClick={() => {
                                setReplyingTo(comment.id);
                                setSelectedPost(posts.find(p => p.id === postId) || null);
                                setNewComment('');
                            }}
                        >
                            Reply
                        </button>
                    )}
                    {isAdmin && (
                        <div className="comment-admin-controls">
                            <button onClick={() => setCommentToDelete(comment.id)}>
                                Delete
                            </button>
                            <button onClick={() => handleBlockUser(comment.authorId)}>
                                Block User
                            </button>
                        </div>
                    )}
                </div>
                
                {/* Render reply form under this specific comment if replying to it */}
                {replyingTo === comment.id && user && (
                    <div className="inline-reply-form">
                        <form className="comment-form" onSubmit={(e) => {
                            e.preventDefault();
                            if (selectedPost) {
                                handleCommentSubmit(e);
                            }
                        }}>
                            <textarea
                                value={newComment}
                                onChange={(e) => setNewComment(e.target.value)}
                                placeholder="Write your reply..."
                                rows={3}
                                required
                            />
                            <div className="reply-form-actions">
                                <button type="submit">Post Reply</button>
                                <button type="button" onClick={() => setReplyingTo(null)}>Cancel</button>
                            </div>
                        </form>
                    </div>
                )}
                
                {/* Render replies if any */}
                {comment.replies && comment.replies.length > 0 && (
                    <ul className="replies-list">
                        {comment.replies.map(reply => renderComment(reply, postId))}
                    </ul>
                )}
            </li>
        );
    };

    // Find post for a comment by checking all comments
    const findPostForComment = (commentId: string): BlogPost | null => {
        // Look through all comments to find which post contains this comment
        for (const comment of comments) {
            if (comment.id === commentId) {
                // Found the comment, now find its post
                return posts.find(post => post.id === comment.postId) || null;
            }
            
            // Also check in replies
            if (comment.replies) {
                for (const reply of comment.replies) {
                    if (reply.id === commentId) {
                        return posts.find(post => post.id === comment.postId) || null;
                    }
                    
                    // Check deeper replies (3rd level)
                    if (reply.replies) {
                        for (const deepReply of reply.replies) {
                            if (deepReply.id === commentId) {
                                return posts.find(post => post.id === comment.postId) || null;
                            }
                        }
                    }
                }
            }
        }
        return null;
    };

    const findCommentPostId = (commentId: string): string | null => {
        const post = findPostForComment(commentId);
        return post ? post.id : null;
    };

    const deleteCommentDirectly = async (postId: string, commentId: string) => {
        try {
            const response = await fetch(`${API_URL}/blog/${postId}/comments/${commentId}`, {
                method: 'DELETE',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${localStorage.getItem('sessionId')}`,
                },
            });

            if (response.ok) {
                await fetchComments(postId);
                setCommentStatus({
                    success: true,
                    message: 'Comment deleted successfully'
                });
            } else {
                const result = await response.json();
                setCommentStatus({
                    success: false,
                    message: result.message || 'Failed to delete comment'
                });
            }
        } catch (err) {
            console.error('Error deleting comment:', err);
            setCommentStatus({
                success: false,
                message: 'An error occurred while deleting the comment'
            });
        } finally {
            setCommentToDelete(null);
        }
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
                            <div className="draftjs-editor-container">
                                <div className="editor-toolbar">
                                    <button type="button" onClick={() => toggleInlineStyle('BOLD')}>Bold</button>
                                    <button type="button" onClick={() => toggleInlineStyle('ITALIC')}>Italic</button>
                                    <button type="button" onClick={() => toggleInlineStyle('UNDERLINE')}>Underline</button>
                                    <button type="button" onClick={() => toggleBlockType('header-one')}>H1</button>
                                    <button type="button" onClick={() => toggleBlockType('header-two')}>H2</button>
                                    <button type="button" onClick={() => toggleBlockType('unordered-list-item')}>UL</button>
                                    <button type="button" onClick={() => toggleBlockType('ordered-list-item')}>OL</button>
                                    <button type="button" onClick={promptForLink}>Link</button>
                                    <button type="button" onClick={openGalleryModal}>Image</button>
                                </div>
                                <div className="editor-box" style={{border: '1px solid #ccc', minHeight: 120, padding: 8}} onClick={() => {}}>
                                    <Editor
                                        editorState={editorState}
                                        onChange={setEditorState}
                                        handleKeyCommand={handleKeyCommand}
                                        onTab={onTab}
                                        placeholder="Write your post..."
                                        spellCheck={true}
                                    />
                                </div>
                                <div className="editor-preview">
                                    <h4>Preview:</h4>
                                    <div className="preview-content" dangerouslySetInnerHTML={{ __html: getHTMLFromEditorState(editorState) }} />
                                </div>
                            </div>
                        </div>
                        <div className="form-group checkbox-group">
                            <label>
                                <input
                                    type="checkbox"
                                    checked={newPost.commentsEnabled}
                                    onChange={(e) => setNewPost({...newPost, commentsEnabled: e.target.checked})}
                                />
                                Enable comments
                            </label>
                        </div>
                        <div className="form-group checkbox-group">
                            <label>
                                <input
                                    type="checkbox"
                                    checked={newPost.isPublic}
                                    onChange={(e) => setNewPost({...newPost, isPublic: e.target.checked})}
                                />
                                Public (visible to everyone)
                            </label>
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
                                            {(isAdmin || (user && post.authorId === user.id)) && (
                                                <div className="post-admin-controls">
                                                    <button onClick={(e) => {
                                                        e.stopPropagation();
                                                        handleEditPost(post);
                                                    }}>
                                                        Edit
                                                    </button>
                                                    <button onClick={(e) => {
                                                        e.stopPropagation();
                                                        if (window.confirm(`Are you sure you want to delete "${post.title}"?`)) {
                                                            handleDeletePost(post.id);
                                                        }
                                                    }}>
                                                        Delete
                                                    </button>
                                                    {isAdmin && (
                                                        <button onClick={(e) => {
                                                            e.stopPropagation();
                                                            toggleCommentsForPost(post);
                                                        }}>
                                                            {post.commentsEnabled ? 'Disable Comments' : 'Enable Comments'}
                                                        </button>
                                                    )}
                                                </div>
                                            )}
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
                                    {isAdmin && user && (
                                        <div className="post-admin-controls">
                                            <button onClick={() => handleEditPost(post)}>
                                                Edit
                                            </button>
                                            <button onClick={() => {
                                                if (window.confirm(`Are you sure you want to delete "${post.title}"?`)) {
                                                    handleDeletePost(post.id);
                                                }
                                            }}>
                                                Delete
                                            </button>
                                            <button onClick={() => toggleCommentsForPost(post)}>
                                                {post.commentsEnabled ? 'Disable Comments' : 'Enable Comments'}
                                            </button>
                                        </div>
                                    )}
                                    <div className="post-content" dangerouslySetInnerHTML={{ __html: getHTMLFromEditorState(getEditorStateFromRaw(post.content)) }} />

                                    <div className="comments-section">
                                        <h3>Comments</h3>
                                        
                                        {commentStatus && (
                                            <div className={commentStatus.success ? 'success-message' : 'error-message'}>
                                                {commentStatus.message}
                                            </div>
                                        )}
                                        
                                        {post.commentsEnabled ? (
                                            <>
                                                {user ? (
                                                    replyingTo ? (
                                                        <div className="reply-form">
                                                            <div className="reply-header">
                                                                <span>Reply to comment</span>
                                                                <button 
                                                                    className="reply-cancel" 
                                                                    onClick={() => setReplyingTo(null)}
                                                                >
                                                                    Cancel
                                                                </button>
                                                            </div>
                                                            <form className="comment-form" onSubmit={(e) => {
                                                                e.preventDefault();
                                                                if (selectedPost?.id !== post.id) {
                                                                    setSelectedPost(post);
                                                                }
                                                                handleCommentSubmit(e);
                                                            }}>
                                                                <textarea
                                                                    value={newComment}
                                                                    onChange={(e) => setNewComment(e.target.value)}
                                                                    placeholder="Write your reply..."
                                                                    rows={3}
                                                                    required
                                                                />
                                                                <button type="submit">Post Reply</button>
                                                            </form>
                                                        </div>
                                                    ) : (
                                                        <form className="comment-form" onSubmit={(e) => {
                                                            e.preventDefault();
                                                            if (selectedPost?.id !== post.id) {
                                                                setSelectedPost(post);
                                                            }
                                                            handleCommentSubmit(e);
                                                        }}>
                                                            <textarea
                                                                value={selectedPost?.id === post.id && !replyingTo ? newComment : ''}
                                                                onChange={(e) => {
                                                                    if (selectedPost?.id !== post.id) {
                                                                        setSelectedPost(post);
                                                                    }
                                                                    setNewComment(e.target.value);
                                                                }}
                                                                placeholder="Write a comment..."
                                                                rows={3}
                                                                required
                                                            />
                                                            <button type="submit">Post Comment</button>
                                                        </form>
                                                    )
                                                ) : (
                                                    <p className="login-prompt">
                                                        Please <Link to="/">log in</Link> to comment.
                                                    </p>
                                                )}
                                                
                                                <ul className="comments-list">
                                                    {comments.filter(comment => comment.postId === post.id && !comment.parentId).length === 0 ? (
                                                        <p>No comments yet.</p>
                                                    ) : (
                                                        comments
                                                            .filter(comment => comment.postId === post.id && !comment.parentId)
                                                            .map((comment) => renderComment(comment, post.id))
                                                    )}
                                                </ul>
                                            </>
                                        ) : (
                                            <p>Comments are disabled for this post.</p>
                                        )}
                                    </div>
                                </div>
                            ))
                        )}
                    </div>
                </div>
            </div>

            {/* Delete comment confirmation dialog */}
            {commentToDelete && (
                <div className="modal confirmation-modal">
                    <div className="confirmation-content">
                        <h3>Confirm Comment Deletion</h3>
                        <p>Are you sure you want to delete this comment?</p>
                        <div className="confirmation-buttons">
                            <button 
                                onClick={() => {
                                    console.log("Delete button clicked for comment ID:", commentToDelete);
                                    // Find which post this comment belongs to
                                    const postId = findCommentPostId(commentToDelete);
                                    if (postId) {
                                        // Call delete directly without timeout or setState
                                        deleteCommentDirectly(postId, commentToDelete);
                                    } else {
                                        console.error("Could not find post ID for comment:", commentToDelete);
                                        setCommentStatus({
                                            success: false,
                                            message: 'Error: Could not determine which post contains this comment'
                                        });
                                        setCommentToDelete(null);
                                    }
                                }}
                            >
                                Yes, Delete
                            </button>
                            <button 
                                onClick={() => setCommentToDelete(null)}
                            >
                                Cancel
                            </button>
                        </div>
                    </div>
                </div>
            )}

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
