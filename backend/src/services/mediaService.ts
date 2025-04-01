export const getMedia = async () => {
    // Placeholder function to get media content
    return [
        { id: 1, url: 'https://example.com/media1.jpg', type: 'image/jpeg' },
        { id: 2, url: 'https://example.com/media2.png', type: 'image/png' },
    ];
};

export const uploadMedia = async (mediaFile: File) => {
    // Placeholder function to upload media content
    // In a real application, you would handle the file upload logic here
    return { success: true, message: 'Media uploaded successfully', fileName: mediaFile.name };
};