// Shared client-side constants. Keep in sync with backend validation rules.

export const MAX_PHOTO_BYTES = 10 * 1024 * 1024; // 10MB — matches backend photos[] sizeBytes cap
export const MAX_PHOTOS_PER_DPR = 10;
export const ACCEPTED_PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

// Round-14: Employee Training. Mirrors backend/src/lib/trainingRules.js
// values — keep in sync if the backend caps change.
//
// TRAINING_PROGRESS_PING_MS — how often the in-platform player POSTs
// progress to /api/training/enrollments/:id/progress. 10s is a good
// balance: fine-grained enough for a smooth progress bar, coarse
// enough to stay well under the 120/h trainingWriteLimiter budget
// (one ping per 10s = 360/h, so a single user with the player open
// all day would hit the limiter — the player should back off if 429).
export const TRAINING_PROGRESS_PING_MS = 10_000;
export const TRAINING_COMPLETION_THRESHOLD = 100; // pct at which to flip status -> COMPLETED

// Provider enum — same strings as the Prisma TrainingProvider enum
// and the backend ALLOWED_PROVIDERS set. UI uses these for badges,
// player routing, and conditional "open external" buttons.
export const TRAINING_PROVIDERS = {
  YOUTUBE: 'YOUTUBE',
  VIMEO: 'VIMEO',
  LINKEDIN_LEARNING: 'LINKEDIN_LEARNING',
  COURSERA: 'COURSERA',
  UDEMY: 'UDEMY',
  OTHER: 'OTHER',
};

// Human-readable labels for the provider badges.
export const TRAINING_PROVIDER_LABELS = {
  YOUTUBE: 'YouTube',
  VIMEO: 'Vimeo',
  LINKEDIN_LEARNING: 'LinkedIn Learning',
  COURSERA: 'Coursera',
  UDEMY: 'Udemy',
  OTHER: 'External',
};

// Status enum — mirrors Prisma TrainingStatus. Pill class names in
// CSS are derived from these (`training-pill-${status.toLowerCase()}`).
export const TRAINING_STATUSES = {
  ASSIGNED: 'ASSIGNED',
  IN_PROGRESS: 'IN_PROGRESS',
  COMPLETED: 'COMPLETED',
};

// LPR-009: canonical terminal-status list shared between the backend
// (`backend/src/lib/trainingRules.js` isCompleted()) and every frontend
// filter, label, action guard, and progress loop. Mirrors the four
// evidence-class terminal states on the server.
//
// A row is "terminal" if it represents a finished enrollment — the union
// of the legacy `COMPLETED` value and the four evidence-class completions
// introduced in round-20. Both lists must stay in sync; the test suite in
// backend/__tests__/trainingRules.test.js pins the membership.
export const TRAINING_TERMINAL_STATUSES = [
  'COMPLETED',
  'SELF_ATTESTED_COMPLETED',
  'PLAYER_OBSERVED_COMPLETED',
  'PROVIDER_VERIFIED_COMPLETED',
  'ADMIN_OVERRIDE_COMPLETED',
];

export const TRAINING_TERMINAL_STATUS_SET = new Set(TRAINING_TERMINAL_STATUSES);

export const isTrainingTerminal = (status) => TRAINING_TERMINAL_STATUS_SET.has(status);

// Priority — used to sort + colour the pill on admin rows.
export const TRAINING_PRIORITIES = {
  LOW: 'LOW',
  NORMAL: 'NORMAL',
  HIGH: 'HIGH',
};

// Providers where we can embed a real player + auto-capture progress.
// LinkedIn Learning / Coursera / Udemy / generic URLs block embedding
// via X-Frame-Options, so the UI shows an "Open course" button instead
// and the employee must click Mark Complete manually.
export const TRACKABLE_PROVIDERS = new Set(['YOUTUBE', 'VIMEO']);
