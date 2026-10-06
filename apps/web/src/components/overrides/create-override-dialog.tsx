"use client";

import {
  RESTRICTION_CATEGORIES,
  RESTRICTION_CATEGORY_LABELS,
  type OverrideType,
  type RestrictionCategory,
} from "@workmode/shared/enums";
import { OVERRIDE_LIMITS, type Override } from "@workmode/validation/overrides";
import { KeyRound } from "lucide-react";
import { useId, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { useBreakPolicies, useCreateOverride } from "@/components/employees/employee-api";
import { ReferenceSelect } from "@/components/employees/reference-select";
import { useNow } from "@/components/employees/use-now";
import { FormErrorAlert, SubmitButton } from "@/components/forms/form-fields";
import { InlineAlert } from "@/components/inline-alert";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useCurrentRole } from "@/hooks/use-current-user";
import { useCurrentOrganisation } from "@/hooks/use-organisation";
import { getFieldErrors } from "@/lib/errorMessages";
import { formatDateTime, formatDurationMinutes } from "@/lib/format";
import { cn } from "@/lib/utils";
import {
  BEHAVIOUR_LABELS,
  OVERRIDE_DURATION_PRESETS,
  OVERRIDE_TYPE_META,
  OVERRIDE_TYPE_ORDER,
  buildCreateOverrideInput,
  computeOverrideExpiry,
  overrideMaxMinutes,
  type OverrideBehaviourChoice,
  type OverrideExpiryChoice,
} from "./override-helpers";

export interface CreateOverrideDialogProps {
  /** The employee the override applies to; `null` offers the organisation-wide emergency override only. */
  employee: { id: string; firstName: string; lastName: string } | null;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Uncontrolled usage: the element that opens the dialog. */
  trigger?: ReactNode;
  onCreated?: (override: Override) => void;
}

type BehaviourKind = OverrideBehaviourChoice["kind"];

/**
 * Creates a manager override (`POST /api/overrides`): type with plain-English explanations, a reason (kept
 * on record), an expiry (15/30/60/120 min presets or a custom end, capped per role) and, for a temporary
 * exception, how restrictions relax. Exported for the Overview and Schedule pages.
 */
export function CreateOverrideDialog({
  employee,
  open: openProp,
  onOpenChange,
  trigger,
  onCreated,
}: CreateOverrideDialogProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  const open = openProp ?? uncontrolledOpen;
  const setOpen = (next: boolean) => {
    if (openProp === undefined) setUncontrolledOpen(next);
    onOpenChange?.(next);
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      {trigger ? <DialogTrigger asChild>{trigger}</DialogTrigger> : null}
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        {/* Remount per opening so the form always starts clean. */}
        {open ? (
          <CreateOverrideForm
            employee={employee}
            onClose={() => setOpen(false)}
            onCreated={onCreated}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function CreateOverrideForm({
  employee,
  onClose,
  onCreated,
}: {
  employee: CreateOverrideDialogProps["employee"];
  onClose: () => void;
  onCreated?: (override: Override) => void;
}) {
  const role = useCurrentRole();
  const now = useNow();
  const organisation = useCurrentOrganisation();
  const create = useCreateOverride();
  const breakPolicies = useBreakPolicies();
  const ids = useId();

  const types: readonly OverrideType[] = employee
    ? OVERRIDE_TYPE_ORDER
    : ["EMERGENCY_POLICY_OVERRIDE"];
  const [type, setType] = useState<OverrideType>(types[0] ?? "EXEMPT_TEMPORARILY");
  const [reason, setReason] = useState("");
  const [expiry, setExpiry] = useState<OverrideExpiryChoice>({
    kind: "preset",
    minutes: OVERRIDE_LIMITS.defaultDurationMinutes,
  });
  const [behaviourKind, setBehaviourKind] = useState<BehaviourKind>("RELAX_ALL");
  const [categories, setCategories] = useState<RestrictionCategory[]>([]);
  const [breakPolicyId, setBreakPolicyId] = useState("");
  const [fieldError, setFieldError] = useState<{ field: string; message: string } | null>(null);

  const maxMinutes = overrideMaxMinutes(role);
  const nowDate = now === null ? null : new Date(now);
  const preview = nowDate ? computeOverrideExpiry(expiry, nowDate, role) : null;
  const timeZone = organisation.data?.organisation.timezone;
  const dateFormat = organisation.data?.organisation.dateFormat;

  const behaviour = (): OverrideBehaviourChoice => {
    switch (behaviourKind) {
      case "RELAX_ALL":
        return { kind: "RELAX_ALL" };
      case "RELAX_CATEGORIES":
        return { kind: "RELAX_CATEGORIES", categories };
      case "BREAK_POLICY":
        return { kind: "BREAK_POLICY", breakPolicyId };
    }
  };

  const submit = async () => {
    setFieldError(null);
    const built = buildCreateOverrideInput(
      { employeeId: employee?.id ?? null, type, reason, expiry, behaviour: behaviour() },
      nowDate ?? new Date(),
      role,
    );
    if (!built.ok) {
      setFieldError({ field: built.field, message: built.message });
      return;
    }
    try {
      const override = await create.mutateAsync(built.input);
      toast.success(`${OVERRIDE_TYPE_META[type].label} applied`, {
        description: `Expires ${formatDateTime(built.expiresAt, { timeZone, dateFormat })}.`,
      });
      onClose();
      onCreated?.(override);
    } catch (error) {
      // Server field errors map onto the matching local section; anything else shows in the alert.
      const fieldErrors = getFieldErrors(error);
      const mapped =
        fieldErrors.reason !== undefined
          ? { field: "reason", message: fieldErrors.reason }
          : fieldErrors.payload !== undefined
            ? { field: "behaviour", message: fieldErrors.payload }
            : fieldErrors.expiresAt !== undefined || fieldErrors.durationMinutes !== undefined
              ? {
                  field: "expiry",
                  message: fieldErrors.expiresAt ?? fieldErrors.durationMinutes ?? "",
                }
              : null;
      if (mapped) setFieldError(mapped);
    }
  };

  const errorFor = (field: string) => (fieldError?.field === field ? fieldError.message : null);
  const employeeName = employee ? `${employee.firstName} ${employee.lastName}` : null;

  return (
    <>
      <DialogHeader>
        <DialogTitle className="flex items-center gap-2">
          <KeyRound className="text-muted-foreground size-5" aria-hidden="true" />
          {employeeName ? `Override for ${employeeName}` : "Organisation-wide override"}
        </DialogTitle>
        <DialogDescription>
          Overrides change what the phone restricts for a limited time. The reason is recorded in
          the audit log and activity feed.
        </DialogDescription>
      </DialogHeader>

      <form
        className="space-y-6"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <FormErrorAlert
          error={fieldError ? null : create.error}
          title="Couldn't create the override"
        />

        {/* Type */}
        <fieldset className="space-y-2">
          <legend className="text-sm font-medium">What kind of override?</legend>
          <RadioGroup
            value={type}
            onValueChange={(value) => setType(value as OverrideType)}
            className="gap-2"
          >
            {types.map((option) => {
              const meta = OVERRIDE_TYPE_META[option];
              const id = `${ids}-type-${option}`;
              return (
                <Label
                  key={option}
                  htmlFor={id}
                  className="has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-primary/5 flex cursor-pointer items-start gap-3 rounded-lg border p-3 font-normal"
                >
                  <RadioGroupItem id={id} value={option} className="mt-0.5" />
                  <span className="flex min-w-0 flex-col gap-0.5">
                    <span className="text-sm font-medium">{meta.label}</span>
                    <span className="text-muted-foreground text-xs">{meta.description}</span>
                    <span className="text-muted-foreground text-xs italic">
                      e.g. {meta.example}
                    </span>
                  </span>
                </Label>
              );
            })}
          </RadioGroup>
        </fieldset>

        {type === "EMERGENCY_POLICY_OVERRIDE" && !employee ? (
          <InlineAlert variant="warning" title="Applies to everyone">
            Without an employee this lifts restrictions for every connected phone in the
            organisation until it expires.
          </InlineAlert>
        ) : null}

        {/* Reason */}
        <div className="space-y-2">
          <Label htmlFor={`${ids}-reason`}>Reason</Label>
          <Textarea
            id={`${ids}-reason`}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Why is this needed? At least 5 characters."
            minLength={OVERRIDE_LIMITS.reasonMinLength}
            maxLength={OVERRIDE_LIMITS.reasonMaxLength}
            aria-invalid={errorFor("reason") ? true : undefined}
            aria-describedby={`${ids}-reason-hint`}
            rows={3}
          />
          <p
            id={`${ids}-reason-hint`}
            className={cn(
              "text-xs",
              errorFor("reason") ? "text-destructive" : "text-muted-foreground",
            )}
          >
            {errorFor("reason") ??
              `${reason.trim().length}/${OVERRIDE_LIMITS.reasonMaxLength} characters. Visible to other managers in the audit log.`}
          </p>
        </div>

        {/* Expiry */}
        <fieldset className="space-y-3">
          <legend className="text-sm font-medium">How long?</legend>
          <ToggleGroup
            type="single"
            variant="outline"
            value={expiry.kind === "preset" ? String(expiry.minutes) : "custom"}
            onValueChange={(value) => {
              if (!value) return;
              if (value === "custom")
                setExpiry({ kind: "custom", until: expiry.kind === "custom" ? expiry.until : "" });
              else setExpiry({ kind: "preset", minutes: Number(value) });
            }}
            aria-label="Override duration"
            className="flex-wrap justify-start"
          >
            {OVERRIDE_DURATION_PRESETS.map((minutes) => (
              <ToggleGroupItem key={minutes} value={String(minutes)} className="px-3">
                {formatDurationMinutes(minutes)}
              </ToggleGroupItem>
            ))}
            <ToggleGroupItem value="custom" className="px-3">
              Custom end
            </ToggleGroupItem>
          </ToggleGroup>
          {expiry.kind === "custom" ? (
            <div className="space-y-1.5">
              <Label htmlFor={`${ids}-until`}>Ends at</Label>
              <Input
                id={`${ids}-until`}
                type="datetime-local"
                value={expiry.until}
                onChange={(event) => setExpiry({ kind: "custom", until: event.target.value })}
                aria-invalid={errorFor("expiry") ? true : undefined}
                className="max-w-xs"
              />
            </div>
          ) : null}
          <p
            className={cn(
              "text-xs",
              errorFor("expiry") || (preview && !preview.ok)
                ? "text-destructive"
                : "text-muted-foreground",
            )}
          >
            {errorFor("expiry") ??
              (preview === null
                ? `Overrides can last at most ${formatDurationMinutes(maxMinutes)}.`
                : preview.ok
                  ? `Expires ${formatDateTime(preview.expiresAt, { timeZone, dateFormat })} (${formatDurationMinutes(preview.durationMinutes)}). Maximum ${formatDurationMinutes(maxMinutes)}.`
                  : preview.message)}
          </p>
        </fieldset>

        {/* Payload for TEMPORARY_EXCEPTION */}
        {type === "TEMPORARY_EXCEPTION" ? (
          <fieldset className="space-y-3">
            <legend className="text-sm font-medium">What relaxes?</legend>
            <RadioGroup
              value={behaviourKind}
              onValueChange={(value) => setBehaviourKind(value as BehaviourKind)}
              className="gap-2"
            >
              {(
                [
                  [
                    "RELAX_ALL",
                    BEHAVIOUR_LABELS.RELAX_ALL,
                    "Every restricted category is allowed until the override expires.",
                  ],
                  [
                    "RELAX_CATEGORIES",
                    BEHAVIOUR_LABELS.RELAX_CATEGORIES,
                    "Only the categories you pick are allowed; the rest stay restricted.",
                  ],
                  [
                    "BREAK_POLICY",
                    "Use a Break Rules preset",
                    "Relax restrictions exactly as those Break Rules do during a break.",
                  ],
                ] as const
              ).map(([kind, label, description]) => {
                const id = `${ids}-behaviour-${kind}`;
                return (
                  <Label
                    key={kind}
                    htmlFor={id}
                    className="has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-primary/5 flex cursor-pointer items-start gap-3 rounded-lg border p-3 font-normal"
                  >
                    <RadioGroupItem id={id} value={kind} className="mt-0.5" />
                    <span className="flex flex-col gap-0.5">
                      <span className="text-sm font-medium">{label}</span>
                      <span className="text-muted-foreground text-xs">{description}</span>
                    </span>
                  </Label>
                );
              })}
            </RadioGroup>
            {behaviourKind === "RELAX_CATEGORIES" ? (
              <ul
                className="grid gap-2 rounded-md border p-3 sm:grid-cols-2"
                aria-label="Categories to relax"
              >
                {RESTRICTION_CATEGORIES.map((category) => {
                  const id = `${ids}-cat-${category}`;
                  const checked = categories.includes(category);
                  return (
                    <li key={category} className="flex items-center gap-2.5">
                      <Checkbox
                        id={id}
                        checked={checked}
                        onCheckedChange={(next) =>
                          setCategories((prev) =>
                            next === true
                              ? [...prev, category]
                              : prev.filter((c) => c !== category),
                          )
                        }
                      />
                      <Label htmlFor={id} className="font-normal">
                        {RESTRICTION_CATEGORY_LABELS[category]}
                      </Label>
                    </li>
                  );
                })}
              </ul>
            ) : null}
            {behaviourKind === "BREAK_POLICY" ? (
              <div className="space-y-1.5">
                <Label htmlFor={`${ids}-break-policy`}>Break Rules</Label>
                <ReferenceSelect
                  id={`${ids}-break-policy`}
                  value={breakPolicyId}
                  onChange={setBreakPolicyId}
                  options={breakPolicies.data
                    ?.filter((p) => p.status !== "ARCHIVED")
                    .map((p) => ({
                      id: p.id,
                      name: p.name,
                      hint: BEHAVIOUR_LABELS[p.restrictionBehaviour],
                    }))}
                  isLoading={breakPolicies.isPending}
                  placeholder="Choose Break Rules"
                  aria-invalid={errorFor("behaviour") ? true : undefined}
                />
              </div>
            ) : null}
            {errorFor("behaviour") ? (
              <p className="text-destructive text-xs" role="alert">
                {errorFor("behaviour")}
              </p>
            ) : null}
          </fieldset>
        ) : null}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={create.isPending}>
            Cancel
          </Button>
          <SubmitButton isPending={create.isPending} pendingLabel="Applying…">
            Apply override
          </SubmitButton>
        </DialogFooter>
      </form>
    </>
  );
}
