"use client";

import type { CommitImportResponse, ShiftImport } from "@clockoff/validation/imports";
import { CalendarCheck, Download, FileUp } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { ROUTES } from "@/config/navigation";
import { formatNumber } from "@/lib/format";
import { errorsCsvUrl } from "./import-wizard-model";

export interface SummaryStepProps {
  record: ShiftImport;
  /** The commit response when the import finished in this session; null when resumed afterwards. */
  result: CommitImportResponse | null;
  onStartAnother: () => void;
}

/** Step 6: what happened, with links to the schedule and the problems report. */
export function SummaryStep({ record, result, onStartAnother }: SummaryStepProps) {
  const created = result?.shiftsCreated ?? record.importedCount;
  const skipped = result?.rowsSkipped ?? record.skippedCount;
  const hasReport = record.errorCount + record.warningCount > 0;

  return (
    <div className="space-y-6">
      <div className="bg-card/50 flex flex-col items-center justify-center gap-4 rounded-xl border border-dashed px-6 py-12 text-center">
        <div
          className="flex size-12 items-center justify-center rounded-full bg-emerald-500/10 text-emerald-700 ring-8 ring-emerald-500/10 dark:text-emerald-300"
          aria-hidden="true"
        >
          <CalendarCheck className="size-6" />
        </div>
        <div className="max-w-md space-y-1.5">
          <h2 className="text-foreground text-lg font-semibold tracking-tight">
            {formatNumber(created)} {created === 1 ? "shift" : "shifts"} added to the schedule
          </h2>
          <p className="text-muted-foreground text-sm text-pretty">
            From <span className="text-foreground font-medium">{record.filename}</span>. Work Mode
            switches on automatically when each shift starts.
          </p>
        </div>
      </div>

      <dl className="grid gap-4 sm:grid-cols-4">
        <div className="bg-card rounded-xl border p-5 shadow-xs">
          <dt className="text-muted-foreground text-sm">Shifts created</dt>
          <dd className="mt-1 text-2xl font-semibold tracking-tight tabular-nums">
            {formatNumber(created)}
          </dd>
        </div>
        {result ? (
          <div className="bg-card rounded-xl border p-5 shadow-xs">
            <dt className="text-muted-foreground text-sm">Employees created</dt>
            <dd className="mt-1 text-2xl font-semibold tracking-tight tabular-nums">
              {formatNumber(result.employeesCreated)}
            </dd>
          </div>
        ) : null}
        <div className="bg-card rounded-xl border p-5 shadow-xs">
          <dt className="text-muted-foreground text-sm">Rows skipped</dt>
          <dd className="mt-1 text-2xl font-semibold tracking-tight tabular-nums">
            {formatNumber(skipped)}
          </dd>
        </div>
        <div className="bg-card rounded-xl border p-5 shadow-xs">
          <dt className="text-muted-foreground text-sm">Rows with errors</dt>
          <dd className="mt-1 text-2xl font-semibold tracking-tight tabular-nums">
            {formatNumber(record.errorCount)}
          </dd>
        </div>
      </dl>

      <div className="flex flex-wrap items-center gap-2">
        <Button asChild>
          <Link href={ROUTES.schedule}>View schedule</Link>
        </Button>
        {hasReport ? (
          <Button asChild variant="outline">
            <a href={errorsCsvUrl(record.id)} download>
              <Download aria-hidden="true" />
              Download problems CSV
            </a>
          </Button>
        ) : null}
        <Button type="button" variant="ghost" onClick={onStartAnother}>
          <FileUp aria-hidden="true" />
          Import another file
        </Button>
      </div>
    </div>
  );
}
