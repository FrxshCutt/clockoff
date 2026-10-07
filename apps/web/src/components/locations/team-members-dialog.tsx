"use client";

import type { Employee } from "@clockoff/validation/employees";
import type { Team } from "@clockoff/validation/locationsTeams";
import { LoaderCircle, UserRoundMinus, UserRoundPlus, X } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import {
  EmployeePicker,
  formatEmployeeHint,
  formatEmployeeName,
} from "@/components/policies/employee-picker";
import { StatusBadge } from "@/components/status/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { useApiErrorToast } from "@/hooks/use-api-error-toast";
import { usePermission } from "@/hooks/use-current-user";
import { formatCount } from "@/lib/format";
import { LOCATIONS_EMPTY_STATES } from "./locations-copy";
import {
  TEAM_MEMBERS_PAGE_SIZE,
  useAddTeamMembers,
  useRemoveTeamMember,
  useTeamMembers,
} from "./use-locations-teams";

export interface TeamMembersDialogProps {
  team: Team | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type PickedEmployee = Pick<Employee, "id" | "firstName" | "lastName">;

/**
 * Members of a team: the current list (`GET /api/employees?teamId=`), a multi-select picker that queues
 * employees to add (`POST /api/teams/:id/members`) and per-row removal (`DELETE /api/teams/:id/members/:employeeId`).
 */
export function TeamMembersDialog({ team, open, onOpenChange }: TeamMembersDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[85vh] flex-col sm:max-w-lg">
        {team && open ? (
          <TeamMembersBody key={team.id} team={team} onClose={() => onOpenChange(false)} />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function TeamMembersBody({ team, onClose }: { team: Team; onClose: () => void }) {
  const canEdit = usePermission("employees:write");
  const members = useTeamMembers(team.id);
  const add = useAddTeamMembers();
  const remove = useRemoveTeamMember();
  const toastError = useApiErrorToast();
  const [toAdd, setToAdd] = useState<ReadonlyMap<string, PickedEmployee>>(new Map());
  const [removingIds, setRemovingIds] = useState<ReadonlySet<string>>(new Set());

  const current = members.data?.items ?? [];
  const memberIds = new Set(current.map((employee) => employee.id));
  const selectedIds = new Set<string>([...memberIds, ...toAdd.keys()]);

  const removeMember = async (employee: PickedEmployee) => {
    setRemovingIds((prev) => new Set(prev).add(employee.id));
    try {
      await remove.mutateAsync({ id: team.id, employeeId: employee.id });
      toast.success(`${formatEmployeeName(employee)} removed from ${team.name}`);
    } catch (error) {
      toastError(error, { title: "Couldn't remove the member" });
    } finally {
      setRemovingIds((prev) => {
        const next = new Set(prev);
        next.delete(employee.id);
        return next;
      });
    }
  };

  const onToggle = (employee: PickedEmployee, selected: boolean) => {
    if (memberIds.has(employee.id)) {
      if (!selected) void removeMember(employee);
      return;
    }
    setToAdd((prev) => {
      const next = new Map(prev);
      if (selected) next.set(employee.id, employee);
      else next.delete(employee.id);
      return next;
    });
  };

  const submitAdd = async () => {
    const employeeIds = [...toAdd.keys()];
    if (employeeIds.length === 0) return;
    try {
      await add.mutateAsync({ id: team.id, input: { employeeIds } });
      toast.success(`${formatCount(employeeIds.length, "employee")} added to ${team.name}`);
      setToAdd(new Map());
    } catch (error) {
      toastError(error, { title: "Couldn't add members" });
    }
  };

  const total = members.data?.total ?? current.length;

  return (
    <>
      <DialogHeader>
        <DialogTitle>Members of {team.name}</DialogTitle>
        <DialogDescription>
          Adding or removing people changes which Work Policy and Break Rules apply to them from
          their phone&apos;s next sync.
        </DialogDescription>
      </DialogHeader>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto pr-1">
        {canEdit ? (
          <div className="space-y-3">
            <EmployeePicker
              label="Add employees"
              description="Tick people to add them. Untick a current member to remove them straight away."
              selectedIds={selectedIds}
              pendingIds={removingIds}
              onToggle={onToggle}
              disabled={add.isPending}
            />
            {toAdd.size > 0 ? (
              <ul className="flex flex-wrap gap-1.5" aria-label="Employees to add">
                {[...toAdd.values()].map((employee) => (
                  <li key={employee.id}>
                    <Badge variant="secondary" className="gap-1 pr-1">
                      {formatEmployeeName(employee)}
                      <button
                        type="button"
                        className="hover:bg-foreground/10 rounded-full p-0.5 outline-none focus-visible:ring-2"
                        aria-label={`Don't add ${formatEmployeeName(employee)}`}
                        onClick={() => onToggle(employee, false)}
                      >
                        <X className="size-3" aria-hidden="true" />
                      </button>
                    </Badge>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}

        <section aria-labelledby="team-members-heading" className="space-y-2">
          <h3 id="team-members-heading" className="text-sm font-semibold">
            Current members{members.data ? ` (${formatCount(total, "person", "people")})` : ""}
          </h3>
          {members.isPending ? (
            <ul className="space-y-2" aria-busy="true">
              {Array.from({ length: 3 }, (_, index) => (
                <li key={index}>
                  <Skeleton className="h-10 w-full" />
                </li>
              ))}
            </ul>
          ) : members.isError ? (
            <ErrorState
              size="sm"
              title="Couldn't load members"
              error={members.error}
              onRetry={() => void members.refetch()}
              isRetrying={members.isRefetching}
            />
          ) : current.length === 0 ? (
            <EmptyState
              icon={LOCATIONS_EMPTY_STATES.teamMembers.icon}
              title={LOCATIONS_EMPTY_STATES.teamMembers.title}
              description={LOCATIONS_EMPTY_STATES.teamMembers.description}
              size="sm"
              headingLevel={3}
            />
          ) : (
            <ul className="divide-y rounded-lg border">
              {current.map((employee) => {
                const hint = formatEmployeeHint(employee);
                const removing = removingIds.has(employee.id);
                return (
                  <li key={employee.id} className="flex items-center gap-3 px-3 py-2.5">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{formatEmployeeName(employee)}</p>
                      {hint ? (
                        <p className="text-muted-foreground truncate text-xs">{hint}</p>
                      ) : null}
                    </div>
                    <StatusBadge
                      kind="inviteStatus"
                      value={employee.inviteStatus}
                      size="sm"
                      hideIcon
                    />
                    {canEdit ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Remove ${formatEmployeeName(employee)} from ${team.name}`}
                        disabled={removing}
                        onClick={() => void removeMember(employee)}
                      >
                        {removing ? (
                          <LoaderCircle className="animate-spin" aria-hidden="true" />
                        ) : (
                          <UserRoundMinus aria-hidden="true" />
                        )}
                      </Button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
          {total > TEAM_MEMBERS_PAGE_SIZE ? (
            <p className="text-muted-foreground text-xs">
              Showing the first {TEAM_MEMBERS_PAGE_SIZE} of {total} members.
            </p>
          ) : null}
        </section>
      </div>

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose} disabled={add.isPending}>
          Done
        </Button>
        {canEdit ? (
          <Button
            type="button"
            onClick={() => void submitAdd()}
            disabled={toAdd.size === 0 || add.isPending}
          >
            {add.isPending ? (
              <LoaderCircle className="animate-spin" aria-hidden="true" />
            ) : (
              <UserRoundPlus aria-hidden="true" />
            )}
            {toAdd.size === 0 ? "Add members" : `Add ${formatCount(toAdd.size, "employee")}`}
          </Button>
        ) : null}
      </DialogFooter>
    </>
  );
}
