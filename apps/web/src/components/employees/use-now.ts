"use client";

import { useSyncExternalStore } from "react";

/**
 * A shared clock for views that compare against "now" (the Today timeline, remaining override time). One
 * interval for every subscriber; `null` during server render / hydration so the first paint never depends
 * on the viewer's clock. Keeping `Date.now()` out of render also keeps components pure.
 */
const TICK_MS = 30_000;
let now = Date.now();
let timer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

function emit() {
  now = Date.now();
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (timer === null) {
    timer = setInterval(emit, TICK_MS);
    queueMicrotask(emit);
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== null) {
      clearInterval(timer);
      timer = null;
    }
  };
}

const getSnapshot = () => now;
const getServerSnapshot = () => null;

/** Epoch milliseconds, refreshed every 30 s; `null` before hydration. */
export function useNow(): number | null {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
