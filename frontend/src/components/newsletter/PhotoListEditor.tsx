import React, { useRef, useState } from 'react';
import { NewsletterPhoto } from '../../types/newsletter';
import { uploadImageToGallery } from '../editor/utils/imageImport';
import { galleryImageUrl } from './urls';

interface PhotoListEditorProps {
  value: NewsletterPhoto[];
  onChange: (next: NewsletterPhoto[]) => void;
  max: number;
  disabled?: boolean;
  /** Who uploads (stored as the gallery item's "taken by" until a credit is given). */
  uploader: string;
}

/** Photos with a description (alt text), a credit and a caption; upload, reorder, remove. */
export const PhotoListEditor: React.FC<PhotoListEditorProps> = ({ value, onChange, max, disabled, uploader }) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const update = (index: number, patch: Partial<NewsletterPhoto>) => {
    onChange(value.map((p, i) => (i === index ? { ...p, ...patch } : p)));
  };
  const move = (index: number, delta: number) => {
    const next = [...value];
    const [photo] = next.splice(index, 1);
    next.splice(index + delta, 0, photo);
    onChange(next);
  };

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setError(null);
    setUploading(true);
    const room = max - value.length;
    const added: NewsletterPhoto[] = [];
    try {
      for (const file of Array.from(files).slice(0, room)) {
        if (!file.type.startsWith('image/')) {
          setError(`${file.name} isn't an image`);
          continue;
        }
        const result = await uploadImageToGallery(file, uploader);
        added.push({ src: result.url, mediumSrc: result.mediumUrl, alt: '' });
      }
      if (files.length > room) setError(`Only ${max} photo${max === 1 ? '' : 's'} can be added here`);
    } catch (err) {
      console.error('Photo upload failed:', err);
      setError("The photo couldn't be uploaded. Try again, or a smaller file.");
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = '';
      if (added.length) onChange([...value, ...added]);
    }
  };

  return (
    <div className="nl-photos">
      {value.map((photo, i) => (
        <div key={`${photo.src}-${i}`} className="nl-photo-row" data-testid="photo-row">
          <img className="nl-photo-thumb" src={galleryImageUrl(photo.mediumSrc || photo.src)} alt={photo.alt || ''} />
          <div className="nl-photo-fields">
            <label className="nl-mini-label">
              Describe the photo (for people who can't see it)
              <input
                type="text"
                className="form-control"
                value={photo.alt}
                disabled={disabled}
                placeholder="e.g. A purple aurora over the playa at night"
                onChange={(e) => update(i, { alt: e.target.value })}
              />
            </label>
            <div className="nl-photo-pair">
              <label className="nl-mini-label">
                Photo credit
                <input
                  type="text"
                  className="form-control"
                  value={photo.credit || ''}
                  disabled={disabled}
                  placeholder="e.g. Vader"
                  onChange={(e) => update(i, { credit: e.target.value || undefined })}
                />
              </label>
              <label className="nl-mini-label nl-grow">
                Caption (optional)
                <input
                  type="text"
                  className="form-control"
                  value={photo.caption || ''}
                  disabled={disabled}
                  onChange={(e) => update(i, { caption: e.target.value || undefined })}
                />
              </label>
            </div>
          </div>
          {!disabled && (
            <div className="nl-photo-actions">
              {i > 0 && (
                <button type="button" className="nl-icon-btn" onClick={() => move(i, -1)} aria-label="Move photo up" title="Move up">
                  <i className="fas fa-arrow-up" />
                </button>
              )}
              {i < value.length - 1 && (
                <button type="button" className="nl-icon-btn" onClick={() => move(i, 1)} aria-label="Move photo down" title="Move down">
                  <i className="fas fa-arrow-down" />
                </button>
              )}
              <button type="button" className="nl-remove" onClick={() => onChange(value.filter((_, j) => j !== i))} aria-label={`Remove photo ${i + 1}`} title="Remove">
                &times;
              </button>
            </div>
          )}
        </div>
      ))}
      {!disabled && value.length < max && (
        <>
          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            multiple={max - value.length > 1}
            style={{ display: 'none' }}
            onChange={(e) => handleFiles(e.target.files)}
            data-testid="photo-input"
          />
          <button type="button" className="add-approver-btn" disabled={uploading} onClick={() => inputRef.current?.click()}>
            {uploading ? 'Uploading…' : `+ Add a photo${max > 1 ? ` (up to ${max})` : ''}`}
          </button>
        </>
      )}
      {error && <div className="field-error">{error}</div>}
    </div>
  );
};

export default PhotoListEditor;
