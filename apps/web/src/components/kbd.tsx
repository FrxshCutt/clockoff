import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/** Keyboard key hint, e.g. `<Kbd>⌘</Kbd><Kbd>B</Kbd>`. */
export function Kbd({ className, ...props }: ComponentProps<"kbd">) {
  return (
    <kbd
      className={cn(
        "bg-muted text-muted-foreground pointer-events-none inline-flex h-5 min-w-5 items-center justify-center gap-1 rounded border px-1 font-sans text-[11px] font-medium select-none",
        className,
      )}
      {...props}
    />
  );
}

export function KbdGroup({ className, ...props }: ComponentProps<"span">) {
  return <span className={cn("inline-flex items-center gap-1", className)} {...props} />;
}
