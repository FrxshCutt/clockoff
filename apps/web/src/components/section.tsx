import { useId, type ReactNode } from "react";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { cn } from "@/lib/utils";

export interface SectionProps {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}

/** A titled page region (`<section aria-labelledby>`) without a card frame. */
export function Section({ title, description, actions, children, className }: SectionProps) {
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className={cn("space-y-4", className)}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-1">
          <h2 id={headingId} className="text-foreground text-lg font-semibold tracking-tight">
            {title}
          </h2>
          {description ? <p className="text-muted-foreground text-sm">{description}</p> : null}
        </div>
        {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
      </div>
      {children}
    </section>
  );
}

export interface SectionCardProps {
  title: ReactNode;
  description?: ReactNode;
  /** Top-right actions in the card header. */
  actions?: ReactNode;
  /** Footer row, e.g. a save button. Rendered with a top border. */
  footer?: ReactNode;
  children?: ReactNode;
  /** Remove content padding (for full-bleed tables). */
  flush?: boolean;
  /** Visual emphasis for destructive settings. */
  tone?: "default" | "danger";
  className?: string;
  contentClassName?: string;
}

/** A Card with a standard header (title, description, actions), body and optional footer. */
export function SectionCard({
  title,
  description,
  actions,
  footer,
  children,
  flush,
  tone = "default",
  className,
  contentClassName,
}: SectionCardProps) {
  const headingId = useId();
  return (
    <Card
      role="region"
      aria-labelledby={headingId}
      className={cn("gap-0 py-0", tone === "danger" && "border-destructive/40", className)}
    >
      <CardHeader className="border-b px-5 py-5 sm:px-6">
        <CardTitle className={cn("text-base", tone === "danger" && "text-destructive")}>
          <h2 id={headingId}>{title}</h2>
        </CardTitle>
        {description ? <CardDescription>{description}</CardDescription> : null}
        {actions ? <CardAction className="flex items-center gap-2">{actions}</CardAction> : null}
      </CardHeader>
      {children !== undefined ? (
        <CardContent className={cn(flush ? "px-0" : "px-5 py-5 sm:px-6", contentClassName)}>
          {children}
        </CardContent>
      ) : null}
      {footer ? (
        <CardFooter className="bg-muted/40 flex flex-wrap justify-end gap-2 rounded-b-xl border-t px-5 py-3 sm:px-6">
          {footer}
        </CardFooter>
      ) : null}
    </Card>
  );
}
