"use client";

import { useQueryClient, type QueryKey } from "@tanstack/react-query";
import { REALTIME_EVENT_TYPES } from "@clockoff/validation/realtime";
import { createContext, useContext, useEffect, useState } from "react";
import {
  REALTIME_ALL_KEYS,
  REALTIME_STREAM_PATH,
  REALTIME_TIMING,
  invalidationKeysFor,
  isPollingFallbackDue,
  nextBackoffMs,
  parseSseEvent,
  statusWhileDisconnected,
  type RealtimeStatus,
} from "@/components/realtime/realtime-model";

export type { RealtimeStatus };

export interface RealtimeContextValue {
  readonly status: RealtimeStatus;
  /** False when no `<RealtimeProvider>` is mounted above the caller (nothing is live or polling). */
  readonly active: boolean;
  /**
   * True until the stream has opened (or failed) once. `status` is "reconnecting" meanwhile, but nothing has
   * actually dropped yet, so the indicator shows a neutral "Connecting…" rather than a warning.
   */
  readonly connecting: boolean;
}

const INACTIVE: RealtimeContextValue = { status: "polling", active: false, connecting: false };

export const RealtimeContext = createContext<RealtimeContextValue>(INACTIVE);

/**
 * Connection status of the organisation's realtime stream: `connected` (SSE open), `reconnecting` (a short
 * drop, retrying with backoff) or `polling` (down for more than 10 s; affected queries refetch every 30 s
 * until the stream is back). Reads from the nearest `<RealtimeProvider>`.
 */
export function useRealtime(): RealtimeContextValue {
  return useContext(RealtimeContext);
}

type Timer = ReturnType<typeof setTimeout>;

export interface RealtimeConnectionState {
  readonly status: RealtimeStatus;
  /** See `RealtimeContextValue.connecting`. */
  readonly connecting: boolean;
}

const INITIAL_STATE: RealtimeConnectionState = { status: "reconnecting", connecting: true };

/**
 * Owns one `EventSource` to `GET /api/realtime/stream` and turns every frame into React Query invalidations
 * (events are hints, never data — §5). Reconnects with jittered exponential backoff; after 10 s without a
 * connection it falls back to invalidating every realtime-backed query every 30 s. Mounted once by
 * `<RealtimeProvider>`; pages call `useRealtime()` for the status.
 */
export function useRealtimeConnection(
  options: { enabled?: boolean } = {},
): RealtimeConnectionState {
  const enabled = options.enabled ?? true;
  const queryClient = useQueryClient();
  const [state, setState] = useState<RealtimeConnectionState>(INITIAL_STATE);

  useEffect(() => {
    if (!enabled || typeof window === "undefined" || typeof EventSource === "undefined") return;

    let source: EventSource | null = null;
    let reconnectTimer: Timer | null = null;
    let pollingFlipTimer: Timer | null = null;
    let flushTimer: Timer | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let attempt = 0;
    let disconnectedSince: number | null = null;
    let disposed = false;
    const pending = new Map<string, QueryKey>();

    /** Every transition means the stream has been heard from (opened or failed), so "connecting" is over. */
    const setStatus = (status: RealtimeStatus) => setState({ status, connecting: false });

    const clearTimer = (timer: Timer | null) => {
      if (timer !== null) clearTimeout(timer);
    };

    const flush = () => {
      flushTimer = null;
      const keys = [...pending.values()];
      pending.clear();
      for (const key of keys) void queryClient.invalidateQueries({ queryKey: key });
    };

    /** Coalesces a burst of events into one invalidation per key. */
    const invalidate = (keys: readonly QueryKey[]) => {
      if (disposed) return;
      for (const key of keys) pending.set(JSON.stringify(key), key);
      if (flushTimer === null) flushTimer = setTimeout(flush, REALTIME_TIMING.coalesceMs);
    };

    const startPolling = () => {
      if (pollTimer !== null) return;
      pollTimer = setInterval(() => invalidate(REALTIME_ALL_KEYS), REALTIME_TIMING.pollIntervalMs);
    };
    const stopPolling = () => {
      if (pollTimer !== null) clearInterval(pollTimer);
      pollTimer = null;
    };

    const onFrame = (event: Event) => {
      const parsed = parseSseEvent((event as MessageEvent).data);
      if (!parsed) return;
      invalidate(invalidationKeysFor(parsed.type));
    };

    const onOpen = () => {
      attempt = 0;
      const wasDisconnected = disconnectedSince !== null;
      disconnectedSince = null;
      clearTimer(pollingFlipTimer);
      pollingFlipTimer = null;
      stopPolling();
      setStatus("connected");
      // Anything that happened while the stream was down was missed: refresh everything once.
      if (wasDisconnected) invalidate(REALTIME_ALL_KEYS);
    };

    const onError = () => {
      // EventSource would retry on its own schedule; close it so the backoff below is the only retry path.
      source?.close();
      source = null;
      const now = Date.now();
      if (disconnectedSince === null) {
        disconnectedSince = now;
        pollingFlipTimer = setTimeout(() => {
          pollingFlipTimer = null;
          if (disposed) return;
          setStatus("polling");
          startPolling();
        }, REALTIME_TIMING.pollingAfterMs);
      }
      setStatus(statusWhileDisconnected(disconnectedSince, now));
      if (isPollingFallbackDue(disconnectedSince, now)) startPolling();
      reconnectTimer = setTimeout(connect, nextBackoffMs(attempt));
      attempt += 1;
    };

    function connect() {
      reconnectTimer = null;
      if (disposed) return;
      const next = new EventSource(REALTIME_STREAM_PATH, { withCredentials: true });
      next.onopen = onOpen;
      next.onerror = onError;
      // Frames carry `event: <type>`, which the default `message` handler does not receive.
      for (const type of REALTIME_EVENT_TYPES) next.addEventListener(type, onFrame);
      next.onmessage = onFrame;
      source = next;
    }

    connect();

    return () => {
      disposed = true;
      source?.close();
      source = null;
      clearTimer(reconnectTimer);
      clearTimer(pollingFlipTimer);
      clearTimer(flushTimer);
      stopPolling();
      pending.clear();
    };
  }, [enabled, queryClient]);

  return state;
}
