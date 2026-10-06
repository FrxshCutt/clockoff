"use client";

import { LogOut, Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { ErrorState } from "@/components/error-state";
import { CardSkeleton } from "@/components/loading-skeletons";
import { SectionCard } from "@/components/section";
import { Button } from "@/components/ui/button";
import { ROUTES } from "@/config/navigation";
import { SITE } from "@/config/site";
import { useApiErrorToast } from "@/hooks/use-api-error-toast";
import { usePermission } from "@/hooks/use-current-user";
import { useCurrentOrganisation, useMembers, useRemoveMember } from "@/hooks/use-organisation";

/**
 * Settings → Danger zone. Leaving removes the caller's own membership (`DELETE …/members/:membershipId`; the
 * API refuses to remove the last owner). Deleting an organisation has no self-serve endpoint yet, so owners
 * are pointed to support instead of a button that cannot work.
 */
export function DangerZone() {
  const router = useRouter();
  const organisation = useCurrentOrganisation();
  // Fallback for the caller's membership id when the organisation endpoint doesn't include it.
  const members = useMembers({ enabled: organisation.isSuccess && organisation.data.membershipId === null });
  const leave = useRemoveMember();
  const canDelete = usePermission("org:delete");
  const toastError = useApiErrorToast();

  if (organisation.isPending) return <CardSkeleton lines={3} />;
  if (organisation.isError) {
    return (
      <ErrorState
        title="Couldn't load organisation"
        error={organisation.error}
        onRetry={() => void organisation.refetch()}
        isRetrying={organisation.isRefetching}
      />
    );
  }

  const orgName = organisation.data.organisation.name;
  const membershipId =
    organisation.data.membershipId ?? members.data?.members.find((m) => m.isCurrentUser === true)?.id ?? null;

  return (
    <div className="space-y-6">
      <SectionCard
        tone="danger"
        title="Leave organisation"
        description={`You'll lose access to ${orgName} immediately. An owner or admin can invite you again.`}
        footer={
          <ConfirmDialog
            title={`Leave ${orgName}?`}
            description="You'll lose access to its employees, schedules and policies. If you're the only owner, make someone else an owner first."
            confirmLabel="Leave organisation"
            destructive
            onConfirm={async () => {
              if (!membershipId) return;
              try {
                await leave.mutateAsync(membershipId);
                toast.success(`You left ${orgName}`);
                router.replace(ROUTES.overview);
              } catch (err) {
                toastError(err, { title: "Couldn't leave the organisation" });
                throw err;
              }
            }}
            trigger={
              <Button type="button" variant="outline" className="text-destructive hover:text-destructive" disabled={!membershipId}>
                <LogOut aria-hidden="true" />
                Leave organisation
              </Button>
            }
          />
        }
      />
      <SectionCard
        tone="danger"
        title="Delete organisation"
        description="Permanently deletes the organisation, its employees, schedules, policies and history, and disconnects every employee's phone."
        footer={
          canDelete ? (
            <Button asChild variant="destructive">
              <a href={`mailto:${SITE.supportEmail}?subject=${encodeURIComponent("Delete organisation")}`}>
                <Trash2 aria-hidden="true" />
                Contact support to delete
              </a>
            </Button>
          ) : (
            <p className="text-muted-foreground mr-auto text-sm">Only owners can delete an organisation.</p>
          )
        }
      >
        <p className="text-muted-foreground text-sm">
          To protect your data, deletion is handled by our support team after confirming the request with an owner.
        </p>
      </SectionCard>
    </div>
  );
}
