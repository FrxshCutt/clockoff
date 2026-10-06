"use client";

import { CircleCheck, LoaderCircle, MailX } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { ROUTES } from "@/config/navigation";
import { useApiErrorToast } from "@/hooks/use-api-error-toast";
import { useResendVerification, useVerifyEmail } from "@/hooks/use-auth";
import { useCurrentUser } from "@/hooks/use-current-user";
import { getErrorMessage } from "@/lib/errorMessages";
import { AuthCard } from "./auth-card";
import { parseLinkToken } from "./schemas";

/** Submits the token from the email link once on load and shows the outcome. */
export function VerifyEmailPanel({ token: rawToken }: { token: string | null }) {
  const token = parseLinkToken("verifyEmail", rawToken);
  const verify = useVerifyEmail();
  const { mutate } = verify;
  const started = useRef(false);
  const { data: me } = useCurrentUser();
  const resend = useResendVerification();
  const toastError = useApiErrorToast();

  useEffect(() => {
    // Guard against React Strict Mode's double effect: tokens are single-use.
    if (!token || started.current) return;
    started.current = true;
    mutate({ token });
  }, [token, mutate]);

  const continueHref = me
    ? me.organisations.length > 0
      ? ROUTES.overview
      : ROUTES.createOrganisation
    : ROUTES.login;
  const continueLabel = me ? "Continue to Work Mode" : "Sign in";

  if (!token) {
    return (
      <AuthCard
        icon={MailX}
        iconTone="danger"
        title="This verification link is incomplete"
        description="Open the link from your email again. If it still doesn't work, sign in and request a new one."
      >
        <Button asChild className="w-full">
          <Link href={continueHref}>{continueLabel}</Link>
        </Button>
      </AuthCard>
    );
  }

  if (verify.isSuccess) {
    return (
      <AuthCard
        icon={CircleCheck}
        iconTone="success"
        title="Email verified"
        description="Thanks — your email address is confirmed."
      >
        <Button asChild className="w-full">
          <Link href={continueHref}>{continueLabel}</Link>
        </Button>
      </AuthCard>
    );
  }

  if (verify.isError) {
    return (
      <AuthCard
        icon={MailX}
        iconTone="danger"
        title="We couldn't verify your email"
        description={getErrorMessage(verify.error)}
      >
        <div className="space-y-3">
          {me && !me.user.emailVerified ? (
            <Button
              type="button"
              className="w-full"
              disabled={resend.isPending || resend.isSuccess}
              onClick={() =>
                resend.mutate(undefined, {
                  onSuccess: () => toast.success(`A new link is on its way to ${me.user.email}`),
                  onError: (error) => toastError(error, { title: "Couldn't send a new link" }),
                })
              }
            >
              {resend.isSuccess
                ? "New link sent"
                : resend.isPending
                  ? "Sending…"
                  : "Send a new link"}
            </Button>
          ) : null}
          <Button
            asChild
            variant={me && !me.user.emailVerified ? "outline" : "default"}
            className="w-full"
          >
            <Link href={continueHref}>{continueLabel}</Link>
          </Button>
        </div>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      icon={LoaderCircle}
      iconClassName="animate-spin"
      title="Verifying your email…"
      description="This only takes a moment."
    >
      <p className="sr-only" role="status">
        Verifying your email address
      </p>
    </AuthCard>
  );
}
