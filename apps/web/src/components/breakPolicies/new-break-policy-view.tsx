"use client";

import { useRouter } from "next/navigation";
import { InlineAlert } from "@/components/inline-alert";
import { FormSkeleton } from "@/components/loading-skeletons";
import { PageHeader } from "@/components/page-header";
import { BackLink } from "@/components/placeholder-page";
import { ROUTES, routeFor } from "@/config/navigation";
import { useCurrentUser, usePermission } from "@/hooks/use-current-user";
import { BreakPolicyForm } from "./break-policy-form";

/** `/break-rules/new`: the full-page create form with presets; a successful create lands on the new rules' page. */
export function NewBreakPolicyView() {
  const router = useRouter();
  const me = useCurrentUser();
  const canEdit = usePermission("policies:write");

  return (
    <>
      <PageHeader
        eyebrow={<BackLink href={ROUTES.breakRules}>Break Rules</BackLink>}
        title="New Break Rules"
        description="Let employees step away without switching Work Mode off. Start from a preset or set every rule yourself."
      />
      {me.isPending ? (
        <FormSkeleton fields={6} />
      ) : canEdit ? (
        <BreakPolicyForm
          variant="page"
          policy={null}
          onCancel={() => router.push(ROUTES.breakRules)}
          onSaved={(saved) => router.replace(routeFor.breakRule(saved.id))}
        />
      ) : (
        <InlineAlert variant="info" title="View only">
          Only owners and admins can create Break Rules.
        </InlineAlert>
      )}
    </>
  );
}
