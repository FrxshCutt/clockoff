"use client";

import { CircleCheck, Circle, PartyPopper, X } from "lucide-react";
import Link from "next/link";
import { ErrorState } from "@/components/error-state";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { useApiErrorToast } from "@/hooks/use-api-error-toast";
import { usePermission } from "@/hooks/use-current-user";
import { useDismissOnboarding } from "@/hooks/use-organisation";
import { useOnboardingProgress } from "@/hooks/useOnboarding";
import { hasErrorCode } from "@/lib/api-client";
import { cn } from "@/lib/utils";

/**
 * "Get set up" checklist from `GET /api/organisations/current/onboarding`: each step links to the page that
 * completes it. Once every step is done the card turns into an "all set" note that owners/admins dismiss
 * (`POST …/onboarding/dismiss`, `org:manage`); it stays hidden after dismissal and is silently absent while
 * the endpoint is unavailable.
 */
export function OnboardingChecklist() {
  const { query, progress } = useOnboardingProgress();
  const { data, isPending, isError, error, refetch, isRefetching } = query;
  const dismiss = useDismissOnboarding();
  const toastError = useApiErrorToast();
  const canDismiss = usePermission("org:manage");

  if (isPending) {
    return (
      <div className="bg-card space-y-4 rounded-xl border p-6" aria-busy="true">
        <Skeleton className="h-5 w-48" />
        <Skeleton className="h-2 w-full" />
        <div className="grid gap-2 sm:grid-cols-2">
          {Array.from({ length: 4 }, (_, i) => (
            <Skeleton key={i} className="h-10" />
          ))}
        </div>
      </div>
    );
  }
  if (isError) {
    // Optional widget: a missing endpoint (or a role that can't see it) leaves the overview as it is.
    if (hasErrorCode(error, "NOT_FOUND", "COMING_SOON", "FORBIDDEN")) return null;
    return (
      <ErrorState
        size="sm"
        title="Couldn't load your setup checklist"
        error={error}
        onRetry={() => void refetch()}
        isRetrying={isRefetching}
      />
    );
  }
  if (!progress || data.dismissedAt || progress.totalCount === 0) return null;

  const allDone = data.complete || progress.allDone;
  const onDismiss = () =>
    dismiss.mutate(undefined, { onError: (err) => toastError(err, { title: "Couldn't dismiss the checklist" }) });

  if (allDone) {
    // Nothing left to do. Only roles that can dismiss see the note; for others it would linger forever.
    if (!canDismiss) return null;
    return (
      <section
        aria-labelledby="onboarding-title"
        className="bg-card flex flex-col gap-4 rounded-xl border p-5 shadow-xs sm:flex-row sm:items-center sm:justify-between sm:p-6"
      >
        <div className="flex items-start gap-4">
          <span
            className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-emerald-50 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300"
            aria-hidden="true"
          >
            <PartyPopper className="size-5" />
          </span>
          <div className="space-y-1">
            <h2 id="onboarding-title" className="font-semibold">
              You&apos;re all set
            </h2>
            <p className="text-muted-foreground text-sm">
              Every setup step is complete. Work Mode will switch on automatically during your employees&apos; shifts.
            </p>
          </div>
        </div>
        <Button type="button" variant="outline" size="sm" disabled={dismiss.isPending} onClick={onDismiss}>
          <X aria-hidden="true" />
          Dismiss checklist
        </Button>
      </section>
    );
  }

  return (
    <section aria-labelledby="onboarding-title" className="bg-card relative overflow-hidden rounded-xl border shadow-xs">
      <div className="from-primary/8 pointer-events-none absolute inset-0 bg-gradient-to-br to-transparent" aria-hidden="true" />
      <div className="relative space-y-5 p-5 sm:p-6">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <h2 id="onboarding-title" className="text-lg font-semibold tracking-tight">
              Get your team set up
            </h2>
            <p className="text-muted-foreground text-sm">
              {progress.completedCount} of {progress.totalCount} steps complete
              {progress.nextStep ? <> · Next: {progress.nextStep.label}</> : null}
            </p>
          </div>
          {canDismiss ? (
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              aria-label="Dismiss setup checklist"
              disabled={dismiss.isPending}
              onClick={onDismiss}
            >
              <X aria-hidden="true" />
            </Button>
          ) : null}
        </div>
        <Progress value={progress.percent} aria-label={`Setup ${progress.percent}% complete`} className="h-2" />
        <ol className="grid gap-2 sm:grid-cols-2">
          {data.items.map((item) => (
            <li key={item.key}>
              <Link
                href={item.href}
                className={cn(
                  "hover:bg-accent/60 focus-visible:ring-ring/50 flex items-center gap-3 rounded-lg border px-3 py-2.5 text-sm transition-colors outline-none focus-visible:ring-[3px]",
                  item.done ? "text-muted-foreground" : "bg-background font-medium",
                )}
              >
                {item.done ? (
                  <CircleCheck className="size-4 shrink-0 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
                ) : (
                  <Circle className="text-muted-foreground size-4 shrink-0" aria-hidden="true" />
                )}
                <span className={cn(item.done && "line-through decoration-1")}>{item.label}</span>
                <span className="sr-only">{item.done ? "(done)" : "(to do)"}</span>
              </Link>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
