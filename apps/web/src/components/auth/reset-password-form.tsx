"use client";

import { CircleCheck, Link2Off } from "lucide-react";
import Link from "next/link";
import {
  FormErrorAlert,
  PasswordField,
  SubmitButton,
  applyApiFieldErrors,
  useZodForm,
} from "@/components/forms/form-fields";
import { Button } from "@/components/ui/button";
import { Form } from "@/components/ui/form";
import { ROUTES, getPostAuthRedirect } from "@/config/navigation";
import { useResetPassword } from "@/hooks/use-auth";
import { hasErrorCode } from "@/lib/api-client";
import { AuthCard, authLinkClass } from "./auth-card";
import { parseLinkToken, resetPasswordFormSchema } from "./schemas";

export function ResetPasswordForm({ token: rawToken }: { token: string | null }) {
  const token = parseLinkToken("resetPassword", rawToken);
  const reset = useResetPassword();
  const form = useZodForm(resetPasswordFormSchema, {
    defaultValues: { password: "", confirmPassword: "" },
  });

  const onSubmit = form.handleSubmit(async ({ password }) => {
    if (!token) return;
    try {
      await reset.mutateAsync({ token, password });
    } catch (error) {
      applyApiFieldErrors(form, error);
    }
  });

  if (!token) {
    return (
      <AuthCard
        icon={Link2Off}
        iconTone="danger"
        title="This reset link is incomplete"
        description="Open the link from your email again, or request a new one."
      >
        <Button asChild className="w-full">
          <Link href={ROUTES.forgotPassword}>Request a new link</Link>
        </Button>
      </AuthCard>
    );
  }

  if (reset.isSuccess) {
    // The API signs this browser in with a fresh session (every other session was signed out).
    const me = reset.data.me;
    return (
      <AuthCard
        icon={CircleCheck}
        iconTone="success"
        title="Password updated"
        description={
          me
            ? "Your password has been changed and you're signed in. Any other devices have been signed out."
            : "Your password has been changed. Sign in with your new password."
        }
      >
        <Button asChild className="w-full">
          {me ? (
            <Link href={getPostAuthRedirect({ organisationCount: me.organisations.length })}>
              Continue to Work Mode
            </Link>
          ) : (
            <Link href={ROUTES.login}>Sign in</Link>
          )}
        </Button>
      </AuthCard>
    );
  }

  const linkProblem = hasErrorCode(reset.error, "INVALID_TOKEN", "TOKEN_EXPIRED", "TOKEN_REUSED");

  return (
    <AuthCard
      title="Choose a new password"
      description="Use at least 10 characters, including a letter and a number."
      footer={
        <Link href={ROUTES.login} className={authLinkClass}>
          Back to sign in
        </Link>
      }
    >
      <Form {...form}>
        <form onSubmit={onSubmit} className="space-y-5" noValidate>
          <FormErrorAlert error={reset.error} />
          {linkProblem ? (
            <Button asChild variant="outline" className="w-full">
              <Link href={ROUTES.forgotPassword}>Request a new link</Link>
            </Button>
          ) : null}
          <PasswordField
            control={form.control}
            name="password"
            label="New password"
            autoComplete="new-password"
            autoFocus
          />
          <PasswordField
            control={form.control}
            name="confirmPassword"
            label="Confirm new password"
            autoComplete="new-password"
          />
          <SubmitButton
            className="w-full"
            isPending={reset.isPending}
            pendingLabel="Updating password…"
          >
            Update password
          </SubmitButton>
        </form>
      </Form>
    </AuthCard>
  );
}
