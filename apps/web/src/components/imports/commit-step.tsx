"use client";

import type {
  CommitImportResponse,
  ImportSummaryResponse,
  ShiftImport,
} from "@clockoff/validation/imports";
import { ArrowLeft, CalendarCheck, LoaderCircle } from "lucide-react";
import { useId, useState } from "react";
import { FormErrorAlert } from "@/components/forms/form-fields";
import { InlineAlert } from "@/components/inline-alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { hasErrorCode } from "@/lib/api-client";
import { formatNumber } from "@/lib/format";
import { useCommitImport } from "./import-queries";
import { planCommit } from "./import-wizard-model";

export interface CommitStepProps {
  record: ShiftImport;
  summary: ImportSummaryResponse;
  canImport: boolean;
  onCommitted: (response: CommitImportResponse) => void;
  onBack: () => void;
}

/**
 * Step 5: confirm what will be created. Warnings import by default; rows with errors block the commit
 * unless the manager chooses to leave them out (`skipErrors`).
 */
export function CommitStep({ record, summary, canImport, onCommitted, onBack }: CommitStepProps) {
  const id = useId();
  const [includeWarnings, setIncludeWarnings] = useState(true);
  const [skipErrors, setSkipErrors] = useState(false);
  const commit = useCommitImport(record.id);
  const plan = planCommit(summary, { includeWarnings, skipErrors });

  const submit = async () => {
    if (!canImport || plan.blockedByErrors || plan.willImport === 0) return;
    try {
      const response = await commit.mutateAsync({ includeWarnings, skipErrors });
      onCommitted(response);
    } catch {
      // Shown inline below.
    }
  };

  return (
    <div className="space-y-6">
      {!canImport ? (
        <InlineAlert variant="info" title="View only">
          Your role can view this import but not create the shifts.
        </InlineAlert>
      ) : null}

      <dl className="grid gap-4 sm:grid-cols-3">
        <div className="bg-card rounded-xl border p-5 shadow-xs">
          <dt className="text-muted-foreground text-sm">Shifts to create</dt>
          <dd className="mt-1 text-3xl font-semibold tracking-tight tabular-nums">
            {formatNumber(plan.willImport)}
          </dd>
        </div>
        <div className="bg-card rounded-xl border p-5 shadow-xs">
          <dt className="text-muted-foreground text-sm">Rows left out</dt>
          <dd className="mt-1 text-3xl font-semibold tracking-tight tabular-nums">
            {formatNumber(plan.willSkip)}
          </dd>
        </div>
        <div className="bg-card rounded-xl border p-5 shadow-xs">
          <dt className="text-muted-foreground text-sm">Rows with errors</dt>
          <dd className="mt-1 text-3xl font-semibold tracking-tight tabular-nums">
            {formatNumber(summary.error)}
          </dd>
        </div>
      </dl>

      <fieldset className="space-y-3" disabled={!canImport || commit.isPending}>
        <legend className="text-sm font-semibold">Options</legend>
        <div className="flex items-start gap-3 rounded-lg border p-4">
          <Checkbox
            id={`${id}-warnings`}
            checked={includeWarnings}
            onCheckedChange={(checked) => setIncludeWarnings(checked === true)}
            className="mt-0.5"
          />
          <div className="space-y-1">
            <Label htmlFor={`${id}-warnings`}>
              Import rows with warnings ({formatNumber(summary.warning)})
            </Label>
            <p className="text-muted-foreground text-sm">
              Overnight shifts, clock-change adjustments and similar notes. Untick to leave them
              out.
            </p>
          </div>
        </div>
        {summary.error > 0 ? (
          <div className="flex items-start gap-3 rounded-lg border p-4">
            <Checkbox
              id={`${id}-errors`}
              checked={skipErrors}
              onCheckedChange={(checked) => setSkipErrors(checked === true)}
              className="mt-0.5"
            />
            <div className="space-y-1">
              <Label htmlFor={`${id}-errors`}>
                Skip rows with errors ({formatNumber(summary.error)})
              </Label>
              <p className="text-muted-foreground text-sm">
                They stay in the report so you can fix them in the source file and import them
                later.
              </p>
            </div>
          </div>
        ) : null}
      </fieldset>

      {plan.blockedByErrors ? (
        <InlineAlert variant="warning" title="Rows with errors block the import">
          Go back and fix or skip them, or tick &ldquo;Skip rows with errors&rdquo; to import the
          rest.
        </InlineAlert>
      ) : plan.willImport === 0 ? (
        <InlineAlert variant="info" title="Nothing to import">
          No rows would be created with these options.
        </InlineAlert>
      ) : null}

      {commit.error ? (
        hasErrorCode(commit.error, "IMPORT_HAS_ERRORS") ? (
          <InlineAlert variant="danger" title="Some rows still have errors">
            Tick &ldquo;Skip rows with errors&rdquo; or go back and fix them, then try again.
          </InlineAlert>
        ) : (
          <FormErrorAlert error={commit.error} title="Couldn't import the shifts" />
        )
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button type="button" variant="outline" onClick={onBack} disabled={commit.isPending}>
          <ArrowLeft aria-hidden="true" />
          Back to review
        </Button>
        <Button
          type="button"
          onClick={() => void submit()}
          disabled={!canImport || plan.blockedByErrors || plan.willImport === 0 || commit.isPending}
          aria-busy={commit.isPending || undefined}
        >
          {commit.isPending ? (
            <LoaderCircle className="animate-spin" aria-hidden="true" />
          ) : (
            <CalendarCheck aria-hidden="true" />
          )}
          {commit.isPending
            ? "Importing…"
            : `Import ${formatNumber(plan.willImport)} ${plan.willImport === 1 ? "shift" : "shifts"}`}
        </Button>
      </div>
    </div>
  );
}
