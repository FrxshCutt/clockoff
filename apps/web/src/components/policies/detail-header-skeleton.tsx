import { PageHeader } from "@/components/page-header";
import { BackLink } from "@/components/placeholder-page";

export interface DetailHeaderSkeletonProps {
  backHref: string;
  backLabel: string;
  /** Screen-reader text for the heading while the record loads, e.g. "Loading policy…". */
  loadingLabel: string;
  /** Reserve space for the header buttons (default true). */
  withActions?: boolean;
}

/**
 * Page header for a detail page whose record is still loading. It renders the page's single `<h1>` — visually a
 * skeleton bar, `loadingLabel` for assistive tech — so the heading outline is the same before and after the
 * data arrives and the page never has zero (or two) top-level headings. The bars are plain `<span>`s because
 * `PageHeader` wraps the description in a `<p>`.
 */
export function DetailHeaderSkeleton({
  backHref,
  backLabel,
  loadingLabel,
  withActions = true,
}: DetailHeaderSkeletonProps) {
  return (
    <PageHeader
      eyebrow={<BackLink href={backHref}>{backLabel}</BackLink>}
      title={
        <>
          <span className="sr-only">{loadingLabel}</span>
          <span
            aria-hidden="true"
            className="bg-accent inline-block h-7 w-48 max-w-full animate-pulse rounded-md align-middle"
          />
        </>
      }
      description={
        <span
          aria-hidden="true"
          className="bg-accent block h-4 w-72 max-w-full animate-pulse rounded-md"
        />
      }
      actions={
        withActions ? (
          <span
            aria-hidden="true"
            className="bg-accent inline-block h-9 w-32 animate-pulse rounded-md"
          />
        ) : undefined
      }
    />
  );
}
