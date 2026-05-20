import { useEffect, useState } from 'react';

// -----------------------------------------------------------------------------
// Tiny location hook. Subscribes to popstate; the helpers manually emit
// 'popstate' after pushState/replaceState so all subscribers stay in sync
// without a router library. Used by AuthBoot to decide what to mount and
// by LandingNav for the burger menu.
// -----------------------------------------------------------------------------

function getPathname(): string {
  return typeof window !== 'undefined' ? window.location.pathname : '/';
}

export function useLocation(): { pathname: string; search: string } {
  const [state, setState] = useState(() => ({
    pathname: getPathname(),
    search: typeof window !== 'undefined' ? window.location.search : '',
  }));

  useEffect(() => {
    const onPop = () => {
      setState({
        pathname: window.location.pathname,
        search: window.location.search,
      });
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  return state;
}

function emitPop(): void {
  // Manually fire popstate so subscribers re-read window.location. Browsers
  // dispatch popstate on back/forward only; pushState/replaceState are
  // silent by design.
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function pushPath(path: string): void {
  window.history.pushState({}, '', path);
  emitPop();
}

export function replacePath(path: string): void {
  window.history.replaceState({}, '', path);
  emitPop();
}
