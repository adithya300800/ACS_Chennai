// Shared client-side constants. Keep in sync with backend validation rules.

export const MAX_PHOTO_BYTES = 10 * 1024 * 1024; // 10MB — matches backend photos[] sizeBytes cap
export const MAX_PHOTOS_PER_DPR = 10;
export const ACCEPTED_PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
