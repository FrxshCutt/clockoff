"use client";

import type { BreakPolicy } from "@workmode/validation/breakPolicies";
import { Sheet, SheetContent } from "@/components/ui/sheet";
import { BreakPolicyForm } from "./break-policy-form";

export interface BreakPolicyFormSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Edit these Break Rules; omit to create new ones. */
  policy?: BreakPolicy | null;
  onSaved?: (policy: BreakPolicy, mode: "create" | "update") => void;
}

/** Create / edit Break Rules in a side sheet. The form is keyed so reopening always starts from fresh values. */
export function BreakPolicyFormSheet({
  open,
  onOpenChange,
  policy = null,
  onSaved,
}: BreakPolicyFormSheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="flex w-full flex-col gap-0 overflow-hidden p-0 sm:max-w-xl">
        {open ? (
          <BreakPolicyForm
            key={policy?.id ?? "new"}
            variant="sheet"
            policy={policy}
            onCancel={() => onOpenChange(false)}
            onSaved={(saved, mode) => {
              onOpenChange(false);
              onSaved?.(saved, mode);
            }}
          />
        ) : null}
      </SheetContent>
    </Sheet>
  );
}
