"use client";

import type { Role } from "@clockoff/shared/enums";
import { inviteMemberSchema } from "@clockoff/validation/organisation";
import { UserPlus } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import {
  FormErrorAlert,
  SelectField,
  SubmitButton,
  TextField,
  applyApiFieldErrors,
  useZodForm,
  type SelectOption,
} from "@/components/forms/form-fields";
import { getStatusMeta } from "@/components/status/statusMeta";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Form } from "@/components/ui/form";
import { useInviteMember } from "@/hooks/use-organisation";

export interface InviteManagerDialogProps {
  /** Roles the current user may grant (see `assignableRoles`). The dialog is not rendered when empty. */
  roles: readonly Role[];
}

/** "Invite manager" button + dialog: `POST /api/organisations/current/members { email, role }`. */
export function InviteManagerDialog({ roles }: InviteManagerDialogProps) {
  const [open, setOpen] = useState(false);
  const invite = useInviteMember();
  const defaultRole: Role = roles.includes("MANAGER")
    ? "MANAGER"
    : (roles[roles.length - 1] ?? "MANAGER");
  const form = useZodForm(inviteMemberSchema, { defaultValues: { email: "", role: defaultRole } });

  const roleOptions: SelectOption[] = roles.map((role) => {
    const meta = getStatusMeta("role", role);
    return { value: role, label: meta.label, hint: meta.description };
  });

  const onOpenChange = (next: boolean) => {
    if (invite.isPending) return;
    if (!next) {
      form.reset();
      invite.reset();
    }
    setOpen(next);
  };

  const onSubmit = form.handleSubmit(async (values) => {
    try {
      await invite.mutateAsync(values);
      toast.success(`Invitation sent to ${values.email}`);
      onOpenChange(false);
    } catch (error) {
      applyApiFieldErrors(form, error);
    }
  });

  if (roles.length === 0) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button type="button">
          <UserPlus aria-hidden="true" />
          Invite manager
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Invite a manager</DialogTitle>
          <DialogDescription>
            We&apos;ll email them a link to join this organisation. The link expires after 7 days.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form onSubmit={onSubmit} noValidate className="space-y-5">
            <FormErrorAlert error={invite.error} title="Couldn't send the invitation" />
            <TextField
              control={form.control}
              name="email"
              label="Email"
              type="email"
              autoComplete="off"
              inputMode="email"
              placeholder="name@company.com"
              autoFocus
            />
            <SelectField control={form.control} name="role" label="Role" options={roleOptions} />
            <DialogFooter>
              <Button
                type="button"
                variant="outline"
                onClick={() => onOpenChange(false)}
                disabled={invite.isPending}
              >
                Cancel
              </Button>
              <SubmitButton isPending={invite.isPending} pendingLabel="Sending…">
                Send invitation
              </SubmitButton>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}
