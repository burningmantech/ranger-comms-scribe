import { API_URL } from '../config';
import React, { useEffect, useState } from 'react';

const Gallery: React.FC = () => {
    const [media, setMedia] = useState<Array<{ id: string; url: string; type: string }>>([]);
    const [loading, setLoading] = useState<boolean>(true);

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
                const data = await response.json();
                setMedia(data);
            } catch (error) {
                console.error('Error fetching media:', error);
            } finally {
                setLoading(false);
            }
        };

        fetchMedia();
    }, []);

    if (loading) {
        return <div>Loading...</div>;
    }

    return (
        <div className="gallery">
            {media.length === 0 ? (
                <p>No media available.</p>
            ) : (
                media.map(item => (
                    <div key={item.id} className="media-item">
                        {item.type === 'image' ? (
                            <img src={item.url} alt={`Media ${item.id}`} />
                        ) : (
                            <video controls>
                                <source src={item.url} type="video/mp4" />
                                Your browser does not support the video tag.
                            </video>
                        )}
                    </div>
                ))
            )}
        </div>
    );
};

export default Gallery;