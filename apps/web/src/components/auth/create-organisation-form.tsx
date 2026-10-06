"use client";

import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { toast } from "sonner";
import { FormErrorAlert, SubmitButton, TextField, applyApiFieldErrors, useZodForm } from "@/components/forms/form-fields";
import { TimezoneField } from "@/components/forms/timezone-select";
import { FormSkeleton } from "@/components/loading-skeletons";
import { Button } from "@/components/ui/button";
import { Form } from "@/components/ui/form";
import { ROUTES, loginRedirectUrl } from "@/config/navigation";
import { detectTimeZone } from "@/config/timezones";
import { useCreateOrganisation, useResendVerification } from "@/hooks/use-auth";
import { useApiErrorToast } from "@/hooks/use-api-error-toast";
import { useCurrentUser } from "@/hooks/use-current-user";
import { hasErrorCode, isUnauthenticatedError } from "@/lib/api-client";
import { AuthCard, authLinkClass } from "./auth-card";
import { createOrganisationFormSchema } from "./schemas";

/** `/create-organisation` — the first step after sign-up (also reachable from the org switcher). */
export function CreateOrganisationForm() {
  const router = useRouter();
  const me = useCurrentUser();
  const create = useCreateOrganisation();
  const form = useZodForm(createOrganisationFormSchema, {
    defaultValues: { name: "", timezone: "", firstLocationName: "" },
  });
  const { getValues, setValue } = form;

  const signedOut = me.isError && isUnauthenticatedError(me.error);
  useEffect(() => {
    if (signedOut) router.replace(loginRedirectUrl(ROUTES.createOrganisation));
  }, [signedOut, router]);

  // Detect the browser's zone after mount (the server can't know it).
  useEffect(() => {
    if (!getValues("timezone")) setValue("timezone", detectTimeZone("Europe/London"), { shouldDirty: false });
  }, [getValues, setValue]);

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      const organisation = await create.mutateAsync(values);
      toast.success(`${organisation.name} is ready`);
      router.replace(ROUTES.overview);
    } catch (error) {
      applyApiFieldErrors(form, error);
    }
  });

  const hasOrganisations = (me.data?.organisations.length ?? 0) > 0;

  if (me.isPending || signedOut) {
    return (
      <AuthCard title="Set up your organisation">
        <FormSkeleton fields={3} />
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title={hasOrganisations ? "Create another organisation" : "Set up your organisation"}
      description="Tell us about your business. You can change these details later in Settings."
      footer={
        hasOrganisations ? (
          <Link href={ROUTES.overview} className={`${authLinkClass} inline-flex items-center gap-1`}>
            <ArrowLeft className="size-4" aria-hidden="true" />
            Back to dashboard
          </Link>
        ) : me.data ? (
          <>Signed in as {me.data.user.email}</>
        ) : undefined
      }
    >
      <Form {...form}>
        <form onSubmit={onSubmit} className="space-y-5" noValidate>
          <FormErrorAlert error={create.error} />
          {hasErrorCode(create.error, "EMAIL_NOT_VERIFIED") ? <ResendVerificationButton email={me.data?.user.email ?? null} /> : null}
          <TextField
            control={form.control}
            name="name"
            label="Organisation name"
            autoComplete="organization"
            placeholder="e.g. Harbour Café Group"
            autoFocus
          />
          <TimezoneField
            control={form.control}
            name="timezone"
            label="Time zone"
            description="Shifts and reports use this zone. We detected it from your browser."
          />
          <TextField
            control={form.control}
            name="firstLocationName"
            label="First location (optional)"
            placeholder="e.g. High Street"
            description="Add more locations and teams later."
          />
          <SubmitButton className="w-full" isPending={create.isPending || create.isSuccess} pendingLabel="Creating organisation…">
            Create organisation
          </SubmitButton>
        </form>
      </Form>
    </AuthCard>
  );
}

/** Shown when organisation creation is refused because the email address isn't verified yet. */
function ResendVerificationButton({ email }: { email: string | null }) {
  const resend = useResendVerification();
  const toastError = useApiErrorToast();
  return (
    <Button
      type="button"
      variant="outline"
      className="w-full"
      disabled={resend.isPending || resend.isSuccess}
      onClick={() =>
        resend.mutate(undefined, {
          onSuccess: () => toast.success(email ? `Verification email sent to ${email}` : "Verification email sent"),
          onError: (error) => toastError(error, { title: "Couldn't send the email" }),
        })
      }
    >
      {resend.isSuccess ? "Verification email sent" : resend.isPending ? "Sending…" : "Resend verification email"}
    </Button>
  );
}
