"use client";

import { CircleAlert, RefreshCw } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { getErrorMessage } from "@/lib/errorMessages";
import { cn } from "@/lib/utils";

export interface ErrorStateProps {
  title?: string;
  /** Explicit copy; when omitted the message is derived from `error` (never a raw message or stack). */
  description?: ReactNode;
  error?: unknown;
  onRetry?: () => void;
  retryLabel?: string;
  /** Retry in progress (disables the button and spins the icon). */
  isRetrying?: boolean;
  /** Extra actions next to retry (e.g. a link home). */
  actions?: ReactNode;
  size?: "sm" | "md";
  className?: string;
}

export function ErrorState({
  title = "Something went wrong",
  description,
  error,
  onRetry,
  retryLabel = "Try again",
  isRetrying = false,
  actions,
  size = "md",
  className,
}: ErrorStateProps) {
  return (
    <div
      role="alert"
      className={cn(
        "flex flex-col items-center justify-center rounded-xl border border-dashed text-center",
        size === "md" ? "gap-4 px-6 py-16" : "gap-3 px-4 py-8",
        className,
      )}
    >
      <div className="bg-destructive/10 text-destructive flex size-11 items-center justify-center rounded-full" aria-hidden="true">
        <CircleAlert className="size-5" />
      </div>
      <div className="max-w-md space-y-1.5">
        <h2 className="text-foreground text-base font-semibold">{title}</h2>
        <p className="text-muted-foreground text-sm text-pretty">{description ?? getErrorMessage(error)}</p>
      </div>
      {onRetry || actions ? (
        <div className="flex flex-wrap items-center justify-center gap-2">
          {onRetry ? (
            <Button type="button" variant="outline" size="sm" onClick={onRetry} disabled={isRetrying}>
              <RefreshCw className={cn(isRetrying && "animate-spin")} aria-hidden="true" />
              {retryLabel}
            </Button>
          ) : null}
          {actions}
        </div>
      ) : null}
    </div>
  );
}
