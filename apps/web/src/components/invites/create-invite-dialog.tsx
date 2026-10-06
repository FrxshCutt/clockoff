"use client";

import type { InviteChannel } from "@workmode/shared/enums";
import type { CreateEmployeeInviteResponse } from "@workmode/validation/invites";
import { useId, useState } from "react";
import { toast } from "sonner";
import { useCreateInvite } from "@/components/employees/employee-api";
import { employeeFullName } from "@/components/employees/employee-view-model";
import { FormErrorAlert, SubmitButton } from "@/components/forms/form-fields";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { cn } from "@/lib/utils";
import { INVITE_CHANNEL_META, INVITE_CHANNEL_ORDER, channelAvailability } from "./invite-helpers";

export interface CreateInviteDialogEmployee {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  inviteStatus: string;
}

export interface CreateInviteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  employee: CreateInviteDialogEmployee;
  /** Called with the new invite and its instructions (the caller usually opens `InviteInstructionsModal`). */
  onCreated?: (result: CreateEmployeeInviteResponse) => void;
}

/**
 * Creates (or re-creates) an employee invite with a channel choice: share-it-yourself link, email, or SMS
 * (shown disabled as "Coming soon"). A new invite revokes the previous pending one.
 */
export function CreateInviteDialog({
  open,
  onOpenChange,
  employee,
  onCreated,
}: CreateInviteDialogProps) {
  const [channel, setChannel] = useState<InviteChannel>("LINK");
  const create = useCreateInvite();
  const groupId = useId();
  const isResend = employee.inviteStatus === "INVITED";
  const name = employeeFullName(employee);

  const close = (next: boolean) => {
    if (create.isPending) return;
    if (!next) create.reset();
    onOpenChange(next);
  };

  const submit = async () => {
    try {
      const result = await create.mutateAsync({ employeeId: employee.id, channel });
      toast.success(
        channel === "EMAIL"
          ? `Invite emailed to ${employee.email ?? name}`
          : `Invite created for ${name}`,
        channel === "LINK"
          ? { description: "Copy the instructions and share them with the employee." }
          : undefined,
      );
      onOpenChange(false);
      onCreated?.(result);
    } catch {
      // The error alert below shows the mapped copy.
    }
  };

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{isResend ? `Resend invite to ${name}` : `Invite ${name}`}</DialogTitle>
          <DialogDescription>
            {isResend
              ? "This issues a new employee code and cancels the previous one. Choose how to deliver it."
              : "The employee gets a personal code to enter in the Work Mode app together with your company code."}
          </DialogDescription>
        </DialogHeader>

        <form
          className="space-y-4"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <FormErrorAlert error={create.error} title="Couldn't create the invite" />

          <RadioGroup
            value={channel}
            onValueChange={(value) => setChannel(value as InviteChannel)}
            aria-labelledby={`${groupId}-label`}
            className="gap-2"
          >
            <p id={`${groupId}-label`} className="text-sm font-medium">
              How do you want to deliver it?
            </p>
            {INVITE_CHANNEL_ORDER.map((option) => {
              const meta = INVITE_CHANNEL_META[option];
              const availability = channelAvailability(option, employee);
              const itemId = `${groupId}-${option}`;
              return (
                <Label
                  key={option}
                  htmlFor={itemId}
                  className={cn(
                    "has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-primary/5 flex cursor-pointer items-start gap-3 rounded-lg border p-3 font-normal",
                    !availability.enabled && "cursor-not-allowed opacity-60",
                  )}
                >
                  <RadioGroupItem
                    id={itemId}
                    value={option}
                    disabled={!availability.enabled}
                    className="mt-0.5"
                  />
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="flex items-center gap-2 text-sm font-medium">
                      {meta.label}
                      {!availability.enabled && availability.reason ? (
                        <Badge variant="secondary" className="font-normal">
                          {availability.reason}
                        </Badge>
                      ) : null}
                    </span>
                    <span className="text-muted-foreground text-xs">
                      {meta.description}
                      {option === "EMAIL" && employee.email && availability.enabled
                        ? ` Sends to ${employee.email}.`
                        : ""}
                    </span>
                  </span>
                </Label>
              );
            })}
          </RadioGroup>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => close(false)}
              disabled={create.isPending}
            >
              Cancel
            </Button>
            <SubmitButton isPending={create.isPending} pendingLabel="Creating…">
              {isResend ? "Resend invite" : "Create invite"}
            </SubmitButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
