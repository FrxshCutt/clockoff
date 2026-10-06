import { CardSkeleton } from "@/components/loading-skeletons";
import { PageHeader } from "@/components/page-header";
import { BackLink } from "@/components/placeholder-page";
import { Skeleton } from "@/components/ui/skeleton";
import { ROUTES } from "@/config/navigation";

/**
 * Loading frame for `/employees/[id]`. The page keeps its title slot — exactly one `<h1>` per page, read as
 * "Loading employee…" — with a placeholder where the name will go, so the heading outline never flickers
 * between zero and one `<h1>`. Used by the route's `loading.tsx` and by the client page while the employee
 * loads. No hooks, so it renders on the server too.
 */
export function EmployeeDetailSkeleton() {
  return (
    <div role="status" aria-live="polite" aria-busy="true" className="space-y-6">
      <PageHeader
        eyebrow={<BackLink href={ROUTES.employees}>Employees</BackLink>}
        title={
          <>
            <span className="sr-only">Loading employee…</span>
            {/* A span (phrasing content) keeps the h1 valid; same look as <Skeleton>. */}
            <span
              className="bg-accent inline-block h-8 w-64 max-w-full animate-pulse rounded-md align-middle"
              aria-hidden="true"
            />
          </>
        }
      />
      <div className="-mt-2 mb-6 flex flex-wrap gap-2" aria-hidden="true">
        <Skeleton className="h-6 w-24 rounded-full" />
        <Skeleton className="h-6 w-28 rounded-full" />
      </div>
      <div className="flex gap-4 border-b pb-3" aria-hidden="true">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-4 w-16" />
        ))}
      </div>
      <div className="grid gap-6 lg:grid-cols-2" aria-hidden="true">
        {Array.from({ length: 4 }, (_, i) => (
          <CardSkeleton key={i} lines={4} />
        ))}
      </div>
    </div>
  );
}
