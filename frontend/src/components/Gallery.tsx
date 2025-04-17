import { API_URL } from '../config';
import React, { useEffect, useState, useRef, useCallback } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { MediaItem, Group, User, GalleryComment } from '../types';
import Navbar from './Navbar';
import './Gallery.css';

interface GalleryProps {
    isAdmin?: boolean;
    skipNavbar?: boolean;
}

const Gallery: React.FC<GalleryProps> = ({ isAdmin = false, skipNavbar = false }) => {
    const [media, setMedia] = useState<MediaItem[]>([]);
    const [groups, setGroups] = useState<Group[]>([]);
    const [loading, setLoading] = useState<boolean>(true);
    const [error, setError] = useState<string | null>(null);
    const [selectedMedia, setSelectedMedia] = useState<MediaItem | null>(null);
    const [fetchedImageData, setFetchedImageData] = useState<string | null>(null);
    const [fetchingImage, setFetchingImage] = useState<boolean>(false);
    const [fetchError, setFetchError] = useState<string | null>(null);
    const [deleteConfirmation, setDeleteConfirmation] = useState<MediaItem | null>(null);
    const [deleteStatus, setDeleteStatus] = useState<{ success: boolean; message: string } | null>(null);
    const [showUploadForm, setShowUploadForm] = useState<boolean>(false);
    const [uploadFiles, setUploadFiles] = useState<File[]>([]);
    const [thumbnailFiles, setThumbnailFiles] = useState<(File | null)[]>([]);
    const [uploadPreviews, setUploadPreviews] = useState<string[]>([]);
    const [thumbnailPreviews, setThumbnailPreviews] = useState<string[]>([]);
    const [bulkUploadGroupId, setBulkUploadGroupId] = useState<string>('');
    const [bulkUploadIsPublic, setBulkUploadIsPublic] = useState<boolean>(true);
    const [uploadStatus, setUploadStatus] = useState<{ success: boolean; message: string } | null>(null);
    const [uploadProgress, setUploadProgress] = useState<{ current: number; total: number; percent: number } | null>(null);
    const [editingMediaId, setEditingMediaId] = useState<string | null>(null);
    const [selectedGroupId, setSelectedGroupId] = useState<string>('');
    const [isPublic, setIsPublic] = useState<boolean>(true);
    const [authenticatedThumbnails, setAuthenticatedThumbnails] = useState<Record<string, string>>({});
    const [user, setUser] = useState<User | null>(null);
    
    // Comments state
    const [comments, setComments] = useState<GalleryComment[]>([]);
    const [commentLoading, setCommentLoading] = useState<boolean>(false);
    const [commentError, setCommentError] = useState<string | null>(null);
    const [newComment, setNewComment] = useState<string>('');
    const [replyingTo, setReplyingTo] = useState<string | null>(null);
    const [commentStatus, setCommentStatus] = useState<{ success: boolean; message: string } | null>(null);
    // State to track comment to be deleted (for confirmation)
    const [commentToDelete, setCommentToDelete] = useState<{mediaId: string, commentId: string} | null>(null);
    // State to track highlighted comment from URL
    const [highlightedCommentId, setHighlightedCommentId] = useState<string | null>(null);
    
    const fileInputRef = useRef<HTMLInputElement>(null);
    const navigate = useNavigate();
    const location = useLocation();
    const commentRefs = useRef<{ [key: string]: HTMLLIElement | null }>({});

    // Parse URL query parameters for comment ID
    useEffect(() => {
        const searchParams = new URLSearchParams(location.search);
        const commentId = searchParams.get('comment');
        const hash = location.hash.replace('#', '');
        
        // If we have a comment ID from either query params or hash, set it as highlighted
        if (commentId || hash) {
            setHighlightedCommentId(commentId || hash);
        }
    }, [location]);

    // Check if user is logged in
    useEffect(() => {
        const userJson = localStorage.getItem('user');
        if (userJson) {
            try {
                const userData = JSON.parse(userJson);
                setUser(userData);
            } catch (err) {
                console.error('Error parsing user data:', err);
            }
        }
    }, []);

    // Function to fetch a thumbnail with authentication
    const fetchThumbnailWithAuth = useCallback(async (item: MediaItem) => {
        if (!item.thumbnailUrl) return;
        
        try {
            const response = await fetch(item.thumbnailUrl, {
                method: 'GET',
                headers: {
                    Authorization: `Bearer ${localStorage.getItem('sessionId')}`,
                },
            });
            
            if (!response.ok) {
                throw new Error(`Failed to fetch thumbnail: ${response.status}`);
            }
            
            const blob = await response.blob();
            const objectUrl = URL.createObjectURL(blob);
            
            setAuthenticatedThumbnails(prev => ({
                ...prev,
                [item.id]: objectUrl
            }));
        } catch (error) {
            console.error(`Error fetching thumbnail for ${item.fileName}:`, error);
        }
    }, []);

    useEffect(() => {
        const fetchData = async () => {
            try {
                // Fetch media items
                const mediaResponse = await fetch(`${API_URL}/gallery`, 
                    {
                        method: 'GET',
                        headers: {
                            'Content-Type': 'application/json',
                            Authorization: `Bearer ${localStorage.getItem('sessionId')}`,
                        },
                    }
                );
                
                if (!mediaResponse.ok) {
                    throw new Error(`Failed to fetch media: ${mediaResponse.status}`);
                }
                
                const mediaData = await mediaResponse.json();
                setMedia(mediaData);
                
                // Fetch groups if admin
                if (isAdmin) {
                    const groupsResponse = await fetch(`${API_URL}/admin/groups`, 
                        {
                            method: 'GET',
                            headers: {
                                'Content-Type': 'application/json',
                                Authorization: `Bearer ${localStorage.getItem('sessionId')}`,
                            },
                        }
                    );
                    
                    if (groupsResponse.ok) {
                        const groupsData = await groupsResponse.json();
                        setGroups(groupsData.groups);
                    }
                }
                
                // Set loading to false after fetching the main data
                setLoading(false);
                
                // Now load thumbnails asynchronously
                setTimeout(() => {
                    loadThumbnailsAsync(mediaData);
                }, 100); // Small delay to ensure the page renders first
                
            } catch (error) {
                console.error('Error fetching data:', error);
                setError('Failed to load gallery items. Please try again later.');
                setLoading(false);
            }
        };

        fetchData();
    }, [isAdmin]);
    
    // Function to load thumbnails asynchronously
    const loadThumbnailsAsync = useCallback((mediaItems: MediaItem[]) => {
        // Create a queue of items to load thumbnails for
        const queue = [...mediaItems].filter(item => item.thumbnailUrl);
        
        // Process thumbnails in batches to avoid overwhelming the browser
        const processBatch = async (startIndex: number, batchSize: number) => {
            const endIndex = Math.min(startIndex + batchSize, queue.length);
            const batch = queue.slice(startIndex, endIndex);
            
            // Load thumbnails for this batch in parallel
            await Promise.all(
                batch.map(item => fetchThumbnailWithAuth(item))
            );
            
            // If there are more items, process the next batch
            if (endIndex < queue.length) {
                // Use setTimeout to give the browser a chance to breathe
                setTimeout(() => {
                    processBatch(endIndex, batchSize);
                }, 50);
            }
        };
        
        // Start processing with a reasonable batch size
        if (queue.length > 0) {
            processBatch(0, 5);
        }
    }, [fetchThumbnailWithAuth]);
    
    // Clean up object URLs when component unmounts
    useEffect(() => {
        return () => {
            // Clean up authenticated thumbnail object URLs
            Object.values(authenticatedThumbnails).forEach(url => {
                URL.revokeObjectURL(url);
            });
        };
    }, [authenticatedThumbnails]);
    
    const updateMediaGroup = async (mediaId: string, isPublic: boolean, groupId?: string) => {
        try {
            const response = await fetch(`${API_URL}/${mediaId}/group`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${localStorage.getItem('sessionId')}`,
                },
                body: JSON.stringify({ 
                    isPublic, 
                    groupId: groupId || null 
                }),
            });
            
            if (!response.ok) {
                throw new Error('Failed to update media group');
            }
            
            // Update the media item in the state
            setMedia(media.map(item => 
                item.id === mediaId 
                    ? { ...item, isPublic, groupId: groupId || undefined } 
                    : item
            ));
            
            // Reset editing state
            setEditingMediaId(null);
            setSelectedGroupId('');
            setIsPublic(true);
            
            return true;
        } catch (error) {
            console.error('Error updating media group:', error);
            setError('Failed to update media group');
            return false;
        }
    };
    
    const startEditing = (item: MediaItem) => {
        setEditingMediaId(item.id);
        setIsPublic(item.isPublic !== undefined ? item.isPublic : true);
        setSelectedGroupId(item.groupId || '');
    };
    
    const cancelEditing = () => {
        setEditingMediaId(null);
        setSelectedGroupId('');
        setIsPublic(true);
    };

    const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
        const files = event.target.files;
        if (!files || files.length === 0) return;
        
        // Convert FileList to array
        const filesArray = Array.from(files);
        setUploadFiles(filesArray);
        
        // Create preview URLs for the files
        const previewUrls = filesArray.map(file => URL.createObjectURL(file));
        setUploadPreviews(previewUrls);
        
        // Initialize thumbnailFiles array with nulls for each file
        setThumbnailFiles(new Array(filesArray.length).fill(null));
        
        // Generate thumbnails for each file
        filesArray.forEach((file, index) => generateThumbnail(file, index));
    };
    
    const generateThumbnail = async (file: File, fileIndex: number) => {
        if (file.type.startsWith('image/')) {
            // For images, create a higher resolution version for thumbnails
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            const img = new Image();
            
            img.onload = () => {
                // Calculate thumbnail dimensions (max 400px width/height for higher resolution)
                const maxSize = 400;
                let width = img.width;
                let height = img.height;
                
                if (width > height) {
                    if (width > maxSize) {
                        height = Math.round(height * (maxSize / width));
                        width = maxSize;
                    }
                } else {
                    if (height > maxSize) {
                        width = Math.round(width * (maxSize / height));
                        height = maxSize;
                    }
                }
                
                canvas.width = width;
                canvas.height = height;
                
                // Draw the image at the new size
                ctx?.drawImage(img, 0, 0, width, height);
                
                // Convert canvas to blob with higher quality (0.9 instead of 0.8)
                canvas.toBlob((blob) => {
                    if (blob) {
                        // Create a File object from the blob
                        const thumbnailFile = new File([blob], `thumbnail_${file.name}`, { 
                            type: 'image/jpeg',
                            lastModified: Date.now()
                        });
                        
                        // Update thumbnailFiles array at the specific index
                        setThumbnailFiles(prev => {
                            const newArray = [...prev];
                            newArray[fileIndex] = thumbnailFile;
                            return newArray;
                        });
                        
                        // Update thumbnailPreviews array at the specific index
                        setThumbnailPreviews(prev => {
                            const newArray = [...prev];
                            newArray[fileIndex] = canvas.toDataURL('image/jpeg', 0.9);
                            return newArray;
                        });
                    }
                }, 'image/jpeg', 0.9); // Higher quality for better thumbnails
            };
            
            img.src = URL.createObjectURL(file);
        } else if (file.type.startsWith('video/')) {
            // For videos, capture a frame
            const video = document.createElement('video');
            video.preload = 'metadata';
            
            video.onloadedmetadata = () => {
                // Seek to a frame at 25% of the video
                video.currentTime = video.duration * 0.25;
            };
            
            video.onseeked = () => {
                const canvas = document.createElement('canvas');
                // Higher resolution for video thumbnails (400px wide)
                canvas.width = 400;
                canvas.height = 400 * (video.videoHeight / video.videoWidth);
                
                const ctx = canvas.getContext('2d');
                ctx?.drawImage(video, 0, 0, canvas.width, canvas.height);
                
                canvas.toBlob((blob) => {
                    if (blob) {
                        const thumbnailFile = new File([blob], `thumbnail_${file.name}`, { 
                            type: 'image/jpeg',
                            lastModified: Date.now()
                        });
                        
                        // Update thumbnailFiles array at the specific index
                        setThumbnailFiles(prev => {
                            const newArray = [...prev];
                            newArray[fileIndex] = thumbnailFile;
                            return newArray;
                        });
                        
                        // Update thumbnailPreviews array at the specific index
                        setThumbnailPreviews(prev => {
                            const newArray = [...prev];
                            newArray[fileIndex] = canvas.toDataURL('image/jpeg', 0.9);
                            return newArray;
                        });
                    }
                }, 'image/jpeg', 0.9); // Higher quality for better thumbnails
            };
            
            video.src = URL.createObjectURL(file);
        }
    };
    
    const handleUpload = async (event: React.FormEvent) => {
        event.preventDefault();
        
        if (uploadFiles.length === 0 || thumbnailFiles.length !== uploadFiles.length) {
            setUploadStatus({
                success: false,
                message: 'Please select files and wait for all thumbnails to generate'
            });
            return;
        }
        
        // Check if any thumbnail is null
        const missingThumbnails = thumbnailFiles.some(file => file === null);
        if (missingThumbnails) {
            setUploadStatus({
                success: false,
                message: 'Some thumbnails are still generating. Please wait.'
            });
            return;
        }
        
        setUploadStatus({
            success: true,
            message: 'Preparing to upload files...'
        });
        
        // Initialize progress tracking
        setUploadProgress({
            current: 0,
            total: uploadFiles.length,
            percent: 0
        });
        
        const uploadedItems: MediaItem[] = [];
        let failedUploads = 0;
        
        // Upload each file individually
        for (let i = 0; i < uploadFiles.length; i++) {
            // Update progress before starting each file
            setUploadProgress({
                current: i,
                total: uploadFiles.length,
                percent: Math.round((i / uploadFiles.length) * 100)
            });
            
            setUploadStatus({
                success: true,
                message: `Uploading file ${i + 1} of ${uploadFiles.length}: ${uploadFiles[i].name}`
            });
            
            const formData = new FormData();
            formData.append('file', uploadFiles[i]);
            
            // We've already checked that no thumbnails are null, but TypeScript doesn't know that
            // So we need to assert that the thumbnail is not null
            // So we need to assert that the thumbnail is not null
            const thumbnailFile = thumbnailFiles[i]!; // Non-null assertion
            formData.append('thumbnail', thumbnailFile);
            
            // Add group information
            formData.append('isPublic', bulkUploadIsPublic.toString());
            if (!bulkUploadIsPublic && bulkUploadGroupId) {
                formData.append('groupId', bulkUploadGroupId);
            }
            
            try {
                const response = await fetch(`${API_URL}/gallery/upload`, {
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${localStorage.getItem('sessionId')}`,
                    },
                    body: formData,
                });
                
                const result = await response.json();
                
                if (response.ok && result.mediaItem) {
                    uploadedItems.push(result.mediaItem);
                } else {
                    console.error(`Failed to upload file ${uploadFiles[i].name}:`, result.message);
                    failedUploads++;
                }
            } catch (error) {
                console.error(`Error uploading file ${uploadFiles[i].name}:`, error);
                failedUploads++;
            }
        }
        
        // Set final progress
        setUploadProgress({
            current: uploadFiles.length,
            total: uploadFiles.length,
            percent: 100
        });
        
        // Update status based on results
        if (failedUploads === 0) {
            setUploadStatus({
                success: true,
                message: `Successfully uploaded ${uploadedItems.length} files!`
            });
        } else if (uploadedItems.length > 0) {
            setUploadStatus({
                success: true,
                message: `Uploaded ${uploadedItems.length} files, but ${failedUploads} failed.`
            });
        } else {
            setUploadStatus({
                success: false,
                message: 'Failed to upload any files.'
            });
        }
        
        // Reset form
        setUploadFiles([]);
        setThumbnailFiles([]);
        setUploadPreviews([]);
        setThumbnailPreviews([]);
        if (fileInputRef.current) {
            fileInputRef.current.value = '';
        }
        
        // Add the new media to the list
        if (uploadedItems.length > 0) {
            setMedia([...uploadedItems, ...media]);
        }
        
        // Hide the upload form if all uploads were successful
        if (failedUploads === 0) {
            setShowUploadForm(false);
        }
    };

    const fetchImageWithAuth = async (url: string) => {
        setFetchingImage(true);
        setFetchError(null);
        setFetchedImageData(null);
        
        try {
            const response = await fetch(url, {
                method: 'GET',
                headers: {
                    Authorization: `Bearer ${localStorage.getItem('sessionId')}`,
                },
            });
            
            if (!response.ok) {
                throw new Error(`Failed to fetch image: ${response.status}`);
            }
            
            const blob = await response.blob();
            const objectUrl = URL.createObjectURL(blob);
            setFetchedImageData(objectUrl);
            // Automatically play the video if it's a video file
            if (selectedMedia && isVideo(selectedMedia.fileType)) {
                const videoElement = document.querySelector('video');
                if (videoElement) {
                    videoElement.currentTime = 0; // Reset to the beginning
                    videoElement.play(); // Start playing
                }
            }
        } catch (error) {
            console.error('Error fetching image:', error);
            setFetchError('Failed to load image. Please try again later.');
        } finally {
            setFetchingImage(false);
        }
    };

    const openModal = (item: MediaItem) => {
        setSelectedMedia(item);
        // Fetch the image with authentication
        if (item.url) {
            fetchImageWithAuth(item.url);
        }
        
        // Only fetch comments if user is logged in or the media is public
        if (user || item.isPublic) {
            fetchComments(item.fileName);
        } else {
            // Clear comments for non-public media when user is not logged in
            setComments([]);
        }
        
        // Clear any existing comment state
        setNewComment('');
        setReplyingTo(null);
        setCommentStatus(null);
    };

    const closeModal = () => {
        setSelectedMedia(null);
        // Clean up any object URLs to prevent memory leaks
        if (fetchedImageData) {
            URL.revokeObjectURL(fetchedImageData);
            setFetchedImageData(null);
        }
    };

    const handleDeleteClick = (item: MediaItem, e: React.MouseEvent) => {
        e.stopPropagation(); // Prevent opening the modal
        setDeleteConfirmation(item);
    };
    
    const confirmDelete = async () => {
        if (!deleteConfirmation) return;
        
        try {
            const response = await fetch(`${API_URL}/gallery/${deleteConfirmation.fileName}`, {
                method: 'DELETE',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${localStorage.getItem('sessionId')}`,
                },
            });
            
            const result = await response.json();
            
            if (response.ok) {
                setDeleteStatus({
                    success: true,
                    message: 'Media deleted successfully'
                });
                
                // Remove the deleted item from the media list
                setMedia(media.filter(item => item.id !== deleteConfirmation.id));
                
                // Close the confirmation dialog
                setDeleteConfirmation(null);
            } else {
                setDeleteStatus({
                    success: false,
                    message: result.message || 'Failed to delete media'
                });
            }
        } catch (error) {
            console.error('Error deleting media:', error);
            setDeleteStatus({
                success: false,
                message: 'An error occurred while deleting the media'
            });
        }
    };
    
    const cancelDelete = () => {
        setDeleteConfirmation(null);
    };

    // Function to fetch comments for a media item
    const fetchComments = async (mediaId: string) => {
        setCommentLoading(true);
        setCommentError(null);
        
        try {
            const response = await fetch(`${API_URL}/gallery/${mediaId}/comments`, {
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
        } catch (error) {
            console.error('Error fetching comments:', error);
            setCommentError('Failed to load comments. Please try again later.');
            setComments([]);
        } finally {
            setCommentLoading(false);
        }
    };

    // Function to handle submitting a new comment
    const handleCommentSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        
        if (!selectedMedia || !newComment.trim() || !user) {
            setCommentStatus({
                success: false,
                message: 'Please enter a comment and make sure you are logged in'
            });
            return;
        }
        
        try {
            const response = await fetch(`${API_URL}/gallery/${selectedMedia.fileName}/comments`, {
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
                
                // Add the new comment to the list
                if (result.comment) {
                    // Refresh comments to show the new nested structure
                    await fetchComments(selectedMedia.fileName);
                }
                
                // Clear the comment form
                setNewComment('');
                setReplyingTo(null);
            } else {
                setCommentStatus({
                    success: false,
                    message: result.message || 'Failed to add comment'
                });
            }
        } catch (error) {
            console.error('Error adding comment:', error);
            setCommentStatus({
                success: false,
                message: 'An error occurred while adding the comment'
            });
        }
    };

    // Function to handle deleting a comment with confirmation
    const handleDeleteComment = async (mediaId: string, commentId: string) => {
        if (!isAdmin) return;
        
        try {
            const response = await fetch(`${API_URL}/gallery/${mediaId}/comments/${commentId}`, {
                method: 'DELETE',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${localStorage.getItem('sessionId')}`,
                },
            });
            
            if (response.ok) {
                setCommentStatus({
                    success: true,
                    message: 'Comment deleted successfully'
                });
                
                // Refresh comments after deletion
                await fetchComments(mediaId);
                // Clear comment to delete
                setCommentToDelete(null);
            } else {
                const result = await response.json();
                setCommentStatus({
                    success: false,
                    message: result.message || 'Failed to delete comment'
                });
            }
        } catch (error) {
            console.error('Error deleting comment:', error);
            setCommentStatus({
                success: false,
                message: 'An error occurred while deleting the comment'
            });
        }
    };

    // Function to find comment in the nested structure
    const findCommentInTree = useCallback((commentId: string) => {
        // Check in top-level comments
        const topLevelComment = comments.find(c => c.id === commentId);
        if (topLevelComment) return topLevelComment;
        
        // Check in replies (first level)
        for (const comment of comments) {
            if (comment.replies && comment.replies.length > 0) {
                const reply = comment.replies.find(r => r.id === commentId);
                if (reply) return reply;
                
                // Check in deep replies (second level)
                for (const r of comment.replies) {
                    if (r.replies && r.replies.length > 0) {
                        const deepReply = r.replies.find(dr => dr.id === commentId);
                        if (deepReply) return deepReply;
                    }
                }
            }
        }
        return null;
    }, [comments]);
    
    // Function to find the media item that contains a specific comment
    const findMediaForComment = useCallback(async (commentId: string) => {
        // We need to check all media items for their comments
        for (const item of media) {
            try {
                const response = await fetch(`${API_URL}/gallery/${item.fileName}/comments`, {
                    method: 'GET',
                    headers: {
                        'Content-Type': 'application/json',
                        Authorization: `Bearer ${localStorage.getItem('sessionId')}`,
                    },
                });
                
                if (!response.ok) continue;
                
                const itemComments = await response.json();
                
                // Helper function to search the comment tree
                const searchCommentTree = (comments: GalleryComment[]) => {
                    for (const comment of comments) {
                        if (comment.id === commentId) return true;
                        
                        if (comment.replies && comment.replies.length > 0) {
                            const found = searchCommentTree(comment.replies);
                            if (found) return true;
                        }
                    }
                    return false;
                };
                
                if (searchCommentTree(itemComments)) {
                    return item;
                }
            } catch (error) {
                console.error(`Error checking comments for ${item.fileName}:`, error);
            }
        }
        return null;
    }, [media]);
    
    // Effect to handle highlighted comments when comments are loaded
    useEffect(() => {
        if (highlightedCommentId && comments.length > 0) {
            // Timeout gives DOM time to render comments
            setTimeout(() => {
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
                }
            }, 500);
        }
    }, [comments, highlightedCommentId]);
    
    // Effect to find and open the media item containing the highlighted comment
    useEffect(() => {
        if (highlightedCommentId && media.length > 0 && !selectedMedia) {
            const findAndOpenMedia = async () => {
                const mediaItem = await findMediaForComment(highlightedCommentId);
                if (mediaItem) {
                    openModal(mediaItem);
                }
            };
            
            findAndOpenMedia();
        }
    }, [highlightedCommentId, media, selectedMedia, findMediaForComment]);

    if (loading) {
        return <div>Loading...</div>;
    }

    const isImage = (fileType: string) => {
        if (!fileType) return false;
        
        // Check MIME type
        if (fileType.startsWith('image/')) return true;
        
        // Fallback: check common image extensions if MIME type is application/octet-stream
        if (fileType === 'application/octet-stream') {
            const fileName = selectedMedia?.fileName.toLowerCase() || '';
            const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.bmp'];
            return imageExtensions.some(ext => fileName.endsWith(ext));
        }
        
        return false;
    };
    
    const isVideo = (fileType: string) => {
        if (!fileType) return false;
        
        // Check MIME type
        if (fileType.startsWith('video/')) return true;
        
        // Fallback: check common video extensions if MIME type is application/octet-stream
        if (fileType === 'application/octet-stream') {
            const fileName = selectedMedia?.fileName.toLowerCase() || '';
            const videoExtensions = ['.mp4', '.webm', '.mov', '.avi', '.mkv', '.flv', '.wmv'];
            return videoExtensions.some(ext => fileName.endsWith(ext));
        }
        
        return false;
    };

    return (
        <>
            {!skipNavbar && <Navbar />}
            <div className="gallery-container">
                <div className="gallery-header">
                    <h1 className="gallery-title">Gallery</h1>
                    <div className="gallery-nav">
                        {isAdmin && user && (
                            <button onClick={() => setShowUploadForm(!showUploadForm)}>
                                {showUploadForm ? 'Cancel Upload' : 'Upload Media'}
                            </button>
                        )}
                    </div>
                </div>

                {error && <div className="error-message">{error}</div>}

                {showUploadForm && isAdmin && user && (
                    <form className="upload-form" onSubmit={handleUpload}>
                        <div className="form-group">
                            <label htmlFor="file-upload">Select files to upload:</label>
                            <input
                                id="file-upload"
                                type="file"
                                accept="image/*,video/*"
                                onChange={handleFileChange}
                                ref={fileInputRef}
                                multiple
                                required
                            />
                        </div>
                        
                        {/* Group selection for bulk upload */}
                        <div className="form-group bulk-upload-options">
                            <div className="visibility-option">
                                <label>
                                    <input 
                                        type="checkbox" 
                                        checked={bulkUploadIsPublic}
                                        onChange={(e) => setBulkUploadIsPublic(e.target.checked)}
                                    />
                                    Make files public
                                </label>
                            </div>
                            
                            {!bulkUploadIsPublic && (
                                <div className="group-selection">
                                    <label htmlFor="group-select">Select a group:</label>
                                    <select 
                                        id="group-select"
                                        value={bulkUploadGroupId}
                                        onChange={(e) => setBulkUploadGroupId(e.target.value)}
                                        disabled={bulkUploadIsPublic}
                                    >
                                        <option value="">Select a group</option>
                                        {groups.map(group => (
                                            <option key={group.id} value={group.id}>
                                                {group.name}
                                            </option>
                                        ))}
                                    </select>
                                </div>
                            )}
                        </div>

                        {uploadPreviews.length > 0 && (
                            <div className="upload-preview">
                                <h3>Selected Files ({uploadPreviews.length})</h3>
                                <div className="preview-grid">
                                    {uploadPreviews.map((preview, index) => (
                                        <div key={index} className="preview-container">
                                            {uploadFiles[index]?.type.startsWith('image/') ? (
                                                <img src={preview} alt={`Upload preview ${index + 1}`} />
                                            ) : (
                                                <video width="100" controls>
                                                    <source src={preview} type={uploadFiles[index]?.type} />
                                                    Your browser does not support the video tag.
                                                </video>
                                            )}
                                            <p className="file-name">{uploadFiles[index]?.name}</p>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        )}

                        {uploadStatus && (
                            <div className={uploadStatus.success ? 'success-message' : 'error-message'}>
                                {uploadStatus.message}
                            </div>
                        )}
                        
                        {uploadProgress && uploadProgress.total > 0 && (
                            <div className="upload-progress">
                                <div className="progress-text">
                                    {uploadProgress.current} of {uploadProgress.total} files uploaded ({uploadProgress.percent}%)
                                </div>
                                <div className="progress-bar-container">
                                    <div 
                                        className="progress-bar" 
                                        style={{ width: `${uploadProgress.percent}%` }}
                                    ></div>
                                </div>
                            </div>
                        )}

                        <button 
                            type="submit" 
                            className="submit-button"
                            disabled={uploadFiles.length === 0 || thumbnailFiles.length !== uploadFiles.length}
                        >
                            Upload {uploadFiles.length} {uploadFiles.length === 1 ? 'File' : 'Files'}
                        </button>
                    </form>
                )}

                <div className="gallery-grid">
                    {media.length === 0 ? (
                        <p>No media available.</p>
                    ) : (
                        media.map(item => (
                            <div key={item.id} className="media-item" onClick={() => openModal(item)}>
                                {/* Use authenticated thumbnail for non-public items, or direct URL for public items */}
                                <img 
                                    src={
                                        // Always use authenticated thumbnail if available
                                        authenticatedThumbnails[item.id] || 
                                        // Fallback to placeholder while we fetch the authenticated version
                                        'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjAwIiBoZWlnaHQ9IjIwMCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cmVjdCB3aWR0aD0iMjAwIiBoZWlnaHQ9IjIwMCIgZmlsbD0iI2VlZSIvPjx0ZXh0IHg9IjUwJSIgeT0iNTAlIiBmb250LWZhbWlseT0iQXJpYWwsIHNhbnMtc2VyaWYiIGZvbnQtc2l6ZT0iMjAiIHRleHQtYW5jaG9yPSJtaWRkbGUiIGRvbWluYW50LWJhc2VsaW5lPSJtaWRkbGUiIGZpbGw9IiM5OTkiPkltYWdlPC90ZXh0Pjwvc3ZnPg=='
                                    }
                                    alt={item.fileName}
                                    className={`media-thumbnail ${!authenticatedThumbnails[item.id] && item.thumbnailUrl ? 'media-thumbnail-loading' : ''}`}
                                    onError={(e) => {
                                        console.error(`Error loading thumbnail for ${item.fileName}`);
                                        console.error(e);
                                        // If we don't have an authenticated thumbnail yet and there's a thumbnail URL
                                        if (!authenticatedThumbnails[item.id] && item.thumbnailUrl) {
                                            // Try to fetch with authentication
                                            fetchThumbnailWithAuth(item);
                                        }
                                        
                                        // Show placeholder while fetching
                                        (e.target as HTMLImageElement).src = 'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjAwIiBoZWlnaHQ9IjIwMCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cmVjdCB3aWR0aD0iMjAwIiBoZWlnaHQ9IjIwMCIgZmlsbD0iI2VlZSIvPjx0ZXh0IHg9IjUwJSIgeT0iNTAlIiBmb250LWZhbWlseT0iQXJpYWwsIHNhbnMtc2VyaWYiIGZvbnQtc2l6ZT0iMjAiIHRleHQtYW5jaG9yPSJtaWRkbGUiIGRvbWluYW50LWJhc2VsaW5lPSJtaWRkbGUiIGZpbGw9IiM5OTkiPkltYWdlPC90ZXh0Pjwvc3ZnPg==';
                                    }}
                                    style={{
                                        opacity: authenticatedThumbnails[item.id] ? 1 : 0.7
                                    }}
                                />
                                <div className="media-info">
                                    <h3 className="media-name">{item.fileName}</h3>
                                    <p className="media-date">
                                        {new Date(item.uploadedAt).toLocaleDateString()}
                                    </p>
                                    
                                    {/* Display group information */}
                                    <p className="media-group">
                                        {item.isPublic ? 'Public' : item.groupId ? 
                                            `Group: ${groups.find(g => g.id === item.groupId)?.name || 'Unknown'}` : 
                                            'Private'}
                                    </p>
                                    
                                    {/* Group editing UI */}
                                    {isAdmin && user && editingMediaId === item.id ? (
                                        <div className="group-edit-form" onClick={(e) => e.stopPropagation()}>
                                            <div className="form-group">
                                                <label>
                                                    <input 
                                                        type="checkbox" 
                                                        checked={isPublic}
                                                        onChange={(e) => setIsPublic(e.target.checked)}
                                                    />
                                                    Public
                                                </label>
                                            </div>
                                            
                                            {!isPublic && (
                                                <div className="form-group">
                                                    <select 
                                                        value={selectedGroupId}
                                                        onChange={(e) => setSelectedGroupId(e.target.value)}
                                                        disabled={isPublic}
                                                    >
                                                        <option value="">Select a group</option>
                                                        {groups.map(group => (
                                                            <option key={group.id} value={group.id}>
                                                                {group.name}
                                                            </option>
                                                        ))}
                                                    </select>
                                                </div>
                                            )}
                                            
                                            <div className="edit-buttons">
                                                <button 
                                                    className="save-button"
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        updateMediaGroup(item.id, isPublic, isPublic ? undefined : selectedGroupId);
                                                    }}
                                                >
                                                    Save
                                                </button>
                                                <button 
                                                    className="cancel-button"
                                                    onClick={(e) => {
                                                        e.stopPropagation();
                                                        cancelEditing();
                                                    }}
                                                >
                                                    Cancel
                                                </button>
                                            </div>
                                        </div>
                                    ) : (
                                        <div className="media-actions">
                                            {isAdmin && user && (
                                                <>
                                                    <button 
                                                        className="edit-button"
                                                        onClick={(e) => {
                                                            e.stopPropagation();
                                                            startEditing(item);
                                                        }}
                                                    >
                                                        Edit Group
                                                    </button>
                                                    <button 
                                                        className="delete-button"
                                                        onClick={(e) => handleDeleteClick(item, e)}
                                                    >
                                                        Delete
                                                    </button>
                                                </>
                                            )}
                                        </div>
                                    )}
                                </div>
                            </div>
                        ))
                    )}
                </div>

                {selectedMedia && (
                    <div className="modal" onClick={closeModal}>
                        <div className="modal-close">×</div>
                        <div className="modal-content" onClick={e => e.stopPropagation()}>
                            {fetchingImage ? (
                                <div className="loading-indicator">Loading...</div>
                            ) : fetchError ? (
                                <div className="error-message">{fetchError}</div>
                            ) : isImage(selectedMedia.fileType) ? (
                                <img 
                                    src={fetchedImageData || ''} 
                                    alt={selectedMedia.fileName} 
                                />
                            ) : isVideo(selectedMedia.fileType) && fetchedImageData ? (
                                <video controls autoPlay>
                                    <source 
                                        src={fetchedImageData || ''} 
                                        type={selectedMedia.fileType} 
                                    />
                                    Your browser does not support the video tag.
                                </video>
                            ) : (
                                <div>Unsupported media type</div>
                            )}
                            
                            {/* Comments Section */}
                            <div className="comments-section">
                                <h3>Comments</h3>
                                
                                {commentStatus && (
                                    <div className={commentStatus.success ? 'success-message' : 'error-message'}>
                                        {commentStatus.message}
                                    </div>
                                )}
                                
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
                                            <form className="comment-form" onSubmit={handleCommentSubmit}>
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
                                        <form className="comment-form" onSubmit={handleCommentSubmit}>
                                            <textarea
                                                value={newComment}
                                                onChange={(e) => setNewComment(e.target.value)}
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
                                
                                {commentLoading ? (
                                    <div className="loading-indicator">Loading comments...</div>
                                ) : commentError ? (
                                    <div className="error-message">{commentError}</div>
                                ) : comments.length === 0 ? (
                                    <p>No comments yet. Be the first to comment!</p>
                                ) : (
                                    <ul className="comments-list">
                                        {comments.map((comment) => (
                                            <li key={comment.id} id={`comment-${comment.id}`} className={`comment-item level-${comment.level}`}>
                                                <div className="comment-meta">
                                                    <span>{comment.author} on {new Date(comment.createdAt).toLocaleDateString()}</span>
                                                </div>
                                                <p className="comment-content">{comment.content}</p>
                                                <div className="comment-actions">
                                                    {user && comment.level < 2 && (
                                                        <button 
                                                            className="reply-button"
                                                            onClick={() => setReplyingTo(comment.id)}
                                                        >
                                                            Reply
                                                        </button>
                                                    )}
                                                    {isAdmin && (
                                                        <button 
                                                            className="delete-comment-button"
                                                            onClick={() => setCommentToDelete({ mediaId: selectedMedia.fileName, commentId: comment.id })}
                                                        >
                                                            Delete
                                                        </button>
                                                    )}
                                                </div>
                                                
                                                {/* Show reply form directly beneath this comment if replying to it */}
                                                {replyingTo === comment.id && user && (
                                                    <div className="inline-reply-form">
                                                        <form className="comment-form" onSubmit={handleCommentSubmit}>
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
                                                
                                                {/* Render replies */}
                                                {comment.replies && comment.replies.length > 0 && (
                                                    <ul className="replies-list">
                                                        {comment.replies.map((reply) => (
                                                            <li key={reply.id} id={`comment-${reply.id}`} className="reply-item">
                                                                <div className="comment-meta">
                                                                    <span>{reply.author} on {new Date(reply.createdAt).toLocaleDateString()}</span>
                                                                </div>
                                                                <p className="comment-content">{reply.content}</p>
                                                                <div className="comment-actions">
                                                                    {user && reply.level < 2 && (
                                                                        <button 
                                                                            className="reply-button"
                                                                            onClick={() => setReplyingTo(reply.id)}
                                                                        >
                                                                            Reply
                                                                        </button>
                                                                    )}
                                                                    {isAdmin && (
                                                                        <button 
                                                                            className="delete-comment-button"
                                                                            onClick={() => setCommentToDelete({ mediaId: selectedMedia.fileName, commentId: reply.id })}
                                                                        >
                                                                            Delete
                                                                        </button>
                                                                    )}
                                                                </div>
                                                                
                                                                {/* Show reply form for level 1 replies */}
                                                                {replyingTo === reply.id && user && (
                                                                    <div className="inline-reply-form">
                                                                        <form className="comment-form" onSubmit={handleCommentSubmit}>
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
                                                                
                                                                {/* Level 2 replies (3rd level in total) */}
                                                                {reply.replies && reply.replies.length > 0 && (
                                                                    <ul className="replies-list">
                                                                        {reply.replies.map((deepReply) => (
                                                                            <li key={deepReply.id} id={`comment-${deepReply.id}`} className="reply-item">
                                                                                <div className="comment-meta">
                                                                                    <span>{deepReply.author} on {new Date(deepReply.createdAt).toLocaleDateString()}</span>
                                                                                </div>
                                                                                <p className="comment-content">{deepReply.content}</p>
                                                                                <div className="comment-actions">
                                                                                    {isAdmin && (
                                                                                        <button 
                                                                                            className="delete-comment-button"
                                                                                            onClick={() => setCommentToDelete({ mediaId: selectedMedia.fileName, commentId: deepReply.id })}
                                                                                        >
                                                                                            Delete
                                                                                        </button>
                                                                                    )}
                                                                                </div>
                                                                            </li>
                                                                        ))}
                                                                    </ul>
                                                                )}
                                                            </li>
                                                        ))}
                                                    </ul>
                                                )}
                                            </li>
                                        ))}
                                    </ul>
                                )}
                            </div>
                        </div>
                    </div>
                )}
                
                {commentToDelete && (
                    <div className="modal confirmation-modal">
                        <div className="modal-overlay" onClick={() => setCommentToDelete(null)}></div>
                        <div className="confirmation-content">
                            <h3>Confirm Comment Deletion</h3>
                            <p>Are you sure you want to delete this comment?</p>
                            <div className="confirmation-buttons">
                                <button 
                                    onClick={() => {
                                        if (commentToDelete) {
                                            handleDeleteComment(commentToDelete.mediaId, commentToDelete.commentId);
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
                
                {deleteConfirmation && (
                    <div className="modal delete-confirmation-modal">
                        <div className="delete-confirmation-content">
                            <h3>Confirm Deletion</h3>
                            <p>Are you sure you want to delete "{deleteConfirmation.fileName}"?</p>
                            <p>This action cannot be undone.</p>
                            
                            <div className="delete-confirmation-buttons">
                                <button 
                                    className="cancel-button"
                                    onClick={cancelDelete}
                                >
                                    Cancel
                                </button>
                                <button 
                                    className="confirm-button"
                                    onClick={confirmDelete}
                                >
                                    Delete
                                </button>
                            </div>
                            
                            {deleteStatus && (
                                <div className={deleteStatus.success ? 'success-message' : 'error-message'}>
                                    {deleteStatus.message}
                                </div>
                            )}
                        </div>
                    </div>
                )}
            </div>
        </>
    );
};

export default Gallery;
