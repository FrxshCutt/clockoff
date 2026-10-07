import {
  CANNOT_SEE,
  CAN_SEE,
  EMPLOYEE_PRIVACY_SUMMARY,
  type PrivacyStatement,
} from "@clockoff/shared/privacyStatements";
import { Check, X } from "lucide-react";
import type { ReactNode } from "react";
import { SITE } from "@/config/site";
import { cn } from "@/lib/utils";

export interface PrivacyStatementListProps {
  items: readonly PrivacyStatement[];
  /** "can" renders ticks, "cannot" crosses. */
  tone: "can" | "cannot";
  /** Show only the first N items (the marketing home teases the full page). */
  limit?: number;
  className?: string;
}

/** Renders CAN_SEE / CANNOT_SEE statements from `@clockoff/shared/privacyStatements`, one `<li>` per statement. */
export function PrivacyStatementList({ items, tone, limit, className }: PrivacyStatementListProps) {
  const shown = limit === undefined ? items : items.slice(0, limit);
  return (
    <ul className={cn("space-y-3", className)} data-tone={tone}>
      {shown.map((item) => (
        <li key={item.key} data-key={item.key} className="flex gap-3 text-sm">
          {tone === "can" ? (
            <Check
              className="mt-0.5 size-4 shrink-0 text-emerald-600 dark:text-emerald-400"
              aria-hidden="true"
            />
          ) : (
            <X className="text-destructive mt-0.5 size-4 shrink-0" aria-hidden="true" />
          )}
          <span>
            <span className="block font-medium">{item.label}</span>
            <span className="text-muted-foreground block leading-relaxed">{item.detail}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

export interface PrivacyExplainerProps {
  /** Heading level for the two column titles (3 inside a titled card, 2 on a bare page). */
  headingLevel?: 2 | 3;
  /** Extra content under the columns (e.g. a link to the full privacy page). */
  footer?: ReactNode;
  limit?: number;
  className?: string;
}

/**
 * What managers can and cannot see, side by side, straight from the shared privacy statements, plus the
 * plain-language summary employees are shown in the app.
 */
export function PrivacyExplainer({
  headingLevel = 3,
  footer,
  limit,
  className,
}: PrivacyExplainerProps) {
  const Heading = headingLevel === 2 ? "h2" : "h3";
  return (
    <div className={cn("space-y-6", className)}>
      <div className="grid gap-6 lg:grid-cols-2">
        <section aria-labelledby="privacy-can-see" className="space-y-4">
          <Heading id="privacy-can-see" className="flex items-center gap-2 font-semibold">
            <Check className="size-4 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
            What managers can see
          </Heading>
          <p className="text-muted-foreground text-sm">Operational status only.</p>
          <PrivacyStatementList items={CAN_SEE} tone="can" limit={limit} />
        </section>
        <section aria-labelledby="privacy-cannot-see" className="space-y-4">
          <Heading id="privacy-cannot-see" className="flex items-center gap-2 font-semibold">
            <X className="text-destructive size-4" aria-hidden="true" />
            What managers can never see
          </Heading>
          <p className="text-muted-foreground text-sm">{SITE.privacyLine}</p>
          <PrivacyStatementList items={CANNOT_SEE} tone="cannot" limit={limit} />
        </section>
      </div>
      <blockquote className="bg-muted/50 border-primary/40 rounded-lg border-l-4 px-4 py-3 text-sm leading-relaxed">
        <p className="text-muted-foreground mb-1 text-xs font-medium tracking-wide uppercase">
          What employees are told
        </p>
        <p>{EMPLOYEE_PRIVACY_SUMMARY}</p>
      </blockquote>
      {footer}
    </div>
  );
}
