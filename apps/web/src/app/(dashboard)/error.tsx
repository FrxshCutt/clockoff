"use client";

import Link from "next/link";
import { useEffect } from "react";
import { ErrorState } from "@/components/error-state";
import { Button } from "@/components/ui/button";
import { ROUTES } from "@/config/navigation";

/**
 * Error boundary for dashboard pages: keeps the sidebar and top bar, replaces only the page body. Never shows
 * the raw error message or stack; the digest lets support match the server log.
 */
export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="space-y-4 py-8">
      <ErrorState
        title="This page couldn't load"
        description="Something went wrong while loading this page. Try again, or go back to your overview."
        onRetry={reset}
        actions={
          <Button asChild variant="ghost" size="sm">
            <Link href={ROUTES.overview}>Go to overview</Link>
          </Button>
        }
      />
      {error.digest ? (
        <p className="text-muted-foreground text-center text-xs">
          Reference: <span className="font-mono">{error.digest}</span>
        </p>
      ) : null}
    </div>
  );
}
