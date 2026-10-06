"use client";

import { registerSchema } from "@workmode/validation/auth";
import { MailCheck } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";
import { FormErrorAlert, PasswordField, SubmitButton, TextField, applyApiFieldErrors, useZodForm } from "@/components/forms/form-fields";
import { Button } from "@/components/ui/button";
import { Form } from "@/components/ui/form";
import { ROUTES, getPostAuthRedirect } from "@/config/navigation";
import { SITE } from "@/config/site";
import { useRefreshCurrentUser, useRegister } from "@/hooks/use-auth";
import { AuthCard, authLinkClass } from "./auth-card";
import { useRedirectIfSignedIn } from "./use-redirect-if-signed-in";

export function RegisterForm({ next }: { next: string | null }) {
  const router = useRouter();
  const register = useRegister();
  const refreshUser = useRefreshCurrentUser();
  const [checkEmailFor, setCheckEmailFor] = useState<string | null>(null);
  useRedirectIfSignedIn(next);
  const form = useZodForm(registerSchema, { defaultValues: { name: "", email: "", password: "" } });

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      const result = await register.mutateAsync(values);
      const me = await refreshUser();
      if (me) {
        if (result.requiresEmailVerification) toast.info(`We've sent a verification link to ${values.email}.`);
        router.replace(getPostAuthRedirect({ organisationCount: me.organisations.length, next }));
        return;
      }
      // No session yet: the account must be verified before signing in.
      setCheckEmailFor(values.email);
    } catch (error) {
      applyApiFieldErrors(form, error);
    }
  });

  const loginHref = next ? `${ROUTES.login}?next=${encodeURIComponent(next)}` : ROUTES.login;

  if (checkEmailFor) {
    return (
      <AuthCard
        icon={MailCheck}
        iconTone="success"
        title="Check your email"
        description={
          <>
            We sent a verification link to <span className="text-foreground font-medium">{checkEmailFor}</span>. Open it to
            activate your account, then sign in.
          </>
        }
      >
        <Button asChild className="w-full">
          <Link href={loginHref}>Go to sign in</Link>
        </Button>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title="Create your account"
      description={SITE.tagline}
      footer={
        <>
          Already have an account?{" "}
          <Link href={loginHref} className={authLinkClass}>
            Sign in
          </Link>
        </>
      }
    >
      <Form {...form}>
        <form onSubmit={onSubmit} className="space-y-5" noValidate>
          <FormErrorAlert error={register.error} />
          <TextField control={form.control} name="name" label="Your name" autoComplete="name" autoFocus />
          <TextField control={form.control} name="email" label="Work email" type="email" autoComplete="email" inputMode="email" />
          <PasswordField
            control={form.control}
            name="password"
            label="Password"
            autoComplete="new-password"
            description="At least 10 characters, including a letter and a number."
          />
          {/* Stays busy after the account is created, while the new session loads and the page redirects. */}
          <SubmitButton
            className="w-full"
            isPending={register.isPending || register.isSuccess || form.formState.isSubmitting}
            pendingLabel="Creating account…"
          >
            Create account
          </SubmitButton>
        </form>
      </Form>
    </AuthCard>
  );
}
