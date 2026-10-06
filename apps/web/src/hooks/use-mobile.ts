import { useSyncExternalStore } from "react";

const MOBILE_BREAKPOINT = 768;
const QUERY = `(max-width: ${MOBILE_BREAKPOINT - 1}px)`;

function subscribe(onChange: () => void): () => void {
  const mql = window.matchMedia(QUERY);
  mql.addEventListener("change", onChange);
  return () => mql.removeEventListener("change", onChange);
}

const getSnapshot = () => window.matchMedia(QUERY).matches;
// The server cannot know the viewport; render the desktop layout and correct after hydration.
const getServerSnapshot = () => false;

/** True below the `md` breakpoint (768px). Subscribes to the media query instead of resize events. */
export function useIsMobile(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
