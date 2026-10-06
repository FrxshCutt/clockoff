import type { StatusTone } from "@workmode/shared/status/statusMeta";
import type { ReactNode } from "react";
import { TONE_CLASSES, TONE_DOT_CLASSES } from "@/components/status/statusMeta";
import { cn } from "@/lib/utils";

export interface TonedBadgeProps {
  tone: StatusTone;
  children: ReactNode;
  /** Native tooltip + screen-reader description. */
  description?: string;
  size?: "sm" | "md";
  className?: string;
}

/**
 * A pill in one of the status tones for enums that have no `StatusBadge` kind yet (Screen Time permission
 * state, app selection state, active/inactive). Same palette as `StatusBadge`, with a dot instead of an icon
 * so colour is never the only signal.
 */
export function TonedBadge({ tone, children, description, size = "md", className }: TonedBadgeProps) {
  return (
    <span
      data-slot="toned-badge"
      data-tone={tone}
      title={description}
      className={cn(
        "inline-flex w-fit shrink-0 items-center gap-1.5 rounded-full border font-medium whitespace-nowrap",
        size === "md" ? "h-6 px-2.5 text-xs" : "h-5 px-2 text-[11px]",
        TONE_CLASSES[tone],
        className,
      )}
    >
      <span aria-hidden="true" className={cn("size-1.5 rounded-full", TONE_DOT_CLASSES[tone])} />
      <span>{children}</span>
      {description ? <span className="sr-only">: {description}</span> : null}
    </span>
  );
}
