"use client";

import { loginSchema } from "@workmode/validation/auth";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  FormErrorAlert,
  PasswordField,
  SubmitButton,
  TextField,
  applyApiFieldErrors,
  useZodForm,
} from "@/components/forms/form-fields";
import { Form } from "@/components/ui/form";
import { ROUTES, getPostAuthRedirect } from "@/config/navigation";
import { useLogin } from "@/hooks/use-auth";
import { AuthCard, authLinkClass } from "./auth-card";
import { useRedirectIfSignedIn } from "./use-redirect-if-signed-in";

export function LoginForm({ next }: { next: string | null }) {
  const router = useRouter();
  const login = useLogin();
  useRedirectIfSignedIn(next);
  const form = useZodForm(loginSchema, { defaultValues: { email: "", password: "" } });

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      const me = await login.mutateAsync(values);
      router.replace(getPostAuthRedirect({ organisationCount: me.organisations.length, next }));
    } catch (error) {
      applyApiFieldErrors(form, error);
    }
  });

  const registerHref = next
    ? `${ROUTES.register}?next=${encodeURIComponent(next)}`
    : ROUTES.register;

  return (
    <AuthCard
      title="Sign in to Work Mode"
      description="Welcome back. Manage shifts, policies and your team's phones."
      footer={
        <>
          New to Work Mode?{" "}
          <Link href={registerHref} className={authLinkClass}>
            Create an account
          </Link>
        </>
      }
    >
      <Form {...form}>
        <form onSubmit={onSubmit} className="space-y-5" noValidate>
          <FormErrorAlert error={login.error} />
          <TextField
            control={form.control}
            name="email"
            label="Work email"
            type="email"
            autoComplete="email"
            inputMode="email"
            autoFocus
          />
          <PasswordField
            control={form.control}
            name="password"
            label="Password"
            autoComplete="current-password"
            labelAside={
              <Link href={ROUTES.forgotPassword} className={`${authLinkClass} text-sm`}>
                Forgot password?
              </Link>
            }
          />
          <SubmitButton
            className="w-full"
            isPending={login.isPending || login.isSuccess}
            pendingLabel="Signing in…"
          >
            Sign in
          </SubmitButton>
        </form>
      </Form>
    </AuthCard>
  );
}
