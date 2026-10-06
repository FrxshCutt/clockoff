"use client";

import { useSyncExternalStore } from "react";
import { formatDateTimeLong, formatRelativeTime, toDate, type DateInput } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * A minute-resolution clock shared by every <RelativeTime>: one interval for the whole page, started when
 * the first instance mounts and stopped when the last unmounts.
 */
const TICK_MS = 60_000;
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
    // Refresh immediately so a page left open before mounting doesn't start with a stale clock.
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

export interface RelativeTimeProps {
  value: DateInput | null | undefined;
  /** Zone for the absolute tooltip; defaults to the viewer's. */
  timeZone?: string;
  /** Shown when `value` is missing/invalid. */
  fallback?: string;
  className?: string;
}

/**
 * "5 minutes ago", updated every minute, with the absolute time in the tooltip and `dateTime` attribute.
 * Renders client-side only (the server cannot know the viewer's clock), so the first paint is an empty
 * <time> of the same element type — no hydration mismatch.
 */
export function RelativeTime({ value, timeZone, fallback = "—", className }: RelativeTimeProps) {
  const current = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const date = toDate(value);
  if (!date) return <span className={className}>{fallback}</span>;
  const iso = date.toISOString();
  if (current === null) {
    // Server render / hydration pass: same element, no viewer-dependent text or tooltip.
    return (
      <time dateTime={iso} className={cn("whitespace-nowrap", className)}>
        <span className="invisible">just now</span>
      </time>
    );
  }
  return (
    <time dateTime={iso} title={formatDateTimeLong(date, { timeZone })} className={cn("whitespace-nowrap", className)}>
      {formatRelativeTime(date, current)}
    </time>
  );
}
