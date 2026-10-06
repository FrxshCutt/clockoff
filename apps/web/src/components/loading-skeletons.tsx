import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/** Loading placeholders. Each announces "Loading…" once to screen readers and hides the shapes. */

function LoadingLabel({ label = "Loading…" }: { label?: string }) {
  return <span className="sr-only">{label}</span>;
}

export function PageHeaderSkeleton({ withActions = true }: { withActions?: boolean }) {
  return (
    <div
      className="flex flex-col gap-4 pb-6 sm:flex-row sm:items-end sm:justify-between"
      aria-hidden="true"
    >
      <div className="space-y-2.5">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-72 max-w-full" />
      </div>
      {withActions ? <Skeleton className="h-9 w-32" /> : null}
    </div>
  );
}

export function CardSkeleton({ lines = 3, className }: { lines?: number; className?: string }) {
  return (
    <div className={cn("bg-card space-y-3 rounded-xl border p-5", className)} aria-hidden="true">
      <Skeleton className="h-5 w-40" />
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} className={cn("h-4", i === lines - 1 ? "w-2/3" : "w-full")} />
      ))}
    </div>
  );
}

export function MetricCardsSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="bg-card space-y-3 rounded-xl border p-5">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-8 w-16" />
        </div>
      ))}
    </div>
  );
}

export function TableSkeleton({
  rows = 6,
  columns = 4,
  className,
}: {
  rows?: number;
  columns?: number;
  className?: string;
}) {
  return (
    <div className={cn("bg-card overflow-hidden rounded-xl border", className)} aria-hidden="true">
      <div className="bg-muted/40 flex gap-4 border-b px-4 py-3">
        {Array.from({ length: columns }, (_, i) => (
          <Skeleton key={i} className="h-4 flex-1" />
        ))}
      </div>
      {Array.from({ length: rows }, (_, r) => (
        <div key={r} className="flex gap-4 border-b px-4 py-3.5 last:border-0">
          {Array.from({ length: columns }, (_, c) => (
            <Skeleton key={c} className={cn("h-4 flex-1", c === 0 && "max-w-48")} />
          ))}
        </div>
      ))}
    </div>
  );
}

export function FormSkeleton({ fields = 3 }: { fields?: number }) {
  return (
    <div className="space-y-5" aria-hidden="true">
      {Array.from({ length: fields }, (_, i) => (
        <div key={i} className="space-y-2">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-9 w-full" />
        </div>
      ))}
      <Skeleton className="h-9 w-28" />
    </div>
  );
}

/** Generic page body: header + metric row + table. Used by route `loading.tsx` files. */
export function PageSkeleton({ label }: { label?: string }) {
  return (
    <div role="status" aria-live="polite" className="space-y-6">
      <LoadingLabel label={label} />
      <PageHeaderSkeleton />
      <TableSkeleton />
    </div>
  );
}

/**
 * The whole dashboard frame (sidebar + top bar + body) shown while the session loads, so the shell never
 * flashes unauthenticated or half-rendered content.
 */
export function FullPageShellSkeleton({ label = "Loading your workspace…" }: { label?: string }) {
  return (
    <div role="status" aria-live="polite" className="bg-background flex min-h-svh w-full">
      <LoadingLabel label={label} />
      <div
        className="bg-sidebar hidden w-64 shrink-0 flex-col gap-6 border-r p-4 md:flex"
        aria-hidden="true"
      >
        <div className="flex items-center gap-2.5">
          <Skeleton className="size-8 rounded-lg" />
          <Skeleton className="h-4 w-28" />
        </div>
        {[5, 3, 3].map((count, group) => (
          <div key={group} className="space-y-2.5">
            <Skeleton className="h-3 w-20" />
            {Array.from({ length: count }, (_, i) => (
              <div key={i} className="flex items-center gap-2.5">
                <Skeleton className="size-4 rounded" />
                <Skeleton className="h-4 flex-1" />
              </div>
            ))}
          </div>
        ))}
      </div>
      <div className="flex min-w-0 flex-1 flex-col" aria-hidden="true">
        <div className="flex h-14 items-center gap-3 border-b px-4">
          <Skeleton className="size-7" />
          <Skeleton className="h-4 w-32" />
          <div className="ml-auto flex items-center gap-2">
            <Skeleton className="size-8 rounded-full" />
            <Skeleton className="size-8 rounded-full" />
          </div>
        </div>
        <div className="mx-auto w-full max-w-7xl space-y-6 px-4 py-6 sm:px-6 lg:px-8 lg:py-8">
          <PageHeaderSkeleton />
          <MetricCardsSkeleton />
          <TableSkeleton rows={5} />
        </div>
      </div>
    </div>
  );
}
