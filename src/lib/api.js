const API_BASE = import.meta.env.VITE_API_URL || '';

class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function request(method, path, body, token) {
  const opts = {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  };

  if (body && method !== 'GET') {
    opts.body = JSON.stringify(body);
  }

  let res;
  try {
    res = await fetch(`${API_BASE}/api${path}`, opts);
  } catch (err) {
    throw new ApiError('Network error — is the server running?', 0);
  }

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new ApiError(data.error || 'Request failed', res.status);
  }

  return data;
}

export const api = {
  get: (path, token) => request('GET', path, null, token),
  post: (path, body, token) => request('POST', path, body, token),
  put: (path, body, token) => request('PUT', path, body, token),
  delete: (path, token) => request('DELETE', path, null, token),

  // DPR methods
  getDprSasUrl: (filename, contentType, container, token) =>
    api.post('/dpr/sas-url', { filename, contentType, container }, token),
  confirmUpload: (ulid, container, filename, contentType, sizeBytes, token) =>
    api.post('/dpr/confirm-upload', { ulid, container, filename, contentType, sizeBytes }, token),
  createDpr: (data, token) => api.post('/dpr', data, token),
  getDprs: (params = {}, token) => {
    const qs = new URLSearchParams(params).toString();
    return api.get(`/dpr${qs ? '?' + qs : ''}`, token);
  },
  getDpr: (id, token) => api.get(`/dpr/${id}`, token),
  updateDpr: (id, data, version, token) =>
    api.put(`/dpr/${id}`, { ...data, version }, token),
  reviewDpr: (id, corrections, adminNotes, token) =>
    api.post(`/dpr/${id}/review`, { corrections, adminNotes }, token),
  generateDprPdf: (id, token) => api.post(`/dpr/${id}/pdf`, {}, token),
  getNotifications: (lastId, token) =>
    api.get(`/dpr/notifications${lastId ? '?lastNotificationId=' + lastId : ''}`, token),
  markAllNotificationsRead: (token) =>
    api.put('/dpr/notifications/read-all', {}, token),
};
