"use client";

import { useMutation } from "@tanstack/react-query";
import { CheckCircle2 } from "lucide-react";
import Link from "next/link";
import { FormErrorAlert, SelectField, SubmitButton, TextField, TextareaField, applyApiFieldErrors, useZodForm, type SelectOption } from "@/components/forms/form-fields";
import { Button } from "@/components/ui/button";
import { Form } from "@/components/ui/form";
import { SITE } from "@/config/site";
import { api } from "@/lib/api-client";
import { MARKETING_ROUTES } from "./marketing-content";
import {
  DEMO_REQUEST_ENDPOINT,
  EMPTY_REQUEST_DEMO_FORM,
  TEAM_SIZE_OPTIONS,
  isHoneypotTripped,
  requestDemoFormSchema,
  toRequestDemoPayload,
  type RequestDemoFormValues,
  type RequestDemoPayload,
} from "./request-demo-schema";

const TEAM_SIZE_SELECT_OPTIONS: SelectOption[] = TEAM_SIZE_OPTIONS.map((value) => ({ value, label: `${value} people` }));

export interface RequestDemoFormProps {
  /** Where the visitor came from (`?source=`), stored with the request after normalisation. */
  source?: string;
}

/**
 * `POST /api/request-demo`. Shows a success panel once the request is stored. The `website` input is a
 * honeypot: hidden from people (and from assistive tech), filled in by bots; when it is filled the form
 * shows the same success panel without sending anything.
 */
export function RequestDemoForm({ source }: RequestDemoFormProps) {
  const form = useZodForm(requestDemoFormSchema, { defaultValues: EMPTY_REQUEST_DEMO_FORM });
  const submit = useMutation({
    mutationFn: async (payload: RequestDemoPayload | null) => {
      if (payload) await api.post<unknown>(DEMO_REQUEST_ENDPOINT, payload);
    },
  });

  const onSubmit = form.handleSubmit(async (values: RequestDemoFormValues) => {
    try {
      await submit.mutateAsync(isHoneypotTripped(values) ? null : toRequestDemoPayload(values, source));
    } catch (error) {
      applyApiFieldErrors(form, error);
    }
  });

  if (submit.isSuccess) {
    return (
      <div role="status" className="bg-card space-y-4 rounded-xl border p-6 shadow-xs sm:p-8">
        <CheckCircle2 className="size-8 text-emerald-600 dark:text-emerald-400" aria-hidden="true" />
        <h2 className="text-xl font-semibold tracking-tight">Thanks, we&apos;ll be in touch</h2>
        <p className="text-muted-foreground text-sm leading-relaxed">
          We&apos;ll reply within one working day to arrange a time. If you&apos;d rather talk sooner, email{" "}
          <a href={`mailto:${SITE.supportEmail}`} className="hover:text-foreground underline underline-offset-4">
            {SITE.supportEmail}
          </a>
          .
        </p>
        <Button asChild variant="outline">
          <Link href={MARKETING_ROUTES.howItWorks}>See how it works in the meantime</Link>
        </Button>
      </div>
    );
  }

  return (
    <Form {...form}>
      <form onSubmit={onSubmit} noValidate className="bg-card space-y-5 rounded-xl border p-6 shadow-xs sm:p-8">
        <FormErrorAlert error={submit.error} title="Couldn't send your request" />
        <div className="grid gap-5 sm:grid-cols-2">
          <TextField control={form.control} name="name" label="Your name" autoComplete="name" />
          <TextField control={form.control} name="email" label="Work email" type="email" autoComplete="email" inputMode="email" />
        </div>
        <div className="grid gap-5 sm:grid-cols-2">
          <TextField control={form.control} name="company" label="Company" autoComplete="organization" />
          <SelectField control={form.control} name="teamSize" label="Team size" options={TEAM_SIZE_SELECT_OPTIONS} placeholder="Optional" />
        </div>
        <TextareaField
          control={form.control}
          name="message"
          label="What would you like to see?"
          description="Optional. Your sites, your rota software, anything you want us to cover."
          rows={4}
        />
        {/* Honeypot: out of the layout, out of the tab order and hidden from assistive technology. */}
        <div aria-hidden="true" className="absolute -left-[9999px] top-auto h-px w-px overflow-hidden">
          <label htmlFor="request-demo-website">Website</label>
          <input id="request-demo-website" type="text" tabIndex={-1} autoComplete="off" {...form.register("website")} />
        </div>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-muted-foreground text-xs">
            We use these details only to arrange your demo. {SITE.privacyLine}
          </p>
          <SubmitButton isPending={submit.isPending} pendingLabel="Sending…">
            Request a demo
          </SubmitButton>
        </div>
      </form>
    </Form>
  );
}
