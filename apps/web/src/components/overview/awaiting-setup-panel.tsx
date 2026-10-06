"use client";

import type { StatusTone } from "@workmode/shared/status/statusMeta";
import type { ComplianceEmployeeRow } from "@workmode/validation/compliance";
import { employeeDetailResponseSchema, type EmployeeDetail } from "@workmode/validation/employees";
import { inviteInstructionsResponseSchema } from "@workmode/validation/invites";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, CircleCheck, Copy, LoaderCircle, Send } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/empty-state";
import { complianceListHref } from "@/components/activity/activity-filters";
import { useCreateInvite, useResendInvite } from "@/components/employees/employee-api";
import { employeeKeys } from "@/components/employees/employee-keys";
import { ErrorState } from "@/components/error-state";
import { canResendInvite, isInviteOpen } from "@/components/invites/invite-helpers";
import { SectionCard } from "@/components/section";
import { StatusBadge } from "@/components/status/status-badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { routeFor } from "@/config/navigation";
import { parseResponse } from "@/hooks/api-shapes";
import { useApiErrorToast } from "@/hooks/use-api-error-toast";
import { copyTextToClipboard } from "@/hooks/use-copy-to-clipboard";
import { usePermission } from "@/hooks/use-current-user";
import { api } from "@/lib/api-client";
import { cn } from "@/lib/utils";
import { useComplianceEmployees } from "./compliance-api";
import { complianceKeys, type ComplianceListParams } from "./compliance-keys";
import { describeAwaitingSetup } from "./overview-model";

export const AWAITING_SETUP_PANEL_SIZE = 8;

const AWAITING_PARAMS: ComplianceListParams = {
  filter: "AWAITING_SETUP",
  search: "",
  page: 1,
  pageSize: AWAITING_SETUP_PANEL_SIZE,
  locationId: null,
  teamId: null,
};

/** The compliance tab with the panel's own API filter, so "View all" lists exactly the rows behind the count. */
const AWAITING_ALL_HREF = complianceListHref("AWAITING_SETUP");

const TONE_TEXT: Record<StatusTone, string> = {
  neutral: "text-muted-foreground",
  success: "text-emerald-700 dark:text-emerald-400",
  info: "text-sky-700 dark:text-sky-400",
  warning: "text-amber-700 dark:text-amber-400",
  danger: "text-red-700 dark:text-red-400",
};

type BusyAction = { id: string; action: "copy" | "resend" };

function fullName(employee: { firstName: string; lastName: string }): string {
  return `${employee.firstName} ${employee.lastName}`.trim();
}

/**
 * Copy / resend need the employee's latest invite, which the compliance row does not carry: the detail is
 * fetched on demand (same key as `useEmployee`, so a later visit to the employee page reuses it).
 */
function useAwaitingSetupActions() {
  const queryClient = useQueryClient();
  const createInvite = useCreateInvite();
  const resendInvite = useResendInvite();
  const toastError = useApiErrorToast();
  const canWrite = usePermission("employees:write");
  const [busy, setBusy] = useState<BusyAction | null>(null);

  const fetchDetail = (employeeId: string): Promise<EmployeeDetail> =>
    queryClient.fetchQuery({
      queryKey: employeeKeys.detail(employeeId),
      queryFn: async ({ signal }) =>
        parseResponse(
          employeeDetailResponseSchema,
          await api.get<unknown>(
            `/api/employees/${encodeURIComponent(employeeId)}`,
            undefined,
            signal,
          ),
          "GET /api/employees/:id",
        ).employee,
      staleTime: 0,
    });

  const refreshPanel = () => queryClient.invalidateQueries({ queryKey: complianceKeys.all });

  const copyInvite = async (row: ComplianceEmployeeRow) => {
    const employeeId = row.employee.id;
    setBusy({ id: employeeId, action: "copy" });
    try {
      const detail = await fetchDetail(employeeId);
      const invite = detail.latestInvite;
      let copyText: string;
      if (invite && isInviteOpen(invite)) {
        const raw = await api.get<unknown>(
          `/api/invites/${encodeURIComponent(invite.id)}/instructions`,
        );
        copyText = parseResponse(
          inviteInstructionsResponseSchema,
          raw,
          "GET /api/invites/:id/instructions",
        ).instructions.copyText;
      } else {
        if (!canWrite) {
          toast.error(
            "There's no open invite to copy. Ask an owner or admin to invite this employee.",
          );
          return;
        }
        // No usable invite yet (never invited, or expired): create one so there is something to share.
        const created = await createInvite.mutateAsync({ employeeId, channel: "LINK" });
        copyText = created.instructions.copyText;
        void refreshPanel();
      }
      const ok = await copyTextToClipboard(copyText);
      if (ok)
        toast.success(
          `Setup instructions for ${fullName(row.employee)} copied. Paste them into a message.`,
        );
      else toast.error("Couldn't copy. Open the employee to view and copy the instructions.");
    } catch (error) {
      toastError(error, { title: "Couldn't copy the invite" });
    } finally {
      setBusy(null);
    }
  };

  const resend = async (row: ComplianceEmployeeRow) => {
    const employeeId = row.employee.id;
    const name = fullName(row.employee);
    setBusy({ id: employeeId, action: "resend" });
    try {
      const detail = await fetchDetail(employeeId);
      const invite = detail.latestInvite;
      if (invite && canResendInvite(invite)) {
        const updated = await resendInvite.mutateAsync({ inviteId: invite.id });
        toast.success(
          updated.channel === "LINK"
            ? `New invite code issued for ${name}. Copy the instructions to share it.`
            : `Invite re-sent to ${name}.`,
        );
      } else {
        await createInvite.mutateAsync({ employeeId, channel: "LINK" });
        toast.success(`Invite created for ${name}. Copy the instructions to share it.`);
      }
      void refreshPanel();
    } catch (error) {
      toastError(error, { title: "Couldn't resend the invite" });
    } finally {
      setBusy(null);
    }
  };

  return { busy, canWrite, copyInvite, resend };
}

/**
 * Employees who have not finished connecting their phone (`GET /api/compliance/employees?filter=AWAITING_SETUP`)
 * with the actions a manager needs to unblock them: copy the setup instructions, resend the invite, open the employee.
 */
export function AwaitingSetupPanel({ className }: { className?: string }) {
  const query = useComplianceEmployees(AWAITING_PARAMS);
  const { busy, canWrite, copyInvite, resend } = useAwaitingSetupActions();

  const total = query.data?.total ?? 0;
  const rows = query.data?.items ?? [];

  return (
    <SectionCard
      title="Awaiting employee setup"
      description="Employees who haven't finished connecting their phone yet."
      className={className}
      actions={
        total > rows.length ? (
          <Button asChild variant="ghost" size="sm">
            <Link href={AWAITING_ALL_HREF}>
              View all {total}
              <ArrowUpRight aria-hidden="true" />
            </Link>
          </Button>
        ) : undefined
      }
      contentClassName="px-5 py-2 sm:px-6"
    >
      {query.isPending ? (
        <ul
          aria-busy="true"
          aria-label="Loading employees awaiting setup"
          className="divide-border divide-y"
        >
          {Array.from({ length: 3 }, (_, i) => (
            <li key={i} className="flex items-center justify-between gap-4 py-3">
              <div className="flex-1 space-y-2">
                <Skeleton className="h-4 w-40" />
                <Skeleton className="h-3 w-56" />
              </div>
              <Skeleton className="h-8 w-40" />
            </li>
          ))}
        </ul>
      ) : query.isError ? (
        <ErrorState
          size="sm"
          title="Couldn't load employees awaiting setup"
          error={query.error}
          onRetry={() => void query.refetch()}
          isRetrying={query.isRefetching}
        />
      ) : rows.length === 0 ? (
        <EmptyState
          icon={CircleCheck}
          size="sm"
          bordered={false}
          headingLevel={3}
          title="Everyone is set up"
          description="Every active employee has connected their phone and finished Screen Time setup."
        />
      ) : (
        <ul className="divide-border divide-y" aria-label="Employees awaiting setup">
          {rows.map((row) => {
            const info = describeAwaitingSetup(row);
            const name = fullName(row.employee);
            const isBusy = busy?.id === row.employee.id;
            return (
              <li
                key={row.employee.id}
                className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="min-w-0 space-y-0.5">
                  <div className="flex flex-wrap items-center gap-2">
                    <Link
                      href={routeFor.employee(row.employee.id)}
                      className="focus-visible:ring-ring/50 truncate rounded-sm font-medium underline-offset-4 outline-none hover:underline focus-visible:ring-2"
                    >
                      {name}
                    </Link>
                    <StatusBadge kind="inviteStatus" value={row.employee.inviteStatus} size="sm" />
                  </div>
                  <p className={cn("text-sm", TONE_TEXT[info.tone])}>{info.statusText}</p>
                  {info.detail ? (
                    <p className="text-muted-foreground text-xs">{info.detail}</p>
                  ) : null}
                </div>
                <div className="flex shrink-0 flex-wrap items-center gap-2">
                  {info.canCopyInvite ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={isBusy}
                      aria-busy={isBusy && busy?.action === "copy" ? true : undefined}
                      aria-label={`Copy invite instructions for ${name}`}
                      onClick={() => void copyInvite(row)}
                    >
                      {isBusy && busy?.action === "copy" ? (
                        <LoaderCircle className="animate-spin" aria-hidden="true" />
                      ) : (
                        <Copy aria-hidden="true" />
                      )}
                      Copy invite
                    </Button>
                  ) : null}
                  {info.inviteAction && canWrite ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={isBusy}
                      aria-busy={isBusy && busy?.action === "resend" ? true : undefined}
                      aria-label={`${info.inviteAction === "invite" ? "Invite" : "Resend invite to"} ${name}`}
                      onClick={() => void resend(row)}
                    >
                      {isBusy && busy?.action === "resend" ? (
                        <LoaderCircle className="animate-spin" aria-hidden="true" />
                      ) : (
                        <Send aria-hidden="true" />
                      )}
                      {info.inviteAction === "invite" ? "Invite" : "Resend"}
                    </Button>
                  ) : null}
                  <Button asChild variant="ghost" size="sm">
                    <Link href={routeFor.employee(row.employee.id)} aria-label={`View ${name}`}>
                      View
                      <ArrowUpRight aria-hidden="true" />
                    </Link>
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </SectionCard>
  );
}
