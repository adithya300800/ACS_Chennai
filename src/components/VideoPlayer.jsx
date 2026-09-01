import React, { useEffect, useRef, useState } from 'react';
import { TRACKABLE_PROVIDERS, TRAINING_PROVIDER_LABELS } from '../lib/constants.js';

/**
 * Provider-aware video player for the Training module.
 *
 * Props:
 *   provider      string  — Prisma TrainingProvider enum value
 *   externalUrl   string  — the 3rd-party course URL (admin-supplied)
 *   onProgress    ({ pct, currentSec }) => void
 *                          — called every TRAINING_PROGRESS_PING_MS while playing.
 *                            pct = 0..100; currentSec is the player-reported position.
 *                          — debounced upstream so we don't POST on every event.
 *   onEnded       () => void — called exactly once when the player reaches the end.
 *                          — the parent should immediately POST progressPct=100 to
 *                            flip the enrollment to COMPLETED.
 *   initialTime   number  — optional resume position in seconds (server-side hint).
 *                          — YouTube/Vimeo players seek here on load.
 *
 * The YouTube IFrame Player API script is loaded once globally via index.html
 * (window.YT), so we don't have to inject it here. Vimeo Player API is loaded
 * lazily inside the component on first VIMEO render so we don't pay the cost
 * for users who never watch a Vimeo course.
 *
 * The component itself never makes network requests — it only reports
 * progress up. The parent (TrainingDetail) is responsible for debouncing
 * those reports into the trainingWriteLimiter-shaped POST cadence.
 */
export default function VideoPlayer({ provider, externalUrl, onProgress, onEnded, initialTime = 0 }) {
  // For untrackable providers (LinkedIn / Coursera / Udemy / generic) we
  // don't render a player at all — those sites block embedding via
  // X-Frame-Options. The parent shows a friendly "open external" card.
  if (!TRACKABLE_PROVIDERS.has(provider)) {
    return (
      <ExternalFallback
        externalUrl={externalUrl}
        provider={provider}
      />
    );
  }

  if (provider === 'YOUTUBE') return <YouTubePlayer externalUrl={externalUrl} onProgress={onProgress} onEnded={onEnded} initialTime={initialTime} />;
  if (provider === 'VIMEO') return <VimeoPlayer externalUrl={externalUrl} onProgress={onProgress} onEnded={onEnded} initialTime={initialTime} />;

  // Defensive default — should never hit because TRACKABLE_PROVIDERS gates
  // everything above.
  return <ExternalFallback externalUrl={externalUrl} provider={provider} />;
}

// ─────────────────────────────────────────────────────────────────────────────
// YouTube — uses the IFrame Player API. The iframe_api script is loaded
// once in index.html so window.YT is available when this component mounts.
// ─────────────────────────────────────────────────────────────────────────────

function YouTubePlayer({ externalUrl, onProgress, onEnded, initialTime }) {
  const containerRef = useRef(null);
  const playerRef = useRef(null);
  // Track whether we've already fired onEnded so a state-flicker from
  // YT's PLAYING→ENDED→CUED transitions doesn't double-fire completion.
  const endedFiredRef = useRef(false);
  const [ready, setReady] = useState(false);

  // Pull the video ID out of any YT URL shape (delegates to the same logic
  // the backend uses for its enum detection). If the URL is malformed we
  // fall back to a generic "couldn't load" card.
  const videoId = extractYouTubeIdClient(externalUrl);

  useEffect(() => {
    if (!videoId) return undefined;

    let cancelled = false;

    function buildPlayer() {
      if (cancelled || !containerRef.current || !window.YT || !window.YT.Player) return;
      // Destroy any previous instance — the component can remount when the
      // employee switches between courses in the same SPA session.
      if (playerRef.current && typeof playerRef.current.destroy === 'function') {
        try { playerRef.current.destroy(); } catch { /* no-op */ }
      }
      playerRef.current = new window.YT.Player(containerRef.current, {
        videoId,
        playerVars: {
          autoplay: 0,
          modestbranding: 1,
          rel: 0,
          // Start the user at their previous position so a refresh doesn't
          // dump them back at 0:00. YT caps initial seek at the player load
          // event; we use onReady below to seek if non-zero.
          start: Math.max(0, Math.floor(initialTime || 0)),
        },
        events: {
          onReady: (event) => {
            setReady(true);
            // For long videos, onReady's `start` param only works in the
            // first few seconds; for an arbitrary resume we have to seek.
            if (initialTime && initialTime > 1) {
              try { event.target.seekTo(Math.floor(initialTime), true); } catch { /* no-op */ }
            }
          },
          onStateChange: (event) => {
            // 0 = ENDED, 1 = PLAYING, 2 = PAUSED, 3 = BUFFERING, 5 = CUED.
            if (event.data === 0) {
              if (endedFiredRef.current) return;
              endedFiredRef.current = true;
              if (onEnded) onEnded();
            } else if (event.data === 1) {
              // Re-arming — user clicked "replay" after completion.
              endedFiredRef.current = false;
            }
          },
        },
      });
    }

    // YT iframe_api may have loaded before we mount (index.html script tag)
    // or after (slow connection on first visit). window.YT.Player is the
    // signal; if missing, poll briefly so we don't race the API load.
    if (window.YT && window.YT.Player) {
      buildPlayer();
    } else {
      const prev = window.onYouTubeIframeAPIReady;
      window.onYouTubeIframeAPIReady = () => {
        if (typeof prev === 'function') prev();
        buildPlayer();
      };
    }

    return () => {
      cancelled = true;
      if (playerRef.current && typeof playerRef.current.destroy === 'function') {
        try { playerRef.current.destroy(); } catch { /* no-op */ }
        playerRef.current = null;
      }
    };
    // initialTime is intentionally not in the dep array — we seek on
    // onReady once, not on every render. The videoId drives remount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoId]);

  // Pull current time / duration every onProgress tick. We can't reliably
  // listen to YT's getCurrentTime from a callback, so we set up an interval
  // here and let the parent debounce / dedupe. (Parent uses a ref-based
  // throttle so re-renders here don't lose state.)
  useEffect(() => {
    if (!ready || !playerRef.current || !onProgress) return undefined;
    const id = setInterval(() => {
      try {
        const player = playerRef.current;
        const current = player.getCurrentTime ? player.getCurrentTime() : 0;
        const total = player.getDuration ? player.getDuration() : 0;
        if (!total || total <= 0) return;
        const pct = Math.min(100, Math.max(0, (current / total) * 100));
        onProgress({ pct, currentSec: current });
      } catch {
        // Player was torn down between interval ticks — silent.
      }
    }, 5000); // 5s polling; parent throttles to the 10s POST cadence.
    return () => clearInterval(id);
  }, [ready, onProgress]);

  if (!videoId) {
    return (
      <div className="training-player-error">
        Couldn’t load this YouTube course — the link doesn’t look like a valid YouTube URL.
      </div>
    );
  }

  return (
    <div className="training-player-wrap">
      <div className="training-player-frame">
        {/* The YT API replaces this div with an iframe on ready. */}
        <div ref={containerRef} className="training-player-yt" />
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Vimeo — uses @vimeo/player (loaded lazily, not bundled into the main
// chunk). We dynamically import it inside the effect so users who never
// watch a Vimeo course don't pay the bandwidth cost.
// ─────────────────────────────────────────────────────────────────────────────

function VimeoPlayer({ externalUrl, onProgress, onEnded, initialTime }) {
  const containerRef = useRef(null);
  const playerRef = useRef(null);
  const endedFiredRef = useRef(false);
  const [error, setError] = useState(null);

  const videoId = extractVimeoIdClient(externalUrl);

  useEffect(() => {
    if (!videoId) return undefined;
    let cancelled = false;

    (async () => {
      try {
        const mod = await import(/* @vite-ignore */ 'https://player.vimeo.com/api/player.js');
        const Player = mod.default || mod.Player || (window.Vimeo && window.Vimeo.Player);
        if (!Player) throw new Error('Vimeo Player unavailable');
        if (cancelled) return;
        playerRef.current = new Player(containerRef.current, {
          id: Number(videoId),
          responsive: true,
          // Vimeo's `start` option is in seconds — matches our resume hint.
          ...(initialTime && initialTime > 1 ? { start: Math.floor(initialTime) } : {}),
        });
        playerRef.current.ready().then(() => {
          // timeupdate fires multiple times per second — parent debounces.
          playerRef.current.on('timeupdate', (data) => {
            if (!data || !data.duration || data.duration <= 0) return;
            const pct = Math.min(100, Math.max(0, (data.seconds / data.duration) * 100));
            if (onProgress) onProgress({ pct, currentSec: data.seconds });
          });
          playerRef.current.on('ended', () => {
            if (endedFiredRef.current) return;
            endedFiredRef.current = true;
            if (onEnded) onEnded();
          });
          // Replay re-arms endedFiredRef so the parent can fire completion again
          // if the user rewinds and replays.
          playerRef.current.on('play', () => { endedFiredRef.current = false; });
        });
      } catch (e) {
        if (!cancelled) setError(e?.message || 'Vimeo load failed');
      }
    })();

    return () => {
      cancelled = true;
      if (playerRef.current && typeof playerRef.current.unload === 'function') {
        try { playerRef.current.unload(); } catch { /* no-op */ }
        playerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [videoId]);

  if (!videoId) {
    return (
      <div className="training-player-error">
        Couldn’t load this Vimeo course — the link doesn’t look like a valid Vimeo URL.
      </div>
    );
  }

  if (error) {
    return (
      <div className="training-player-error">
        Couldn’t load the Vimeo player: {error}
      </div>
    );
  }

  return (
    <div className="training-player-wrap">
      <div className="training-player-frame">
        <div ref={containerRef} className="training-player-vimeo" />
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// External fallback — shown for LinkedIn Learning / Coursera / Udemy / generic
// URLs that block embedding. Employee opens the course in a new tab and
// clicks Mark Complete when done. We intentionally do NOT open the link
// automatically — many users want to skim the description first.
// ─────────────────────────────────────────────────────────────────────────────

function ExternalFallback({ externalUrl, provider }) {
  const label = TRAINING_PROVIDER_LABELS[provider] || 'External';
  return (
    <div className="training-player-external" role="region" aria-label={`External ${label} course`}>
      <div className="training-player-external-icon" aria-hidden="true">
        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" />
          <polyline points="15 3 21 3 21 9" />
          <line x1="10" y1="14" x2="21" y2="3" />
        </svg>
      </div>
      <div className="training-player-external-title">This course is hosted on {label}</div>
      <div className="training-player-external-sub">
        {label} doesn’t allow embedding, so open the course in a new tab to watch it.
        When you’re done, come back here and click <strong>Mark as Complete</strong>.
      </div>
      <a
        className="training-btn training-btn-primary"
        href={externalUrl}
        target="_blank"
        rel="noopener noreferrer"
      >
        Open course in new tab
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6" />
          <polyline points="15 3 21 3 21 9" />
          <line x1="10" y1="14" x2="21" y2="3" />
        </svg>
      </a>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// URL parsing (client-side mirror of backend/src/lib/trainingRules.js). The
// backend is still authoritative — we re-validate on save — but the client
// needs IDs immediately to build the player on mount.
// ─────────────────────────────────────────────────────────────────────────────

function extractYouTubeIdClient(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  let url;
  try { url = new URL(rawUrl); } catch { return null; }
  if (!/^https?:$/.test(url.protocol)) return null;
  const host = url.hostname.toLowerCase();
  if (host === 'youtu.be') {
    const id = url.pathname.replace(/^\/+/, '').split('/')[0];
    return /^[A-Za-z0-9_-]{6,15}$/.test(id) ? id : null;
  }
  if (host.endsWith('youtube.com') || host.endsWith('youtube-nocookie.com')) {
    const v = url.searchParams.get('v');
    if (v && /^[A-Za-z0-9_-]{6,15}$/.test(v)) return v;
    const parts = url.pathname.split('/').filter(Boolean);
    const idx = parts.findIndex((p) => p === 'embed' || p === 'shorts' || p === 'v');
    if (idx >= 0 && parts[idx + 1] && /^[A-Za-z0-9_-]{6,15}$/.test(parts[idx + 1])) {
      return parts[idx + 1];
    }
  }
  return null;
}

function extractVimeoIdClient(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return null;
  let url;
  try { url = new URL(rawUrl); } catch { return null; }
  if (!/^https?:$/.test(url.protocol)) return null;
  const host = url.hostname.toLowerCase();
  if (host !== 'vimeo.com' && host !== 'player.vimeo.com') return null;
  const parts = url.pathname.split('/').filter(Boolean);
  for (const p of parts) {
    if (/^\d{6,12}$/.test(p)) return p;
  }
  return null;
}
