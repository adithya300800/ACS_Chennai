import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

function ScrollToTop() {
  const { pathname } = useLocation();

  useEffect(() => {
    // Reset scroll on every route change. Then move keyboard focus to
    // <main id="main-content"> (set by PortalLayout / public layouts) so
    // screen-reader users land in the new page's content rather than at
    // the still-focused nav link they left. Falls back to scrolling the
    // main into view if focus() isn't available.
    window.scrollTo(0, 0);
    const main = document.getElementById('main-content');
    if (main) {
      // Don't disturb if focus is already inside the new <main> (e.g. user
      // tabbed into a button before navigating). Only steal focus when
      // it's elsewhere on the page.
      if (!main.contains(document.activeElement)) {
        if (typeof main.focus === 'function') {
          main.focus({ preventScroll: true });
        } else {
          main.setAttribute('tabindex', '-1');
          main.focus({ preventScroll: true });
        }
      }
    }
  }, [pathname]);

  return null;
}

export default ScrollToTop;