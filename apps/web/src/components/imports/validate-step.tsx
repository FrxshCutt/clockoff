"use client";

import type { ValidateImportResponse } from "@workmode/validation/imports";
import { ArrowLeft, LoaderCircle } from "lucide-react";
import { useEffect, useRef } from "react";
import { ErrorState } from "@/components/error-state";
import { InlineAlert } from "@/components/inline-alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { formatNumber } from "@/lib/format";
import { useValidateImport } from "./import-queries";

export interface ValidateStepProps {
  importId: string;
  rowCount: number;
  canImport: boolean;
  onValidated: (response: ValidateImportResponse) => void;
  onBack: () => void;
}

/**
 * Step 3: `POST /api/imports/:id/validate` runs as soon as the step opens (once per import), then hands the
 * summary to the review step. Failures show a retry; a view-only role sees why nothing happens.
 */
export function ValidateStep({ importId, rowCount, canImport, onValidated, onBack }: ValidateStepProps) {
  const validate = useValidateImport(importId);
  const startedFor = useRef<string | null>(null);
  const { mutate } = validate;

  useEffect(() => {
    if (!canImport || startedFor.current === importId) return;
    startedFor.current = importId;
    mutate(undefined, { onSuccess: onValidated });
  }, [canImport, importId, mutate, onValidated]);

  if (!canImport) {
    return (
      <div className="space-y-4">
        <InlineAlert variant="info" title="View only">
          Your role can view this import but not run validation.
        </InlineAlert>
        <Button type="button" variant="outline" onClick={onBack}>
          <ArrowLeft aria-hidden="true" />
          Back
        </Button>
      </div>
    );
  }

  if (validate.isError) {
    return (
      <ErrorState
        title="Couldn't validate the file"
        error={validate.error}
        onRetry={() => mutate(undefined, { onSuccess: onValidated })}
        isRetrying={validate.isPending}
        actions={
          <Button type="button" variant="ghost" size="sm" onClick={onBack}>
            <ArrowLeft aria-hidden="true" />
            Back to mapping
          </Button>
        }
      />
    );
  }

  return (
    <div className="bg-card/50 flex flex-col items-center justify-center gap-4 rounded-xl border border-dashed px-6 py-16 text-center" role="status" aria-live="polite">
      <LoaderCircle className="text-primary size-8 animate-spin" aria-hidden="true" />
      <div className="max-w-md space-y-1.5">
        <h2 className="text-foreground text-lg font-semibold tracking-tight">Checking {formatNumber(rowCount)} {rowCount === 1 ? "row" : "rows"}…</h2>
        <p className="text-muted-foreground text-sm">Dates, times, employees, locations and overlaps with existing shifts.</p>
      </div>
      <div className="w-full max-w-md space-y-2" aria-hidden="true">
        <Skeleton className="h-3 w-full" />
        <Skeleton className="h-3 w-5/6" />
        <Skeleton className="h-3 w-2/3" />
      </div>
    </div>
  );
}
