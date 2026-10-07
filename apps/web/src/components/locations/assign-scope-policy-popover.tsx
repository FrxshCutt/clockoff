"use client";

import type { ScopeAssignment } from "@clockoff/validation/locationsTeams";
import { Check, ChevronsUpDown, LoaderCircle, Undo2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { useApiErrorToast } from "@/hooks/use-api-error-toast";
import { getErrorMessage } from "@/lib/errorMessages";
import { cn } from "@/lib/utils";
import {
  POLICY_KIND_NOUN,
  SCOPE_NOUN,
  summariseScopeAssignment,
  type AssignableScope,
  type PolicyKind,
  type PolicyOption,
} from "./locations-view-model";
import {
  useAssignScopePolicy,
  useRemoveScopeAssignment,
  type PolicyOptionsState,
} from "./use-scope-assignments";

export interface AssignScopePolicyPopoverProps {
  kind: PolicyKind;
  scopeType: AssignableScope;
  scope: { id: string; name: string };
  /** The assignment in force at this scope, as embedded on the row (`null` / `undefined` = inherits). */
  assignment: ScopeAssignment | null | undefined;
  /** Policies that can be chosen, from `usePolicyOptions()`. */
  choices: PolicyOptionsState;
  canEdit: boolean;
}

/**
 * Inline "Assign…" control for a table cell: shows the Work Policy / Break Rules assigned at a location or team
 * and lets managers with `policies:write` pick another one (`POST /api/<kind>/:id/assignments` at LOCATION /
 * TEAM scope, which replaces the current one) or remove it (`DELETE /api/<kind>-assignments/:id`).
 */
export function AssignScopePolicyPopover({
  kind,
  scopeType,
  scope,
  assignment,
  choices,
  canEdit,
}: AssignScopePolicyPopoverProps) {
  const [open, setOpen] = useState(false);
  const assign = useAssignScopePolicy(kind);
  const remove = useRemoveScopeAssignment(kind);
  const toastError = useApiErrorToast();

  const noun = POLICY_KIND_NOUN[kind];
  const scopeNoun = SCOPE_NOUN[scopeType];
  const summary = summariseScopeAssignment(assignment);
  const pending = assign.isPending || remove.isPending;

  const label = (
    <span className="flex min-w-0 items-center gap-1.5">
      {pending ? (
        <LoaderCircle
          className="text-muted-foreground size-3.5 shrink-0 animate-spin"
          aria-hidden="true"
        />
      ) : null}
      <span className={cn("truncate", !summary.assigned && "text-muted-foreground")}>
        {summary.label}
      </span>
    </span>
  );

  if (!canEdit) {
    return <span className="text-sm">{label}</span>;
  }

  const choosePolicy = (option: PolicyOption) => {
    setOpen(false);
    if (option.id === summary.policyId) return;
    assign.mutate(
      { policyId: option.id, scopeType, scopeId: scope.id },
      {
        onSuccess: () => toast.success(`${option.name} assigned to ${scope.name}`),
        onError: (error) => toastError(error, { title: `Couldn't assign the ${noun}` }),
      },
    );
  };

  const inherit = () => {
    setOpen(false);
    if (!summary.assignmentId) return;
    remove.mutate(summary.assignmentId, {
      onSuccess: () => toast.success(`${scope.name} now inherits its ${noun}`),
      onError: (error) => toastError(error, { title: `Couldn't remove the ${noun} assignment` }),
    });
  };

  const emptyText = choices.isError
    ? getErrorMessage(choices.error)
    : choices.options && choices.options.length === 0
      ? `No ${noun} yet. Create and publish one first.`
      : "Nothing found.";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          role="combobox"
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-label={`${noun} for ${scope.name}: ${summary.label}. Change`}
          disabled={pending}
          className="-ml-2.5 h-8 max-w-full justify-start gap-1.5 px-2.5 font-normal"
        >
          {label}
          <ChevronsUpDown className="size-3.5 shrink-0 opacity-50" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-72 p-0" align="start">
        <Command>
          <CommandInput placeholder={`Search ${noun}…`} aria-label={`Search ${noun}`} />
          <CommandList className="max-h-64">
            {choices.isPending ? (
              <div
                className="text-muted-foreground flex items-center gap-2 px-3 py-4 text-sm"
                aria-busy="true"
              >
                <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
                Loading {noun}…
              </div>
            ) : (
              <>
                <CommandEmpty>{emptyText}</CommandEmpty>
                <CommandGroup heading={noun}>
                  {(choices.options ?? []).map((option) => {
                    const selected = option.id === summary.policyId;
                    return (
                      <CommandItem
                        key={option.id}
                        value={`${option.name} ${option.id}`}
                        disabled={option.disabled}
                        onSelect={() => choosePolicy(option)}
                        aria-selected={selected}
                      >
                        <Check
                          className={cn("size-4 shrink-0", selected ? "opacity-100" : "opacity-0")}
                          aria-hidden="true"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block truncate">{option.name}</span>
                          {option.hint ? (
                            <span className="text-muted-foreground block truncate text-xs">
                              {option.hint}
                            </span>
                          ) : null}
                        </span>
                      </CommandItem>
                    );
                  })}
                </CommandGroup>
              </>
            )}
            <CommandSeparator />
            <CommandGroup>
              <CommandItem
                value="inherit-from-organisation"
                disabled={!summary.assigned}
                onSelect={inherit}
              >
                <Undo2 className="size-4 shrink-0" aria-hidden="true" />
                <span className="min-w-0 flex-1">
                  <span className="block">Inherit</span>
                  <span className="text-muted-foreground block text-xs">
                    Remove the {scopeNoun} assignment and use the next level up.
                  </span>
                </span>
              </CommandItem>
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
