"use client";

import Link from "next/link";
import { useEffect } from "react";
import { BrandLogo } from "@/components/brand";
import { ErrorState } from "@/components/error-state";
import { Button } from "@/components/ui/button";
import { ROUTES } from "@/config/navigation";

/**
 * Root error boundary. Shows friendly copy and a retry; never the error message or stack (those can contain
 * internals). The digest lets support match the server log entry.
 */
export default function GlobalRouteError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <main id="main-content" tabIndex={-1} className="flex min-h-svh flex-col items-center justify-center gap-8 p-4 outline-none">
      <BrandLogo />
      <ErrorState
        className="bg-card w-full max-w-lg border-solid"
        title="Something went wrong"
        description="An unexpected error stopped this page from loading. Try again, or head back to your overview."
        onRetry={reset}
        actions={
          <Button asChild variant="ghost" size="sm">
            <Link href={ROUTES.overview}>Go to overview</Link>
          </Button>
        }
      />
      {error.digest ? (
        <p className="text-muted-foreground text-xs">
          Reference: <span className="font-mono">{error.digest}</span>
        </p>
      ) : null}
    </main>
  );
}
