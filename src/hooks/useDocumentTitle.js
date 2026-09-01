import { useEffect } from 'react';

const DEFAULT_TITLE = 'ACS Chennai — Construction Project Management Consultancy';
const DEFAULT_DESCRIPTION = 'ACS Chennai — independent construction project management consultancy for residential, commercial, and infrastructure projects across Tamil Nadu.';

export function useDocumentTitle(title, description) {
  useEffect(() => {
    const prevTitle = document.title;
    document.title = title ? `${title} · ACS Chennai` : DEFAULT_TITLE;

    let meta = document.querySelector('meta[name="description"]');
    const prevDescription = meta?.getAttribute('content');
    if (description) {
      if (!meta) {
        meta = document.createElement('meta');
        meta.setAttribute('name', 'description');
        document.head.appendChild(meta);
      }
      meta.setAttribute('content', description);
    }

    return () => {
      document.title = prevTitle;
      if (meta && prevDescription !== null) {
        meta.setAttribute('content', prevDescription);
      } else if (meta && description) {
        meta.removeAttribute('content');
      }
    };
  }, [title, description]);
}

export { DEFAULT_TITLE, DEFAULT_DESCRIPTION };