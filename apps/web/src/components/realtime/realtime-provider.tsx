"use client";

import { useContext, useMemo, type ReactNode } from "react";
import {
  RealtimeContext,
  useRealtimeConnection,
  type RealtimeContextValue,
} from "@/hooks/useRealtime";

export interface RealtimeProviderProps {
  children: ReactNode;
  /** Set false to render children without opening the stream (e.g. while signed out). Default true. */
  enabled?: boolean;
}

/**
 * Opens the organisation's realtime stream for everything beneath it and exposes the connection status
 * through `useRealtime()`. Nesting is safe: a provider already active above simply passes children
 * through, so pages can mount their own until the dashboard layout mounts one globally.
 */
export function RealtimeProvider({ children, enabled = true }: RealtimeProviderProps) {
  const parent = useContext(RealtimeContext);
  if (parent.active) return <>{children}</>;
  return <RealtimeConnection enabled={enabled}>{children}</RealtimeConnection>;
}

function RealtimeConnection({ children, enabled }: { children: ReactNode; enabled: boolean }) {
  const { status, connecting } = useRealtimeConnection({ enabled });
  const value = useMemo<RealtimeContextValue>(
    () => ({ status, active: enabled, connecting: enabled && connecting }),
    [status, enabled, connecting],
  );
  return <RealtimeContext.Provider value={value}>{children}</RealtimeContext.Provider>;
}
