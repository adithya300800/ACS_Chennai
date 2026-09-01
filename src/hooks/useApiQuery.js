import { useState, useEffect } from 'react';
import { api } from '../lib/api.js';

export function useApiQuery(path, { token, skip = false, deps = [] } = {}) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(!skip);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (skip) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    api.get(path, token)
      .then((result) => { if (!cancelled) setData(result); })
      .catch((err) => { if (!cancelled) setError(err); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [path, token, skip, ...deps]);

  const refetch = () => {
    setLoading(true);
    setError(null);
    return api.get(path, token)
      .then((result) => { setData(result); return result; })
      .catch((err) => { setError(err); throw err; })
      .finally(() => setLoading(false));
  };

  return { data, loading, error, refetch };
}
