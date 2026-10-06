"use client";

import type { BreakPolicy } from "@workmode/validation/breakPolicies";
import { Pencil, Star } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { InlineAlert } from "@/components/inline-alert";
import { FormSkeleton, PageHeaderSkeleton } from "@/components/loading-skeletons";
import { PageHeader } from "@/components/page-header";
import { BackLink } from "@/components/placeholder-page";
import { AssignmentsPanel } from "@/components/policies/assignments-panel";
import { formatAssignedSummary } from "@/components/policies/policy-view-model";
import { SectionCard } from "@/components/section";
import { useBreadcrumbLabel } from "@/components/shell/breadcrumb-store";
import { StatusBadge } from "@/components/status/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EMPTY_STATES } from "@/config/emptyStates";
import { ROUTES } from "@/config/navigation";
import { usePermission } from "@/hooks/use-current-user";
import { hasErrorCode } from "@/lib/api-client";
import { formatDurationMinutes } from "@/lib/format";
import { BreakPolicyMenu, DeleteBreakPolicyDialog, useToggleDefaultBreakPolicy } from "./break-policy-actions";
import { BreakPolicyFormSheet } from "./break-policy-form-sheet";
import {
  BREAK_RULE_FIELD_META,
  RELAX_CATEGORIES_DEVICE_NOTE,
  breakPolicyAssignGuard,
  breakPolicySetDefaultGuard,
  describeBreakBehaviourLabel,
  describeBreakStarters,
  describeBreakTriggers,
  formatBreakCount,
  summariseBreakPolicy,
} from "./break-policy-view-model";
import {
  useAssignBreakPolicy,
  useBreakPolicy,
  useBreakPolicyAssignments,
  useRemoveBreakPolicyAssignment,
  useSetDefaultBreakPolicy,
} from "./use-break-policies";

const GRID = "grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(20rem,25rem)]";

function BreakRulesBackLink() {
  return <BackLink href={ROUTES.breakRules}>Break Rules</BackLink>;
}

function BreakPolicyNotFound() {
  const copy = EMPTY_STATES.breakRuleDetail;
  return (
    <>
      <PageHeader eyebrow={<BreakRulesBackLink />} title="Break Rules" />
      <EmptyState
        icon={copy.icon}
        title="Break Rules not found"
        description="They may have been deleted, or they belong to a different organisation."
        action={
          <Button asChild>
            <Link href={ROUTES.breakRules}>Back to Break Rules</Link>
          </Button>
        }
      />
    </>
  );
}

/** `/break-rules/[id]`: header with status and summary, the rules card, assignments, edit sheet and delete guard. */
export function BreakPolicyDetailView({ id }: { id: string }) {
  const router = useRouter();
  const canEdit = usePermission("policies:write");
  const policy = useBreakPolicy(id);
  useBreadcrumbLabel(id, policy.data?.name);
  const toggleDefault = useToggleDefaultBreakPolicy();
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState<BreakPolicy | null>(null);

  if (policy.isPending) {
    return (
      <>
        <PageHeaderSkeleton />
        <div className={GRID} aria-busy="true" role="status" aria-label="Loading Break Rules">
          <FormSkeleton fields={4} />
          <FormSkeleton fields={3} />
        </div>
      </>
    );
  }
  if (policy.isError) {
    if (hasErrorCode(policy.error, "NOT_FOUND")) return <BreakPolicyNotFound />;
    return (
      <>
        <PageHeader eyebrow={<BreakRulesBackLink />} title="Break Rules" />
        <ErrorState
          title="Couldn't load these Break Rules"
          error={policy.error}
          onRetry={() => void policy.refetch()}
          isRetrying={policy.isRefetching}
        />
      </>
    );
  }

  const current = policy.data;
  const archived = current.status === "ARCHIVED";
  const editable = canEdit && !archived;

  return (
    <>
      <PageHeader
        eyebrow={<BreakRulesBackLink />}
        title={current.name}
        description={
          <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <StatusBadge kind="policyStatus" value={current.status} size="sm" />
            {current.isDefault ? (
              <Badge variant="secondary" className="gap-1 font-normal">
                <Star className="fill-amber-400 text-amber-500" aria-hidden="true" />
                Organisation default
              </Badge>
            ) : null}
            <span className="tabular-nums">{summariseBreakPolicy(current)}</span>
            <span aria-hidden="true">·</span>
            <span>{formatAssignedSummary(current)}</span>
          </span>
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            {editable ? (
              <Button type="button" onClick={() => setEditing(true)}>
                <Pencil aria-hidden="true" />
                Edit
              </Button>
            ) : null}
            <BreakPolicyMenu
              policy={current}
              canEdit={canEdit}
              hideView
              onEdit={() => setEditing(true)}
              onDelete={setDeleting}
              onToggleDefault={(target) => void toggleDefault.toggle(target)}
              defaultPending={toggleDefault.isPending}
            />
          </div>
        }
      />

      {archived ? (
        <InlineAlert variant="warning" title="These Break Rules are archived">
          They are skipped when working out which Break Rules apply, and they can’t be edited or assigned.
        </InlineAlert>
      ) : null}

      <div className={GRID}>
        <BreakRulesCard policy={current} />
        <BreakPolicyAssignments policy={current} canEdit={editable} />
      </div>

      <BreakPolicyFormSheet open={editing} onOpenChange={setEditing} policy={current} />
      <DeleteBreakPolicyDialog policy={deleting} onClose={() => setDeleting(null)} onDeleted={() => router.push(ROUTES.breakRules)} />
    </>
  );
}

function minutesOrLabel(minutes: number, zeroLabel: string): string {
  return minutes === 0 ? zeroLabel : formatDurationMinutes(minutes);
}

/** Every rule as a definition list, with the on-device note when only some categories relax. */
function BreakRulesCard({ policy }: { policy: BreakPolicy }) {
  const rows: Array<{ label: string; value: ReactNode }> = [
    { label: "Breaks allowed", value: policy.breaksEnabled ? "Yes" : "No" },
    ...(policy.breaksEnabled
      ? [
          { label: BREAK_RULE_FIELD_META.maxBreaksPerShift.label, value: formatBreakCount(policy.maxBreaksPerShift) },
          { label: BREAK_RULE_FIELD_META.maxBreakDurationMinutes.label, value: formatDurationMinutes(policy.maxBreakDurationMinutes) },
          { label: BREAK_RULE_FIELD_META.maxTotalBreakMinutes.label, value: formatDurationMinutes(policy.maxTotalBreakMinutes) },
          {
            label: BREAK_RULE_FIELD_META.minGapBetweenBreaksMinutes.label,
            value: minutesOrLabel(policy.minGapBetweenBreaksMinutes, "No minimum gap"),
          },
          {
            label: BREAK_RULE_FIELD_META.minMinutesAfterShiftStart.label,
            value: minutesOrLabel(policy.minMinutesAfterShiftStart, "Straight away"),
          },
          { label: "Who can start a break", value: describeBreakStarters(policy) },
        ]
      : []),
    { label: "During a break", value: describeBreakBehaviourLabel(policy.restrictionBehaviour, policy.relaxedCategories) },
  ];

  return (
    <SectionCard title="Rules" description={policy.description ?? describeBreakTriggers(policy)}>
      <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
        {rows.map((row) => (
          <div key={row.label} className="space-y-0.5">
            <dt className="text-muted-foreground text-xs font-medium tracking-wide uppercase">{row.label}</dt>
            <dd className="text-sm">{row.value}</dd>
          </div>
        ))}
      </dl>
      {policy.restrictionBehaviour === "RELAX_CATEGORIES" ? (
        <InlineAlert variant="info" className="mt-5">
          {RELAX_CATEGORIES_DEVICE_NOTE}
        </InlineAlert>
      ) : null}
    </SectionCard>
  );
}

/** The assignments panel wired to `/api/break-policies/:id/assignments`, `/api/break-policy-assignments/:id` and the org default. */
function BreakPolicyAssignments({ policy, canEdit }: { policy: BreakPolicy; canEdit: boolean }) {
  const assignments = useBreakPolicyAssignments(policy.id);
  const assign = useAssignBreakPolicy();
  const remove = useRemoveBreakPolicyAssignment();
  const setDefault = useSetDefaultBreakPolicy();
  const guard = breakPolicyAssignGuard(policy);
  const defaultGuard = breakPolicySetDefaultGuard(policy);

  return (
    <AssignmentsPanel
      noun="Break Rules"
      description="Who these Break Rules apply to. The most specific assignment wins."
      emptyText="No assignments yet. Pick locations, teams or employees above, or make these the organisation default Break Rules."
      precedenceTitle="Which Break Rules apply?"
      assignments={assignments.data}
      isLoading={assignments.isPending}
      isError={assignments.isError}
      error={assignments.error}
      onRetry={() => void assignments.refetch()}
      isRetrying={assignments.isRefetching}
      canEdit={canEdit}
      assignDisabledReason={guard.ok ? undefined : guard.reason}
      isDefault={policy.isDefault}
      defaultDisabledReason={policy.isDefault || defaultGuard.ok ? undefined : defaultGuard.reason}
      onSetDefault={(next) => setDefault.mutateAsync({ breakPolicyId: next ? policy.id : null })}
      onAssign={(scopeType, scopeId) => assign.mutateAsync({ id: policy.id, input: { scopeType, scopeId } })}
      onRemove={(assignment) => remove.mutateAsync({ assignmentId: assignment.id, breakPolicyId: policy.id })}
    />
  );
}
