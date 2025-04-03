import { API_URL } from '../config';
import React, { useEffect, useState, useRef } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { MediaItem } from '../types';

interface GalleryProps {
    isAdmin?: boolean;
}

const Gallery: React.FC<GalleryProps> = ({ isAdmin = false }) => {
    const [media, setMedia] = useState<MediaItem[]>([]);
    const [loading, setLoading] = useState<boolean>(true);
    const [error, setError] = useState<string | null>(null);
    const [selectedMedia, setSelectedMedia] = useState<MediaItem | null>(null);
    const [showUploadForm, setShowUploadForm] = useState<boolean>(false);
    const [uploadFile, setUploadFile] = useState<File | null>(null);
    const [thumbnailFile, setThumbnailFile] = useState<File | null>(null);
    const [uploadPreview, setUploadPreview] = useState<string | null>(null);
    const [thumbnailPreview, setThumbnailPreview] = useState<string | null>(null);
    const [uploadStatus, setUploadStatus] = useState<{ success: boolean; message: string } | null>(null);
    
    const fileInputRef = useRef<HTMLInputElement>(null);
    const navigate = useNavigate();

    useEffect(() => {
        const fetchMedia = async () => {
            try {
                const response = await fetch(`${API_URL}/gallery`, 
                    {
                        method: 'GET',
                        headers: {
                            'Content-Type': 'application/json',
                            Authorization: `Bearer ${localStorage.getItem('sessionId')}`,
                        },
                    }
                );
                
                if (!response.ok) {
                    throw new Error(`Failed to fetch media: ${response.status}`);
                }
                
                const data = await response.json();
                setMedia(data);
            } catch (error) {
                console.error('Error fetching media:', error);
                setError('Failed to load gallery items. Please try again later.');
            } finally {
                setLoading(false);
            }
        };

        fetchMedia();
    }, []);

    const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        if (!file) return;
        
        setUploadFile(file);
        
        // Create a preview URL for the file
        const previewUrl = URL.createObjectURL(file);
        setUploadPreview(previewUrl);
        
        // Generate a thumbnail for the file
        generateThumbnail(file);
    };
    
    const generateThumbnail = async (file: File) => {
        if (file.type.startsWith('image/')) {
            // For images, create a smaller version
            const canvas = document.createElement('canvas');
            const ctx = canvas.getContext('2d');
            const img = new Image();
            
            img.onload = () => {
                // Calculate thumbnail dimensions (max 200px width/height)
                const maxSize = 200;
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
                
                // Convert canvas to blob
                canvas.toBlob((blob) => {
                    if (blob) {
                        // Create a File object from the blob
                        const thumbnailFile = new File([blob], `thumbnail_${file.name}`, { 
                            type: 'image/jpeg',
                            lastModified: Date.now()
                        });
                        
                        setThumbnailFile(thumbnailFile);
                        setThumbnailPreview(canvas.toDataURL('image/jpeg'));
                    }
                }, 'image/jpeg', 0.8);
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
                canvas.width = 200;
                canvas.height = 200 * (video.videoHeight / video.videoWidth);
                
                const ctx = canvas.getContext('2d');
                ctx?.drawImage(video, 0, 0, canvas.width, canvas.height);
                
                canvas.toBlob((blob) => {
                    if (blob) {
                        const thumbnailFile = new File([blob], `thumbnail_${file.name}`, { 
                            type: 'image/jpeg',
                            lastModified: Date.now()
                        });
                        
                        setThumbnailFile(thumbnailFile);
                        setThumbnailPreview(canvas.toDataURL('image/jpeg'));
                    }
                }, 'image/jpeg', 0.8);
            };
            
            video.src = URL.createObjectURL(file);
        }
    };
    
    const handleUpload = async (event: React.FormEvent) => {
        event.preventDefault();
        
        if (!uploadFile || !thumbnailFile) {
            setUploadStatus({
                success: false,
                message: 'Please select a file and wait for the thumbnail to generate'
            });
            return;
        }
        
        const formData = new FormData();
        formData.append('file', uploadFile);
        formData.append('thumbnail', thumbnailFile);
        
        try {
            const response = await fetch(`${API_URL}/gallery/upload`, {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${localStorage.getItem('sessionId')}`,
                },
                body: formData,
            });
            
            const result = await response.json();
            
            if (response.ok) {
                setUploadStatus({
                    success: true,
                    message: 'File uploaded successfully!'
                });
                
                // Reset form
                setUploadFile(null);
                setThumbnailFile(null);
                setUploadPreview(null);
                setThumbnailPreview(null);
                if (fileInputRef.current) {
                    fileInputRef.current.value = '';
                }
                
                // Add the new media to the list
                if (result.mediaItem) {
                    setMedia([result.mediaItem, ...media]);
                }
                
                // Hide the upload form
                setShowUploadForm(false);
            } else {
                setUploadStatus({
                    success: false,
                    message: result.message || 'Failed to upload file'
                });
            }
        } catch (error) {
            console.error('Error uploading file:', error);
            setUploadStatus({
                success: false,
                message: 'An error occurred while uploading the file'
            });
        }
    };

    const openModal = (item: MediaItem) => {
        setSelectedMedia(item);
    };

    const closeModal = () => {
        setSelectedMedia(null);
    };

    const goToHome = () => {
        navigate('/');
    };

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
            <div className="gallery-container">
                <div className="gallery-header">
                    <h1 className="gallery-title">Gallery</h1>
                    <div className="gallery-nav">
                        <button onClick={goToHome}>Home</button>
                        {isAdmin && (
                            <button onClick={() => setShowUploadForm(!showUploadForm)}>
                                {showUploadForm ? 'Cancel Upload' : 'Upload Media'}
                            </button>
                        )}
                    </div>
                </div>

                {error && <div className="error-message">{error}</div>}

                {showUploadForm && isAdmin && (
                    <form className="upload-form" onSubmit={handleUpload}>
                        <div className="form-group">
                            <label htmlFor="file-upload">Select a file to upload:</label>
                            <input
                                id="file-upload"
                                type="file"
                                accept="image/*,video/*"
                                onChange={handleFileChange}
                                ref={fileInputRef}
                                required
                            />
                        </div>

                        {(uploadPreview || thumbnailPreview) && (
                            <div className="upload-preview">
                                {uploadPreview && (
                                    <div className="preview-container">
                                        <h3>Original</h3>
                                        {uploadFile?.type.startsWith('image/') ? (
                                            <img src={uploadPreview} alt="Upload preview" />
                                        ) : (
                                            <video width="200" controls>
                                                <source src={uploadPreview} type={uploadFile?.type} />
                                                Your browser does not support the video tag.
                                            </video>
                                        )}
                                        <p>{uploadFile?.name}</p>
                                    </div>
                                )}

                                {thumbnailPreview && (
                                    <div className="preview-container">
                                        <h3>Thumbnail</h3>
                                        <img src={thumbnailPreview} alt="Thumbnail preview" />
                                    </div>
                                )}
                            </div>
                        )}

                        {uploadStatus && (
                            <div className={uploadStatus.success ? 'success-message' : 'error-message'}>
                                {uploadStatus.message}
                            </div>
                        )}

                        <button 
                            type="submit" 
                            className="submit-button"
                            disabled={!uploadFile || !thumbnailFile}
                        >
                            Upload
                        </button>
                    </form>
                )}

                <div className="gallery-grid">
                    {media.length === 0 ? (
                        <p>No media available.</p>
                    ) : (
                        media.map(item => (
                            <div key={item.id} className="media-item" onClick={() => openModal(item)}>
                                <img 
                                    src={item.thumbnailUrl || item.url} 
                                    alt={item.fileName}
                                    className="media-thumbnail"
                                />
                                <div className="media-info">
                                    <h3 className="media-name">{item.fileName}</h3>
                                    <p className="media-date">
                                        {new Date(item.uploadedAt).toLocaleDateString()}
                                    </p>
                                </div>
                            </div>
                        ))
                    )}
                </div>

                {selectedMedia && (
                    <div className="modal" onClick={closeModal}>
                        <div className="modal-close">×</div>
                        <div className="modal-content" onClick={e => e.stopPropagation()}>
                            {isImage(selectedMedia.fileType) ? (
                                <img src={selectedMedia.url} alt={selectedMedia.fileName} />
                            ) : isVideo(selectedMedia.fileType) ? (
                                <video controls>
                                    <source src={selectedMedia.url} type={selectedMedia.fileType} />
                                    Your browser does not support the video tag.
                                </video>
                            ) : (
                                <div>Unsupported media type</div>
                            )}
                        </div>
                    </div>
                )}
            </div>
        </>
    );
};

export default Gallery;
