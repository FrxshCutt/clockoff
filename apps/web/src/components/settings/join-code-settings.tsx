"use client";

import { KeyRound, RefreshCw, ShieldOff } from "lucide-react";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import { CopyButton } from "@/components/copy-button";
import { EmptyState } from "@/components/empty-state";
import { ErrorState } from "@/components/error-state";
import { InlineAlert } from "@/components/inline-alert";
import { CardSkeleton } from "@/components/loading-skeletons";
import { SectionCard } from "@/components/section";
import { Button } from "@/components/ui/button";
import { useApiErrorToast } from "@/hooks/use-api-error-toast";
import { usePermission } from "@/hooks/use-current-user";
import { useCurrentOrganisation, useRegenerateJoinCode, useRevokeJoinCode } from "@/hooks/use-organisation";

/**
 * Settings → Join code. Shows the ACTIVE company join code (from `GET /api/organisations/current`) and lets
 * owners/admins regenerate or revoke it (`POST /api/organisations/current/join-code/regenerate|revoke`).
 */
export function JoinCodeSettings() {
  const { data, isPending, isError, error, refetch, isRefetching } = useCurrentOrganisation();
  const canManage = usePermission("org:manage");
  const regenerate = useRegenerateJoinCode();
  const revoke = useRevokeJoinCode();
  const toastError = useApiErrorToast();

  if (isPending) return <CardSkeleton lines={4} />;
  if (isError) {
    return (
      <ErrorState title="Couldn't load the join code" error={error} onRetry={() => void refetch()} isRetrying={isRefetching} />
    );
  }

  const code = data.joinCode;

  // ConfirmDialog keeps itself open when onConfirm rejects, so errors are toasted and rethrown.
  const runRegenerate = async () => {
    try {
      await regenerate.mutateAsync();
      toast.success(code ? "New join code created. The old code no longer works." : "Join code created");
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
        description="Employees enter this code and their name in the Work Mode app to join your organisation."
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
                <CopyButton value={code} label="Copy join code" successMessage="Join code copied" size="sm">
                  Copy
                </CopyButton>
              </div>
            </div>
            {canManage ? (
              <div className="flex flex-wrap gap-2">
                <ConfirmDialog
                  title="Create a new join code?"
                  description="The current code stops working immediately. Employees who have already joined stay connected; anyone still joining will need the new code."
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
                    <Button type="button" variant="outline" className="text-destructive hover:text-destructive">
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
      <SectionCard title="How joining works">
        <ol className="text-muted-foreground list-decimal space-y-2 pl-5 text-sm">
          <li>Add the employee in Employees, with the name they&apos;ll type in the app.</li>
          <li>They install Work Mode on their iPhone and enter the company join code.</li>
          <li>Work Mode matches their name to your employee list. If more than one employee matches, they also enter their personal invite code.</li>
          <li>They approve Screen Time access and choose which apps to restrict. You only ever see whether setup is complete.</li>
        </ol>
      </SectionCard>
    </div>
  );
}
