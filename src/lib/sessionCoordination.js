// SOL DR-001 — cross-tab session coordination.
//
// Threat model (audit, "Displayed identity and acting token can disagree
// across browser tabs"): the portal used to treat { accessToken,
// refreshToken, employee, refreshEpoch } as four independent fields
// persisted in shared localStorage. A second tab can log in as a
// different employee and overwrite the shared fields while the first
// tab still holds the original employee in React state. When the first
// tab then refreshes — preemptive timer or 401 — its /auth/refresh
// reads the now-shared refresh token (which belongs to the OTHER
// tab's account), gets back the OTHER tab's access token, and installs
// just that token into React state via the auth:token-refreshed
// listener. The first tab now displays employee A but its
// Authorization header carries B's token — submitting under A's
// identity using B's credentials.
//
// Resolution: treat { sessionGeneration, accessToken, refreshToken,
// employee } as ONE session value. Every login bumps sessionGeneration;
// every cross-tab listener reads it. Late /auth/refresh responses
// (those that started under one sessionGeneration but land under
// another) are dropped at the doRefresh boundary in api.js with
// ApiError('SESSION_CHANGED'), so the auth:token-refreshed path that
// would otherwise install just the accessToken never fires.
//
// Transport — BroadcastChannel.
//
//   * Same-origin, cross-tab is the exact contract we need (the
//     'storage' event is fire-and-forget and listener mutations of
//     localStorage can cause subtle reorderings across tabs).
//   * Chromium / Firefox / Safari (15.4+) all support it; the only
//     browsers without it are pre-2018 and out of the portal's support
//     window.
//   * No round-trip through the serializer (we send typed numbers).
//
// Why a separate module (not in api.js): api.js owns the fetch concern
// and AuthContext owns the React state. sessionGeneration is the
// cross-tab coordination concern, so it gets its own module so neither
// of the two existing owners grows the wrong shape.
//
// Persisted to localStorage so a fresh page load inherits the same
// generation other tabs are currently using; without persistence the
// next tab to mount would start at 0 and the late-response rejection
// in api.js would fire spuriously on the first refresh after mount.

'use strict';

const SESSION_GEN_KEY = 'acs_session_generation';
const CHANNEL_NAME = 'acs-session';

// Module-local generation counter. Persisted to localStorage; on module
// init we hydrate from the shared value so peer-tab bumps are visible
// immediately (within localStorage's synchronous contract — no
// BroadcastChannel race window).
let sessionGeneration = 0;

function readSessionGenerationFromStorage() {
  try {
    const raw = localStorage.getItem(SESSION_GEN_KEY);
    if (!raw) return 0;
    const parsed = parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
  } catch {
    return 0;
  }
}

function writeSessionGenerationToStorage(value) {
  try {
    localStorage.setItem(SESSION_GEN_KEY, String(value));
  } catch {
    // localStorage may be unavailable (private mode quota, SSR, tests
    // that haven't seeded the env). The in-memory counter still
    // updates; the only loss is cross-tab coordination via storage
    // re-hydration. BroadcastChannel still works.
  }
}

// Hydrate from storage so the next tab to mount inherits the current
// generation instead of starting at 0. Without this the very first
// refresh in a fresh tab would land with sessionGeneration=0 (the
// shared storage value) and sessionGenAtCall=0 (the in-memory value)
// → check passes spuriously even when a peer tab has bumped.
sessionGeneration = readSessionGenerationFromStorage();

function bumpSessionGeneration() {
  // Bump relative to the highest value we've observed (memory OR
  // storage). Reading storage first guarantees monotonicity even if
  // two tabs both call this concurrently — each write is atomic in
  // localStorage and the second writer reads the first writer's value
  // before incrementing. The BroadcastChannel post-message is
  // best-effort; localStorage is the durable coordination source.
  const fromStorage = readSessionGenerationFromStorage();
  const base = Math.max(sessionGeneration, fromStorage);
  sessionGeneration = base + 1;
  writeSessionGenerationToStorage(sessionGeneration);
  return sessionGeneration;
}

function getSessionGeneration() {
  // Re-read on every access so the late-response check in api.js sees
  // a peer tab's session change immediately, even if its
  // BroadcastChannel message was missed (browser bug, throttled tab).
  // The synchronous localStorage read is the source of truth; the
  // BroadcastChannel listener is the latency optimisation.
  const fromStorage = readSessionGenerationFromStorage();
  if (fromStorage > sessionGeneration) {
    sessionGeneration = fromStorage;
  }
  return sessionGeneration;
}

// BroadcastChannel — primary cross-tab transport. Each tab owns its
// own instance; messages are delivered to all OTHER tabs in the same
// browsing context group (same origin). One-way only: a tab never
// receives its own broadcasts.
let channel = null;
function getChannel() {
  if (typeof BroadcastChannel === 'undefined') return null;
  if (!channel) channel = new BroadcastChannel(CHANNEL_NAME);
  return channel;
}

function broadcastSessionChange(detail) {
  const c = getChannel();
  if (!c) return;
  try {
    c.postMessage({
      type: 'session-changed',
      sessionGeneration,
      ...(detail || {}),
    });
  } catch {
    // BroadcastChannel.postMessage can throw if the channel was closed
    // (e.g. during teardown). Swallow — the localStorage write is the
    // canonical publication; the broadcast is a wake-up signal.
  }
}

function subscribeToSessionChanges(handler) {
  const c = getChannel();
  if (!c) {
    // No BroadcastChannel support — the module-local sessionGeneration
    // still catches the late-response case (within a single tab or
    // across tabs that share storage and re-read on every get()).
    // Cross-tab wake-ups are missed; that's the documented fallback.
    return () => {};
  }
  const wrapped = (event) => {
    // Sync the in-memory counter from the broadcast so doRefresh's
    // sessionGenAtCall check sees the peer's bump without waiting for
    // the next get() re-read. This is the latency optimisation path;
    // get() is the source of truth.
    const broadcastGen = event.data?.sessionGeneration;
    if (typeof broadcastGen === 'number' && broadcastGen > sessionGeneration) {
      sessionGeneration = broadcastGen;
    }
    handler(event.data);
  };
  c.addEventListener('message', wrapped);
  return () => {
    c.removeEventListener('message', wrapped);
  };
}

export {
  SESSION_GEN_KEY,
  CHANNEL_NAME,
  bumpSessionGeneration,
  getSessionGeneration,
  broadcastSessionChange,
  subscribeToSessionChanges,
};