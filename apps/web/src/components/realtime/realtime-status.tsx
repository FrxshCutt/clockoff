"use client";

import { TONE_CLASSES, TONE_DOT_CLASSES } from "@/components/status/statusMeta";
import { useRealtime } from "@/hooks/useRealtime";
import { cn } from "@/lib/utils";
import { REALTIME_CONNECTING_META, REALTIME_STATUS_META } from "./realtime-model";

/**
 * "Connecting…" / "Live" / "Reconnecting…" / "Refreshing every 30 s" pill for page headers. Renders nothing
 * when no `<RealtimeProvider>` is mounted. Colour is never the only signal: the label changes with the status.
 */
export function RealtimeStatusIndicator({ className }: { className?: string }) {
  const { status, active, connecting } = useRealtime();
  if (!active) return null;
  const meta = connecting ? REALTIME_CONNECTING_META : REALTIME_STATUS_META[status];
  return (
    <span
      role="status"
      aria-live="polite"
      data-realtime-status={connecting ? "connecting" : status}
      title={meta.description}
      className={cn(
        "inline-flex h-8 shrink-0 items-center gap-2 rounded-full border px-3 text-xs font-medium whitespace-nowrap",
        TONE_CLASSES[meta.tone],
        className,
      )}
    >
      <span
        aria-hidden="true"
        className={cn(
          "size-2 rounded-full",
          TONE_DOT_CLASSES[meta.tone],
          !connecting && status === "connected" && "animate-pulse",
        )}
      />
      {meta.label}
      <span className="sr-only">. {meta.description}</span>
    </span>
  );
}
