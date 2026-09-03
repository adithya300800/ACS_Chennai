import React, { useState, useRef, useCallback, useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext.jsx';
import { api } from '../lib/api.js';
import { uploadBlob } from '../lib/blobUpload.js';
import { MAX_PHOTO_BYTES, MAX_PHOTOS_PER_DPR, ACCEPTED_PHOTO_TYPES } from '../lib/constants.js';
import { CameraIcon } from './Icons.jsx';

const ACCEPTED_TYPES = ACCEPTED_PHOTO_TYPES;
const MAX_SIZE = MAX_PHOTO_BYTES;
const MAX_FILES = MAX_PHOTOS_PER_DPR;

function UploadItem({ item, onRemove }) {
  const statusLabel = {
    idle: 'Waiting...',
    'requesting-sas': 'Getting upload URL...',
    uploading: 'Uploading...',
    confirming: 'Verifying...',
    complete: 'Done',
    error: item.error || 'Failed',
  }[item.status] || item.status;

  return (
    <div className="upload-item">
      {item.previewUrl ? (
        <img
          src={item.previewUrl}
          alt={item.caption || 'Photo'}
          className="upload-item-thumb"
        />
      ) : (
        <div className="upload-item-placeholder" aria-hidden="true">
          <CameraIcon size={20} style={{ color: 'var(--steel)' }} />
        </div>
      )}

      <div className="upload-item-meta">
        <div className="upload-item-name">{item.filename}</div>
        <div className={`upload-item-status ${item.status}`}>
          {statusLabel}
        </div>
        {item.status === 'uploading' && (
          <div className="upload-item-progress">
            <div
              className="upload-item-progress-bar"
              style={{ width: `${item.progress || 0}%` }}
            />
          </div>
        )}
        <input
          className="upload-item-caption"
          placeholder="Add caption..."
          value={item.caption || ''}
          onChange={(e) => item.onCaptionChange?.(e.target.value)}
        />
      </div>

      <button
        className="upload-item-remove"
        onClick={onRemove}
        title="Remove"
        aria-label={`Remove ${item.filename || 'photo'}`}
      >
        ×
      </button>
    </div>
  );
}

export default function PhotoUpload({ dprId, onPhotosChange, initialPhotos = [] }) {
  const { accessToken } = useAuth();
  const fileInputRef = useRef(null);

  const [items, setItems] = useState(initialPhotos.map(p => ({
    ...p,
    status: 'complete',
    previewUrl: p.readUrl || null,
  })));
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState('');
  // Track blob URLs we created so we can revoke them on unmount.
  // Items in `items` get a previewUrl from URL.createObjectURL; without
  // revocation, long-running tabs accumulate dead references.
  const ownedUrlsRef = useRef(new Set());

  useEffect(() => {
    return () => {
      ownedUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
      ownedUrlsRef.current.clear();
    };
  }, []);

  const processFiles = useCallback(async (files) => {
    const arr = Array.from(files);
    const valid = arr.filter(f =>
      ACCEPTED_TYPES.includes(f.type) && f.size <= MAX_SIZE
    );

    const remaining = MAX_FILES - items.length;
    if (valid.length > remaining) {
      setError(`Max ${MAX_FILES} photos allowed. You can add ${remaining} more.`);
      return;
    }

    if (valid.length === 0) {
      setError('Please select valid images (JPG, PNG, WebP, max 5MB each)');
      return;
    }

    setError('');

    // Create pending items with previews
    const newItems = valid.map(file => {
      const previewUrl = URL.createObjectURL(file);
      ownedUrlsRef.current.add(previewUrl);
      return {
        id: `temp-${Date.now()}-${Math.random()}`,
        file,
        filename: file.name,
        contentType: file.type,
        sizeBytes: file.size,
        ulid: null,
        status: 'idle',
        progress: 0,
        caption: '',
        previewUrl,
        error: '',
      };
    });

    setItems(prev => [...prev, ...newItems]);

    // Upload each
    for (const item of newItems) {
      await uploadItem(item);
    }
  }, [items.length]);

  const uploadItem = async (item) => {
    // Update status: requesting-sas
    updateItem(item.id, { status: 'requesting-sas' });

    try {
      // Step 1: Get SAS URL
      const { sasUrl, ulid } = await api.getDprSasUrl(
        item.filename, item.contentType, 'dpr-photos', accessToken
      );

      updateItem(item.id, { ulid, status: 'uploading' });

      // Step 2: PUT to blob with progress + 60s timeout. Previously this was
      // an inline XHR with no xhr.timeout, so a hung Azure upload left the
      // progress bar stuck at 0% forever (Aug 29 2026 user report). The
      // helper enforces a 60s ceiling and surfaces a clean error.
      await uploadBlob(sasUrl, item.file, {
        contentType: item.contentType,
        onProgress: (pct) => updateItem(item.id, { progress: pct }),
      });

      // Step 3: Confirm upload
      updateItem(item.id, { status: 'confirming' });
      const confirmed = await api.confirmUpload(
        ulid, 'dpr-photos', item.filename, item.contentType, item.sizeBytes, accessToken
      );

      // Update with confirmed data
      updateItem(item.id, {
        status: 'complete',
        progress: 100,
        id: confirmed.id || item.id,
        ulid,
      });

      // Notify parent of complete photos
      setItems(prev => {
        const updated = prev.map(i =>
          i.id === item.id
            ? { ...i, status: 'complete', progress: 100, id: confirmed.id || i.id, ulid }
            : i
        );
        const completed = updated.filter(i => i.status === 'complete');
        onPhotosChange?.(completed.map(({ id, ulid, filename, contentType, sizeBytes, caption }) => ({
          id, ulid, filename, contentType, sizeBytes, caption,
        })));
        return updated;
      });

    } catch (err) {
      updateItem(item.id, { status: 'error', error: err.message });
    }
  };

  const updateItem = (id, changes) => {
    setItems(prev => prev.map(i => i.id === id ? { ...i, ...changes } : i));
  };

  const removeItem = (id) => {
    setItems(prev => {
      const removed = prev.find(i => i.id === id);
      if (removed?.previewUrl && ownedUrlsRef.current.has(removed.previewUrl)) {
        URL.revokeObjectURL(removed.previewUrl);
        ownedUrlsRef.current.delete(removed.previewUrl);
      }
      const updated = prev.filter(i => i.id !== id);
      const completed = updated.filter(i => i.status === 'complete');
      onPhotosChange?.(completed.map(({ id, ulid, filename, contentType, sizeBytes, caption }) => ({
        id, ulid, filename, contentType, sizeBytes, caption,
      })));
      return updated;
    });
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    processFiles(e.dataTransfer.files);
  };

  const pendingCount = items.filter(i => i.status !== 'complete' && i.status !== 'error').length;
  const canAddMore = items.length < MAX_FILES;

  return (
    <div>
      {error && (
        <div className="upload-error">{error}</div>
      )}

      {/* Upload zone */}
      {canAddMore && (
        <div
          className={`photo-upload-zone${dragOver ? ' drag-over' : ''}`}
          onDrop={handleDrop}
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onClick={() => fileInputRef.current?.click()}
        >
          <svg width="32" height="32" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24" aria-hidden="true">
            <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12"/>
          </svg>
          <p className="upload-zone-hint">
            Drop photos here or click to browse
          </p>
          <span className="upload-zone-meta">
            JPG, PNG, WebP — max 5MB each ({MAX_FILES - items.length} remaining)
          </span>
        </div>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept={ACCEPTED_TYPES.join(',')}
        multiple
        style={{ display: 'none' }}
        onChange={(e) => processFiles(e.target.files)}
      />

      {/* Upload queue */}
      {items.length > 0 && (
        <div className="upload-queue">
          {items.map(item => (
            <UploadItem
              key={item.id}
              item={item}
              onRemove={() => removeItem(item.id)}
            />
          ))}
        </div>
      )}

      {pendingCount > 0 && (
        <div className="upload-pending">
          {pendingCount} photo{pendingCount !== 1 ? 's' : ''} uploading...
        </div>
      )}
    </div>
  );
}
