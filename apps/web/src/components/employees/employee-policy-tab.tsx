"use client";

import { RESTRICTION_CATEGORY_LABELS } from "@clockoff/shared/enums";
import type { BreakPolicy } from "@clockoff/validation/breakPolicies";
import type { EmployeeDetail } from "@clockoff/validation/employees";
import type { Policy } from "@clockoff/validation/policies";
import { Coffee, ExternalLink, ShieldCheck } from "lucide-react";
import Link from "next/link";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { InlineAlert } from "@/components/inline-alert";
import { BEHAVIOUR_LABELS } from "@/components/overrides/override-helpers";
import { SectionCard } from "@/components/section";
import { StatusBadge } from "@/components/status/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ROUTES, routeFor } from "@/config/navigation";
import { usePermission } from "@/hooks/use-current-user";
import { useApiErrorToast } from "@/hooks/use-api-error-toast";
import { formatDurationMinutes, humanizeEnum } from "@/lib/format";
import { AssignPolicyDialog } from "./assign-policy-dialog";
import {
  useAssignEmployeeBreakPolicy,
  useAssignEmployeePolicy,
  useBreakPolicies,
  usePolicies,
} from "./employee-api";
import { describeResolvedFrom, employeeFullName } from "./employee-view-model";

export interface EmployeePolicyTabProps {
  employee: EmployeeDetail;
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-0.5">
      <dt className="text-muted-foreground text-xs font-medium tracking-wide uppercase">{label}</dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

/**
 * The Work Policy and Break Rules that resolve for this employee (employee → team → location → organisation →
 * default), what they restrict, and the employee-level override controls (`POST /api/employees/:id/assign-policy`
 * / `assign-break-policy`; `null` clears the override).
 */
export function EmployeePolicyTab({ employee }: EmployeePolicyTabProps) {
  const canWrite = usePermission("employees:write");
  const policies = usePolicies();
  const breakPolicies = useBreakPolicies();
  const assignPolicy = useAssignEmployeePolicy();
  const assignBreakPolicy = useAssignEmployeeBreakPolicy();
  const toastError = useApiErrorToast();
  const [dialog, setDialog] = useState<
    "policy" | "breakPolicy" | "clearPolicy" | "clearBreakPolicy" | null
  >(null);

  const name = employeeFullName(employee);
  const resolvedPolicy = employee.resolvedPolicy;
  const resolvedBreak = employee.resolvedBreakPolicy;
  const policy: Policy | undefined = resolvedPolicy
    ? policies.data?.find((p) => p.id === resolvedPolicy.id)
    : undefined;
  const breakPolicy: BreakPolicy | undefined = resolvedBreak
    ? breakPolicies.data?.find((p) => p.id === resolvedBreak.id)
    : undefined;
  const policyFrom = describeResolvedFrom(resolvedPolicy, employee);
  const breakFrom = describeResolvedFrom(resolvedBreak, employee);
  const version = policy?.currentVersion ?? null;

  const clearPolicy = async () => {
    try {
      await assignPolicy.mutateAsync({ id: employee.id, policyId: null });
      toast.success(`Policy override removed for ${name}`, {
        description: "The team, location or organisation policy applies again.",
      });
    } catch (error) {
      toastError(error, { title: "Couldn't remove the override" });
      throw error;
    }
  };
  const clearBreakPolicy = async () => {
    try {
      await assignBreakPolicy.mutateAsync({ id: employee.id, breakPolicyId: null });
      toast.success(`Break Rules override removed for ${name}`);
    } catch (error) {
      toastError(error, { title: "Couldn't remove the override" });
      throw error;
    }
  };

  const overrideControls = (kind: "policy" | "breakPolicy") => {
    if (!canWrite) return null;
    const current = kind === "policy" ? employee.policyOverride : employee.breakPolicyOverride;
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" variant="outline" size="sm" onClick={() => setDialog(kind)}>
          {current ? "Change override" : "Set employee override"}
        </Button>
        {current ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setDialog(kind === "policy" ? "clearPolicy" : "clearBreakPolicy")}
          >
            Clear override
          </Button>
        ) : null}
      </div>
    );
  };

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <SectionCard
        title={
          <span className="flex items-center gap-2">
            <ShieldCheck className="text-muted-foreground size-4" aria-hidden="true" />
            Work Policy
          </span>
        }
        description="What is restricted on the phone during shifts."
        actions={
          resolvedPolicy ? (
            <Button asChild variant="ghost" size="sm">
              <Link href={routeFor.policy(resolvedPolicy.id)}>
                Open policy
                <ExternalLink aria-hidden="true" />
              </Link>
            </Button>
          ) : undefined
        }
        footer={overrideControls("policy")}
      >
        {!resolvedPolicy ? (
          <InlineAlert
            variant="warning"
            title="No Work Policy applies"
            action={
              <Button asChild variant="outline" size="sm">
                <Link href={ROUTES.policies}>Policies</Link>
              </Button>
            }
          >
            Nothing is restricted during this employee&apos;s shifts until a policy is assigned to
            them, their team, their location or the organisation.
          </InlineAlert>
        ) : (
          <dl className="space-y-4">
            <Fact label="Policy">
              <span className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{resolvedPolicy.name}</span>
                {policy ? (
                  <StatusBadge kind="policyStatus" value={policy.status} size="sm" />
                ) : policies.isPending ? (
                  <Skeleton className="h-5 w-16" />
                ) : null}
              </span>
            </Fact>
            <Fact label="Resolved from">
              {policyFrom ? (
                <span>
                  {policyFrom.label}
                  {policyFrom.detail ? (
                    <span className="text-muted-foreground"> · {policyFrom.detail}</span>
                  ) : null}
                </span>
              ) : (
                "—"
              )}
              {employee.policyOverride ? (
                <p className="text-muted-foreground mt-0.5 text-xs">
                  Employee override: {employee.policyOverride.name}
                </p>
              ) : null}
            </Fact>
            {policies.isPending ? (
              <div className="space-y-2" aria-busy="true">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-6 w-full" />
              </div>
            ) : version ? (
              <>
                <Fact label="Restricted categories">
                  <ul className="flex flex-wrap gap-1.5" aria-label="Restricted categories">
                    {version.restrictionConfig.categories.map((category) => (
                      <li key={category}>
                        <Badge variant="secondary" className="font-normal">
                          {RESTRICTION_CATEGORY_LABELS[category] ?? humanizeEnum(category)}
                        </Badge>
                      </li>
                    ))}
                  </ul>
                </Fact>
                <div className="grid gap-4 sm:grid-cols-2">
                  <Fact label="Switches on">
                    {version.restrictionConfig.activationMode === "SCHEDULED"
                      ? "At scheduled shift times"
                      : "On clock-in events"}
                    {version.restrictionConfig.preShiftWarningMinutes > 0
                      ? ` · warns ${formatDurationMinutes(version.restrictionConfig.preShiftWarningMinutes)} before`
                      : ""}
                  </Fact>
                  <Fact label="App selection">
                    {version.restrictionConfig.requireEmployeeAppSelection
                      ? "Employee picks the apps on their phone"
                      : "Category-based"}
                  </Fact>
                </div>
                {version.restrictionConfig.alwaysAllowedNote.length > 0 ? (
                  <Fact label="Always allowed">
                    {version.restrictionConfig.alwaysAllowedNote.join(", ")}
                  </Fact>
                ) : null}
                <Fact label="During breaks (policy default)">
                  {BEHAVIOUR_LABELS[version.breakBehaviourDefault.restrictionBehaviour]}
                  {version.breakBehaviourDefault.restrictionBehaviour === "RELAX_CATEGORIES"
                    ? `: ${version.breakBehaviourDefault.relaxedCategories.map((c) => RESTRICTION_CATEGORY_LABELS[c] ?? c).join(", ")}`
                    : ""}
                </Fact>
              </>
            ) : policy ? (
              <InlineAlert variant="warning">
                This policy has never been published, so devices have nothing to apply yet.
              </InlineAlert>
            ) : (
              <p className="text-muted-foreground text-sm">
                Details unavailable (the policy may be archived).
              </p>
            )}
          </dl>
        )}
      </SectionCard>

      <SectionCard
        title={
          <span className="flex items-center gap-2">
            <Coffee className="text-muted-foreground size-4" aria-hidden="true" />
            Break Rules
          </span>
        }
        description="How breaks work and what relaxes during them."
        actions={
          resolvedBreak ? (
            <Button asChild variant="ghost" size="sm">
              <Link href={routeFor.breakRule(resolvedBreak.id)}>
                Open Break Rules
                <ExternalLink aria-hidden="true" />
              </Link>
            </Button>
          ) : undefined
        }
        footer={overrideControls("breakPolicy")}
      >
        {!resolvedBreak ? (
          <InlineAlert
            variant="info"
            title="No Break Rules apply"
            action={
              <Button asChild variant="outline" size="sm">
                <Link href={ROUTES.breakRules}>Break Rules</Link>
              </Button>
            }
          >
            Breaks fall back to the Work Policy&apos;s default break behaviour. Assign Break Rules
            to control how many breaks are allowed and how long they last.
          </InlineAlert>
        ) : (
          <dl className="space-y-4">
            <Fact label="Break Rules">
              <span className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{resolvedBreak.name}</span>
                {breakPolicy ? (
                  <StatusBadge kind="policyStatus" value={breakPolicy.status} size="sm" />
                ) : breakPolicies.isPending ? (
                  <Skeleton className="h-5 w-16" />
                ) : null}
              </span>
            </Fact>
            <Fact label="Resolved from">
              {breakFrom ? (
                <span>
                  {breakFrom.label}
                  {breakFrom.detail ? (
                    <span className="text-muted-foreground"> · {breakFrom.detail}</span>
                  ) : null}
                </span>
              ) : (
                "—"
              )}
              {employee.breakPolicyOverride ? (
                <p className="text-muted-foreground mt-0.5 text-xs">
                  Employee override: {employee.breakPolicyOverride.name}
                </p>
              ) : null}
            </Fact>
            {breakPolicies.isPending ? (
              <div className="space-y-2" aria-busy="true">
                <Skeleton className="h-4 w-32" />
                <Skeleton className="h-6 w-full" />
              </div>
            ) : breakPolicy ? (
              breakPolicy.breaksEnabled ? (
                <>
                  <div className="grid gap-4 sm:grid-cols-2">
                    <Fact label="Per shift">
                      Up to {breakPolicy.maxBreaksPerShift}{" "}
                      {breakPolicy.maxBreaksPerShift === 1 ? "break" : "breaks"},{" "}
                      {formatDurationMinutes(breakPolicy.maxTotalBreakMinutes)} in total
                    </Fact>
                    <Fact label="Each break">
                      Up to {formatDurationMinutes(breakPolicy.maxBreakDurationMinutes)}
                    </Fact>
                    <Fact label="Earliest break">
                      {formatDurationMinutes(breakPolicy.minMinutesAfterShiftStart)} after the shift
                      starts
                    </Fact>
                    <Fact label="Gap between breaks">
                      {formatDurationMinutes(breakPolicy.minGapBetweenBreaksMinutes)}
                    </Fact>
                  </div>
                  <Fact label="Who starts breaks">
                    {[
                      breakPolicy.employeeTriggeredAllowed ? "The employee, from the app" : null,
                      breakPolicy.scheduledBreaksAllowed ? "Scheduled on the shift" : null,
                    ]
                      .filter(Boolean)
                      .join(" · ") || "Nobody (breaks are configured but cannot start)"}
                  </Fact>
                  <Fact label="During a break">
                    {BEHAVIOUR_LABELS[breakPolicy.restrictionBehaviour]}
                    {breakPolicy.restrictionBehaviour === "RELAX_CATEGORIES"
                      ? `: ${breakPolicy.relaxedCategories.map((c) => RESTRICTION_CATEGORY_LABELS[c] ?? c).join(", ")}`
                      : ""}
                  </Fact>
                </>
              ) : (
                <InlineAlert variant="info">
                  Breaks are turned off under these Break Rules.
                </InlineAlert>
              )
            ) : (
              <p className="text-muted-foreground text-sm">
                Details unavailable (the Break Rules may be archived).
              </p>
            )}
          </dl>
        )}
      </SectionCard>

      <div className="lg:col-span-2">
        <InlineAlert variant="info" title="How policies resolve">
          An employee-level override wins, then the team (one team only — several teams with
          policies is flagged in Activity), then the primary location, then the organisation
          assignment, then the organisation default.
        </InlineAlert>
      </div>

      <AssignPolicyDialog
        open={dialog === "policy"}
        onOpenChange={(open) => (open ? undefined : setDialog(null))}
        kind="policy"
        title={`Work Policy override for ${name}`}
        description="An employee-level assignment overrides the team, location and organisation policies."
        currentId={employee.policyOverride?.id ?? null}
        isPending={assignPolicy.isPending}
        error={assignPolicy.error}
        onSubmit={async (policyId) => {
          try {
            await assignPolicy.mutateAsync({ id: employee.id, policyId });
            toast.success(
              policyId ? `Policy assigned to ${name}` : `Policy override removed for ${name}`,
            );
          } catch (error) {
            toastError(error, { title: "Couldn't assign the policy" });
            throw error;
          }
        }}
      />
      <AssignPolicyDialog
        open={dialog === "breakPolicy"}
        onOpenChange={(open) => (open ? undefined : setDialog(null))}
        kind="breakPolicy"
        title={`Break Rules override for ${name}`}
        description="An employee-level assignment overrides the team, location and organisation Break Rules."
        currentId={employee.breakPolicyOverride?.id ?? null}
        isPending={assignBreakPolicy.isPending}
        error={assignBreakPolicy.error}
        onSubmit={async (breakPolicyId) => {
          try {
            await assignBreakPolicy.mutateAsync({ id: employee.id, breakPolicyId });
            toast.success(
              breakPolicyId
                ? `Break Rules assigned to ${name}`
                : `Break Rules override removed for ${name}`,
            );
          } catch (error) {
            toastError(error, { title: "Couldn't assign the Break Rules" });
            throw error;
          }
        }}
      />
      <ConfirmDialog
        open={dialog === "clearPolicy"}
        onOpenChange={(open) => (open ? undefined : setDialog(null))}
        title="Remove the Work Policy override?"
        description={`${name} will follow the team, location or organisation policy again. The phone picks it up on its next sync.`}
        confirmLabel="Remove override"
        onConfirm={clearPolicy}
      />
      <ConfirmDialog
        open={dialog === "clearBreakPolicy"}
        onOpenChange={(open) => (open ? undefined : setDialog(null))}
        title="Remove the Break Rules override?"
        description={`${name} will follow the team, location or organisation Break Rules again.`}
        confirmLabel="Remove override"
        onConfirm={clearBreakPolicy}
      />
    </div>
  );
}
