import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface EmptyStateProps {
  icon?: LucideIcon;
  title: string;
  description?: ReactNode;
  /** Primary call to action (usually a `<Button>`). */
  action?: ReactNode;
  secondaryAction?: ReactNode;
  /** Extra content under the actions (e.g. a help link). */
  children?: ReactNode;
  /** `sm` for inside tables/cards, `md` (default) for full sections. */
  size?: "sm" | "md";
  /** Draw a dashed outline (default true). Turn off when already inside a bordered container. */
  bordered?: boolean;
  /** Heading level for the title: 2 on a page (default), 3 inside a titled section or card. */
  headingLevel?: 2 | 3;
  className?: string;
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  secondaryAction,
  children,
  size = "md",
  bordered = true,
  headingLevel = 2,
  className,
}: EmptyStateProps) {
  const Heading = headingLevel === 2 ? "h2" : "h3";
  return (
    <div
      className={cn(
        "flex flex-col items-center justify-center text-center",
        bordered && "bg-card/50 rounded-xl border border-dashed",
        size === "md" ? "gap-4 px-6 py-16" : "gap-3 px-4 py-10",
        className,
      )}
    >
      {Icon ? (
        <div
          className={cn(
            "bg-primary/10 text-primary ring-primary/15 flex items-center justify-center rounded-full ring-8",
            size === "md" ? "size-12" : "size-10",
          )}
          aria-hidden="true"
        >
          <Icon className={size === "md" ? "size-6" : "size-5"} />
        </div>
      ) : null}
      <div className="max-w-md space-y-1.5">
        <Heading
          className={cn(
            "text-foreground font-semibold tracking-tight",
            size === "md" ? "text-lg" : "text-base",
          )}
        >
          {title}
        </Heading>
        {description ? (
          <p className="text-muted-foreground text-sm text-pretty">{description}</p>
        ) : null}
      </div>
      {action || secondaryAction ? (
        <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
          {action}
          {secondaryAction}
        </div>
      ) : null}
      {children}
    </div>
  );
}
