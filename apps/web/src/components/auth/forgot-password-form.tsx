"use client";

import { forgotPasswordSchema } from "@clockoff/validation/auth";
import { MailCheck } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import {
  FormErrorAlert,
  SubmitButton,
  TextField,
  applyApiFieldErrors,
  useZodForm,
} from "@/components/forms/form-fields";
import { Button } from "@/components/ui/button";
import { Form } from "@/components/ui/form";
import { ROUTES } from "@/config/navigation";
import { useForgotPassword } from "@/hooks/use-auth";
import { AuthCard, authLinkClass } from "./auth-card";

export function ForgotPasswordForm() {
  const forgot = useForgotPassword();
  const [sentTo, setSentTo] = useState<string | null>(null);
  const form = useZodForm(forgotPasswordSchema, { defaultValues: { email: "" } });

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      await forgot.mutateAsync(values);
      setSentTo(values.email);
    } catch (error) {
      applyApiFieldErrors(form, error);
    }
  });

  if (sentTo) {
    return (
      <AuthCard
        icon={MailCheck}
        iconTone="success"
        title="Check your email"
        description={
          <>
            If an account exists for <span className="text-foreground font-medium">{sentTo}</span>,
            we&apos;ve sent a link to reset your password. It expires soon, so use it promptly.
          </>
        }
        footer={
          <>
            Didn&apos;t get it?{" "}
            <button type="button" className={authLinkClass} onClick={() => setSentTo(null)}>
              Try again
            </button>
          </>
        }
      >
        <Button asChild variant="outline" className="w-full">
          <Link href={ROUTES.login}>Back to sign in</Link>
        </Button>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title="Reset your password"
      description="Enter the email you sign in with and we'll send you a reset link."
      footer={
        <>
          Remembered it?{" "}
          <Link href={ROUTES.login} className={authLinkClass}>
            Back to sign in
          </Link>
        </>
      }
    >
      <Form {...form}>
        <form onSubmit={onSubmit} className="space-y-5" noValidate>
          <FormErrorAlert error={forgot.error} />
          <TextField
            control={form.control}
            name="email"
            label="Work email"
            type="email"
            autoComplete="email"
            inputMode="email"
            autoFocus
          />
          <SubmitButton
            className="w-full"
            isPending={forgot.isPending}
            pendingLabel="Sending link…"
          >
            Send reset link
          </SubmitButton>
        </form>
      </Form>
    </AuthCard>
  );
}
