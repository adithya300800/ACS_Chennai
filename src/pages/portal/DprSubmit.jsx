import React, { useState, useRef, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext.jsx';
import { api } from '../../lib/api.js';

const WEATHER_OPTIONS = ['Sunny', 'Cloudy', 'Rainy', 'Windy', 'Haze', 'Foggy'];

export default function DprSubmit() {
  const { accessToken } = useAuth();
  const navigate = useNavigate();
  const fileInputRef = useRef(null);

  const [form, setForm] = useState({
    projectName: '',
    location: '',
    reportDate: new Date().toISOString().split('T')[0],
    weather: 'Sunny',
    temperature: '',
    contractor: '',
  });
  const [photos, setPhotos] = useState([]);
  const [gps, setGps] = useState(null);
  const [status, setStatus] = useState('idle'); // idle | locating | uploading | submitting | error
  const [error, setError] = useState('');
  const [locError, setLocError] = useState('');

  const captureGps = useCallback(() => {
    if (!navigator.geolocation) {
      setLocError('Geolocation not supported');
      return;
    }
    setStatus('locating');
    setLocError('');
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setGps({ lat: pos.coords.latitude, lng: pos.coords.longitude });
        setStatus('idle');
      },
      (err) => {
        setLocError(err.message);
        setStatus('idle');
      },
      { enableHighAccuracy: true, timeout: 20000 }
    );
  }, []);

  const handleChange = (e) => {
    const { name, value } = e.target;
    setForm((f) => ({ ...f, [name]: value }));
  };

  const removePhoto = (idx) => {
    setPhotos((p) => p.filter((_, i) => i !== idx));
  };

  const handleFiles = async (files) => {
    const valid = Array.from(files).filter(
      (f) => ['image/jpeg', 'image/png', 'image/webp'].includes(f.type) && f.size <= 5 * 1024 * 1024
    );
    if (valid.length === 0) {
      setError('Select valid images (jpg/png/webp, max 5MB each)');
      return;
    }
    if (photos.length + valid.length > 10) {
      setError('Max 10 photos allowed');
      return;
    }

    setStatus('uploading');
    setError('');

    const newPhotos = [];
    for (const file of valid) {
      try {
        // Step 1: Get SAS URL
        const { sasUrl, ulid } = await api.getDprSasUrl(file.name, file.type, 'dpr-photos', accessToken);

        // Step 2: PUT directly to blob
        await fetch(sasUrl, {
          method: 'PUT',
          headers: { 'Content-Type': file.type },
          body: file,
        });

        // Step 3: Confirm upload
        await api.confirmUpload(ulid, 'dpr-photos', file.name, file.type, file.size, accessToken);

        newPhotos.push({
          ulid,
          container: 'dpr-photos',
          filename: file.name,
          contentType: file.type,
          sizeBytes: file.size,
          caption: '',
          location: '',
          takenAt: new Date().toISOString(),
          file, // for preview only
          previewUrl: URL.createObjectURL(file),
        });
      } catch (err) {
        setError(`Upload failed for ${file.name}: ${err.message}`);
        setStatus('idle');
        return;
      }
    }

    setPhotos((p) => [...p, ...newPhotos]);
    setStatus('idle');
  };

  const handleDrop = (e) => {
    e.preventDefault();
    handleFiles(e.dataTransfer.files);
  };

  const handleSubmit = async (submitStatus) => {
    if (!form.projectName || !form.location || !form.reportDate) {
      setError('Project name, location, and date are required');
      return;
    }
    setStatus('submitting');
    setError('');

    try {
      const dpr = await api.createDpr(
        {
          projectName: form.projectName,
          location: form.location,
          reportDate: form.reportDate,
          weather: form.weather,
          temperature: form.temperature,
          contractor: form.contractor,
          status: submitStatus,
          photos: photos.map(({ ulid, container, filename, contentType, sizeBytes, caption, location, takenAt }) => ({
            ulid, container, filename, contentType, sizeBytes, caption, location, takenAt,
          })),
          ...(gps ? { gpsLat: gps.lat, gpsLng: gps.lng } : {}),
        },
        accessToken
      );
      navigate('/portal/dpr/my');
    } catch (err) {
      setError(err.message || 'Failed to submit DPR');
      setStatus('idle');
    }
  };

  return (
    <div className="dpr-page">
      <div className="dpr-card">
        <h1 className="dpr-page-title">Submit Daily Progress Report</h1>

        {error && <div className="portal-auth-error" style={{ marginBottom: '1rem' }}>{error}</div>}

        <div className="dpr-form">
          {/* Project & Date */}
          <div className="form-row">
            <div className="form-group" style={{ flex: 2 }}>
              <label htmlFor="projectName">Project Name *</label>
              <input id="projectName" name="projectName" className="form-input" value={form.projectName} onChange={handleChange} placeholder="e.g. Metro Station Phase 2" />
            </div>
            <div className="form-group" style={{ flex: 1 }}>
              <label htmlFor="reportDate">Date *</label>
              <input id="reportDate" type="date" name="reportDate" className="form-input" value={form.reportDate} onChange={handleChange} />
            </div>
          </div>

          {/* Location */}
          <div className="form-group">
            <label htmlFor="location">Location *</label>
            <input id="location" name="location" className="form-input" value={form.location} onChange={handleChange} placeholder="Site address or location description" />
          </div>

          {/* Weather, Temperature, Contractor */}
          <div className="form-row">
            <div className="form-group">
              <label htmlFor="weather">Weather</label>
              <select id="weather" name="weather" className="form-input" value={form.weather} onChange={handleChange}>
                {WEATHER_OPTIONS.map((w) => <option key={w} value={w}>{w}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label htmlFor="temperature">Temperature</label>
              <input id="temperature" name="temperature" className="form-input" value={form.temperature} onChange={handleChange} placeholder="e.g. 32°C" />
            </div>
            <div className="form-group">
              <label htmlFor="contractor">Contractor</label>
              <input id="contractor" name="contractor" className="form-input" value={form.contractor} onChange={handleChange} placeholder="Contractor name" />
            </div>
          </div>

          {/* GPS */}
          <div className="form-group">
            <label>GPS Location</label>
            <button type="button" className="btn btn-secondary" onClick={captureGps} disabled={status === 'locating'}>
              {status === 'locating' ? 'Getting location...' : gps ? `Lat: ${gps.lat.toFixed(5)}, Lng: ${gps.lng.toFixed(5)}` : 'Capture GPS'}
            </button>
            {locError && <p className="field-error">{locError}</p>}
          </div>

          {/* Photo Upload */}
          <div className="form-group">
            <label>Site Photos (max 10)</label>
            <div
              className="photo-upload-zone"
              onDrop={handleDrop}
              onDragOver={(e) => e.preventDefault()}
              onClick={() => fileInputRef.current?.click()}
            >
              <svg width="32" height="32" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12"/></svg>
              <p>Drag & drop photos or click to browse</p>
              <span>JPG, PNG, WebP — max 5MB each</span>
            </div>
            <input ref={fileInputRef} type="file" accept="image/jpeg,image/png,image/webp" multiple style={{ display: 'none' }} onChange={(e) => handleFiles(e.target.files)} />

            {/* Photo Grid */}
            {photos.length > 0 && (
              <div className="photo-grid">
                {photos.map((photo, idx) => (
                  <div key={idx} className="photo-thumb">
                    <img src={photo.previewUrl} alt={photo.caption || 'Site photo'} />
                    <button type="button" className="photo-remove" onClick={() => removePhoto(idx)}>×</button>
                    <input
                      className="photo-caption-input"
                      placeholder="Caption..."
                      value={photo.caption}
                      onChange={(e) => {
                        const updated = [...photos];
                        updated[idx] = { ...updated[idx], caption: e.target.value };
                        setPhotos(updated);
                      }}
                    />
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Actions */}
          <div className="dpr-form-actions">
            <button type="button" className="btn btn-secondary" onClick={() => handleSubmit('DRAFT')} disabled={status === 'submitting' || status === 'uploading'}>
              {status === 'submitting' ? 'Saving...' : 'Save as Draft'}
            </button>
            <button type="button" className="btn btn-primary" onClick={() => handleSubmit('SUBMITTED')} disabled={status === 'submitting' || status === 'uploading'}>
              {status === 'submitting' ? 'Submitting...' : 'Submit Report'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
