"use client";

import type { AssignmentScopeType } from "@clockoff/shared/enums";
import { SCOPE_TYPE_LABELS } from "@clockoff/shared/policy/explainResolution";
import {
  Building2,
  LoaderCircle,
  MapPin,
  Star,
  UserRound,
  Users,
  X,
  type LucideIcon,
} from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { ErrorState } from "@/components/error-state";
import { InlineAlert } from "@/components/inline-alert";
import { RelativeTime } from "@/components/relative-time";
import { SectionCard } from "@/components/section";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import { useNow } from "@/components/employees/use-now";
import { useApiErrorToast } from "@/hooks/use-api-error-toast";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import { EmployeePicker } from "./employee-picker";
import { MultiSelectCombobox, type MultiSelectOption } from "./multi-select-combobox";
import {
  PRECEDENCE_LEVELS,
  activeAssignmentsByScopeId,
  describeAssignmentScope,
  groupAssignmentsByScope,
  openAssignments,
  type ScopedAssignment,
} from "./policy-view-model";
import { PrecedenceExplainer } from "./precedence-explainer";
import { useLocations, useTeams } from "./use-assignment-targets";
import { useOrgDateOptions } from "./use-org-format";

export const SCOPE_ICONS: Record<AssignmentScopeType, LucideIcon> = {
  EMPLOYEE: UserRound,
  TEAM: Users,
  LOCATION: MapPin,
  ORGANISATION: Building2,
};

export type AssignableScopeType = Exclude<AssignmentScopeType, "ORGANISATION">;

export interface AssignmentsPanelProps {
  /** "policy" or "break rules" — fills the copy. */
  noun: string;
  assignments: readonly ScopedAssignment[] | undefined;
  isLoading: boolean;
  isError: boolean;
  error?: unknown;
  onRetry: () => void;
  isRetrying?: boolean;
  canEdit: boolean;
  /** Why new assignments can't be made right now (e.g. the policy isn't published). */
  assignDisabledReason?: string;
  isDefault: boolean;
  /** Why the default toggle can't be switched on right now. */
  defaultDisabledReason?: string;
  onSetDefault: (next: boolean) => Promise<unknown>;
  onAssign: (
    scopeType: AssignableScopeType,
    scopeId: string,
    scopeName: string,
  ) => Promise<unknown>;
  onRemove: (assignment: ScopedAssignment) => Promise<unknown>;
  /** Shown above the pickers (e.g. a "publish first" note). */
  notice?: ReactNode;
  /** Copy overrides for plural nouns ("Break Rules"); the defaults read naturally for "policy". */
  description?: string;
  emptyText?: string;
  precedenceTitle?: string;
}

function scopeKey(scopeType: AssignmentScopeType, scopeId: string): string {
  return `${scopeType}:${scopeId}`;
}

/**
 * Who a policy applies to: organisation default toggle, location / team multi-selects, an employee picker, the
 * precedence explainer and the current assignments with remove buttons. Every toggle is a real request;
 * rows show a spinner until it settles.
 */
export function AssignmentsPanel({
  noun,
  assignments,
  isLoading,
  isError,
  error,
  onRetry,
  isRetrying,
  canEdit,
  assignDisabledReason,
  isDefault,
  defaultDisabledReason,
  onSetDefault,
  onAssign,
  onRemove,
  notice,
  description = `Who this ${noun} applies to. The most specific assignment wins.`,
  emptyText = `No assignments yet. Pick locations, teams or employees above, or make this the organisation default ${noun}.`,
  precedenceTitle,
}: AssignmentsPanelProps) {
  const toastError = useApiErrorToast();
  const [pendingKeys, setPendingKeys] = useState<ReadonlySet<string>>(new Set());
  const [defaultPending, setDefaultPending] = useState(false);
  const defaultId = useId();

  const locations = useLocations({ enabled: canEdit });
  const teams = useTeams({ enabled: canEdit });

  const list = assignments ?? [];
  const byLocation = activeAssignmentsByScopeId(list, "LOCATION");
  const byTeam = activeAssignmentsByScopeId(list, "TEAM");
  const byEmployee = activeAssignmentsByScopeId(list, "EMPLOYEE");

  const track = async (key: string, task: () => Promise<unknown>) => {
    setPendingKeys((prev) => new Set(prev).add(key));
    try {
      await task();
    } finally {
      setPendingKeys((prev) => {
        const next = new Set(prev);
        next.delete(key);
        return next;
      });
    }
  };

  const toggleScope = (
    scopeType: AssignableScopeType,
    scopeId: string,
    scopeName: string,
    selected: boolean,
  ) => {
    const existing = activeAssignmentsByScopeId(list, scopeType).get(scopeId);
    void track(scopeKey(scopeType, scopeId), async () => {
      try {
        if (selected) {
          await onAssign(scopeType, scopeId, scopeName);
          toast.success(`Assigned to ${scopeName}`);
        } else if (existing) {
          await onRemove(existing);
          toast.success(`Removed from ${scopeName}`);
        }
      } catch (err) {
        toastError(err, { title: selected ? "Couldn't assign" : "Couldn't remove the assignment" });
      }
    });
  };

  const removeAssignment = (assignment: ScopedAssignment) => {
    const name = describeAssignmentScope(assignment);
    void track(scopeKey(assignment.scopeType, assignment.scopeId), async () => {
      try {
        await onRemove(assignment);
        toast.success(`Removed from ${name}`);
      } catch (err) {
        toastError(err, { title: "Couldn't remove the assignment" });
      }
    });
  };

  const toggleDefault = async (next: boolean) => {
    setDefaultPending(true);
    try {
      await onSetDefault(next);
      toast.success(
        next
          ? `Now the organisation default ${noun}`
          : `No longer the organisation default ${noun}`,
      );
    } catch (err) {
      toastError(err, { title: "Couldn't change the organisation default" });
    } finally {
      setDefaultPending(false);
    }
  };

  const pendingIdsFor = (scopeType: AssignableScopeType): ReadonlySet<string> => {
    const ids = new Set<string>();
    for (const key of pendingKeys) {
      const [type, id] = key.split(":");
      if (type === scopeType && id) ids.add(id);
    }
    return ids;
  };

  const toOptions = (
    rows: ReadonlyArray<{ id: string; name: string; hint?: string }> | undefined,
  ): MultiSelectOption[] | undefined =>
    rows?.map((row) => ({ id: row.id, name: row.name, hint: row.hint }));

  const assignDisabled = !canEdit || assignDisabledReason !== undefined;
  const defaultSwitchDisabled =
    !canEdit || defaultPending || (!isDefault && defaultDisabledReason !== undefined);

  return (
    <SectionCard title="Assignments" description={description} contentClassName="space-y-5">
      {notice}

      <div className="flex items-start justify-between gap-4 rounded-lg border p-4">
        <div className="space-y-1">
          <Label htmlFor={defaultId} className="flex items-center gap-2">
            <Star
              className={cn(
                "size-4",
                isDefault ? "fill-amber-400 text-amber-500" : "text-muted-foreground",
              )}
              aria-hidden="true"
            />
            Organisation default
          </Label>
          <p className="text-muted-foreground text-sm">
            Applies to everyone who has no location, team or employee assignment.
            {!isDefault && defaultDisabledReason ? ` ${defaultDisabledReason}` : ""}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {defaultPending ? (
            <LoaderCircle
              className="text-muted-foreground size-4 animate-spin"
              aria-hidden="true"
            />
          ) : null}
          <Switch
            id={defaultId}
            checked={isDefault}
            disabled={defaultSwitchDisabled}
            onCheckedChange={(next) => void toggleDefault(next)}
            aria-busy={defaultPending || undefined}
          />
        </div>
      </div>

      {canEdit ? (
        <div className="grid gap-4 sm:grid-cols-2">
          <MultiSelectCombobox
            label="Locations"
            icon={MapPin}
            noun="location"
            options={toOptions(locations.data)}
            isLoading={locations.isPending}
            selectedIds={new Set(byLocation.keys())}
            pendingIds={pendingIdsFor("LOCATION")}
            onToggle={(option, selected) =>
              toggleScope("LOCATION", option.id, option.name, selected)
            }
            disabled={assignDisabled || locations.isError}
            disabledReason={
              assignDisabledReason ?? (locations.isError ? "Couldn't load locations." : undefined)
            }
            description="Applies to employees whose primary location this is."
            searchPlaceholder="Search locations…"
            emptyText="No locations match."
          />
          <MultiSelectCombobox
            label="Teams"
            icon={Users}
            noun="team"
            options={toOptions(
              teams.data?.map((team) => ({
                id: team.id,
                name: team.name,
                hint: team.location?.name,
              })),
            )}
            isLoading={teams.isPending}
            selectedIds={new Set(byTeam.keys())}
            pendingIds={pendingIdsFor("TEAM")}
            onToggle={(option, selected) => toggleScope("TEAM", option.id, option.name, selected)}
            disabled={assignDisabled || teams.isError}
            disabledReason={
              assignDisabledReason ?? (teams.isError ? "Couldn't load teams." : undefined)
            }
            description="Applies to every member of the team."
            searchPlaceholder="Search teams…"
            emptyText="No teams match."
          />
          <div className="sm:col-span-2">
            <EmployeePicker
              selectedIds={new Set(byEmployee.keys())}
              pendingIds={pendingIdsFor("EMPLOYEE")}
              onToggle={(employee, selected) =>
                toggleScope(
                  "EMPLOYEE",
                  employee.id,
                  `${employee.firstName} ${employee.lastName}`.trim(),
                  selected,
                )
              }
              disabled={assignDisabled}
              disabledReason={assignDisabledReason}
            />
          </div>
        </div>
      ) : (
        <InlineAlert variant="info" title="View only">
          Only owners and admins can change assignments.
        </InlineAlert>
      )}

      <PrecedenceExplainer noun={noun} title={precedenceTitle} />

      <div className="space-y-2">
        <h3 className="text-sm font-medium">Current assignments</h3>
        {isError ? (
          <ErrorState
            size="sm"
            title="Couldn't load assignments"
            error={error}
            onRetry={onRetry}
            isRetrying={isRetrying}
          />
        ) : (
          <AssignmentList
            assignments={isLoading ? undefined : list}
            canRemove={canEdit}
            onRemove={removeAssignment}
            pendingKeys={pendingKeys}
            emptyText={emptyText}
          />
        )}
      </div>
    </SectionCard>
  );
}

export interface AssignmentListProps {
  /** `undefined` renders skeleton rows. */
  assignments: readonly ScopedAssignment[] | undefined;
  canRemove: boolean;
  onRemove?: (assignment: ScopedAssignment) => void;
  pendingKeys?: ReadonlySet<string>;
  emptyText?: string;
  className?: string;
}

/**
 * Open assignments grouped by scope in precedence order, each with an optional remove button. Ended
 * assignments are history, not "current", so they are left out (the API returns every row).
 */
export function AssignmentList({
  assignments,
  canRemove,
  onRemove,
  pendingKeys,
  emptyText = "No assignments.",
  className,
}: AssignmentListProps) {
  const { timeZone, dateFormat } = useOrgDateOptions();
  // Shared clock (null during the server/hydration pass, when the list shows its skeleton anyway).
  const now = useNow();

  if (assignments === undefined || now === null) {
    return (
      <div className={cn("space-y-2", className)} aria-busy="true">
        {Array.from({ length: 3 }, (_, i) => (
          <Skeleton key={i} className="h-12 w-full" />
        ))}
      </div>
    );
  }
  const open = openAssignments(assignments, now);
  if (open.length === 0) {
    return (
      <p
        className={cn(
          "text-muted-foreground rounded-lg border border-dashed px-4 py-6 text-center text-sm",
          className,
        )}
      >
        {emptyText}
      </p>
    );
  }

  const groups = groupAssignmentsByScope(open);
  return (
    <div className={cn("space-y-4", className)}>
      {PRECEDENCE_LEVELS.map((level) => {
        const rows = groups[level.scopeType];
        if (rows.length === 0) return null;
        const Icon = SCOPE_ICONS[level.scopeType];
        return (
          <div key={level.scopeType} className="space-y-1.5">
            <p className="text-muted-foreground flex items-center gap-1.5 text-xs font-medium tracking-wide uppercase">
              <Icon className="size-3.5" aria-hidden="true" />
              {SCOPE_TYPE_LABELS[level.scopeType]}
            </p>
            <ul className="divide-y rounded-lg border">
              {rows.map((assignment) => {
                const pending =
                  pendingKeys?.has(scopeKey(assignment.scopeType, assignment.scopeId)) ?? false;
                const name = describeAssignmentScope(assignment);
                return (
                  <li key={assignment.id} className="flex items-center gap-3 px-3 py-2.5">
                    <div className="min-w-0 flex-1">
                      <p className="flex flex-wrap items-center gap-2 text-sm font-medium">
                        <span className="truncate">{name}</span>
                        {!assignment.isActive ? (
                          <Badge variant="outline" className="font-normal">
                            {assignment.effectiveFrom && Date.parse(assignment.effectiveFrom) > now
                              ? `Starts ${formatDateTime(assignment.effectiveFrom, { timeZone, dateFormat })}`
                              : "Not active"}
                          </Badge>
                        ) : null}
                      </p>
                      <p className="text-muted-foreground text-xs">
                        Assigned <RelativeTime value={assignment.createdAt} timeZone={timeZone} />
                        {assignment.createdBy ? ` by ${assignment.createdBy.name}` : ""}
                        {assignment.effectiveTo
                          ? ` · until ${formatDateTime(assignment.effectiveTo, { timeZone, dateFormat })}`
                          : ""}
                      </p>
                    </div>
                    {canRemove && onRemove ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Remove assignment for ${name}`}
                        disabled={pending}
                        onClick={() => onRemove(assignment)}
                      >
                        {pending ? (
                          <LoaderCircle className="animate-spin" aria-hidden="true" />
                        ) : (
                          <X aria-hidden="true" />
                        )}
                      </Button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </div>
        );
      })}
    </div>
  );
}
