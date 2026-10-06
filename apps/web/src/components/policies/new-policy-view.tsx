"use client";

import { useRouter } from "next/navigation";
import { InlineAlert } from "@/components/inline-alert";
import { FormSkeleton } from "@/components/loading-skeletons";
import { PageHeader } from "@/components/page-header";
import { BackLink } from "@/components/placeholder-page";
import { ROUTES, routeFor } from "@/config/navigation";
import { useCurrentUser, usePermission } from "@/hooks/use-current-user";
import { PolicyBuilder } from "./policy-builder";

/** `/policies/new`: the builder in create mode; a successful create lands on the new policy's page. */
export function NewPolicyView() {
  const router = useRouter();
  const me = useCurrentUser();
  const canEdit = usePermission("policies:write");

  return (
    <>
      <PageHeader
        eyebrow={<BackLink href={ROUTES.policies}>Policies</BackLink>}
        title="New Work Policy"
        description="Decide which distractions are restricted while employees are on shift. The policy starts as a draft; publish it when you're ready."
      />
      {me.isPending ? (
        <FormSkeleton fields={6} />
      ) : canEdit ? (
        <PolicyBuilder
          policy={null}
          canEdit
          onSaved={(policy) => router.replace(routeFor.policy(policy.id))}
        />
      ) : (
        <InlineAlert variant="info" title="View only">
          Only owners and admins can create policies.
        </InlineAlert>
      )}
    </>
  );
}
