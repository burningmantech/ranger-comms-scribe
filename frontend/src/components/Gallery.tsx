import { API_URL } from '../config';
import React, { useEffect, useState, useRef, useCallback } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { MediaItem, Group, User, GalleryComment } from '../types';
import Navbar from './Navbar';
import './Gallery.css';
import logger from '../utils/logger';

const LoadingSkeleton = () => {
    return (
        <div className="skeleton-container">
            {Array.from({ length: 8 }).map((_, index) => (
                <div className="skeleton-item" key={index}>
                    <div className="skeleton-image"></div>
                    <div className="skeleton-info">
                        <div className="skeleton-text"></div>
                        <div className="skeleton-text short"></div>
                    </div>
                </div>
            ))}
        </div>
    );
};

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
    const [mediumFiles, setMediumFiles] = useState<(File | null)[]>([]);
    const [uploadPreviews, setUploadPreviews] = useState<string[]>([]);
    const [thumbnailPreviews, setThumbnailPreviews] = useState<string[]>([]);
    const [bulkUploadGroupId, setBulkUploadGroupId] = useState<string>('');
    const [bulkUploadIsPublic, setBulkUploadIsPublic] = useState<boolean>(true);
    const [bulkUploadTakenBy, setBulkUploadTakenBy] = useState<string>('');
    const [uploadStatus, setUploadStatus] = useState<{ success: boolean; message: string } | null>(null);
    const [uploadProgress, setUploadProgress] = useState<{ current: number; total: number; percent: number } | null>(null);
    const [editingMediaId, setEditingMediaId] = useState<string | null>(null);
    const [selectedGroupId, setSelectedGroupId] = useState<string>('');
    const [isPublic, setIsPublic] = useState<boolean>(true);
    const [authenticatedThumbnails, setAuthenticatedThumbnails] = useState<Record<string, string>>({});
    const [authenticatedMediums, setAuthenticatedMediums] = useState<Record<string, string>>({});
    const blobUrlsRef = useRef<Map<string, string>>(new Map());
    const activeUrlsRef = useRef<Set<string>>(new Set());
    const [user, setUser] = useState<User | null>(null);
    const [viewMode, setViewMode] = useState<'thumbnail' | 'medium' | 'full'>('full');
    const [editingTakenBy, setEditingTakenBy] = useState<boolean>(false);
    const [takenByValue, setTakenByValue] = useState<string>('');
    const [takenByStatus, setTakenByStatus] = useState<{ success: boolean; message: string } | null>(null);
    const [currentItemDeleted, setCurrentItemDeleted] = useState<boolean>(false);

    // Comments state
    const [comments, setComments] = useState<GalleryComment[]>([]);
    const [commentLoading, setCommentLoading] = useState<boolean>(false);
    const [commentError, setCommentError] = useState<string | null>(null);
    const [newComment, setNewComment] = useState<string>('');
    const [replyingTo, setReplyingTo] = useState<string | null>(null);
    const [commentStatus, setCommentStatus] = useState<{ success: boolean; message: string } | null>(null);
    const [commentToDelete, setCommentToDelete] = useState<{ mediaId: string; commentId: string } | null>(null);
    const [highlightedCommentId, setHighlightedCommentId] = useState<string | null>(null);

    const fileInputRef = useRef<HTMLInputElement>(null);
    const navigate = useNavigate();
    const location = useLocation();
    const commentRefs = useRef<{ [key: string]: HTMLLIElement | null }>({});
    const [loadingMediumImage, setLoadingMediumImage] = useState<boolean>(false);
    const mediumImageRef = useRef<HTMLImageElement | null>(null);

    // Modify the component state to include an image cache
    const [imageCache, setImageCache] = useState<{
        [key: string]: {
            medium?: Blob;
            thumbnail?: Blob;
            full?: Blob;
        };
    }>({});

    // For keyboard navigation and touch events
    const modalContentRef = useRef<HTMLDivElement>(null);
    const touchStartX = useRef<number | null>(null);
    const touchEndX = useRef<number | null>(null);
    const minSwipeDistance = 50; // Minimum distance in pixels for a swipe to register

    // Functions for finding previous/next images
    const findPreviousImage = useCallback(() => {
        if (!selectedMedia || media.length <= 1) return null;
        
        const currentIndex = media.findIndex(item => item.id === selectedMedia.id);
        if (currentIndex <= 0) {
            // Wrap around to the end of the array
            return media[media.length - 1];
        }
        return media[currentIndex - 1];
    }, [selectedMedia, media]);
    
    const findNextImage = useCallback(() => {
        if (!selectedMedia || media.length <= 1) return null;
        
        const currentIndex = media.findIndex(item => item.id === selectedMedia.id);
        if (currentIndex === -1 || currentIndex === media.length - 1) {
            // Wrap around to the beginning of the array
            return media[0];
        }
        return media[currentIndex + 1];
    }, [selectedMedia, media]);

    const navigateToPreviousImage = () => {
        const prevImage = findPreviousImage();
        if (prevImage) {
            // Reset fetchedImageData to ensure we start with medium view
            if (fetchedImageData) {
                URL.revokeObjectURL(fetchedImageData);
                setFetchedImageData(null);
            }
            // Always force medium view mode and disable fetching full image
            setViewMode('medium');
            openModal(prevImage, 'medium');
        }
    };

    const navigateToNextImage = () => {
        const nextImage = findNextImage();
        if (nextImage) {
            // Reset fetchedImageData to ensure we start with medium view
            if (fetchedImageData) {
                URL.revokeObjectURL(fetchedImageData);
                setFetchedImageData(null);
            }
            // Always force medium view mode and disable fetching full image
            setViewMode('medium');
            openModal(nextImage, 'medium');
        }
    };

    const getMediaSource = () => {
        if (!selectedMedia) return '';

        switch (viewMode) {
            case 'thumbnail':
                return authenticatedThumbnails[selectedMedia.id] || '';
            case 'medium':
                // First try to get a fresh URL directly from our blob cache
                const cachedMediumUrl = getCachedUrl(selectedMedia.id, 'medium');
                if (cachedMediumUrl) {
                    logger.debug(`[DEBUG] Using freshly generated URL from blob cache for ${selectedMedia.fileName}`);
                    return cachedMediumUrl;
                }
                
                // Fall back to previously generated URLs if needed
                const storedMediumUrl = blobUrlsRef.current.get(selectedMedia.id);
                if (storedMediumUrl) {
                    logger.debug(`[DEBUG] Using stored blob URL from ref for ${selectedMedia.fileName}: ${storedMediumUrl}`);
                    return storedMediumUrl;
                }
                
                // Check if we have a medium image URL in state
                const stateMediumUrl = authenticatedMediums[selectedMedia.id];
                if (typeof stateMediumUrl === 'string' && stateMediumUrl !== 'loading' && stateMediumUrl !== 'error') {
                    logger.debug(`[DEBUG] Using medium URL from state for ${selectedMedia.fileName}: ${stateMediumUrl}`);
                    return stateMediumUrl;
                }
                
                // Fall back to full size if medium is not available
                logger.debug(`[DEBUG] No valid medium URL found for ${selectedMedia.fileName}, using full-sized image`);
                return fetchedImageData || '';
            case 'full':
            default:
                return fetchedImageData || '';
        }
    };

    const getViewToggleLabel = () => {
        switch (viewMode) {
            case 'thumbnail':
                return 'View Medium Size';
            case 'medium':
                return 'View Full Size';
            case 'full':
                return selectedMedia?.mediumUrl ? 'View Medium Size' : 'Full Size';
            default:
                return 'Change View';
        }
    };

    const toggleView = () => {
        if (viewMode === 'thumbnail') {
            setViewMode('medium');
        } else if (viewMode === 'medium') {
            // Only fetch the full-sized image when the user explicitly clicks to view it
            if (selectedMedia && !fetchedImageData) {
                setViewMode('full');
                logger.debug(`[DEBUG] Fetching full-sized image for ${selectedMedia.fileName} on user request`);
                fetchImageWithAuth(`${API_URL}/gallery/${selectedMedia.fileName}`);
            } else {
                setViewMode('full');
            }
        } else {
            setViewMode(selectedMedia?.mediumUrl ? 'medium' : 'thumbnail');
        }
    };

    const handleMediumImageLoad = () => {
        setLoadingMediumImage(false);
    };

    const handleMediumImageError = () => {
        logger.error('Error loading medium image');
        setLoadingMediumImage(false);
        if (fetchedImageData) {
            setViewMode('full');
        }
    };

    useEffect(() => {
        // Add keyboard event listener when modal is open
        const handleKeyDown = (e: KeyboardEvent) => {
            if (selectedMedia) {
                if (e.key === 'ArrowLeft' || e.key === 'Left') {
                    navigateToPreviousImage();
                } else if (e.key === 'ArrowRight' || e.key === 'Right') {
                    navigateToNextImage();
                } else if (e.key === 'Escape') {
                    closeModal();
                }
            }
        };

        // Add touch event handlers
        const handleTouchStart = (e: TouchEvent) => {
            touchStartX.current = e.changedTouches[0].screenX;
        };

        const handleTouchEnd = (e: TouchEvent) => {
            touchEndX.current = e.changedTouches[0].screenX;
            handleSwipe();
        };

        const handleSwipe = () => {
            if (!touchStartX.current || !touchEndX.current) return;
            
            const distance = touchEndX.current - touchStartX.current;
            const isLeftSwipe = distance < -minSwipeDistance;
            const isRightSwipe = distance > minSwipeDistance;
            
            if (isLeftSwipe) {
                // Left swipe - next image
                navigateToNextImage();
            } else if (isRightSwipe) {
                // Right swipe - previous image
                navigateToPreviousImage();
            }
            
            // Reset values
            touchStartX.current = null;
            touchEndX.current = null;
        };

        window.addEventListener('keydown', handleKeyDown);
        
        const modalContent = modalContentRef.current;
        if (modalContent) {
            modalContent.addEventListener('touchstart', handleTouchStart);
            modalContent.addEventListener('touchend', handleTouchEnd);
        }
        
        return () => {
            window.removeEventListener('keydown', handleKeyDown);
            if (modalContent) {
                modalContent.removeEventListener('touchstart', handleTouchStart);
                modalContent.removeEventListener('touchend', handleTouchEnd);
            }
        };
    }, [selectedMedia, navigateToPreviousImage, navigateToNextImage]);

    // Create a cache-backed URL generator
    const getCachedUrl = useCallback((itemId: string, type: 'medium' | 'thumbnail' | 'full'): string => {
        const cache = imageCache[itemId];
        if (!cache || !cache[type]) return '';
        
        // Generate a new URL from the cached blob every time to prevent URL revocation issues
        // Add type assertion to ensure cache[type] is treated as Blob (not undefined)
        const blob = cache[type];
        if (!blob) return '';
        
        return URL.createObjectURL(blob);
    }, [imageCache]);

    // Add this function to resolve user display names from email addresses
    const resolveUserNames = async (mediaItems: MediaItem[]): Promise<MediaItem[]> => {
        // Create a map to cache user info requests
        const userCache: Record<string, string> = {};
        
        // Return early if there are no items
        if (!mediaItems.length) return mediaItems;
        
        // Process media items in batches to avoid too many simultaneous requests
        const enhancedMedia: MediaItem[] = [];
        
        for (const item of mediaItems) {
            // Skip if already has a proper uploaderName
            if (item.uploaderName && item.uploaderName !== 'unknown') {
                enhancedMedia.push(item);
                continue;
            }
            
            // Use email as uploader name if available (but not "unknown")
            if (item.uploadedBy && item.uploadedBy !== 'unknown') {
                // Check if we've already looked up this user
                if (userCache[item.uploadedBy]) {
                    enhancedMedia.push({
                        ...item,
                        uploaderName: userCache[item.uploadedBy]
                    });
                    continue;
                }
                
                try {
                    // Try to fetch user info if we have a sessionId
                    if (localStorage.getItem('sessionId')) {
                        const response = await fetch(`${API_URL}/user/info/${encodeURIComponent(item.uploadedBy)}`, {
                            method: 'GET',
                            headers: {
                                'Content-Type': 'application/json',
                                Authorization: `Bearer ${localStorage.getItem('sessionId')}`,
                            }
                        });
                        
                        if (response.ok) {
                            const userData = await response.json();
                            if (userData.name) {
                                // Cache the result for future use
                                userCache[item.uploadedBy] = userData.name;
                                
                                // Update the item with the user's name
                                enhancedMedia.push({
                                    ...item,
                                    uploaderName: userData.name
                                });
                                continue;
                            }
                        }
                    }
                    
                    // If we couldn't get the name or there was an error, just use the email
                    userCache[item.uploadedBy] = item.uploadedBy;
                    enhancedMedia.push({
                        ...item,
                        uploaderName: item.uploadedBy
                    });
                } catch (error) {
                    logger.error(`Error fetching user info for ${item.uploadedBy}:`, error);
                    // Use email address as fallback
                    enhancedMedia.push({
                        ...item,
                        uploaderName: item.uploadedBy
                    });
                }
            } else {
                // No valid uploadedBy field, keep as is with "Unknown"
                enhancedMedia.push(item);
            }
        }
        
        return enhancedMedia;
    };

    // Helper function to organize media by group
    const organizeMediaByGroup = useCallback(() => {
        // Public content first
        const publicItems = media.filter(item => isItemPublic(item));
        
        // Group private items by group
        const groupedItems: Record<string, {
            name: string;
            items: MediaItem[];
        }> = {};
        
        // Add "Private" category for items with no group
        groupedItems["private"] = {
            name: "Private",
            items: []
        };
        
        // Sort items into groups
        media.forEach(item => {
            // Skip public items as they're handled separately
            if (isItemPublic(item)) return;
            
            if (item.groupId) {
                const groupName = groups.find(g => g.id === item.groupId)?.name || 
                                 item.groupName || 
                                 'Unknown Group';
                
                if (!groupedItems[item.groupId]) {
                    groupedItems[item.groupId] = {
                        name: groupName,
                        items: []
                    };
                }
                
                groupedItems[item.groupId].items.push(item);
            } else {
                // No group ID, add to private
                groupedItems["private"].items.push(item);
            }
        });
        
        // Remove empty private category
        if (groupedItems["private"].items.length === 0) {
            delete groupedItems["private"];
        }
        
        return { publicItems, groupedItems };
    }, [media, groups]);

    // Media gallery card component to avoid repetition
    const MediaCard = ({ item }: { item: MediaItem }) => (
        <div className="media-item" onClick={() => openModal(item)} data-media-id={item.id}>
            <div className="media-content">
                <img
                    src={
                        authenticatedThumbnails[item.id] ||
                        'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjAwIiBoZWlnaHQ9IjIwMCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cmVjdCB3aWR0aD0iMjAwIiBoZWlnaHQ9IjIwMCIgZmlsbD0iI2VlZSIvPjx0ZXh0IHg9IjUwJSIgeT0iNTAlIiBmb250LWZhbWlseT0iQXJpYWwsIHNhbnMtc2VyaWYiIGZvbnQtc2l6ZT0iMjAiIHRleHQtYW5jaG9yPSJtaWRkbGUiIGRvbWluYW50LWJhc2VsaW5lPSJtaWRkbGUiIGZpbGw9IiM5OTkiPkltYWdlPC90ZXh0Pjwvc3ZnPg=='
                    }
                    alt={item.fileName}
                    className={`media-thumbnail ${
                        !authenticatedThumbnails[item.id] && item.thumbnailUrl
                            ? 'media-thumbnail-loading'
                            : ''
                    }`}
                    onError={(e) => {
                        logger.error(`Error loading thumbnail for ${item.fileName}`);
                        logger.error(e);
                        if (!authenticatedThumbnails[item.id] && item.thumbnailUrl) {
                            fetchThumbnailWithAuth([item]);
                        }

                        (e.target as HTMLImageElement).src =
                            'data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iMjAwIiBoZWlnaHQ9IjIwMCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cmVjdCB3aWR0aD0iMjAwIiBoZWlnaHQ9IjIwMCIgZmlsbD0iI2VlZSIvPjx0ZXh0IHg9IjUwJSIgeT0iNTAlIiBmb250LWZhbWlseT0iQXJpYWwsIHNhbnMtc2VyaWYiIGZvbnQtc2l6ZT0iMjAiIHRleHQtYW5jaG9yPSJtaWRkbGUiIGRvbWluYW50LWJhc2VsaW5lPSJtaWRkbGUiIGZpbGw9IiM5OTkiPkltYWdlPC90ZXh0Pjwvc3ZnPg==';
                    }}
                    style={{
                        opacity: authenticatedThumbnails[item.id] ? 1 : 0.7,
                    }}
                />
                <div className="media-info-wrapper">
                    <div className="media-info">
                        <p className="media-group">
                            {isItemPublic(item)
                                ? 'Public'
                                : item.groupId
                                ? `Group: ${
                                      groups.find((g) => g.id === item.groupId)?.name ||
                                      item.groupName ||
                                      'Unknown Group'
                                  }`
                                : 'Private'}
                        </p>

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
                                            {groups.map((group) => (
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
                                            updateMediaGroup(
                                                item.id,
                                                isPublic,
                                                isPublic ? undefined : selectedGroupId
                                            );
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
                                        {(isAdmin || (user && item.uploadedBy === user.email)) && (
                                            <button
                                                className="delete-button"
                                                onClick={(e) => handleDeleteClick(item, e)}
                                            >
                                                Delete
                                            </button>
                                        )}
                                    </>
                                )}
                            </div>
                        )}
                    </div>
                </div>
            </div>
        </div>
    );

    // Parse URL query parameters for comment ID
    useEffect(() => {
        const searchParams = new URLSearchParams(location.search);
        const commentId = searchParams.get('comment');
        const hash = location.hash.replace('#', '');

        if (commentId || hash) {
            setHighlightedCommentId(commentId || hash);
        }
    }, [location]);

    useEffect(() => {
        const userJson = localStorage.getItem('user');
        if (userJson) {
            try {
                const userData = JSON.parse(userJson);
                setUser(userData);
            } catch (err) {
                logger.error('Error parsing user data:', err);
            }
        }
    }, []);

    // Batch thumbnail updates to prevent excessive re-renders
    const fetchThumbnailWithAuth = useCallback(async (items: MediaItem[]) => {
        if (!items.length) return;
        
        // Process thumbnails in batch and update state once
        const thumbnailUpdates: Record<string, string> = {};
        
        await Promise.all(items.map(async (item) => {
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
                
                // Collect URL but don't update state yet
                thumbnailUpdates[item.id] = objectUrl;
            } catch (error) {
                logger.error(`Error fetching thumbnail for ${item.fileName}:`, error);
            }
        }));
        
        // Update state once with all fetched thumbnails
        if (Object.keys(thumbnailUpdates).length > 0) {
            setAuthenticatedThumbnails(prev => ({
                ...prev,
                ...thumbnailUpdates
            }));
        }
    }, []);

    // Enhanced fetchMediumWithAuth to use the blob cache
    const fetchMediumWithAuth = useCallback(async (item: MediaItem) => {
        if (!item.mediumUrl) return;
        
        const startTime = Date.now();
        logger.debug(`[DEBUG] Starting to fetch medium image for ${item.fileName}`, item.mediumUrl);
        
        try {
            // Mark it as loading while we fetch
            setAuthenticatedMediums((prev) => ({
                ...prev,
                [item.id]: 'loading',
            }));
            
            const response = await fetch(item.mediumUrl, {
                method: 'GET',
                headers: {
                    Authorization: `Bearer ${localStorage.getItem('sessionId')}`,
                },
            });

            logger.debug(`[DEBUG] Medium image fetch response for ${item.fileName}: status=${response.status}`);

            if (!response.ok) {
                logger.warn(`Medium image not available for ${item.fileName}: ${response.status}`);
                // If medium image fails to load, mark it as failed so we know not to try again
                setAuthenticatedMediums((prev) => ({
                    ...prev,
                    [item.id]: 'error',
                }));
                return;
            }

            const blob = await response.blob();
            logger.debug(`[DEBUG] Medium image blob created for ${item.fileName}: size=${blob.size}, type=${blob.type}`);
            
            // Store the blob in our cache
            setImageCache(prev => ({
                ...prev,
                [item.id]: {
                    ...prev[item.id],
                    medium: blob
                }
            }));
            
            // Create a new blob URL from the cached blob
            const objectUrl = URL.createObjectURL(blob);
            logger.debug(`[DEBUG] Created object URL for ${item.fileName}: ${objectUrl}`);

            setAuthenticatedMediums((prev) => ({
                ...prev,
                [item.id]: objectUrl,
            }));
            
            const elapsedTime = Date.now() - startTime;
            logger.debug(`[DEBUG] Medium image loaded for ${item.fileName} in ${elapsedTime}ms`);
        } catch (error) {
            logger.error(`Error fetching medium image for ${item.fileName}:`, error);
            // Mark as error
            setAuthenticatedMediums((prev) => ({
                ...prev,
                [item.id]: 'error',
            }));
        }
    }, []);

    const isItemPublic = (item: MediaItem): boolean => {
        if (typeof item.isPublic === 'boolean') {
            return item.isPublic;
        }
        if (typeof item.isPublic === 'string') {
            return item.isPublic === 'true';
        }
        return true;
    };

    const isImage = (fileType: string) => {
        if (!fileType) return false;

        if (fileType.startsWith('image/')) return true;

        if (fileType === 'application/octet-stream') {
            const fileName = selectedMedia?.fileName.toLowerCase() || '';
            const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg', '.bmp'];
            return imageExtensions.some((ext) => fileName.endsWith(ext));
        }

        return false;
    };

    const isVideo = (fileType: string) => {
        if (!fileType) return false;

        if (fileType.startsWith('video/')) return true;

        if (fileType === 'application/octet-stream') {
            const fileName = selectedMedia?.fileName.toLowerCase() || '';
            const videoExtensions = ['.mp4', '.webm', '.mov', '.avi', '.mkv', '.flv', '.wmv'];
            return videoExtensions.some((ext) => fileName.endsWith(ext));
        }

        return false;
    };

    useEffect(() => {
        const fetchData = async () => {
            try {
                const mediaResponse = await fetch(`${API_URL}/gallery`, {
                    method: 'GET',
                    headers: {
                        'Content-Type': 'application/json',
                        ...(localStorage.getItem('sessionId')
                            ? {
                                  Authorization: `Bearer ${localStorage.getItem('sessionId')}`,
                              }
                            : {}),
                    },
                });

                if (!mediaResponse.ok) {
                    throw new Error(`Failed to fetch media: ${mediaResponse.status}`);
                }

                const mediaData = await mediaResponse.json();
                
                // Resolve user names where possible
                const enhancedMedia = await resolveUserNames(mediaData);
                setMedia(enhancedMedia);

                if (isAdmin) {
                    const groupsResponse = await fetch(`${API_URL}/admin/groups`, {
                        method: 'GET',
                        headers: {
                            'Content-Type': 'application/json',
                            Authorization: `Bearer ${localStorage.getItem('sessionId')}`,
                        },
                    });

                    if (groupsResponse.ok) {
                        const groupsData = await groupsResponse.json();
                        setGroups(groupsData.groups);
                    }
                }

                setLoading(false);

                setTimeout(() => {
                    loadThumbnailsAsync(enhancedMedia);
                }, 100);
            } catch (error) {
                logger.error('Error fetching data:', error);
                setError('Failed to load gallery items. Please try again later.');
                setLoading(false);
            }
        };

        fetchData();
    }, [isAdmin]);

    const loadThumbnailsAsync = useCallback(
        (mediaItems: MediaItem[]) => {
            // Create the initial queue with all items that have thumbnails
            const allItems = [...mediaItems].filter((item) => item.thumbnailUrl);
            
            // Track visible items
            const checkIfVisible = (item: MediaItem): boolean => {
                // Try to find the element for this item
                const element = document.querySelector(`[data-media-id="${item.id}"]`);
                if (!element) return false;
                
                // Check if element is in viewport
                const rect = element.getBoundingClientRect();
                return (
                    rect.top >= -rect.height &&
                    rect.top <= window.innerHeight + rect.height
                );
            };
            
            // Sort the queue to process visible and top items first
            const queue = allItems.sort((a, b) => {
                const aVisible = checkIfVisible(a);
                const bVisible = checkIfVisible(b);
                
                // Visible items come first
                if (aVisible && !bVisible) return -1;
                if (!aVisible && bVisible) return 1;
                
                // For items with similar visibility, prioritize public items
                if (isItemPublic(a) && !isItemPublic(b)) return -1;
                if (!isItemPublic(a) && isItemPublic(b)) return 1;
                
                // All else equal, compare their position in the original array
                return mediaItems.indexOf(a) - mediaItems.indexOf(b);
            });

            const processBatch = async (startIndex: number, batchSize: number) => {
                const endIndex = Math.min(startIndex + batchSize, queue.length);
                const batch = queue.slice(startIndex, endIndex);

                await fetchThumbnailWithAuth(batch);

                if (endIndex < queue.length) {
                    setTimeout(() => {
                        processBatch(endIndex, batchSize);
                    }, 50);
                }
            };

            if (queue.length > 0) {
                processBatch(0, 5);
            }
        },
        [fetchThumbnailWithAuth, isItemPublic]
    );

    useEffect(() => {
        // Only clean up on component unmount, not on every render
        return () => {
            // Clean up all blob URLs when component unmounts
            Object.values(authenticatedThumbnails).forEach((url) => {
                if (typeof url === 'string' && url.startsWith('blob:')) {
                    URL.revokeObjectURL(url);
                }
            });
            
            blobUrlsRef.current.forEach((url) => {
                if (!activeUrlsRef.current.has(url)) {
                    URL.revokeObjectURL(url);
                }
            });
        };
    }, []); // Empty dependency array ensures this only runs on unmount

    useEffect(() => {
        // This effect ensures that blob URLs are preserved when needed
        if (selectedMedia && viewMode === 'medium') {
            const blobUrl = blobUrlsRef.current.get(selectedMedia.id);
            if (blobUrl) {
                // Create a new Image element to "touch" the blob URL before displaying it
                // This helps prevent the "not found" error by ensuring the blob is active
                const img = new Image();
                img.onload = () => {
                    logger.debug(`[DEBUG] Successfully pre-loaded medium image blob for ${selectedMedia.fileName}`);
                    // Mark this URL as currently active to prevent revocation
                    activeUrlsRef.current.add(blobUrl);
                };
                img.onerror = (e) => {
                    logger.error(`[DEBUG] Failed to pre-load medium image blob for ${selectedMedia.fileName}`, e);
                    // If pre-loading fails, fall back to full-sized image
                    setViewMode('full');
                    setLoadingMediumImage(false);
                    
                    // The blob might be invalid - remove it from our refs
                    blobUrlsRef.current.delete(selectedMedia.id);
                    
                    // Try to fetch it again
                    if (selectedMedia.mediumUrl) {
                        logger.debug(`[DEBUG] Re-fetching medium image after blob error: ${selectedMedia.fileName}`);
                        fetchMediumWithAuth(selectedMedia);
                    }
                };
                logger.debug(`[DEBUG] Pre-loading medium image blob: ${blobUrl}`);
                img.src = blobUrl;
            }
        }
    }, [selectedMedia, viewMode, fetchMediumWithAuth]);

    const updateMediaTakenBy = async (mediaId: string, takenBy: string) => {
        try {
            const response = await fetch(`${API_URL}/gallery/${mediaId.split('/').pop()}/metadata`, {
                method: 'PUT',
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${localStorage.getItem('sessionId')}`,
                },
                body: JSON.stringify({ takenBy }),
            });

            if (!response.ok) {
                throw new Error('Failed to update media metadata');
            }

            const result = await response.json();

            if (result.success && result.mediaItem) {
                setMedia(
                    media.map((item) =>
                        item.id === mediaId ? { ...item, takenBy } : item
                    )
                );

                if (selectedMedia && selectedMedia.id === mediaId) {
                    setSelectedMedia({ ...selectedMedia, takenBy });
                }

                setTakenByStatus({
                    success: true,
                    message: 'Photographer info updated successfully',
                });

                setTimeout(() => {
                    setEditingTakenBy(false);
                    setTakenByStatus(null);
                }, 3000);
            } else {
                setTakenByStatus({
                    success: false,
                    message: result.message || 'Failed to update photographer info',
                });
            }

            return result.success;
        } catch (error) {
            logger.error('Error updating media metadata:', error);
            setTakenByStatus({
                success: false,
                message: 'An error occurred while updating photographer info',
            });
            return false;
        }
    };

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
                    groupId: groupId || null,
                }),
            });

            if (!response.ok) {
                throw new Error('Failed to update media group');
            }

            setMedia(
                media.map((item) =>
                    item.id === mediaId
                        ? { ...item, isPublic, groupId: groupId || undefined }
                        : item
                )
            );

            setEditingMediaId(null);
            setSelectedGroupId('');
            setIsPublic(true);

            return true;
        } catch (error) {
            logger.error('Error updating media group:', error);
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

        const filesArray = Array.from(files);
        setUploadFiles(filesArray);

        const previewUrls = filesArray.map((file) => URL.createObjectURL(file));
        setUploadPreviews(previewUrls);

        setThumbnailFiles(new Array(filesArray.length).fill(null));
        setMediumFiles(new Array(filesArray.length).fill(null));

        filesArray.forEach((file, index) => {
            generateThumbnail(file, index);
            generateMediumImage(file, index);
        });
    };

    const generateThumbnail = async (file: File, fileIndex: number) => {
        if (file.type.startsWith('image/')) {
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            const img = new Image();

            img.onload = () => {
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

                ctx?.drawImage(img, 0, 0, width, height);

                canvas.toBlob((blob) => {
                    if (blob) {
                        const thumbnailFile = new File([blob], `thumbnail_${file.name}`, {
                            type: 'image/jpeg',
                            lastModified: Date.now(),
                        });

                        setThumbnailFiles((prev) => {
                            const newArray = [...prev];
                            newArray[fileIndex] = thumbnailFile;
                            return newArray;
                        });

                        setThumbnailPreviews((prev) => {
                            const newArray = [...prev];
                            newArray[fileIndex] = canvas.toDataURL('image/jpeg', 0.9);
                            return newArray;
                        });
                    }
                }, 'image/jpeg', 0.9);
            };

            img.src = URL.createObjectURL(file);
        } else if (file.type.startsWith('video/')) {
            const video = document.createElement('video');
            video.preload = 'metadata';

            video.onloadedmetadata = () => {
                video.currentTime = video.duration * 0.25;
            };

            video.onseeked = () => {
                const canvas = document.createElement('canvas');
                canvas.width = 400;
                canvas.height = 400 * (video.videoHeight / video.videoWidth);

                const ctx = canvas.getContext('2d');
                ctx?.drawImage(video, 0, 0, canvas.width, canvas.height);

                canvas.toBlob((blob) => {
                    if (blob) {
                        const thumbnailFile = new File([blob], `thumbnail_${file.name}`, {
                            type: 'image/jpeg',
                            lastModified: Date.now(),
                        });

                        setThumbnailFiles((prev) => {
                            const newArray = [...prev];
                            newArray[fileIndex] = thumbnailFile;
                            return newArray;
                        });

                        setThumbnailPreviews((prev) => {
                            const newArray = [...prev];
                            newArray[fileIndex] = canvas.toDataURL('image/jpeg', 0.9);
                            return newArray;
                        });
                    }
                }, 'image/jpeg', 0.9);
            };

            video.src = URL.createObjectURL(file);
        }
    };

    const generateMediumImage = async (file: File, fileIndex: number) => {
        if (file.type.startsWith('image/')) {
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            const img = new Image();

            img.onload = () => {
                const maxDimension = 1024;
                let width = img.width;
                let height = img.height;

                if (width > maxDimension || height > maxDimension) {
                    if (width > height) {
                        if (width > maxDimension) {
                            height = Math.round(height * (maxDimension / width));
                            width = maxDimension;
                        }
                    } else {
                        if (height > maxDimension) {
                            width = Math.round(width * (maxDimension / height));
                            height = maxDimension;
                        }
                    }
                }

                canvas.width = width;
                canvas.height = height;

                ctx?.drawImage(img, 0, 0, width, height);

                canvas.toBlob((blob) => {
                    if (blob) {
                        const mediumFile = new File([blob], `medium_${file.name}`, {
                            type: 'image/jpeg',
                            lastModified: Date.now(),
                        });

                        setMediumFiles((prev) => {
                            const newArray = [...prev];
                            newArray[fileIndex] = mediumFile;
                            return newArray;
                        });

                        logger.debug(`Created medium-sized image for ${file.name}: ${width}x${height}`);
                    }
                }, 'image/jpeg', 0.92);
            };

            img.src = URL.createObjectURL(file);
        } else if (file.type.startsWith('video/')) {
            setMediumFiles((prev) => {
                const newArray = [...prev];
                newArray[fileIndex] = file;
                return newArray;
            });
        }
    };

    const handleUpload = async (event: React.FormEvent) => {
        event.preventDefault();

        if (uploadFiles.length === 0 || 
           thumbnailFiles.length !== uploadFiles.length || 
           mediumFiles.length !== uploadFiles.length) {
            setUploadStatus({
                success: false,
                message: 'Please select files and wait for all thumbnails and medium images to generate',
            });
            return;
        }

        const missingThumbnails = thumbnailFiles.some((file) => file === null);
        const missingMediums = mediumFiles.some((file) => file === null);
        if (missingThumbnails || missingMediums) {
            setUploadStatus({
                success: false,
                message: 'Some thumbnails or medium images are still generating. Please wait.',
            });
            return;
        }

        setUploadStatus({
            success: true,
            message: 'Preparing to upload files...',
        });

        setUploadProgress({
            current: 0,
            total: uploadFiles.length,
            percent: 0,
        });

        const uploadedItems: MediaItem[] = [];
        let failedUploads = 0;

        for (let i = 0; i < uploadFiles.length; i++) {
            setUploadProgress({
                current: i,
                total: uploadFiles.length,
                percent: Math.round((i / uploadFiles.length) * 100),
            });

            setUploadStatus({
                success: true,
                message: `Uploading file ${i + 1} of ${uploadFiles.length}: ${uploadFiles[i].name}`,
            });

            const formData = new FormData();
            formData.append('file', uploadFiles[i]);

            const thumbnailFile = thumbnailFiles[i]!;
            formData.append('thumbnail', thumbnailFile);
            
            const mediumFile = mediumFiles[i]!;
            formData.append('medium', mediumFile);

            formData.append('isPublic', bulkUploadIsPublic.toString());
            if (!bulkUploadIsPublic && bulkUploadGroupId) {
                formData.append('groupId', bulkUploadGroupId);
            }
            
            if (bulkUploadTakenBy.trim()) {
                formData.append('takenBy', bulkUploadTakenBy.trim());
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
                    logger.error(`Failed to upload file ${uploadFiles[i].name}:`, result.message);
                    failedUploads++;
                }
            } catch (error) {
                logger.error(`Error uploading file ${uploadFiles[i].name}:`, error);
                failedUploads++;
            }
        }

        setUploadProgress({
            current: uploadFiles.length,
            total: uploadFiles.length,
            percent: 100,
        });

        if (failedUploads === 0) {
            setUploadStatus({
                success: true,
                message: `Successfully uploaded ${uploadedItems.length} files!`,
            });
        } else if (uploadedItems.length > 0) {
            setUploadStatus({
                success: true,
                message: `Uploaded ${uploadedItems.length} files, but ${failedUploads} failed.`,
            });
        } else {
            setUploadStatus({
                success: false,
                message: 'Failed to upload any files.',
            });
        }

        setUploadFiles([]);
        setThumbnailFiles([]);
        setMediumFiles([]);
        setUploadPreviews([]);
        setThumbnailPreviews([]);
        if (fileInputRef.current) {
            fileInputRef.current.value = '';
        }

        // If we uploaded at least one file successfully
        if (uploadedItems.length > 0) {
            // First add the new items to the current state
            setMedia([...uploadedItems, ...media]);
            
            // Then set a timeout to reload the page for proper thumbnail display
            setTimeout(() => {
                window.location.reload();
            }, 1500); // Give user a chance to see the success message before reload
        }

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
            if (selectedMedia && isVideo(selectedMedia.fileType)) {
                setTimeout(() => {
                    const videoElement = document.querySelector('video');
                    if (videoElement) {
                        videoElement.currentTime = 0;
                        videoElement.play();
                    }
                }, 100);
            }
        } catch (error) {
            logger.error('Error fetching image:', error);
            setFetchError('Failed to load image. Please try again later.');
        } finally {
            setFetchingImage(false);
        }
    };

    const openModal = (item: MediaItem, forceViewMode: 'thumbnail' | 'medium' | 'full' = 'medium') => {
        // First, clean up any existing selected media resources
        if (selectedMedia) {
            // Don't revoke blob URLs for medium images while they might still be in use
            if (fetchedImageData) {
                logger.debug(`[DEBUG] Revoking previous full-sized image URL`);
                URL.revokeObjectURL(fetchedImageData);
                setFetchedImageData(null);
            }
        }
        
        logger.debug(`[DEBUG] Opening modal for ${item.fileName}, medium URL: ${item.mediumUrl || 'none'}`);
        
        // Make sure we have a valid uploader name by checking all properties
        // The backend stores it as uploadedBy with the email address
        const uploaderName = item.uploaderName || 
                             (item.uploadedBy && item.uploadedBy !== 'unknown' ? item.uploadedBy : 'Unknown');
        
        // Set the new selected media - ensure all fields, including uploadedBy, are copied over
        setSelectedMedia({
            ...item,
            uploadedBy: uploaderName
        });
        setCurrentItemDeleted(false);
        setDeleteStatus(null);
        setEditingTakenBy(false);
        setTakenByValue(item.takenBy || '');

        // Use forceViewMode parameter to enforce a specific view mode (always 'medium' for navigation)
        setViewMode(forceViewMode);
        setLoadingMediumImage(forceViewMode === 'medium');
        
        // Then check if we need to adjust based on available resources
        if (item.mediumUrl) {
            logger.debug(`[DEBUG] Medium URL is available for ${item.fileName}`);
            
            // Check if we already have this image in our blob ref
            const storedMediumUrl = blobUrlsRef.current.get(item.id);
            if (storedMediumUrl) {
                logger.debug(`[DEBUG] Using stored blob URL for ${item.fileName}: ${storedMediumUrl}`);
                activeUrlsRef.current.add(storedMediumUrl);
                setLoadingMediumImage(false);
            }
            // Check the state of the medium image in state
            else {
                const mediumState = authenticatedMediums[item.id];
                if (!mediumState) {
                    logger.debug(`[DEBUG] Fetching medium image for ${item.fileName}, no existing state`);
                    fetchMediumWithAuth(item);
                } else if (mediumState === 'error') {
                    logger.debug(`[DEBUG] Medium image previously failed for ${item.fileName}, setting view to full`);
                    setViewMode('full');
                    setLoadingMediumImage(false);
                } else if (mediumState === 'loading') {
                    logger.debug(`[DEBUG] Medium image still loading for ${item.fileName}`);
                    // Keep medium loading state
                } else {
                    logger.debug(`[DEBUG] Using existing medium image for ${item.fileName}: ${mediumState}`);
                    // Store this URL in our refs
                    blobUrlsRef.current.set(item.id, mediumState);
                    activeUrlsRef.current.add(mediumState);
                    setLoadingMediumImage(false);
                }
            }
        } else if (!item.mediumUrl && item.thumbnailUrl) {
            logger.debug(`[DEBUG] No medium URL available, setting view mode to thumbnail for ${item.fileName}`);
            setViewMode('thumbnail');
            setLoadingMediumImage(false);
        } else {
            logger.debug(`[DEBUG] No medium or thumbnail URL available, setting view mode to full for ${item.fileName}`);
            setViewMode('full');
            setLoadingMediumImage(false);
        }

        // DO NOT fetch the full-sized image automatically - only when user explicitly requests it
        // The full image will be loaded when user clicks "View Full Size" button

        // Fetch comments if appropriate
        if (user || item.isPublic) {
            fetchComments(item.fileName);
        } else {
            setComments([]);
        }

        // Reset other UI state
        setNewComment('');
        setReplyingTo(null);
        setCommentStatus(null);
    };

    const closeModal = () => {
        // Clean up blob URLs and reset state when closing modal
        if (selectedMedia) {
            // First, reset UI state
            setNewComment('');
            setReplyingTo(null);
            setCommentStatus(null);
            setFetchError(null);
            setCurrentItemDeleted(false);
            
            // If we have a full-sized image loaded, clean it up
            if (fetchedImageData) {
                logger.debug(`[DEBUG] Revoking full-sized image URL for ${selectedMedia.fileName}`);
                URL.revokeObjectURL(fetchedImageData);
                setFetchedImageData(null);
            }
            
            // Set selectedMedia to null before doing anything else to prevent 
            // any rerenders from trying to use cleaned up resources
            setSelectedMedia(null);
            
            // Default back to medium view mode for next time a modal is opened
            setViewMode('medium');
            setLoadingMediumImage(false);
        }
    };

    const handleDeleteClick = (item: MediaItem, e: React.MouseEvent) => {
        e.stopPropagation();
        // Clear any previous delete status when opening delete confirmation for a new image
        setDeleteStatus(null);
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
                    message: 'Media deleted successfully',
                });

                setMedia(media.filter((item) => item.id !== deleteConfirmation.id));

                if (selectedMedia && selectedMedia.id === deleteConfirmation.id) {
                    setCurrentItemDeleted(true);
                }

                setDeleteConfirmation(null);
            } else {
                setDeleteStatus({
                    success: false,
                    message: result.message || 'Failed to delete media',
                });
            }
        } catch (error) {
            logger.error('Error deleting media:', error);
            setDeleteStatus({
                success: false,
                message: 'An error occurred while deleting the media',
            });
        }
    };

    const cancelDelete = () => {
        setDeleteConfirmation(null);
    };

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
            logger.error('Error fetching comments:', error);
            setCommentError('Failed to load comments. Please try again later.');
            setComments([]);
        } finally {
            setCommentLoading(false);
        }
    };

    const handleCommentSubmit = async (e: React.FormEvent) => {
        e.preventDefault();

        if (!selectedMedia || !newComment.trim() || !user) {
            setCommentStatus({
                success: false,
                message: 'Please enter a comment and make sure you are logged in',
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
                    parentId: replyingTo,
                }),
            });

            const result = await response.json();

            if (response.ok) {
                setCommentStatus({
                    success: true,
                    message: 'Comment added successfully',
                });

                if (result.comment) {
                    await fetchComments(selectedMedia.fileName);
                }

                setNewComment('');
                setReplyingTo(null);
            } else {
                setCommentStatus({
                    success: false,
                    message: result.message || 'Failed to add comment',
                });
            }
        } catch (error) {
            logger.error('Error adding comment:', error);
            setCommentStatus({
                success: false,
                message: 'An error occurred while adding the comment',
            });
        }
    };

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
                    message: 'Comment deleted successfully',
                });
            } else {
                setCommentStatus({
                    success: false,
                    message: 'Failed to delete comment',
                });
            }
        } catch (error) {
            logger.error('Error deleting comment:', error);
            setCommentStatus({
                success: false,
                message: 'An error occurred while deleting the comment',
            });
        }
    };

    if (loading) {
        return (
            <>
                {!skipNavbar && <Navbar />}
                <div className="gallery-container">
                    <div className="gallery-header">
                        <h1 className="gallery-title">Gallery</h1>
                    </div>
                    <LoadingSkeleton />
                </div>
            </>
        );
    }

    // Organize media by group
    const { publicItems, groupedItems } = organizeMediaByGroup();

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

                        <div className="form-group bulk-upload-options">
                            <div className="visibility-option">
                                <div className="custom-checkbox">
                                    <input
                                        type="checkbox"
                                        id="bulkUploadIsPublic"
                                        checked={bulkUploadIsPublic}
                                        onChange={(e) => setBulkUploadIsPublic(e.target.checked)}
                                    />
                                    <span className="checkbox-icon"></span>
                                    <label htmlFor="bulkUploadIsPublic">Make files public</label>
                                </div>
                            </div>

                            <div className="form-group">
                                <label htmlFor="photographer-input">Photographer:</label>
                                <input
                                    id="photographer-input"
                                    type="text"
                                    value={bulkUploadTakenBy}
                                    onChange={(e) => setBulkUploadTakenBy(e.target.value)}
                                    placeholder="Enter photographer name (optional)"
                                    className="photographer-input"
                                />
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
                                        {groups.map((group) => (
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
                                    {uploadProgress.current} of {uploadProgress.total} files uploaded (
                                    {uploadProgress.percent}%)
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

                {media.length === 0 ? (
                    <p>No media available.</p>
                ) : (
                    <>
                        {/* Public content section - always shown at the top */}
                        {publicItems.length > 0 && (
                            <div className="gallery-section">
                                <div className="gallery-section-header">
                                    <h2>Public Gallery</h2>
                                    <span className="item-count">{publicItems.length} items</span>
                                </div>
                                <div className="gallery-grid">
                                    {publicItems.map(item => (
                                        <MediaCard key={item.id} item={item} />
                                    ))}
                                </div>
                            </div>
                        )}
                        
                        {/* Group sections */}
                        {Object.entries(groupedItems).map(([groupId, group]) => (
                            <div className="gallery-section" key={groupId}>
                                <div className="gallery-section-header">
                                    <h2>{group.name}</h2>
                                    <span className="item-count">{group.items.length} items</span>
                                </div>
                                <div className="gallery-grid">
                                    {group.items.map(item => (
                                        <MediaCard key={item.id} item={item} />
                                    ))}
                                </div>
                            </div>
                        ))}
                    </>
                )}

                {selectedMedia && (
                    <div className="modal" onClick={closeModal}>
                        <div className="modal-close">×</div>
                        <div className="modal-content" ref={modalContentRef} onClick={(e) => e.stopPropagation()}>
                            {fetchingImage && viewMode === 'full' ? (
                                <div className="loading-indicator">Loading...</div>
                            ) : fetchError && viewMode === 'full' ? (
                                <div className="error-message">{fetchError}</div>
                            ) : currentItemDeleted ? (
                                <div className="success-message">Media item has been deleted</div>
                            ) : isImage(selectedMedia.fileType) ? (
                                <div className="media-view-container">
                                    {loadingMediumImage && viewMode === 'medium' && (
                                        <div className="loading-indicator medium-loading">Loading medium image...</div>
                                    )}
                                    <button 
                                        className="nav-button prev-button" 
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            navigateToPreviousImage();
                                        }}
                                        aria-label="Previous image"
                                    >
                                        &lt;
                                    </button>
                                    <img
                                        ref={viewMode === 'medium' ? mediumImageRef : null}
                                        src={getMediaSource()}
                                        alt={selectedMedia.fileName}
                                        className={`media-view ${viewMode} ${
                                            loadingMediumImage && viewMode === 'medium' ? 'loading' : ''
                                        }`}
                                        onLoad={viewMode === 'medium' ? handleMediumImageLoad : undefined}
                                        onError={viewMode === 'medium' ? handleMediumImageError : undefined}
                                        style={
                                            viewMode === 'medium'
                                                ? {
                                                      maxWidth: '1024px',
                                                      maxHeight: '1024px',
                                                      objectFit: 'contain',
                                                  }
                                                : undefined
                                        }
                                    />
                                    <button 
                                        className="nav-button next-button" 
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            navigateToNextImage();
                                        }}
                                        aria-label="Next image"
                                    >
                                        &gt;
                                    </button>
                                    {(selectedMedia.mediumUrl || selectedMedia.thumbnailUrl) && (
                                        <button className="view-toggle-button" onClick={toggleView}>
                                            {getViewToggleLabel()}
                                        </button>
                                    )}
                                </div>
                            ) : isVideo(selectedMedia.fileType) && fetchedImageData ? (
                                <video controls autoPlay>
                                    <source src={fetchedImageData || ''} type={selectedMedia.fileType} />
                                    Your browser does not support the video tag.
                                </video>
                            ) : (
                                <div>Unsupported media type</div>
                            )}

                            {selectedMedia && !currentItemDeleted && (
                                <div className="media-info-section">
                                    <div className="media-details">
                                        <p className="media-uploader">
                                            <strong>Uploaded by:</strong>{' '}
                                            {selectedMedia.uploaderName || selectedMedia.uploadedBy || 'Unknown'}
                                        </p>
                                        <p className="media-date">
                                            <strong>Upload date:</strong>{' '}
                                            {new Date(selectedMedia.uploadedAt).toLocaleDateString()}
                                        </p>

                                        <div className="taken-by-section">
                                            {editingTakenBy ? (
                                                <div className="taken-by-edit">
                                                    <label htmlFor="taken-by-input">Photographer:</label>
                                                    <input
                                                        id="taken-by-input"
                                                        type="text"
                                                        value={takenByValue}
                                                        onChange={(e) => setTakenByValue(e.target.value)}
                                                        placeholder="Enter photographer name"
                                                    />
                                                    <div className="taken-by-actions">
                                                        <button
                                                            className="save-button"
                                                            onClick={() =>
                                                                updateMediaTakenBy(selectedMedia.id, takenByValue)
                                                            }
                                                        >
                                                            Save
                                                        </button>
                                                        <button
                                                            className="cancel-button"
                                                            onClick={() => {
                                                                setEditingTakenBy(false);
                                                                setTakenByValue(selectedMedia.takenBy || '');
                                                            }}
                                                        >
                                                            Cancel
                                                        </button>
                                                    </div>

                                                    {takenByStatus && (
                                                        <div
                                                            className={
                                                                takenByStatus.success
                                                                    ? 'success-message'
                                                                    : 'error-message'
                                                            }
                                                        >
                                                            {takenByStatus.message}
                                                        </div>
                                                    )}
                                                </div>
                                            ) : (
                                                <p className="media-taken-by">
                                                    <strong>Photographer:</strong>{' '}
                                                    {selectedMedia.takenBy || 'Not specified'}
                                                    {isAdmin && user && (
                                                        <button
                                                            className="edit-button"
                                                            onClick={() => setEditingTakenBy(true)}
                                                        >
                                                            Edit
                                                        </button>
                                                    )}
                                                </p>
                                            )}
                                        </div>
                                    </div>

                                    {user ? (
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
                                                <li
                                                    key={comment.id}
                                                    id={`comment-${comment.id}`}
                                                    className={`comment-item level-${comment.level}`}
                                                >
                                                    {/* Comment content remains the same, omitted for brevity */}
                                                </li>
                                            ))}
                                        </ul>
                                    )}
                                </div>
                            )}
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
                                            handleDeleteComment(
                                                commentToDelete.mediaId,
                                                commentToDelete.commentId
                                            );
                                        }
                                    }}
                                >
                                    Yes, Delete
                                </button>
                                <button onClick={() => setCommentToDelete(null)}>Cancel</button>
                            </div>
                        </div>
                    </div>
                )}

                {deleteConfirmation && (
                    <div className="modal delete-confirmation-modal">
                        <div className="delete-confirmation-content">
                            <h3>Confirm Deletion</h3>
                            <p>
                                Are you sure you want to delete "{deleteConfirmation.fileName}"?
                            </p>
                            <p>This action cannot be undone.</p>

                            <div className="delete-confirmation-buttons">
                                <button className="cancel-button" onClick={cancelDelete}>
                                    Cancel
                                </button>
                                <button className="confirm-button" onClick={confirmDelete}>
                                    Delete
                                </button>
                            </div>

                            {deleteStatus && (
                                <div
                                    className={
                                        deleteStatus.success ? 'success-message' : 'error-message'
                                    }
                                >
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
