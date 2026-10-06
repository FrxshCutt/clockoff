"use client";

import { changePasswordSchema } from "@workmode/validation/auth";
import { toast } from "sonner";
import { z } from "zod";
import {
  FormErrorAlert,
  PasswordField,
  SubmitButton,
  applyApiFieldErrors,
  useZodForm,
} from "@/components/forms/form-fields";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Form } from "@/components/ui/form";
import { useChangePassword } from "@/hooks/use-auth";

const changePasswordFormSchema = changePasswordSchema
  .extend({ confirmPassword: z.string() })
  .refine((v) => v.newPassword === v.confirmPassword, {
    path: ["confirmPassword"],
    message: "Passwords don't match",
  });

export function ChangePasswordDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const mutation = useChangePassword();
  const form = useZodForm(changePasswordFormSchema, {
    defaultValues: { currentPassword: "", newPassword: "", confirmPassword: "" },
  });

  const close = (next: boolean) => {
    if (mutation.isPending) return;
    if (!next) {
      form.reset();
      mutation.reset();
    }
    onOpenChange(next);
  };

  const onSubmit = form.handleSubmit(async ({ currentPassword, newPassword }) => {
    try {
      await mutation.mutateAsync({ currentPassword, newPassword });
      toast.success("Password changed");
      close(false);
    } catch (error) {
      applyApiFieldErrors(form, error);
    }
  });

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Change password</DialogTitle>
          <DialogDescription>
            Use at least 10 characters with a letter and a number.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={onSubmit} className="space-y-4" noValidate>
            <FormErrorAlert error={mutation.error} />
            <PasswordField
              control={form.control}
              name="currentPassword"
              label="Current password"
              autoComplete="current-password"
            />
            <PasswordField
              control={form.control}
              name="newPassword"
              label="New password"
              autoComplete="new-password"
            />
            <PasswordField
              control={form.control}
              name="confirmPassword"
              label="Confirm new password"
              autoComplete="new-password"
            />
            <DialogFooter className="pt-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => close(false)}
                disabled={mutation.isPending}
              >
                Cancel
              </Button>
              <SubmitButton isPending={mutation.isPending} pendingLabel="Saving…">
                Change password
              </SubmitButton>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
