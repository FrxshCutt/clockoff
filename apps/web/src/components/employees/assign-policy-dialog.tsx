"use client";

import { useId, useState, type ReactNode } from "react";
import { FormErrorAlert, SubmitButton } from "@/components/forms/form-fields";
import { InlineAlert } from "@/components/inline-alert";
import { StatusBadge } from "@/components/status/status-badge";
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
import { useBreakPolicies, usePolicies } from "./employee-api";
import { ReferenceSelect } from "./reference-select";

export type AssignPolicyKind = "policy" | "breakPolicy";

export interface AssignPolicyDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  kind: AssignPolicyKind;
  title: string;
  description?: ReactNode;
  /** Current employee-level override id (single employee) so the select starts there. */
  currentId?: string | null;
  /** Runs the assignment; `null` clears the override. The dialog closes when it resolves. */
  onSubmit: (id: string | null) => Promise<unknown>;
  submitLabel?: string;
  /** Hide "No override (inherit)" — e.g. for bulk assignment when clearing is handled elsewhere. */
  allowClear?: boolean;
  error?: unknown;
  isPending?: boolean;
}

/**
 * Pick a Work Policy or Break Rules preset to apply at EMPLOYEE scope (or clear the override so the team /
 * location / organisation policy applies again). Only published (ACTIVE) policies can be assigned.
 */
export function AssignPolicyDialog({
  open,
  onOpenChange,
  kind,
  title,
  description,
  currentId = null,
  onSubmit,
  submitLabel = "Assign",
  allowClear = true,
  error,
  isPending = false,
}: AssignPolicyDialogProps) {
  const id = useId();
  const policies = usePolicies({ enabled: open && kind === "policy" });
  const breakPolicies = useBreakPolicies({ enabled: open && kind === "breakPolicy" });
  const [value, setValue] = useState<string>(currentId ?? "");

  const isLoading = kind === "policy" ? policies.isPending : breakPolicies.isPending;
  const loadError = kind === "policy" ? policies.error : breakPolicies.error;
  const options =
    kind === "policy"
      ? policies.data
          ?.filter((p) => p.status !== "ARCHIVED")
          .map((p) => ({
            id: p.id,
            name: p.name,
            hint:
              p.status === "ACTIVE"
                ? p.isDefault
                  ? "Organisation default"
                  : undefined
                : "Draft — publish it first",
            disabled: p.status !== "ACTIVE",
          }))
      : breakPolicies.data
          ?.filter((p) => p.status !== "ARCHIVED")
          .map((p) => ({
            id: p.id,
            name: p.name,
            hint: p.isDefault ? "Organisation default" : undefined,
            disabled: p.status !== "ACTIVE",
          }));

  const noun = kind === "policy" ? "Work Policy" : "Break Rules";
  const unchanged = value === (currentId ?? "");

  return (
    <Dialog open={open} onOpenChange={(next) => (isPending ? undefined : onOpenChange(next))}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description ? <DialogDescription>{description}</DialogDescription> : null}
        </DialogHeader>
        <form
          className="space-y-5"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            void onSubmit(value === "" ? null : value).then(
              () => onOpenChange(false),
              () => undefined,
            );
          }}
        >
          <FormErrorAlert error={error} title={`Couldn't assign the ${noun}`} />
          {loadError ? <FormErrorAlert error={loadError} title={`Couldn't load ${noun}`} /> : null}
          <div className="space-y-2">
            <Label htmlFor={`${id}-select`}>{noun}</Label>
            <ReferenceSelect
              id={`${id}-select`}
              value={value}
              onChange={setValue}
              options={options}
              isLoading={isLoading}
              noneLabel={
                allowClear ? "No override (inherit from team, location or organisation)" : undefined
              }
              placeholder={`Choose ${noun}`}
            />
            {options && options.length === 0 ? (
              <InlineAlert variant="info">
                No {noun} exist yet. Create and publish one first.
              </InlineAlert>
            ) : null}
          </div>
          {kind === "policy" && options?.some((o) => o.disabled) ? (
            <p className="text-muted-foreground flex items-center gap-2 text-xs">
              <StatusBadge kind="policyStatus" value="DRAFT" size="sm" describe={false} /> policies
              can&apos;t be assigned until published.
            </p>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
              disabled={isPending}
            >
              Cancel
            </Button>
            <SubmitButton
              isPending={isPending}
              pendingLabel="Assigning…"
              disabled={(unchanged && currentId !== null) || (value === "" && !allowClear)}
            >
              {value === "" && allowClear ? "Clear override" : submitLabel}
            </SubmitButton>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
