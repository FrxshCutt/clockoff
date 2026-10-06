"use client";

import { RESTRICTION_CATEGORY_LABELS } from "@workmode/shared/enums";
import type { Override } from "@workmode/validation/overrides";
import type { ColumnDef } from "@tanstack/react-table";
import { Ban } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { DataTable } from "@/components/data-table";
import { useOverrides, useRevokeOverride } from "@/components/employees/employee-api";
import { EMPLOYEE_EMPTY_STATES } from "@/components/employees/employee-copy";
import { useNow } from "@/components/employees/use-now";
import { EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { TONE_CLASSES } from "@/components/status/statusMeta";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useApiErrorToast } from "@/hooks/use-api-error-toast";
import { useCurrentOrganisation } from "@/hooks/use-organisation";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  BEHAVIOUR_LABELS,
  OVERRIDE_STATUS_META,
  OVERRIDE_TYPE_META,
  describeOverrideRemaining,
} from "./override-helpers";

export function OverrideStatusBadge({
  status,
  size = "md",
}: {
  status: Override["status"];
  size?: "sm" | "md";
}) {
  const meta = OVERRIDE_STATUS_META[status] ?? {
    label: status,
    tone: "neutral" as const,
    description: "",
  };
  return (
    <Badge
      variant="outline"
      className={cn(
        "font-medium",
        TONE_CLASSES[meta.tone],
        size === "sm" ? "h-5 text-[11px]" : "h-6 text-xs",
      )}
      title={meta.description || undefined}
    >
      {meta.label}
    </Badge>
  );
}

function describePayload(override: Override): string | null {
  if (override.type !== "TEMPORARY_EXCEPTION") return null;
  const { restrictionBehaviour, relaxedCategories, breakPolicyId } = override.payload;
  const parts: string[] = [];
  if (restrictionBehaviour) parts.push(BEHAVIOUR_LABELS[restrictionBehaviour]);
  if (restrictionBehaviour === "RELAX_CATEGORIES" && relaxedCategories?.length) {
    parts.push(relaxedCategories.map((c) => RESTRICTION_CATEGORY_LABELS[c] ?? c).join(", "));
  }
  if (breakPolicyId) parts.push("via Break Rules preset");
  return parts.length > 0 ? parts.join(" · ") : "Relax all restrictions";
}

export interface OverridesTableProps {
  employeeId: string;
  canRevoke: boolean;
  /** Rendered as the empty state's call to action (the "Create override" button). */
  createAction?: React.ReactNode;
}

/** `GET /api/overrides?employeeId=` with revoke (`POST /api/overrides/:id/revoke`). */
export function OverridesTable({ employeeId, canRevoke, createAction }: OverridesTableProps) {
  const query = useOverrides({ employeeId });
  const organisation = useCurrentOrganisation();
  const now = useNow();
  const revoke = useRevokeOverride();
  const toastError = useApiErrorToast();
  const [revoking, setRevoking] = useState<Override | null>(null);
  const [revokeReason, setRevokeReason] = useState("");

  const timeZone = organisation.data?.organisation.timezone;
  const dateFormat = organisation.data?.organisation.dateFormat;
  const rows = useMemo(
    () => query.data?.pages.flatMap((page) => page.items) ?? undefined,
    [query.data],
  );

  const columns = useMemo<ColumnDef<Override>[]>(
    () => [
      {
        id: "type",
        header: "Type",
        cell: ({ row }) => {
          const payload = describePayload(row.original);
          return (
            <div className="min-w-0 space-y-0.5">
              <p className="font-medium">
                {OVERRIDE_TYPE_META[row.original.type]?.label ?? row.original.type}
              </p>
              {payload ? <p className="text-muted-foreground text-xs">{payload}</p> : null}
            </div>
          );
        },
      },
      {
        id: "reason",
        header: "Reason",
        cell: ({ row }) => (
          <p className="max-w-xs text-sm text-pretty whitespace-normal">{row.original.reason}</p>
        ),
      },
      {
        id: "createdBy",
        header: "Created by",
        cell: ({ row }) => (
          <div className="min-w-0 space-y-0.5 text-sm">
            <p className="truncate">{row.original.createdBy?.name ?? "System"}</p>
            <p className="text-muted-foreground text-xs">
              {formatDateTime(row.original.createdAt, { timeZone, dateFormat })}
            </p>
          </div>
        ),
      },
      {
        id: "expires",
        header: "Expires",
        cell: ({ row }) => (
          <div className="space-y-0.5 text-sm">
            <p>{formatDateTime(row.original.expiresAt, { timeZone, dateFormat })}</p>
            <p className="text-muted-foreground text-xs">
              {now === null ? "" : describeOverrideRemaining(row.original, now)}
            </p>
          </div>
        ),
      },
      {
        id: "status",
        header: "Status",
        cell: ({ row }) => <OverrideStatusBadge status={row.original.status} size="sm" />,
      },
      {
        id: "actions",
        size: 110,
        header: () => <span className="sr-only">Actions</span>,
        cell: ({ row }) => {
          const override = row.original;
          const revocable =
            canRevoke && (override.status === "ACTIVE" || override.status === "SCHEDULED");
          if (!revocable) return null;
          return (
            <Button type="button" variant="outline" size="sm" onClick={() => setRevoking(override)}>
              <Ban aria-hidden="true" />
              Revoke
              <span className="sr-only">
                {" "}
                {OVERRIDE_TYPE_META[override.type]?.label ?? override.type}
              </span>
            </Button>
          );
        },
      },
    ],
    [canRevoke, dateFormat, now, timeZone],
  );

  if (query.isError) {
    return (
      <ErrorState
        title="Couldn't load overrides"
        error={query.error}
        onRetry={() => void query.refetch()}
        isRetrying={query.isRefetching}
        size="sm"
      />
    );
  }

  return (
    <div className="space-y-4">
      <DataTable<Override>
        label="Overrides"
        columns={columns}
        data={rows}
        isLoading={query.isPending}
        getRowId={(row) => row.id}
        paginate={false}
        stickyHeader={false}
        emptyState={
          <EmptyState
            icon={EMPLOYEE_EMPTY_STATES.overrides.icon}
            title={EMPLOYEE_EMPTY_STATES.overrides.title}
            description={EMPLOYEE_EMPTY_STATES.overrides.description}
            action={createAction}
            headingLevel={3}
          />
        }
      />
      {query.hasNextPage ? (
        <div className="flex justify-center">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void query.fetchNextPage()}
            disabled={query.isFetchingNextPage}
          >
            {query.isFetchingNextPage ? "Loading…" : "Load more"}
          </Button>
        </div>
      ) : null}

      <ConfirmDialog
        open={revoking !== null}
        onOpenChange={(open) => {
          if (!open) {
            setRevoking(null);
            setRevokeReason("");
          }
        }}
        title="Revoke this override?"
        description="Restrictions return to what the schedule and policy say as soon as the device next syncs."
        confirmLabel="Revoke override"
        destructive
        onConfirm={async () => {
          if (!revoking) return;
          try {
            await revoke.mutateAsync({ id: revoking.id, reason: revokeReason });
            toast.success("Override revoked");
          } catch (error) {
            toastError(error, { title: "Couldn't revoke the override" });
            throw error;
          }
        }}
      >
        <div className="space-y-2">
          <Label htmlFor="revoke-override-reason" className="text-sm font-normal">
            Note (optional)
          </Label>
          <Textarea
            id="revoke-override-reason"
            value={revokeReason}
            onChange={(event) => setRevokeReason(event.target.value)}
            maxLength={500}
            rows={2}
            placeholder="Why are you ending it early?"
          />
        </div>
      </ConfirmDialog>
    </div>
  );
}
