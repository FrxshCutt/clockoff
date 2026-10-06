"use client";

import type { ColumnDef, PaginationState } from "@tanstack/react-table";
import type {
  ImportRow,
  ImportSummaryResponse,
  ShiftImport,
  UpdateImportRowInput,
} from "@workmode/validation/imports";
import {
  ArrowLeft,
  ArrowRight,
  CircleAlert,
  Download,
  LoaderCircle,
  RefreshCw,
  RotateCcw,
  SkipForward,
  TriangleAlert,
  UserRoundSearch,
  UserPlus,
} from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { toast } from "sonner";
import { DataTable } from "@/components/data-table";
import { EmptyState } from "@/components/empty-state";
import { InlineAlert } from "@/components/inline-alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useApiErrorToast } from "@/hooks/use-api-error-toast";
import { formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useImportRows, useUpdateImportRow, useValidateImport } from "./import-queries";
import {
  REVIEW_TABS,
  REVIEW_TAB_META,
  clampPage,
  defaultReviewTab,
  errorsCsvUrl,
  isReviewTab,
  problemResolution,
  problemTitle,
  rawCellFor,
  reviewTabCounts,
  rowEmployeeLabel,
  rowFixes,
  rowTimeLabel,
  type ReviewTab,
} from "./import-wizard-model";
import { ChooseEmployeeDialog, CreateEmployeeDialog, LocationFixMenu } from "./row-fix-dialogs";

export interface ReviewStepProps {
  record: ShiftImport;
  summary: ImportSummaryResponse;
  canImport: boolean;
  onContinue: () => void;
  onBack: () => void;
}

const PAGE_SIZE_OPTIONS = [25, 50, 100] as const;

type FixDialog = { kind: "choose"; row: ImportRow } | { kind: "create"; row: ImportRow } | null;

/**
 * Step 4: rows grouped into Valid / Warnings / Errors / Skipped tabs with their parsed values and problems.
 * Fixes are per row (match or create an employee, create/ignore a location, skip or restore); every fix is
 * a PATCH the API re-validates, and the counts come back with it.
 */
export function ReviewStep({ record, summary, canImport, onContinue, onBack }: ReviewStepProps) {
  const [tab, setTab] = useState<ReviewTab>(() => defaultReviewTab(summary));
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(PAGE_SIZE_OPTIONS[0]);
  const [pendingRowId, setPendingRowId] = useState<string | null>(null);
  const [dialog, setDialog] = useState<FixDialog>(null);
  const toastError = useApiErrorToast();

  const rowsQuery = useImportRows({ id: record.id, status: tab, page, pageSize });
  const { mutateAsync: patchRow } = useUpdateImportRow(record.id);
  const revalidate = useValidateImport(record.id);
  const counts = reviewTabCounts(summary);

  const total = rowsQuery.data?.total ?? 0;

  const applyFix = useCallback(
    async (row: ImportRow, input: UpdateImportRowInput) => {
      setPendingRowId(row.id);
      try {
        const response = await patchRow({ rowId: row.id, input });
        // A fix can move the row to another tab and empty the current page: stay on the last page that exists.
        setPage((current) => clampPage(current, Math.max(0, total - 1), pageSize));
        return response;
      } finally {
        setPendingRowId(null);
      }
    },
    [patchRow, total, pageSize],
  );

  /** Inline fixes (skip, restore, location) toast on failure; the dialogs show errors themselves. */
  const quickFix = useCallback(
    (row: ImportRow, input: UpdateImportRowInput, done: string) => {
      void applyFix(row, input)
        .then(() => toast.success(done))
        .catch((error: unknown) => toastError(error, { title: "Couldn't update the row" }));
    },
    [applyFix, toastError],
  );

  const columns = useMemo<ColumnDef<ImportRow>[]>(
    () => [
      {
        id: "rowNumber",
        accessorKey: "rowNumber",
        header: () => (
          <span className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
            Row
          </span>
        ),
        size: 64,
        cell: ({ row }) => (
          <span className="text-muted-foreground tabular-nums">{row.original.rowNumber}</span>
        ),
      },
      {
        id: "employee",
        header: () => (
          <span className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
            Employee
          </span>
        ),
        cell: ({ row }) => {
          const label = rowEmployeeLabel(row.original);
          return (
            <div className="flex min-w-0 flex-col gap-1">
              <span
                className={cn(
                  "truncate font-medium",
                  label.kind === "unmatched" && "text-muted-foreground",
                )}
              >
                {label.label}
              </span>
              {label.kind === "new" ? (
                <Badge variant="secondary" className="w-fit">
                  New employee
                </Badge>
              ) : label.kind === "unmatched" ? (
                <Badge variant="outline" className="w-fit">
                  Not matched
                </Badge>
              ) : null}
            </div>
          );
        },
      },
      {
        id: "date",
        header: () => (
          <span className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
            Date
          </span>
        ),
        cell: ({ row }) => {
          const parsed = row.original.parsed?.date;
          const raw = parsed ? null : rawCellFor(row.original, record.columnMapping, "date");
          return parsed ? (
            <span className="tabular-nums">{parsed}</span>
          ) : (
            <span className="text-muted-foreground font-mono text-xs">{raw ?? "—"}</span>
          );
        },
      },
      {
        id: "time",
        header: () => (
          <span className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
            Time
          </span>
        ),
        cell: ({ row }) => {
          const label = rowTimeLabel(row.original.parsed);
          if (label !== "—") return <span className="tabular-nums">{label}</span>;
          const start = rawCellFor(row.original, record.columnMapping, "start_time");
          const end = rawCellFor(row.original, record.columnMapping, "end_time");
          return (
            <span className="text-muted-foreground font-mono text-xs">
              {start || end ? `${start ?? "?"}–${end ?? "?"}` : "—"}
            </span>
          );
        },
      },
      {
        id: "location",
        header: () => (
          <span className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
            Location
          </span>
        ),
        cell: ({ row }) =>
          row.original.parsed?.locationName ?? <span className="text-muted-foreground">—</span>,
      },
      {
        id: "problems",
        header: () => (
          <span className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
            Problems
          </span>
        ),
        cell: ({ row }) =>
          row.original.problems.length === 0 ? (
            <span className="text-muted-foreground text-xs">None</span>
          ) : (
            <ul className="space-y-1.5">
              {row.original.problems.map((problem, index) => (
                <li
                  key={`${problem.code}-${index}`}
                  className="flex items-start gap-1.5 text-xs leading-4"
                >
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span
                        className="mt-px inline-flex shrink-0"
                        tabIndex={0}
                        aria-label={`${problem.severity === "ERROR" ? "Error" : "Warning"}: ${problemTitle(problem.code)}`}
                      >
                        {problem.severity === "ERROR" ? (
                          <CircleAlert className="text-destructive size-3.5" aria-hidden="true" />
                        ) : (
                          <TriangleAlert
                            className="size-3.5 text-amber-600 dark:text-amber-400"
                            aria-hidden="true"
                          />
                        )}
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="left" className="max-w-xs">
                      {problemResolution(problem.code)}
                    </TooltipContent>
                  </Tooltip>
                  <span className="min-w-0">
                    <span className="font-medium">{problemTitle(problem.code)}</span>
                    <span className="text-muted-foreground"> — {problem.message}</span>
                  </span>
                </li>
              ))}
            </ul>
          ),
      },
      {
        id: "actions",
        header: () => <span className="sr-only">Actions</span>,
        cell: ({ row }) => {
          const fixes = rowFixes(row.original);
          const busy = pendingRowId === row.original.id;
          if (!canImport) return null;
          return (
            <div className="flex flex-wrap items-center justify-end gap-1">
              {busy ? (
                <LoaderCircle
                  className="text-muted-foreground size-4 animate-spin"
                  aria-label="Updating row"
                />
              ) : null}
              {fixes.chooseEmployee ? (
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  disabled={busy}
                  onClick={() => setDialog({ kind: "choose", row: row.original })}
                >
                  <UserRoundSearch aria-hidden="true" />
                  Choose employee
                </Button>
              ) : null}
              {fixes.createEmployee ? (
                <Button
                  type="button"
                  variant="outline"
                  size="xs"
                  disabled={busy}
                  onClick={() => setDialog({ kind: "create", row: row.original })}
                >
                  <UserPlus aria-hidden="true" />
                  Create employee
                </Button>
              ) : null}
              {fixes.location ? (
                <LocationFixMenu
                  locationName={row.original.parsed?.locationName ?? null}
                  disabled={busy}
                  onAction={(action) =>
                    quickFix(
                      row.original,
                      { locationAction: action },
                      action === "CREATE"
                        ? "Location created"
                        : "Row will import without a location",
                    )
                  }
                />
              ) : null}
              {fixes.skip ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  disabled={busy}
                  onClick={() =>
                    quickFix(row.original, { skip: true }, `Row ${row.original.rowNumber} skipped`)
                  }
                >
                  <SkipForward aria-hidden="true" />
                  Skip
                </Button>
              ) : null}
              {fixes.unskip ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  disabled={busy}
                  onClick={() =>
                    quickFix(
                      row.original,
                      { skip: false },
                      `Row ${row.original.rowNumber} restored`,
                    )
                  }
                >
                  <RotateCcw aria-hidden="true" />
                  Restore
                </Button>
              ) : null}
            </div>
          );
        },
      },
    ],
    [canImport, pendingRowId, record.columnMapping, quickFix],
  );

  const pagination: PaginationState = { pageIndex: page - 1, pageSize };
  const hasProblems = summary.error + summary.warning > 0;
  const importable = summary.valid + summary.warning;

  return (
    <div className="space-y-6">
      {!canImport ? (
        <InlineAlert variant="info" title="View only">
          Your role can review this import but not change rows.
        </InlineAlert>
      ) : null}

      {summary.error > 0 ? (
        <InlineAlert
          variant="warning"
          title={`${formatNumber(summary.error)} ${summary.error === 1 ? "row has" : "rows have"} errors`}
        >
          Fix or skip them here, or choose to leave them out at the import step.{" "}
          {formatNumber(importable)} {importable === 1 ? "row is" : "rows are"} ready to import.
        </InlineAlert>
      ) : (
        <InlineAlert
          variant="success"
          title={`${formatNumber(importable)} ${importable === 1 ? "row is" : "rows are"} ready to import`}
        >
          {summary.warning > 0
            ? `${formatNumber(summary.warning)} ${summary.warning === 1 ? "has" : "have"} warnings worth a look; they import as they are unless you skip them.`
            : "No problems were found."}
          {summary.skipped > 0
            ? ` ${formatNumber(summary.skipped)} ${summary.skipped === 1 ? "row is" : "rows are"} skipped.`
            : ""}
        </InlineAlert>
      )}

      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <Tabs
          value={tab}
          onValueChange={(value) => {
            if (isReviewTab(value)) {
              setTab(value);
              setPage(1);
            }
          }}
        >
          <TabsList aria-label="Row status">
            {REVIEW_TABS.map((status) => (
              <TabsTrigger key={status} value={status} className="gap-1.5 px-3">
                {REVIEW_TAB_META[status].label}
                <span className="bg-muted-foreground/15 rounded-full px-1.5 text-xs tabular-nums">
                  {formatNumber(counts[status])}
                </span>
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <div className="flex flex-wrap items-center gap-2">
          {hasProblems ? (
            <Button asChild variant="outline" size="sm">
              <a href={errorsCsvUrl(record.id)} download>
                <Download aria-hidden="true" />
                Download problems CSV
              </a>
            </Button>
          ) : null}
          {canImport ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() =>
                revalidate.mutate(undefined, {
                  onSuccess: () => {
                    setPage(1);
                    toast.success("Rows re-validated");
                  },
                  onError: (error) => toastError(error, { title: "Couldn't re-validate" }),
                })
              }
              disabled={revalidate.isPending}
            >
              <RefreshCw
                className={cn(revalidate.isPending && "animate-spin")}
                aria-hidden="true"
              />
              Re-validate
            </Button>
          ) : null}
        </div>
      </div>

      <DataTable<ImportRow>
        label={`${REVIEW_TAB_META[tab].label} rows`}
        columns={columns}
        data={rowsQuery.data?.items}
        isLoading={rowsQuery.isPending}
        getRowId={(row) => row.id}
        manualPagination
        rowCount={rowsQuery.data?.total ?? 0}
        pagination={pagination}
        onPaginationChange={(updater) => {
          const next = typeof updater === "function" ? updater(pagination) : updater;
          setPage(next.pageIndex + 1);
          setPageSize(next.pageSize);
        }}
        pageSizeOptions={PAGE_SIZE_OPTIONS}
        stickyHeader={false}
        emptyState={
          <EmptyState
            title={REVIEW_TAB_META[tab].empty}
            size="sm"
            bordered={false}
            headingLevel={3}
          />
        }
      />

      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button type="button" variant="outline" onClick={onBack} disabled={revalidate.isPending}>
          <ArrowLeft aria-hidden="true" />
          Back to mapping
        </Button>
        <Button type="button" onClick={onContinue} disabled={!canImport || revalidate.isPending}>
          Continue to import
          <ArrowRight aria-hidden="true" />
        </Button>
      </div>

      <ChooseEmployeeDialog
        row={dialog?.kind === "choose" ? dialog.row : null}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
        onSubmit={(input) =>
          dialog
            ? applyFix(dialog.row, input).then(() => toast.success("Row matched"))
            : Promise.resolve()
        }
      />
      <CreateEmployeeDialog
        row={dialog?.kind === "create" ? dialog.row : null}
        onOpenChange={(open) => {
          if (!open) setDialog(null);
        }}
        onSubmit={(input) =>
          dialog
            ? applyFix(dialog.row, input).then(() => toast.success("Employee created and matched"))
            : Promise.resolve()
        }
      />
    </div>
  );
}
