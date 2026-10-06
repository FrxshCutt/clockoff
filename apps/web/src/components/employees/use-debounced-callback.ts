"use client";

import { useCallback, useEffect, useRef } from "react";

/** Returns a debounced version of `callback` (latest closure wins); pending calls are dropped on unmount. */
export function useDebouncedCallback<Args extends unknown[]>(
  callback: (...args: Args) => void,
  delayMs: number,
) {
  const latest = useRef(callback);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Keep the newest closure without re-creating the debounced function (refs are only touched outside render).
  useEffect(() => {
    latest.current = callback;
  }, [callback]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  return useCallback(
    (...args: Args) => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = null;
        latest.current(...args);
      }, delayMs);
    },
    [delayMs],
  );
}
