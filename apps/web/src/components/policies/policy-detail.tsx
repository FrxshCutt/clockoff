"use client";

import type { Policy } from "@clockoff/validation/policies";
import { Rocket, Star } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { InlineAlert } from "@/components/inline-alert";
import { FormSkeleton } from "@/components/loading-skeletons";
import { PageHeader } from "@/components/page-header";
import { BackLink } from "@/components/placeholder-page";
import { useBreadcrumbLabel } from "@/components/shell/breadcrumb-store";
import { StatusBadge } from "@/components/status/status-badge";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EMPTY_STATES } from "@/config/emptyStates";
import { ROUTES, routeFor } from "@/config/navigation";
import { usePermission } from "@/hooks/use-current-user";
import { hasErrorCode } from "@/lib/api-client";
import { AssignmentsPanel } from "./assignments-panel";
import { DetailHeaderSkeleton } from "./detail-header-skeleton";
import {
  PolicyActionDialogs,
  PolicyMenu,
  usePolicyActionState,
  useToggleDefaultPolicy,
} from "./policy-actions";
import { PolicyBuilder } from "./policy-builder";
import { PolicyVersionHistory } from "./policy-version-history";
import {
  assignGuard,
  canPublish,
  formatAssignedSummary,
  formatVersionLabel,
  nextVersionNumber,
  setDefaultGuard,
} from "./policy-view-model";
import { PublishPolicyDialog } from "./publish-policy-dialog";
import {
  useAssignPolicy,
  usePolicy,
  usePolicyAssignments,
  usePublishPolicy,
  useRemovePolicyAssignment,
  useSetDefaultPolicy,
} from "./use-policies";

const GRID = "grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(20rem,25rem)]";

function PolicyBackLink() {
  return <BackLink href={ROUTES.policies}>Policies</BackLink>;
}

function PolicyNotFound() {
  const copy = EMPTY_STATES.policyDetail;
  return (
    <>
      <PageHeader eyebrow={<PolicyBackLink />} title="Work Policy" />
      <EmptyState
        icon={copy.icon}
        title="Policy not found"
        description="It may have been deleted, or it belongs to a different organisation."
        action={
          <Button asChild>
            <Link href={ROUTES.policies}>Back to policies</Link>
          </Button>
        }
      />
    </>
  );
}

/** `/policies/[id]`: header with status, version and actions; the builder; assignments; publish and action dialogs. */
export function PolicyDetailView({ id }: { id: string }) {
  const router = useRouter();
  const canEdit = usePermission("policies:write");
  const policy = usePolicy(id);
  useBreadcrumbLabel(id, policy.data?.name);
  const actions = usePolicyActionState();
  const toggleDefault = useToggleDefaultPolicy();
  const publish = usePublishPolicy();
  const [publishOpen, setPublishOpen] = useState(false);

  if (policy.isPending) {
    return (
      <>
        <DetailHeaderSkeleton
          backHref={ROUTES.policies}
          backLabel="Policies"
          loadingLabel="Loading policy…"
        />
        <div className={GRID} aria-busy="true" role="status" aria-label="Loading policy">
          <FormSkeleton fields={6} />
          <FormSkeleton fields={3} />
        </div>
      </>
    );
  }
  if (policy.isError) {
    if (hasErrorCode(policy.error, "NOT_FOUND")) return <PolicyNotFound />;
    return (
      <>
        <PageHeader eyebrow={<PolicyBackLink />} title="Work Policy" />
        <ErrorState
          title="Couldn't load this policy"
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
  const readOnlyReason = archived
    ? "Archived policies can't be edited. Duplicate it to start a new draft."
    : canEdit
      ? undefined
      : "Only owners and admins can edit policies.";

  return (
    <>
      <PageHeader
        eyebrow={<PolicyBackLink />}
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
            <span className="tabular-nums">{formatVersionLabel(current)}</span>
            <span aria-hidden="true">·</span>
            <span>{formatAssignedSummary(current)}</span>
          </span>
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <PolicyVersionHistory policyId={current.id} policyName={current.name} />
            {editable && canPublish(current) ? (
              <Button type="button" onClick={() => setPublishOpen(true)}>
                <Rocket aria-hidden="true" />
                Publish v{nextVersionNumber(current)}
              </Button>
            ) : null}
            <PolicyMenu
              policy={current}
              canEdit={canEdit}
              hideEdit
              onAction={actions.open}
              onToggleDefault={(target) => void toggleDefault.toggle(target)}
              defaultPending={toggleDefault.isPending}
            />
          </div>
        }
      />

      {archived ? (
        <InlineAlert variant="warning" title="This policy is archived">
          It is skipped when working out which policy applies, and it can’t be edited or assigned.
          Duplicate it to start a new draft.
        </InlineAlert>
      ) : current.status === "DRAFT" ? (
        <InlineAlert variant="info" title="Draft — not on any device yet">
          Publish the policy to make it assignable and send it to employees’ phones.
        </InlineAlert>
      ) : current.draftVersion && current.currentVersion ? (
        <InlineAlert
          variant="info"
          title={`Unpublished changes in draft v${current.draftVersion.versionNumber}`}
        >
          Devices are still on v{current.currentVersion.versionNumber}. Publish when you’re ready to
          roll the changes out.
        </InlineAlert>
      ) : null}

      <div className={GRID}>
        <PolicyBuilder
          key={current.id}
          policy={current}
          canEdit={editable}
          readOnlyReason={readOnlyReason}
        />
        <PolicyAssignments policy={current} canEdit={editable} />
      </div>

      <PublishPolicyDialog
        policy={current}
        open={publishOpen}
        onOpenChange={setPublishOpen}
        onPublish={async (changeNote) => {
          const saved = await publish.mutateAsync({
            id: current.id,
            input: changeNote === undefined ? {} : { changeNote },
          });
          toast.success(
            `Published v${saved.currentVersion?.versionNumber ?? nextVersionNumber(current)}`,
            {
              description: "Devices pick it up on their next sync.",
            },
          );
        }}
      />
      <PolicyActionDialogs
        request={actions.request}
        onClose={actions.close}
        onDuplicated={(created) => router.push(routeFor.policy(created.id))}
        onRemoved={(_removed, kind) => {
          if (kind === "delete") router.push(ROUTES.policies);
        }}
      />
    </>
  );
}

/** The assignments panel wired to `/api/policies/:id/assignments`, `/api/policy-assignments/:id` and the org default. */
function PolicyAssignments({ policy, canEdit }: { policy: Policy; canEdit: boolean }) {
  const assignments = usePolicyAssignments(policy.id);
  const assign = useAssignPolicy();
  const remove = useRemovePolicyAssignment();
  const setDefault = useSetDefaultPolicy();
  const guard = assignGuard(policy);
  const defaultGuard = setDefaultGuard(policy);

  return (
    <AssignmentsPanel
      noun="policy"
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
      onSetDefault={(next) => setDefault.mutateAsync({ policyId: next ? policy.id : null })}
      onAssign={(scopeType, scopeId) =>
        assign.mutateAsync({ id: policy.id, input: { scopeType, scopeId } })
      }
      onRemove={(assignment) =>
        remove.mutateAsync({ assignmentId: assignment.id, policyId: policy.id })
      }
    />
  );
}
