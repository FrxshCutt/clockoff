"use client";

import type { AuditLog } from "@workmode/validation/auditLogs";
import type { ColumnDef } from "@tanstack/react-table";
import { ChevronDown, LoaderCircle, X } from "lucide-react";
import { useMemo, useState } from "react";
import { DataTable, DataTableColumnHeader } from "@/components/data-table";
import { useDebouncedCallback } from "@/components/employees/use-debounced-callback";
import { EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { RelativeTime } from "@/components/relative-time";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { EMPTY_STATES } from "@/config/emptyStates";
import { useCurrentOrganisation } from "@/hooks/use-organisation";
import { formatDateTimeLong } from "@/lib/format";
import { cn } from "@/lib/utils";
import { DEFAULT_AUDIT_LOG_PARAMS, hasActiveAuditLogFilters, useAuditLogs, type AuditLogListParams } from "./activity-api";
import {
  changedEntries,
  describeActor,
  describeAuditAction,
  describeEntityType,
  diffJson,
  formatJson,
  hasSnapshot,
  shortId,
  type DiffEntry,
} from "./audit-log-model";
import { DateRangeFilter } from "./date-range-filter";

function auditColumns(timeZone: string | undefined): ColumnDef<AuditLog>[] {
  return [
    {
      id: "occurredAt",
      header: ({ column }) => <DataTableColumnHeader column={column} title="When" />,
      enableSorting: false,
      size: 160,
      cell: ({ row }) => <RelativeTime value={row.original.occurredAt} timeZone={timeZone} className="text-sm" />,
    },
    {
      id: "actor",
      header: ({ column }) => <DataTableColumnHeader column={column} title="Actor" />,
      enableSorting: false,
      cell: ({ row }) => (
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{describeActor(row.original)}</p>
          {row.original.actor?.email ? <p className="text-muted-foreground truncate text-xs">{row.original.actor.email}</p> : null}
        </div>
      ),
    },
    {
      id: "action",
      header: ({ column }) => <DataTableColumnHeader column={column} title="Action" />,
      enableSorting: false,
      cell: ({ row }) => (
        <div className="min-w-0">
          <p className="truncate text-sm">{describeAuditAction(row.original.action)}</p>
          <p className="text-muted-foreground truncate font-mono text-[11px]">{row.original.action}</p>
        </div>
      ),
    },
    {
      id: "entity",
      header: ({ column }) => <DataTableColumnHeader column={column} title="Entity" />,
      enableSorting: false,
      cell: ({ row }) => (
        <div className="flex min-w-0 items-center gap-2">
          <Badge variant="outline" className="shrink-0">
            {describeEntityType(row.original.entityType)}
          </Badge>
          {shortId(row.original.entityId) ? (
            <span className="text-muted-foreground truncate font-mono text-xs" title={row.original.entityId ?? undefined}>
              {shortId(row.original.entityId)}
            </span>
          ) : null}
        </div>
      ),
    },
    {
      id: "details",
      header: () => <span className="sr-only">Details</span>,
      enableSorting: false,
      size: 110,
      cell: ({ row }) =>
        hasSnapshot(row.original) ? (
          <span className="text-primary text-xs font-medium">View changes</span>
        ) : (
          <span className="text-muted-foreground text-xs">No snapshot</span>
        ),
    },
  ];
}

const DIFF_TONE: Record<DiffEntry["kind"], string> = {
  added: "bg-emerald-50 text-emerald-900 dark:bg-emerald-500/10 dark:text-emerald-100",
  removed: "bg-red-50 text-red-900 dark:bg-red-500/10 dark:text-red-100",
  changed: "bg-amber-50 text-amber-950 dark:bg-amber-500/10 dark:text-amber-100",
  unchanged: "",
};

function Value({ value }: { value: unknown }) {
  if (value === undefined) return <span className="text-muted-foreground italic">—</span>;
  return <code className="font-mono text-xs break-all whitespace-pre-wrap">{formatJson(value)}</code>;
}

/** Before/after side by side, changes first; unchanged fields and the raw snapshots stay collapsed. */
function AuditDiff({ entry }: { entry: AuditLog }) {
  const entries = diffJson(entry.before, entry.after);
  const changed = changedEntries(entries);
  const unchanged = entries.filter((e) => e.kind === "unchanged");
  return (
    <div className="space-y-4">
      {changed.length === 0 ? (
        <p className="text-muted-foreground text-sm">No field changed between the two snapshots.</p>
      ) : (
        <ul className="divide-border divide-y rounded-lg border" aria-label="Changed fields">
          {changed.map((diff) => (
            <li key={diff.path} className={cn("space-y-1 px-3 py-2", DIFF_TONE[diff.kind])}>
              <p className="flex items-center gap-2 font-mono text-xs font-medium">
                {diff.path}
                <Badge variant="outline" className="h-4 px-1 text-[10px] uppercase">
                  {diff.kind}
                </Badge>
              </p>
              <dl className="grid gap-1 text-sm sm:grid-cols-2">
                <div>
                  <dt className="text-muted-foreground text-[11px] uppercase">Before</dt>
                  <dd>
                    <Value value={diff.before} />
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground text-[11px] uppercase">After</dt>
                  <dd>
                    <Value value={diff.after} />
                  </dd>
                </div>
              </dl>
            </li>
          ))}
        </ul>
      )}
      {unchanged.length > 0 ? (
        <Collapsible>
          <CollapsibleTrigger asChild>
            <Button type="button" variant="ghost" size="sm" className="group">
              <ChevronDown className="transition-transform group-data-[state=open]:rotate-180" aria-hidden="true" />
              {unchanged.length} unchanged field{unchanged.length === 1 ? "" : "s"}
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <ul className="divide-border mt-2 divide-y rounded-lg border" aria-label="Unchanged fields">
              {unchanged.map((diff) => (
                <li key={diff.path} className="flex items-start justify-between gap-3 px-3 py-1.5 text-sm">
                  <span className="font-mono text-xs">{diff.path}</span>
                  <Value value={diff.after} />
                </li>
              ))}
            </ul>
          </CollapsibleContent>
        </Collapsible>
      ) : null}
      <Collapsible>
        <CollapsibleTrigger asChild>
          <Button type="button" variant="ghost" size="sm" className="group">
            <ChevronDown className="transition-transform group-data-[state=open]:rotate-180" aria-hidden="true" />
            Raw snapshots
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <div className="mt-2 grid gap-3 sm:grid-cols-2">
            <div>
              <p className="text-muted-foreground mb-1 text-[11px] uppercase">Before</p>
              <pre className="bg-muted/50 max-h-72 overflow-auto rounded-lg border p-3 font-mono text-xs">{formatJson(entry.before ?? undefined)}</pre>
            </div>
            <div>
              <p className="text-muted-foreground mb-1 text-[11px] uppercase">After</p>
              <pre className="bg-muted/50 max-h-72 overflow-auto rounded-lg border p-3 font-mono text-xs">{formatJson(entry.after ?? undefined)}</pre>
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

/**
 * The organisation's audit log (`GET /api/audit-logs`): who did what, to which record, when — with the
 * before/after snapshot one click away. Cursor-paginated with "Load more"; filters are page-local.
 */
export function AuditLogTable() {
  const organisation = useCurrentOrganisation();
  const timeZone = organisation.data?.organisation.timezone;
  const [params, setParams] = useState<AuditLogListParams>(DEFAULT_AUDIT_LOG_PARAMS);
  const [drafts, setDrafts] = useState({ entityType: "", action: "" });
  const [selected, setSelected] = useState<AuditLog | null>(null);
  const query = useAuditLogs(params, timeZone ?? "UTC", { enabled: !organisation.isPending });
  const columns = useMemo(() => auditColumns(timeZone), [timeZone]);

  const pushText = useDebouncedCallback((patch: Partial<Pick<AuditLogListParams, "entityType" | "action">>) => {
    setParams((previous) => ({ ...previous, ...patch }));
  }, 300);

  const entries = query.data?.pages.flatMap((page) => page.items) ?? [];
  const filtersActive = hasActiveAuditLogFilters(params);
  const copy = EMPTY_STATES.auditLogs;
  const searchCopy = EMPTY_STATES.search;

  const reset = () => {
    setDrafts({ entityType: "", action: "" });
    setParams(DEFAULT_AUDIT_LOG_PARAMS);
  };

  if (query.isError) {
    return <ErrorState title="Couldn't load the audit log" error={query.error} onRetry={() => void query.refetch()} isRetrying={query.isRefetching} />;
  }

  return (
    <div className="space-y-4">
      <div role="group" aria-label="Audit log filters" className="flex flex-wrap items-center gap-2">
        <Input
          type="search"
          value={drafts.entityType}
          onChange={(event) => {
            const value = event.target.value;
            setDrafts((previous) => ({ ...previous, entityType: value }));
            pushText({ entityType: value.trim() || null });
          }}
          placeholder="Entity type, e.g. policy"
          aria-label="Filter by entity type"
          className="h-9 w-48"
        />
        <Input
          type="search"
          value={drafts.action}
          onChange={(event) => {
            const value = event.target.value;
            setDrafts((previous) => ({ ...previous, action: value }));
            pushText({ action: value.trim() || null });
          }}
          placeholder="Action, e.g. policy.published"
          aria-label="Filter by action"
          className="h-9 w-56"
        />
        <DateRangeFilter
          value={{ range: params.range, from: params.from, to: params.to }}
          onChange={(next) => setParams((previous) => ({ ...previous, range: next.range, from: next.from, to: next.to }))}
        />
        {filtersActive ? (
          <Button type="button" variant="ghost" size="sm" className="h-9" onClick={reset}>
            Reset
            <X aria-hidden="true" />
          </Button>
        ) : null}
      </div>

      <DataTable<AuditLog>
        label="Audit log"
        columns={columns}
        data={query.isPending ? undefined : entries}
        isLoading={query.isPending}
        getRowId={(row) => row.id}
        paginate={false}
        manualFiltering
        onRowClick={(row) => setSelected(row)}
        getRowLabel={(row) => `View ${describeAuditAction(row.action)} by ${describeActor(row)}`}
        emptyState={
          filtersActive ? (
            <EmptyState
              icon={searchCopy.icon}
              title={searchCopy.title}
              description={searchCopy.description}
              action={
                <Button type="button" variant="outline" size="sm" onClick={reset}>
                  Clear filters
                </Button>
              }
            />
          ) : (
            <EmptyState icon={copy.icon} title={copy.title} description={copy.description} />
          )
        }
      />

      {!query.isPending && entries.length > 0 ? (
        <div className="flex items-center justify-between gap-3">
          <p className="text-muted-foreground text-xs">
            Showing {entries.length} entr{entries.length === 1 ? "y" : "ies"}
          </p>
          {query.hasNextPage ? (
            <Button type="button" variant="outline" size="sm" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
              {query.isFetchingNextPage ? <LoaderCircle className="animate-spin" aria-hidden="true" /> : null}
              Load more
            </Button>
          ) : (
            <p className="text-muted-foreground text-xs">End of log for this period.</p>
          )}
        </div>
      ) : null}

      <Sheet open={selected !== null} onOpenChange={(open) => !open && setSelected(null)}>
        <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-xl">
          {selected ? (
            <>
              <SheetHeader>
                <SheetTitle>{describeAuditAction(selected.action)}</SheetTitle>
                <SheetDescription>
                  {describeEntityType(selected.entityType)}
                  {selected.entityId ? (
                    <>
                      {" "}
                      <span className="font-mono text-xs">{selected.entityId}</span>
                    </>
                  ) : null}{" "}
                  · by {describeActor(selected)} · {formatDateTimeLong(selected.occurredAt, { timeZone })}
                </SheetDescription>
              </SheetHeader>
              <div className="space-y-4 px-4 pb-6">
                <dl className="grid gap-2 text-sm sm:grid-cols-2">
                  <div>
                    <dt className="text-muted-foreground text-[11px] uppercase">Action code</dt>
                    <dd className="font-mono text-xs">{selected.action}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground text-[11px] uppercase">From</dt>
                    <dd className="truncate text-xs" title={selected.userAgent ?? undefined}>
                      {selected.ip ?? "Unknown address"}
                      {selected.userAgent ? ` · ${selected.userAgent}` : ""}
                    </dd>
                  </div>
                </dl>
                {hasSnapshot(selected) ? <AuditDiff entry={selected} /> : <p className="text-muted-foreground text-sm">This action recorded no before/after snapshot.</p>}
              </div>
            </>
          ) : null}
        </SheetContent>
      </Sheet>
    </div>
  );
}
