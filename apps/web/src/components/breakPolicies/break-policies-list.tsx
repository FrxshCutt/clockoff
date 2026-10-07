"use client";

import type { BreakPolicy } from "@clockoff/validation/breakPolicies";
import type { ColumnDef } from "@tanstack/react-table";
import { Plus, Star } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { DataTable, DataTableColumnHeader } from "@/components/data-table";
import { EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { PageHeader } from "@/components/page-header";
import { formatAssignedSummary } from "@/components/policies/policy-view-model";
import { StatusBadge } from "@/components/status/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EMPTY_STATES } from "@/config/emptyStates";
import { routeFor } from "@/config/navigation";
import { usePermission } from "@/hooks/use-current-user";
import {
  BreakPolicyMenu,
  DeleteBreakPolicyDialog,
  useToggleDefaultBreakPolicy,
} from "./break-policy-actions";
import { BreakPolicyFormSheet } from "./break-policy-form-sheet";
import { describeBreakTriggers, summariseBreakPolicy } from "./break-policy-view-model";
import { useBreakPolicies } from "./use-break-policies";

interface ColumnHandlers {
  canEdit: boolean;
  defaultPending: boolean;
  onEdit: (policy: BreakPolicy) => void;
  onDelete: (policy: BreakPolicy) => void;
  onToggleDefault: (policy: BreakPolicy) => void;
}

function buildColumns(handlers: ColumnHandlers): ColumnDef<BreakPolicy>[] {
  return [
    {
      accessorKey: "name",
      header: ({ column }) => <DataTableColumnHeader column={column} title="Name" />,
      cell: ({ row }) => (
        <div className="min-w-0 space-y-0.5">
          <div className="flex flex-wrap items-center gap-2">
            <Link
              href={routeFor.breakRule(row.original.id)}
              className="font-medium hover:underline"
            >
              {row.original.name}
            </Link>
            {row.original.isDefault ? (
              <Badge
                variant="secondary"
                className="gap-1 font-normal"
                title="Applies to everyone without a more specific assignment"
              >
                <Star className="fill-amber-400 text-amber-500" aria-hidden="true" />
                Default
              </Badge>
            ) : null}
          </div>
          {row.original.description ? (
            <p className="text-muted-foreground line-clamp-1 text-xs">{row.original.description}</p>
          ) : null}
        </div>
      ),
    },
    {
      id: "rules",
      accessorFn: (row) => summariseBreakPolicy(row),
      header: "Rules",
      enableSorting: false,
      cell: ({ row }) => (
        <div className="min-w-0 space-y-0.5">
          <p className="text-sm tabular-nums">{summariseBreakPolicy(row.original)}</p>
          <p className="text-muted-foreground line-clamp-1 text-xs">
            {describeBreakTriggers(row.original)}
          </p>
        </div>
      ),
    },
    {
      accessorKey: "status",
      header: ({ column }) => <DataTableColumnHeader column={column} title="Status" />,
      cell: ({ row }) => <StatusBadge kind="policyStatus" value={row.original.status} size="sm" />,
    },
    {
      id: "assigned",
      accessorFn: (row) => row.assignedEmployeeCount,
      header: ({ column }) => <DataTableColumnHeader column={column} title="Applies to" />,
      cell: ({ row }) => (
        <span className="text-muted-foreground text-sm tabular-nums">
          {formatAssignedSummary(row.original)}
        </span>
      ),
    },
    {
      id: "actions",
      header: () => <span className="sr-only">Actions</span>,
      enableSorting: false,
      size: 56,
      cell: ({ row }) => (
        <div className="flex justify-end">
          <BreakPolicyMenu
            policy={row.original}
            canEdit={handlers.canEdit}
            onEdit={handlers.onEdit}
            onDelete={handlers.onDelete}
            onToggleDefault={handlers.onToggleDefault}
            defaultPending={handlers.defaultPending}
          />
        </div>
      ),
    },
  ];
}

/** `/break-rules`: header, the Break Rules table, the create/edit sheet and the delete guard dialog. */
export function BreakRulesView() {
  const router = useRouter();
  const canEdit = usePermission("policies:write");
  const policies = useBreakPolicies();
  const { toggle: toggleDefault, isPending: defaultPending } = useToggleDefaultBreakPolicy();
  const [sheet, setSheet] = useState<{ open: boolean; policy: BreakPolicy | null }>({
    open: false,
    policy: null,
  });
  const [deleting, setDeleting] = useState<BreakPolicy | null>(null);
  const copy = EMPTY_STATES.breakRules;

  // `toggleDefault` and the state setters are referentially stable, so the columns only rebuild on real changes.
  const columns = useMemo(
    () =>
      buildColumns({
        canEdit,
        defaultPending,
        onEdit: (policy) => setSheet({ open: true, policy }),
        onDelete: setDeleting,
        onToggleDefault: (policy) => void toggleDefault(policy),
      }),
    [canEdit, defaultPending, toggleDefault],
  );

  return (
    <>
      <PageHeader
        title="Break Rules"
        description="How long breaks last, how often they can be taken and what relaxes during them."
        actions={
          canEdit ? (
            <Button type="button" onClick={() => setSheet({ open: true, policy: null })}>
              <Plus aria-hidden="true" />
              Create Break Rules
            </Button>
          ) : undefined
        }
      />

      {policies.isError ? (
        <ErrorState
          title="Couldn't load Break Rules"
          error={policies.error}
          onRetry={() => void policies.refetch()}
          isRetrying={policies.isRefetching}
        />
      ) : (
        <DataTable
          columns={columns}
          data={policies.data}
          label="Break Rules"
          isLoading={policies.isPending}
          getRowId={(row) => row.id}
          searchable
          searchPlaceholder="Search Break Rules…"
          initialSorting={[{ id: "name", desc: false }]}
          onRowClick={(row) => router.push(routeFor.breakRule(row.id))}
          getRowLabel={(row) => `Open ${row.name}`}
          emptyState={
            <EmptyState
              icon={copy.icon}
              title={copy.title}
              description={copy.description}
              action={
                canEdit && copy.action?.href ? (
                  <Button asChild>
                    <Link href={copy.action.href}>{copy.action.label}</Link>
                  </Button>
                ) : undefined
              }
            />
          }
        />
      )}

      <BreakPolicyFormSheet
        open={sheet.open}
        onOpenChange={(open) => setSheet((prev) => ({ ...prev, open }))}
        policy={sheet.policy}
        onSaved={(saved, mode) => {
          if (mode === "create") router.push(routeFor.breakRule(saved.id));
        }}
      />
      <DeleteBreakPolicyDialog policy={deleting} onClose={() => setDeleting(null)} />
    </>
  );
}
