import React, { useEffect, useState, useRef } from 'react';
import { API_URL } from '../config';
import { BlogPost, BlogComment, User, Group, UserType } from '../types';
import { Link } from 'react-router-dom';

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

    // State to track comment to be deleted (for confirmation)
    const [commentToDelete, setCommentToDelete] = useState<string | null>(null);

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
        
        if (!newPost.title.trim() || !newPost.content.trim() || !isAdmin) {
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
                    content: newPost.content,
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
        
        if (!editingPost || !newPost.title.trim() || !newPost.content.trim() || !isAdmin) {
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
                    content: newPost.content,
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
            <li key={comment.id} className={`comment-item level-${comment.level || 0}`}>
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
                            <label htmlFor="post-content">Content:</label>
                            <div className="html-editor-container">
                                <div className="editor-toolbar">
                                    <button type="button" onClick={() => {
                                        const textarea = document.getElementById('post-content') as HTMLTextAreaElement;
                                        if (textarea) {
                                            const start = textarea.selectionStart;
                                            const end = textarea.selectionEnd;
                                            const selectedText = textarea.value.substring(start, end);
                                            const beforeText = textarea.value.substring(0, start);
                                            const afterText = textarea.value.substring(end);
                                            
                                            const newContent = `${beforeText}<strong>${selectedText}</strong>${afterText}`;
                                            setNewPost({...newPost, content: newContent});
                                            
                                            // Set cursor position after the selection
                                            setTimeout(() => {
                                                textarea.focus();
                                                textarea.selectionStart = start + 8; // "<strong>".length
                                                textarea.selectionEnd = start + 8 + selectedText.length;
                                            }, 0);
                                        }
                                    }}>Bold</button>
                                    
                                    <button type="button" onClick={() => {
                                        const textarea = document.getElementById('post-content') as HTMLTextAreaElement;
                                        if (textarea) {
                                            const start = textarea.selectionStart;
                                            const end = textarea.selectionEnd;
                                            const selectedText = textarea.value.substring(start, end);
                                            const beforeText = textarea.value.substring(0, start);
                                            const afterText = textarea.value.substring(end);
                                            
                                            const newContent = `${beforeText}<em>${selectedText}</em>${afterText}`;
                                            setNewPost({...newPost, content: newContent});
                                            
                                            // Set cursor position after the selection
                                            setTimeout(() => {
                                                textarea.focus();
                                                textarea.selectionStart = start + 4; // "<em>".length
                                                textarea.selectionEnd = start + 4 + selectedText.length;
                                            }, 0);
                                        }
                                    }}>Italic</button>
                                    
                                    <button type="button" onClick={() => {
                                        const textarea = document.getElementById('post-content') as HTMLTextAreaElement;
                                        if (textarea) {
                                            const start = textarea.selectionStart;
                                            const end = textarea.selectionEnd;
                                            const selectedText = textarea.value.substring(start, end);
                                            const beforeText = textarea.value.substring(0, start);
                                            const afterText = textarea.value.substring(end);
                                            
                                            const newContent = `${beforeText}<a href="#">${selectedText}</a>${afterText}`;
                                            setNewPost({...newPost, content: newContent});
                                            
                                            // Set cursor position after the selection
                                            setTimeout(() => {
                                                textarea.focus();
                                                textarea.selectionStart = start + 9; // '<a href="#">'.length
                                                textarea.selectionEnd = start + 9 + selectedText.length;
                                            }, 0);
                                        }
                                    }}>Link</button>
                                    
                                    <button type="button" onClick={() => {
                                        const textarea = document.getElementById('post-content') as HTMLTextAreaElement;
                                        if (textarea) {
                                            const start = textarea.selectionStart;
                                            const end = textarea.selectionEnd;
                                            const selectedText = textarea.value.substring(start, end);
                                            const beforeText = textarea.value.substring(0, start);
                                            const afterText = textarea.value.substring(end);
                                            
                                            const newContent = `${beforeText}<h2>${selectedText}</h2>${afterText}`;
                                            setNewPost({...newPost, content: newContent});
                                            
                                            // Set cursor position after the selection
                                            setTimeout(() => {
                                                textarea.focus();
                                                textarea.selectionStart = start + 4; // "<h2>".length
                                                textarea.selectionEnd = start + 4 + selectedText.length;
                                            }, 0);
                                        }
                                    }}>Heading</button>
                                    
                                    <button type="button" onClick={() => {
                                        const textarea = document.getElementById('post-content') as HTMLTextAreaElement;
                                        if (textarea) {
                                            const start = textarea.selectionStart;
                                            const end = textarea.selectionEnd;
                                            const selectedText = textarea.value.substring(start, end);
                                            const beforeText = textarea.value.substring(0, start);
                                            const afterText = textarea.value.substring(end);
                                            
                                            const newContent = `${beforeText}<ul>\n  <li>${selectedText}</li>\n</ul>${afterText}`;
                                            setNewPost({...newPost, content: newContent});
                                            
                                            // Set cursor position after the selection
                                            setTimeout(() => {
                                                textarea.focus();
                                                textarea.selectionStart = start + 9; // "<ul>\n  <li>".length
                                                textarea.selectionEnd = start + 9 + selectedText.length;
                                            }, 0);
                                        }
                                    }}>List</button>
                                </div>
                                <textarea
                                    id="post-content"
                                    value={newPost.content}
                                    onChange={(e) => setNewPost({...newPost, content: e.target.value})}
                                    rows={10}
                                    required
                                />
                                <div className="editor-preview">
                                    <h4>Preview:</h4>
                                    <div 
                                        className="preview-content"
                                        dangerouslySetInnerHTML={{ __html: newPost.content }}
                                    />
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
                                            {isAdmin && user && (
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
                                                    <button onClick={(e) => {
                                                        e.stopPropagation();
                                                        toggleCommentsForPost(post);
                                                    }}>
                                                        {post.commentsEnabled ? 'Disable Comments' : 'Enable Comments'}
                                                    </button>
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
                                    <div className="post-content" dangerouslySetInnerHTML={{ __html: post.content }} />

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
        </>
    );
};

export default Blog;
