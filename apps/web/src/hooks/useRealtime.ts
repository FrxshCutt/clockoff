"use client";

import { useQueryClient, type QueryKey } from "@tanstack/react-query";
import { REALTIME_EVENT_TYPES, REALTIME_RECONNECT_EVENT } from "@clockoff/validation/realtime";
import { createContext, useContext, useEffect, useState } from "react";
import {
  REALTIME_ALL_KEYS,
  REALTIME_STREAM_PATH,
  REALTIME_TIMING,
  attemptAfterDrop,
  classifyStreamEnd,
  invalidationKeysFor,
  isPollingFallbackDue,
  msUntilPollingFallback,
  nextBackoffMs,
  outageStartedAt,
  parseSseEvent,
  plannedReconnectDelayMs,
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
 * Connection status of the organisation's realtime stream: `connected` (SSE open, including the server's
 * planned reconnects, which do not show unless the replacement stream fails or takes over 10 s to open),
 * `reconnecting` (an unplanned drop, retrying with backoff) or `polling` (down for more than 10 s; affected
 * queries refetch every 30 s until the stream is back). Reads from the nearest `<RealtimeProvider>`.
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
 * (events are hints, never data — §5). Mounted once by `<RealtimeProvider>`; pages call `useRealtime()` for
 * the status. The decisions live in `realtime-model.ts`; this hook only wires them up:
 *
 * - **Planned reconnect.** The server ends every stream after its lifetime cap (and when it shuts down) with
 *   an `event: reconnect` control frame (`REALTIME_RECONNECT_EVENT`). If the stream had been open for `minHealthyStreamMs`, the hook reconnects
 *   after 100–400 ms without changing status (no "Reconnecting…" flash, nothing announced) and without the
 *   refetch-all on reopen. The polling flip is still armed from the close: if the replacement fails it is an
 *   unplanned drop dated from the close, and if it has not opened 10 s after the close the status goes
 *   straight to "polling", exactly when it would have after an unplanned drop.
 * - **Unplanned drop** (network, platform cut, an older server without the frame, or a "planned" close right
 *   after opening): status "reconnecting", jittered exponential backoff — reset only when the stream that
 *   ended had been open for `minHealthyStreamMs`, so a server that closes at once backs off instead of
 *   hot-looping — then everything realtime-backed is refetched once on reopen. After 10 s down it falls back
 *   to invalidating every realtime-backed query every 30 s.
 * - **Explicit refresh.** While connected it invalidates every realtime-backed query every 30 s
 *   (`refreshIntervalMs`), kept across planned reconnects: events raised while the server's listener or this
 *   stream was reconnecting arrive this way.
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
    let refreshTimer: ReturnType<typeof setInterval> | null = null;
    let attempt = 0;
    let disconnectedSince: number | null = null;
    /** When the current source opened (null until it does). */
    let openedAt: number | null = null;
    /** The current source received the server's `reconnect` control frame. */
    let plannedClose = false;
    /** When a planned close ended the last stream, until its replacement opens (or the gap becomes an outage). */
    let plannedGapSince: number | null = null;
    let disposed = false;
    const pending = new Map<string, QueryKey>();

    /**
     * Every transition means the stream has been heard from (opened or failed), so "connecting" is over. An
     * unchanged status keeps the same state object: no re-render, nothing for the live region to announce.
     */
    const setStatus = (status: RealtimeStatus) =>
      setState((current) =>
        current.status === status && !current.connecting ? current : { status, connecting: false },
      );

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

    /** One interval while connected; survives planned reconnects, stopped by an unplanned drop. */
    const startRefresh = () => {
      if (refreshTimer !== null) return;
      refreshTimer = setInterval(
        () => invalidate(REALTIME_ALL_KEYS),
        REALTIME_TIMING.refreshIntervalMs,
      );
    };
    const stopRefresh = () => {
      if (refreshTimer !== null) clearInterval(refreshTimer);
      refreshTimer = null;
    };

    const onFrame = (event: Event) => {
      const parsed = parseSseEvent((event as MessageEvent).data);
      if (!parsed) return;
      invalidate(invalidationKeysFor(parsed.type));
    };

    /**
     * Down for `pollingAfterMs`: fall back to polling. Armed by an unplanned drop, and at a planned close as the
     * watchdog for a replacement that never opens (the outage then dates from that close).
     */
    const flipToPolling = () => {
      pollingFlipTimer = null;
      if (disposed) return;
      disconnectedSince = outageStartedAt({ disconnectedSince, plannedGapSince, now: Date.now() });
      plannedGapSince = null;
      stopRefresh();
      setStatus("polling");
      startPolling();
    };

    const onOpen = () => {
      // The backoff is not reset here: only a stream that stays open resets it (see onError).
      openedAt = Date.now();
      plannedGapSince = null;
      const wasDisconnected = disconnectedSince !== null;
      disconnectedSince = null;
      clearTimer(pollingFlipTimer);
      pollingFlipTimer = null;
      stopPolling();
      startRefresh();
      setStatus("connected");
      // Anything that happened while the stream was down was missed: refresh everything once. A planned
      // reconnect that reopens in time never sets disconnectedSince, so it does not get here.
      if (wasDisconnected) invalidate(REALTIME_ALL_KEYS);
    };

    const onError = () => {
      // EventSource would retry on its own schedule; close it so the paths below are the only retry path.
      source?.close();
      source = null;
      const now = Date.now();
      const end = classifyStreamEnd({ plannedCloseSeen: plannedClose, openedAt, now });
      attempt = attemptAfterDrop(attempt, openedAt, now);
      plannedClose = false;
      openedAt = null;

      if (end === "planned") {
        // The server's lifetime cap: still "connected" as far as anyone can tell. No status change, no
        // refetch on reopen; the refresh interval keeps running. The polling flip is armed from this close
        // in case the replacement stalls before opening (onOpen cancels it).
        plannedGapSince = now;
        clearTimer(pollingFlipTimer);
        pollingFlipTimer = setTimeout(flipToPolling, msUntilPollingFallback(now, now));
        reconnectTimer = setTimeout(connect, plannedReconnectDelayMs());
        return;
      }

      stopRefresh();
      if (disconnectedSince === null) {
        // The outage starts now, or at the planned close when this is that close's replacement failing.
        disconnectedSince = outageStartedAt({ disconnectedSince, plannedGapSince, now });
        clearTimer(pollingFlipTimer);
        pollingFlipTimer = setTimeout(
          flipToPolling,
          msUntilPollingFallback(disconnectedSince, now),
        );
      }
      plannedGapSince = null;
      setStatus(statusWhileDisconnected(disconnectedSince, now));
      if (isPollingFallbackDue(disconnectedSince, now)) startPolling();
      reconnectTimer = setTimeout(connect, nextBackoffMs(attempt));
      attempt += 1;
    };

    function connect() {
      reconnectTimer = null;
      if (disposed) return;
      plannedClose = false;
      openedAt = null;
      const next = new EventSource(REALTIME_STREAM_PATH, { withCredentials: true });
      next.onopen = onOpen;
      next.onerror = onError;
      // Control frame, not an event kind: the server is about to end this stream on purpose.
      next.addEventListener(REALTIME_RECONNECT_EVENT, () => {
        plannedClose = true;
      });
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
      stopRefresh();
      pending.clear();
    };
  }, [enabled, queryClient]);

  return state;
}
