"use client";

import { Building, CircleCheck, Link2Off, LoaderCircle } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  FormErrorAlert,
  PasswordField,
  SubmitButton,
  TextField,
  applyApiFieldErrors,
  useZodForm,
} from "@/components/forms/form-fields";
import { InlineAlert } from "@/components/inline-alert";
import { StatusBadge } from "@/components/status/status-badge";
import { Button } from "@/components/ui/button";
import { Form } from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ROUTES } from "@/config/navigation";
import {
  useAcceptManagerInvite,
  useLogout,
  useManagerInvitePreview,
  useRefreshCurrentUser,
  useSwitchOrganisation,
} from "@/hooks/use-auth";
import type { InvitePreview, ManagerInviteState } from "@/hooks/api-shapes";
import { useCurrentUser } from "@/hooks/use-current-user";
import { isUnauthenticatedError } from "@/lib/api-client";
import { getErrorMessage } from "@/lib/errorMessages";
import { formatDateTime } from "@/lib/format";
import { AuthCard, authLinkClass } from "./auth-card";
import { acceptInviteAccountFormSchema, parseLinkToken } from "./schemas";

/** Copy for invites that can no longer be accepted (exhaustive over every non-pending state). */
const CLOSED_INVITE_COPY: Record<
  Exclude<ManagerInviteState, "PENDING">,
  { title: string; description: string; tone: "success" | "danger" }
> = {
  ACCEPTED: {
    title: "Invitation already accepted",
    description: "This invitation has already been accepted. Sign in to continue.",
    tone: "success",
  },
  EXPIRED: {
    title: "This invitation has expired",
    description: "Ask the person who invited you to send a new one.",
    tone: "danger",
  },
  REVOKED: {
    title: "This invitation was cancelled",
    description: "Ask the person who invited you if you still need access.",
    tone: "danger",
  },
};

/** `/accept-invite?token=…` — preview a manager invite, then accept it (creating an account if needed). */
export function AcceptInvitePanel({ token: rawToken }: { token: string | null }) {
  const token = parseLinkToken("managerInvite", rawToken);
  const preview = useManagerInvitePreview(token);

  if (!token) {
    return (
      <AuthCard
        icon={Link2Off}
        iconTone="danger"
        title="This invitation link is incomplete"
        description="Open the link from your invitation email again, or ask for a new invitation."
      >
        <Button asChild variant="outline" className="w-full">
          <Link href={ROUTES.login}>Go to sign in</Link>
        </Button>
      </AuthCard>
    );
  }

  if (preview.isPending) {
    return (
      <AuthCard
        icon={LoaderCircle}
        iconClassName="animate-spin"
        title="Checking your invitation…"
      />
    );
  }

  if (preview.isError) {
    return (
      <AuthCard
        icon={Link2Off}
        iconTone="danger"
        title="This invitation can't be used"
        description={getErrorMessage(preview.error)}
      >
        <Button asChild variant="outline" className="w-full">
          <Link href={ROUTES.login}>Go to sign in</Link>
        </Button>
      </AuthCard>
    );
  }

  const invite = preview.data;
  if (invite.status !== null && invite.status !== "PENDING") {
    const copy = CLOSED_INVITE_COPY[invite.status];
    return (
      <AuthCard
        icon={copy.tone === "success" ? CircleCheck : Link2Off}
        iconTone={copy.tone}
        title={copy.title}
        description={copy.description}
      >
        <Button asChild className="w-full">
          <Link href={ROUTES.login}>Go to sign in</Link>
        </Button>
      </AuthCard>
    );
  }

  return <AcceptInviteForm token={token} invite={invite} />;
}

function InviteSummary({ invite }: { invite: InvitePreview }) {
  return (
    <div className="bg-muted/40 flex items-start gap-3 rounded-xl border p-4">
      <span
        className="bg-primary/10 text-primary flex size-10 shrink-0 items-center justify-center rounded-lg"
        aria-hidden="true"
      >
        <Building className="size-5" />
      </span>
      <div className="min-w-0 space-y-1">
        <p className="truncate font-medium">{invite.organisationName}</p>
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge kind="role" value={invite.role} size="sm" />
          {invite.invitedByName ? (
            <span className="text-muted-foreground text-xs">Invited by {invite.invitedByName}</span>
          ) : null}
        </div>
        <p className="text-muted-foreground text-xs">Expires {formatDateTime(invite.expiresAt)}</p>
      </div>
    </div>
  );
}

function AcceptInviteForm({ token, invite }: { token: string; invite: InvitePreview }) {
  const router = useRouter();
  const accept = useAcceptManagerInvite();
  const refreshUser = useRefreshCurrentUser();
  const { mutateAsync: switchOrganisation } = useSwitchOrganisation({ navigateTo: null });
  const me = useCurrentUser({ enabled: !invite.requiresAccount });
  const inviteHref = `${ROUTES.acceptInvite}?token=${encodeURIComponent(token)}`;
  const signInToAcceptHref = `${ROUTES.login}?next=${encodeURIComponent(inviteHref)}`;
  // Signing out of the wrong account comes straight back here after signing in as the invitee.
  const logout = useLogout({ redirectTo: signInToAcceptHref });
  const form = useZodForm(acceptInviteAccountFormSchema, {
    defaultValues: { name: "", password: "" },
  });

  const finish = async (organisationId: string | null) => {
    const user = await refreshUser();
    if (!user) {
      toast.success("Invitation accepted. Sign in to continue.");
      router.replace(ROUTES.login);
      return;
    }
    if (organisationId) {
      try {
        await switchOrganisation(organisationId);
      } catch {
        // Already a member either way; the shell will pick an organisation.
      }
    }
    toast.success(`Welcome to ${invite.organisationName}`);
    router.replace(ROUTES.overview);
  };

  const acceptAsExistingUser = async () => {
    try {
      const result = await accept.mutateAsync({ token });
      await finish(result.organisationId);
    } catch {
      // Error shown via accept.error.
    }
  };

  const onCreateAccount = form.handleSubmit(async (values) => {
    try {
      const result = await accept.mutateAsync({
        token,
        name: values.name,
        password: values.password,
      });
      await finish(result.organisationId);
    } catch (error) {
      applyApiFieldErrors(form, error);
    }
  });

  const title = `Join ${invite.organisationName}`;

  if (invite.requiresAccount) {
    return (
      <AuthCard title={title} description="Create your manager account to accept this invitation.">
        <InviteSummary invite={invite} />
        <Form {...form}>
          <form onSubmit={onCreateAccount} className="space-y-5" noValidate>
            <FormErrorAlert error={accept.error} />
            <div className="space-y-2">
              <Label htmlFor="invite-email">Email</Label>
              <Input
                id="invite-email"
                value={invite.email}
                readOnly
                disabled
                autoComplete="email"
              />
            </div>
            <TextField
              control={form.control}
              name="name"
              label="Your name"
              autoComplete="name"
              autoFocus
            />
            <PasswordField
              control={form.control}
              name="password"
              label="Password"
              autoComplete="new-password"
              description="At least 10 characters, including a letter and a number."
            />
            <SubmitButton
              className="w-full"
              isPending={accept.isPending || accept.isSuccess}
              pendingLabel="Joining…"
            >
              Create account and join
            </SubmitButton>
          </form>
        </Form>
      </AuthCard>
    );
  }

  // Existing account: must be signed in as the invited email.
  const signedOut = me.isError && isUnauthenticatedError(me.error);
  const signedInAs = me.data?.user.email ?? null;
  const wrongAccount =
    signedInAs !== null && signedInAs.toLowerCase() !== invite.email.toLowerCase();

  return (
    <AuthCard
      title={title}
      description={
        <>
          This invitation is for <span className="text-foreground font-medium">{invite.email}</span>
          .
        </>
      }
    >
      <InviteSummary invite={invite} />
      <FormErrorAlert error={accept.error} />
      {me.isPending && !signedOut ? (
        <SubmitButton className="w-full" isPending pendingLabel="Checking your session…">
          Accept invitation
        </SubmitButton>
      ) : signedOut ? (
        <Button asChild className="w-full">
          <Link href={signInToAcceptHref}>Sign in to accept</Link>
        </Button>
      ) : wrongAccount ? (
        <div className="space-y-3">
          <InlineAlert variant="warning" title="You're signed in with a different account">
            You&apos;re signed in as {signedInAs}. Sign out, then sign in as {invite.email} to
            accept.
          </InlineAlert>
          <Button
            type="button"
            variant="outline"
            className="w-full"
            onClick={() => logout.mutate()}
            disabled={logout.isPending}
          >
            Sign out
          </Button>
        </div>
      ) : (
        <Button
          type="button"
          className="w-full"
          onClick={acceptAsExistingUser}
          disabled={accept.isPending || accept.isSuccess}
        >
          {accept.isPending || accept.isSuccess ? (
            <LoaderCircle className="animate-spin" aria-hidden="true" />
          ) : null}
          Accept invitation
        </Button>
      )}
      <p className="text-muted-foreground text-center text-xs">
        Not expecting this?{" "}
        <Link href={ROUTES.home} className={authLinkClass}>
          Ignore it
        </Link>
        . The invitation simply expires.
      </p>
    </AuthCard>
  );
}
