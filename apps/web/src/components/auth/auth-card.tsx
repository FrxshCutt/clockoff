import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface AuthCardProps {
  title: string;
  description?: ReactNode;
  /** Optional icon above the title (used by result screens: success, expired link…). */
  icon?: LucideIcon;
  iconTone?: "primary" | "success" | "danger";
  /** Extra classes for the icon (e.g. `animate-spin` for a loader). */
  iconClassName?: string;
  children?: ReactNode;
  /** Muted row under the card body, e.g. "Don't have an account? Sign up". */
  footer?: ReactNode;
  className?: string;
}

const ICON_TONES = {
  primary: "bg-primary/10 text-primary",
  success: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400",
  danger: "bg-destructive/10 text-destructive",
} as const;

/** The card every auth page renders inside the centered auth layout. Holds the page's `<h1>`. */
export function AuthCard({
  title,
  description,
  icon: Icon,
  iconTone = "primary",
  iconClassName,
  children,
  footer,
  className,
}: AuthCardProps) {
  return (
    <div className={cn("bg-card text-card-foreground rounded-2xl border shadow-sm", className)}>
      <div className="space-y-6 p-6 sm:p-8">
        <div className="space-y-2 text-center">
          {Icon ? (
            <div
              className={cn(
                "mx-auto mb-4 flex size-12 items-center justify-center rounded-full",
                ICON_TONES[iconTone],
              )}
              aria-hidden="true"
            >
              <Icon className={cn("size-6", iconClassName)} />
            </div>
          ) : null}
          <h1 className="text-2xl font-semibold tracking-tight text-balance">{title}</h1>
          {description ? (
            <p className="text-muted-foreground text-sm text-pretty">{description}</p>
          ) : null}
        </div>
        {children}
      </div>
      {footer ? (
        <div className="bg-muted/40 text-muted-foreground rounded-b-2xl border-t px-6 py-4 text-center text-sm sm:px-8">
          {footer}
        </div>
      ) : null}
    </div>
  );
}

/** Inline text link used inside auth copy. */
export const authLinkClass =
  "text-primary font-medium underline-offset-4 hover:underline focus-visible:ring-ring/50 rounded-sm outline-none focus-visible:ring-[3px]";
