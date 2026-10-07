"use client";

import type { ColumnDef } from "@tanstack/react-table";
import type { JoinCode } from "@clockoff/validation/organisation";
import { KeyRound, RefreshCw, ShieldOff } from "lucide-react";
import { useMemo } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { CopyButton } from "@/components/copy-button";
import { DataTable, DataTableColumnHeader } from "@/components/data-table";
import { EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { InlineAlert } from "@/components/inline-alert";
import { CardSkeleton } from "@/components/loading-skeletons";
import { SectionCard } from "@/components/section";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useApiErrorToast } from "@/hooks/use-api-error-toast";
import { usePermission } from "@/hooks/use-current-user";
import { useCurrentOrganisation } from "@/hooks/use-organisation";
import { formatDateTime } from "@/lib/format";
import { useJoinCode, useRegenerateCompanyCode, useRevokeCompanyCode } from "./use-join-code";

/**
 * Settings → Join code. Shows the ACTIVE company join code and its history (`GET
 * /api/organisations/current/join-code`) and lets owners/admins regenerate or revoke it (`POST
 * …/join-code/regenerate|revoke`). Until the history endpoint is deployed, the active code comes from
 * `GET /api/organisations/current` and the history table says so.
 */
export function JoinCodeSettings() {
  const organisation = useCurrentOrganisation();
  const joinCode = useJoinCode();
  const canManage = usePermission("org:manage");
  const regenerate = useRegenerateCompanyCode();
  const revoke = useRevokeCompanyCode();
  const toastError = useApiErrorToast();

  const dateOptions = {
    timeZone: organisation.data?.organisation.timezone,
    dateFormat: organisation.data?.organisation.dateFormat,
  };

  const columns = useMemo<ColumnDef<JoinCode>[]>(
    () => [
      {
        accessorKey: "code",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Code" />,
        cell: ({ row }) => (
          <span className="font-mono font-medium tracking-wider">{row.original.code}</span>
        ),
      },
      {
        accessorKey: "status",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Status" />,
        cell: ({ row }) =>
          row.original.status === "ACTIVE" ? (
            <Badge>Active</Badge>
          ) : (
            <Badge variant="secondary">Revoked</Badge>
          ),
      },
      {
        accessorKey: "createdAt",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Created" />,
        cell: ({ row }) => (
          <span className="text-sm">
            {formatDateTime(row.original.createdAt, dateOptions)}
            {row.original.createdBy ? (
              <span className="text-muted-foreground"> by {row.original.createdBy.name}</span>
            ) : null}
          </span>
        ),
      },
      {
        accessorKey: "revokedAt",
        header: ({ column }) => <DataTableColumnHeader column={column} title="Revoked" />,
        sortUndefined: "last",
        cell: ({ row }) =>
          row.original.revokedAt ? (
            <span className="text-sm">{formatDateTime(row.original.revokedAt, dateOptions)}</span>
          ) : (
            <span className="text-muted-foreground text-sm">—</span>
          ),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps -- dateOptions is derived from these two values
    [dateOptions.timeZone, dateOptions.dateFormat],
  );

  if (organisation.isPending || joinCode.isPending) return <CardSkeleton lines={4} />;
  if (organisation.isError) {
    return (
      <ErrorState
        title="Couldn't load the join code"
        error={organisation.error}
        onRetry={() => void organisation.refetch()}
        isRetrying={organisation.isRefetching}
      />
    );
  }
  if (joinCode.isError) {
    return (
      <ErrorState
        title="Couldn't load the join code"
        error={joinCode.error}
        onRetry={() => void joinCode.refetch()}
        isRetrying={joinCode.isRefetching}
      />
    );
  }

  const history = joinCode.data.available ? joinCode.data.data : null;
  const code = history ? (history.current?.code ?? null) : organisation.data.joinCode;
  const rows: JoinCode[] = history
    ? [...(history.current ? [history.current] : []), ...history.history]
    : [];

  // ConfirmDialog keeps itself open when onConfirm rejects, so errors are toasted and rethrown.
  const runRegenerate = async () => {
    try {
      await regenerate.mutateAsync();
      toast.success(
        code ? "New join code created. The old code no longer works." : "Join code created",
      );
    } catch (err) {
      toastError(err, { title: "Couldn't create a new join code" });
      throw err;
    }
  };
  const runRevoke = async () => {
    try {
      await revoke.mutateAsync();
      toast.success("Join code revoked. No one can join with it any more.");
    } catch (err) {
      toastError(err, { title: "Couldn't revoke the join code" });
      throw err;
    }
  };

  return (
    <div className="space-y-6">
      {canManage ? null : (
        <InlineAlert variant="info" title="View only">
          Only owners and admins can create or revoke join codes.
        </InlineAlert>
      )}
      <SectionCard
        title="Company join code"
        description="Employees enter this code and their name in the ClockOff app to join your organisation."
      >
        {code ? (
          <div className="flex flex-col gap-6 sm:flex-row sm:items-center sm:justify-between">
            <div className="space-y-2">
              <p className="text-muted-foreground text-sm">Current code</p>
              {/* Codes are up to 10 characters (`WORDS-1234`): sized and wrapping so they fit a 360px screen. */}
              <div className="flex flex-wrap items-center gap-3">
                <span className="bg-muted/60 rounded-lg border px-4 py-2 font-mono text-xl font-semibold tracking-[0.15em] sm:text-3xl sm:tracking-[0.25em]">
                  {code}
                </span>
                <CopyButton
                  value={code}
                  label="Copy join code"
                  successMessage="Join code copied"
                  size="sm"
                >
                  Copy
                </CopyButton>
              </div>
            </div>
            {canManage ? (
              <div className="flex flex-wrap gap-2">
                <ConfirmDialog
                  title="Create a new join code?"
                  description="Employees who haven't joined yet will need the new code. The current code stops working immediately; anyone already connected stays connected."
                  confirmLabel="Create new code"
                  onConfirm={runRegenerate}
                  trigger={
                    <Button type="button" variant="outline">
                      <RefreshCw aria-hidden="true" />
                      Regenerate
                    </Button>
                  }
                />
                <ConfirmDialog
                  title="Revoke the join code?"
                  description="No one will be able to join with a company code until you create a new one. Employees who have already joined stay connected."
                  confirmLabel="Revoke code"
                  destructive
                  onConfirm={runRevoke}
                  trigger={
                    <Button
                      type="button"
                      variant="outline"
                      className="text-destructive hover:text-destructive"
                    >
                      <ShieldOff aria-hidden="true" />
                      Revoke
                    </Button>
                  }
                />
              </div>
            ) : null}
          </div>
        ) : (
          <EmptyState
            icon={KeyRound}
            title="No active join code"
            description="Employees can't join with a company code right now. Create one to share with your team."
            size="sm"
            bordered={false}
            headingLevel={3}
            action={
              canManage ? (
                <ConfirmDialog
                  title="Create a join code?"
                  description="Anyone with the code and a matching name on your employee list can join your organisation from the app."
                  confirmLabel="Create code"
                  onConfirm={runRegenerate}
                  trigger={<Button type="button">Create join code</Button>}
                />
              ) : undefined
            }
          />
        )}
      </SectionCard>

      <SectionCard
        title="Code history"
        description="Every code this organisation has had. Revoked codes can't be used to join."
        flush
        contentClassName="px-4 py-4 sm:px-6"
      >
        {history ? (
          <DataTable
            label="Join code history"
            columns={columns}
            data={rows}
            getRowId={(row) => row.id}
            initialSorting={[{ id: "createdAt", desc: true }]}
            paginate={rows.length > 10}
            initialPageSize={10}
            stickyHeader={false}
            emptyState={
              <EmptyState
                icon={KeyRound}
                title="No codes yet"
                description="Create a join code and it will appear here."
                size="sm"
                bordered={false}
                headingLevel={3}
              />
            }
          />
        ) : (
          <InlineAlert variant="info" title="Code history isn't available yet">
            Previous codes will be listed here once the join-code history endpoint is live. The
            current code above is up to date.
          </InlineAlert>
        )}
      </SectionCard>

      <SectionCard title="How joining works">
        <ol className="text-muted-foreground list-decimal space-y-2 pl-5 text-sm">
          <li>Add the employee in Employees, with the name they&apos;ll type in the app.</li>
          <li>They install ClockOff on their iPhone and enter the company join code.</li>
          <li>
            ClockOff matches their name to your employee list. If more than one employee matches,
            they also enter their personal invite code.
          </li>
          <li>
            They approve Screen Time access and choose which apps to restrict. You only ever see
            whether setup is complete.
          </li>
        </ol>
      </SectionCard>
    </div>
  );
}
