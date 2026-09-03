import React from 'react';

// R22.5: per-photo download affordance. Sits as a small absolute-positioned
// overlay on top of any photo thumbnail. The signed R2 `readUrl` is opened
// in a new tab — the user can right-click → Save As from there, or just
// drag the image to their desktop. Cross-origin R2 ignores the `download`
// attribute on most browsers, so the visible affordance is "open in new
// tab" rather than "force-download". The download attribute is set anyway
// because some browsers do honour it.
//
// Render contract:
//   - parent must have `position: relative` so the overlay anchors to it
//   - photo.readUrl must be present (component returns null otherwise —
//     avoids dead buttons on photos whose SAS URL failed to generate)
//
// Mount points:
//   - DprList.jsx modal photo grid (line ~540-555)
//   - DprAll.jsx modal photo grid (line ~161-175)
//   - DprDashboard.jsx queue card thumbnails (line ~514-535)
//   - InspectionDetail.jsx photo grid (line ~181-205)
export default function PhotoDownloadButton({ photo, label = 'Open photo' }) {
  if (!photo?.readUrl) return null;
  // Derive a usable filename hint. The actual blob path is
  // `${employeeId}/${ulid}.${ext}` so `<ulid>.${ext>` is the best we can
  // offer — R2 doesn't know the original upload filename.
  const ext = photo.contentType ? photo.contentType.split('/')[1]?.split('+')[0] : null;
  const filename = photo.filename || `${photo.ulid || 'photo'}${ext ? `.${ext}` : ''}`;
  return (
    <a
      href={photo.readUrl}
      target="_blank"
      rel="noopener noreferrer"
      download={filename}
      aria-label={`${label}: ${photo.caption || filename}`}
      title={`Open ${filename} in new tab`}
      onClick={(e) => e.stopPropagation()}
      style={{
        position: 'absolute',
        top: 4,
        right: 4,
        width: 26,
        height: 26,
        borderRadius: 6,
        background: 'rgba(15,23,42,0.75)',
        color: '#fff',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        textDecoration: 'none',
        lineHeight: 1,
        opacity: 0.85,
        transition: 'opacity .15s',
        zIndex: 2,
      }}
      onMouseEnter={(e) => { e.currentTarget.style.opacity = '1'; }}
      onMouseLeave={(e) => { e.currentTarget.style.opacity = '0.85'; }}
    >
      {/* Small download arrow into tray — inline SVG to match the app's
          icon language (see round-15 SOL C-06). */}
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M12 3v12" />
        <path d="M7 10l5 5 5-5" />
        <path d="M5 21h14" />
      </svg>
    </a>
  );
}
