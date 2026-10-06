import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { EmptyState } from "@/components/empty-state";
import { PageHeader } from "@/components/page-header";
import { Button } from "@/components/ui/button";
import { EMPTY_STATES, type EmptyStateCopy, type EmptyStateKey } from "@/config/emptyStates";

function ActionButton({
  action,
  variant,
}: {
  action: NonNullable<EmptyStateCopy["action"]>;
  variant: "default" | "outline";
}) {
  if (action.href) {
    return (
      <Button asChild variant={variant}>
        <Link href={action.href}>{action.label}</Link>
      </Button>
    );
  }
  // The flow behind this action is still being built: show it, but don't pretend it works.
  return (
    <Button type="button" variant={variant} disabled title="Coming soon">
      {action.label}
    </Button>
  );
}

export interface PlaceholderPageProps {
  title: string;
  description?: ReactNode;
  emptyState: EmptyStateKey;
  /** Extra header actions. */
  actions?: ReactNode;
  /** Small content above the title, e.g. `<BackLink>`. */
  eyebrow?: ReactNode;
  /** Content above the empty state (e.g. a summary card). */
  children?: ReactNode;
  /**
   * Show the "being built" note. Defaults to true when an action has no destination yet; pass true for
   * pages whose own flow is still to come (e.g. create forms).
   */
  inProgress?: boolean;
}

/** "← Employees" link above a detail page title. */
export function BackLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      className="text-muted-foreground hover:text-foreground focus-visible:ring-ring/50 inline-flex items-center gap-1 rounded-sm text-sm font-medium outline-none focus-visible:ring-[3px]"
    >
      <ArrowLeft className="size-4" aria-hidden="true" />
      {children}
    </Link>
  );
}

/**
 * Standard frame for a dashboard page whose body is not built yet: PageHeader + the configured EmptyState.
 * Feature work replaces the EmptyState with the real body and keeps the header.
 */
export function PlaceholderPage({
  title,
  description,
  emptyState,
  actions,
  eyebrow,
  children,
  inProgress,
}: PlaceholderPageProps) {
  const copy: EmptyStateCopy = EMPTY_STATES[emptyState];
  const pending =
    inProgress ??
    Boolean(
      (copy.action && !copy.action.href) || (copy.secondaryAction && !copy.secondaryAction.href),
    );
  return (
    <>
      <PageHeader title={title} description={description} actions={actions} eyebrow={eyebrow} />
      {children}
      <EmptyState
        icon={copy.icon}
        title={copy.title}
        description={copy.description}
        action={copy.action ? <ActionButton action={copy.action} variant="default" /> : undefined}
        secondaryAction={
          copy.secondaryAction ? (
            <ActionButton action={copy.secondaryAction} variant="outline" />
          ) : undefined
        }
      >
        {pending ? (
          <p className="text-muted-foreground text-xs">This section is being built.</p>
        ) : null}
      </EmptyState>
    </>
  );
}
