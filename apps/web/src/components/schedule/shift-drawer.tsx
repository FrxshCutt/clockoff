"use client";

import type { Shift } from "@clockoff/validation/shifts";
import { SHIFT_LIMITS } from "@clockoff/validation/shifts";
import { RECURRENCE_WEEKDAY_CODES, type LocalDateString } from "@clockoff/shared/time/time";
import {
  Ban,
  CalendarPlus,
  Coffee,
  Copy,
  LoaderCircle,
  MoonStar,
  Plus,
  Repeat,
  ShieldAlert,
  Trash2,
  X,
} from "lucide-react";
import { useId, useMemo, useState } from "react";
import { useFieldArray, useWatch } from "react-hook-form";
import { toast } from "sonner";
import { ConfirmDialog } from "@/components/confirm-dialog";
import {
  FormErrorAlert,
  SubmitButton,
  TextareaField,
  applyApiFieldErrors,
  useZodForm,
} from "@/components/forms/form-fields";
import { InlineAlert } from "@/components/inline-alert";
import { StatusBadge } from "@/components/status/status-badge";
import { Button } from "@/components/ui/button";
import {
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
  Form,
} from "@/components/ui/form";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useApiErrorToast } from "@/hooks/use-api-error-toast";
import { hasErrorCode } from "@/lib/api-client";
import { formatDurationMinutes, formatTimeZoneLabel } from "@/lib/format";
import { getErrorMessage } from "@/lib/errorMessages";
import { cn } from "@/lib/utils";
import { EmployeePicker, type EmployeeRef } from "./employee-picker";
import { LocationSelect } from "./location-select";
import {
  REPEAT_OPTIONS,
  REPEAT_OPTION_LABELS,
  WEEKDAY_LABELS,
  describeRecurrenceRule,
  isWeekdayCode,
} from "./rrule-builder";
import {
  employeeName,
  formatLocalDay,
  futureSeriesShifts,
  seriesIdOf,
  shiftLocalTimes,
  shiftTimeLabel,
} from "./schedule-model";
import {
  fetchEmployeeShiftsFrom,
  useBulkShiftAction,
  useCancelShift,
  useCreateShift,
  useDeleteShift,
  useDuplicateShift,
  useLocations,
  useUpdateShift,
} from "./schedule-queries";
import {
  DST_WARNING_COPY,
  NO_LOCATION,
  emptyShiftForm,
  formTimezone,
  previewShiftTimes,
  readOverlapConflictIds,
  readResponseWarnings,
  resolveConflicts,
  shiftFormSchema,
  shiftToFormValues,
  toCreateShiftInput,
  toUpdateShiftInput,
  type ShiftFormValues,
} from "./shift-form-model";

export type ShiftDrawerState =
  | { mode: "closed" }
  | {
      mode: "create";
      date: LocalDateString;
      employeeId?: string | null;
      employee?: EmployeeRef | null;
      locationId?: string | null;
    }
  | { mode: "edit"; shift: Shift };

export interface ShiftDrawerProps {
  state: ShiftDrawerState;
  onClose: () => void;
  organisationTimezone: string;
  canEdit: boolean;
  /** Shifts already loaded for the visible range (used to label conflicts without another request). */
  knownShifts?: readonly Shift[];
}

export type SeriesScope = "this" | "future";

/**
 * Create / edit a shift. One Sheet; the inner form remounts per shift so react-hook-form defaults are
 * always fresh. Save → POST or PATCH, plus duplicate / cancel / delete actions; members of a recurrence
 * series can apply save, cancel and delete to "this and future shifts".
 */
export function ShiftDrawer({
  state,
  onClose,
  organisationTimezone,
  canEdit,
  knownShifts = [],
}: ShiftDrawerProps) {
  const open = state.mode !== "closed";
  const formKey =
    state.mode === "edit"
      ? `edit:${state.shift.id}:${state.shift.version}`
      : state.mode === "create"
        ? `create:${state.date}:${state.employeeId ?? ""}`
        : "closed";
  return (
    <Sheet open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <SheetContent
        side="right"
        className="flex w-full flex-col gap-0 p-0 sm:max-w-xl"
        showCloseButton={false}
      >
        {state.mode !== "closed" ? (
          <ShiftDrawerBody
            key={formKey}
            state={state}
            onClose={onClose}
            organisationTimezone={organisationTimezone}
            canEdit={canEdit}
            knownShifts={knownShifts}
          />
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

interface BodyProps {
  state: Exclude<ShiftDrawerState, { mode: "closed" }>;
  onClose: () => void;
  organisationTimezone: string;
  canEdit: boolean;
  knownShifts: readonly Shift[];
}

function ShiftDrawerBody({
  state,
  onClose,
  organisationTimezone,
  canEdit,
  knownShifts,
}: BodyProps) {
  const isEdit = state.mode === "edit";
  const shift = isEdit ? state.shift : null;
  const toastError = useApiErrorToast();
  const locations = useLocations();
  const createShift = useCreateShift();
  const updateShift = useUpdateShift();
  const deleteShift = useDeleteShift();
  const duplicateShift = useDuplicateShift();
  const cancelShift = useCancelShift();
  const bulk = useBulkShiftAction();
  const [busy, setBusy] = useState(false);
  const [scope, setScope] = useState<SeriesScope>("this");
  const [submitError, setSubmitError] = useState<unknown>(null);
  const [selectedEmployee, setSelectedEmployee] = useState<EmployeeRef | null>(
    isEdit ? state.shift.employee : (state.employee ?? null),
  );

  const defaults = useMemo<ShiftFormValues>(
    () =>
      isEdit
        ? shiftToFormValues(state.shift)
        : emptyShiftForm({
            employeeId: state.employeeId ?? null,
            locationId: state.locationId ?? null,
            date: state.date,
          }),
    [isEdit, state],
  );
  const form = useZodForm(shiftFormSchema, { defaultValues: defaults });
  const breaks = useFieldArray({ control: form.control, name: "scheduledBreaks" });
  const watched = useWatch({ control: form.control });
  const locationId = watched.locationId ?? NO_LOCATION;
  const repeat = watched.repeat ?? "none";
  const timezone = shift
    ? shift.timezone
    : formTimezone(locationId, locations.data ?? [], organisationTimezone);
  const preview = previewShiftTimes(
    {
      date: watched.date ?? "",
      startTime: watched.startTime ?? "",
      endTime: watched.endTime ?? "",
    },
    timezone,
  );
  const inSeries = shift ? seriesIdOf(shift) !== null : false;
  const readOnly = !canEdit;
  const pending =
    busy ||
    createShift.isPending ||
    updateShift.isPending ||
    deleteShift.isPending ||
    duplicateShift.isPending ||
    cancelShift.isPending ||
    bulk.isPending;

  const idPrefix = useId();
  const dateId = `${idPrefix}-date`;
  const startId = `${idPrefix}-start`;
  const endId = `${idPrefix}-end`;
  const untilId = `${idPrefix}-until`;

  /** Members of this shift's series starting at or after it (itself included). */
  const loadFutureSiblings = async (): Promise<Shift[]> => {
    if (!shift) return [];
    const fetched = await fetchEmployeeShiftsFrom(shift.employee.id, shift.startsAt);
    return futureSeriesShifts(shift, [shift, ...knownShifts, ...fetched]);
  };

  const closeAfter = (message: string) => {
    toast.success(message);
    onClose();
  };

  const surfaceWarnings = (payload: unknown) => {
    for (const warning of readResponseWarnings(payload)) toast.warning(warning);
  };

  /** Saves the form; `allowOverlap` is the "Allow overlap" retry after a SHIFT_OVERLAP answer. */
  const save = async (values: ShiftFormValues, allowOverlap: boolean) => {
    setSubmitError(null);
    try {
      if (!shift) {
        const response = await createShift.mutateAsync(
          toCreateShiftInput(values, { allowOverlap }),
        );
        surfaceWarnings(response);
        const skipped = response.skippedOccurrences?.length ?? 0;
        if (skipped > 0) {
          toast.warning(
            `${skipped} ${skipped === 1 ? "occurrence was" : "occurrences were"} skipped because ${skipped === 1 ? "it" : "they"} overlapped existing shifts.`,
          );
        }
        const count = response.shifts.length;
        closeAfter(count > 1 ? `${count} shifts created` : "Shift created");
        return;
      }
      const applyTo = scope === "future" && inSeries ? "THIS_AND_FUTURE" : "THIS";
      const response = await updateShift.mutateAsync({
        id: shift.id,
        input: toUpdateShiftInput(values, shift, { allowOverlap, applyTo }),
      });
      surfaceWarnings(response);
      closeAfter(applyTo === "THIS_AND_FUTURE" ? "This and future shifts saved" : "Shift saved");
    } catch (error) {
      if (hasErrorCode(error, "INVALID_RECURRENCE")) {
        form.setError(values.repeat === "weekly" ? "weekdays" : "customRule", {
          type: "server",
          message: getErrorMessage(error),
        });
      } else if (!applyApiFieldErrors(form, error)) {
        setSubmitError(error);
      }
    }
  };

  const onSubmit = form.handleSubmit((values) => save(values, false));
  const onAllowOverlap = form.handleSubmit((values) => save(values, true));

  const runSeriesAction = async (action: "CANCEL" | "DELETE") => {
    if (!shift) return;
    setBusy(true);
    try {
      if (scope === "future" && inSeries) {
        const siblings = await loadFutureSiblings();
        // Bulk CANCEL answers CONFLICT per already-cancelled/completed member; only scheduled ones are sent.
        const targets =
          action === "CANCEL" ? siblings.filter((s) => s.status === "SCHEDULED") : siblings;
        const ids = targets.length > 0 ? targets.map((s) => s.id) : [shift.id];
        const result = await bulk.mutateAsync(
          action === "CANCEL"
            ? { action: "CANCEL", shiftIds: ids }
            : { action: "DELETE", shiftIds: ids },
        );
        if (result.failed.length > 0)
          toast.warning(
            `${result.failed.length} ${result.failed.length === 1 ? "shift" : "shifts"} could not be ${action === "CANCEL" ? "cancelled" : "deleted"}`,
          );
        closeAfter(
          `${result.succeeded} ${result.succeeded === 1 ? "shift" : "shifts"} ${action === "CANCEL" ? "cancelled" : "deleted"}`,
        );
        return;
      }
      if (action === "CANCEL") {
        await cancelShift.mutateAsync({
          id: shift.id,
          input: cancelReason.trim() ? { reason: cancelReason.trim() } : {},
        });
        closeAfter("Shift cancelled");
      } else {
        await deleteShift.mutateAsync(shift.id);
        closeAfter("Shift deleted");
      }
    } catch (error) {
      toastError(error, {
        title: action === "CANCEL" ? "Couldn't cancel the shift" : "Couldn't delete the shift",
      });
      throw error;
    } finally {
      setBusy(false);
    }
  };

  const [cancelReason, setCancelReason] = useState("");
  const [duplicateDate, setDuplicateDate] = useState<string>(() =>
    shift ? shiftLocalTimes(shift, shift.timezone).startDate : "",
  );
  const [duplicateOpen, setDuplicateOpen] = useState(false);
  const [duplicateError, setDuplicateError] = useState<unknown>(null);

  const onDuplicate = async () => {
    if (!shift || !/^\d{4}-\d{2}-\d{2}$/.test(duplicateDate)) return;
    setDuplicateError(null);
    try {
      await duplicateShift.mutateAsync({ id: shift.id, input: { date: duplicateDate } });
      setDuplicateOpen(false);
      toast.success(`Shift copied to ${formatLocalDay(duplicateDate, "long")}`);
    } catch (error) {
      setDuplicateError(error);
    }
  };

  const overlapConflicts = hasErrorCode(submitError, "SHIFT_OVERLAP")
    ? resolveConflicts(readOverlapConflictIds(submitError.details), knownShifts)
    : [];
  const genericSubmitError =
    submitError && !hasErrorCode(submitError, "SHIFT_OVERLAP", "SHIFT_TOO_SHORT")
      ? submitError
      : null;

  return (
    <Form {...form}>
      <form onSubmit={onSubmit} noValidate className="flex min-h-0 flex-1 flex-col">
        <SheetHeader className="border-b px-6 py-5">
          <div className="flex items-start justify-between gap-4">
            <div className="min-w-0 space-y-1">
              <SheetTitle>{shift ? "Edit shift" : "Add shift"}</SheetTitle>
              <SheetDescription>
                {shift ? (
                  <span className="flex flex-wrap items-center gap-2">
                    <span>{employeeName(shift.employee)}</span>
                    <StatusBadge kind="shiftStatus" value={shift.status} size="sm" />
                  </span>
                ) : (
                  "Work Mode switches on automatically when the shift starts."
                )}
              </SheetDescription>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              onClick={onClose}
              aria-label="Close"
            >
              <X aria-hidden="true" />
            </Button>
          </div>
        </SheetHeader>

        <div className="min-h-0 flex-1 space-y-6 overflow-y-auto px-6 py-5">
          {readOnly ? (
            <InlineAlert variant="info" title="View only">
              Your role can view the schedule but not change it.
            </InlineAlert>
          ) : null}

          {genericSubmitError ? (
            <FormErrorAlert error={genericSubmitError} title="Couldn't save the shift" />
          ) : null}
          {hasErrorCode(submitError, "SHIFT_TOO_SHORT") ? (
            <InlineAlert variant="danger" title="Shift too short">
              Shifts must be at least {SHIFT_LIMITS.minDurationMinutes} minutes long. Check the
              start and end times.
            </InlineAlert>
          ) : null}
          {hasErrorCode(submitError, "SHIFT_OVERLAP") ? (
            <InlineAlert
              variant="danger"
              title="This shift overlaps another shift for the same employee"
            >
              {overlapConflicts.length > 0 ? (
                <ul className="mt-1 list-disc space-y-0.5 pl-4 tabular-nums">
                  {overlapConflicts.map((c) => (
                    <li key={c.id}>
                      {c.shift
                        ? `${formatLocalDay(shiftLocalTimes(c.shift, timezone).startDate, "medium")}, ${shiftTimeLabel(shiftLocalTimes(c.shift, timezone))}${c.shift.location ? ` · ${c.shift.location.name}` : ""}`
                        : `Shift ${c.id.slice(0, 8)}… (outside the loaded range)`}
                    </li>
                  ))}
                </ul>
              ) : null}
              <p className="mt-2">
                Change the date or times, cancel the other shift, or save anyway if the double
                booking is intended.
              </p>
              {!readOnly ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="mt-2"
                  onClick={() => void onAllowOverlap()}
                  disabled={pending}
                >
                  <ShieldAlert aria-hidden="true" />
                  Allow overlap and save
                </Button>
              ) : null}
            </InlineAlert>
          ) : null}

          {/* Employee */}
          <FormField
            control={form.control}
            name="employeeId"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Employee</FormLabel>
                {shift ? (
                  <p className="text-sm">
                    {employeeName(shift.employee)}
                    {shift.employee.jobTitle ? (
                      <span className="text-muted-foreground"> · {shift.employee.jobTitle}</span>
                    ) : null}
                  </p>
                ) : (
                  <FormControl>
                    <EmployeePicker
                      ref={field.ref}
                      value={field.value || null}
                      selected={selectedEmployee}
                      onChange={(employee) => {
                        setSelectedEmployee(employee);
                        field.onChange(employee?.id ?? "");
                      }}
                      onBlur={field.onBlur}
                      disabled={readOnly}
                      aria-invalid={Boolean(form.formState.errors.employeeId)}
                    />
                  </FormControl>
                )}
                <FormMessage />
              </FormItem>
            )}
          />

          {/* Location */}
          <FormField
            control={form.control}
            name="locationId"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Location</FormLabel>
                <FormControl>
                  <LocationSelect
                    value={field.value || null}
                    onChange={(id) => field.onChange(id ?? NO_LOCATION)}
                    onBlur={field.onBlur}
                    nullLabel="No location"
                    disabled={readOnly}
                    className="w-full"
                  />
                </FormControl>
                <FormDescription>
                  Times are entered in {formatTimeZoneLabel(timezone)}.
                </FormDescription>
                <FormMessage />
              </FormItem>
            )}
          />

          {/* Date & times */}
          <div className="grid gap-4 sm:grid-cols-3">
            <FormField
              control={form.control}
              name="date"
              render={({ field }) => (
                <FormItem>
                  <FormLabel htmlFor={dateId}>Date</FormLabel>
                  <FormControl>
                    <Input id={dateId} type="date" {...field} disabled={readOnly} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="startTime"
              render={({ field }) => (
                <FormItem>
                  <FormLabel htmlFor={startId}>Start</FormLabel>
                  <FormControl>
                    <Input id={startId} type="time" step={60} {...field} disabled={readOnly} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="endTime"
              render={({ field }) => (
                <FormItem>
                  <FormLabel htmlFor={endId}>End</FormLabel>
                  <FormControl>
                    <Input id={endId} type="time" step={60} {...field} disabled={readOnly} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
          </div>

          <div className="space-y-2" aria-live="polite">
            <p className="text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
              {preview.overnight ? (
                <span className="text-foreground inline-flex items-center gap-1 font-medium">
                  <MoonStar className="size-4" aria-hidden="true" />
                  Ends next day
                </span>
              ) : null}
              {preview.durationMinutes !== null ? (
                <span>Length: {formatDurationMinutes(preview.durationMinutes)}</span>
              ) : null}
            </p>
            {preview.tooShort ? (
              <InlineAlert variant="warning" title="Shorter than the minimum">
                Shifts must be at least {SHIFT_LIMITS.minDurationMinutes} minutes. The API will
                reject this shift.
              </InlineAlert>
            ) : null}
            {preview.warnings.map((warning) => (
              <InlineAlert key={warning} variant="warning" title="Clock change on this date">
                {DST_WARNING_COPY[warning]}
              </InlineAlert>
            ))}
          </div>

          {/* Breaks */}
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-2">
              <Label className="flex items-center gap-2">
                <Coffee className="text-muted-foreground size-4" aria-hidden="true" />
                Scheduled breaks
              </Label>
              {!readOnly ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={breaks.fields.length >= SHIFT_LIMITS.maxScheduledBreaks}
                  onClick={() =>
                    breaks.append({ offsetMinutesFromStart: "240", durationMinutes: "30" })
                  }
                >
                  <Plus aria-hidden="true" />
                  Add break
                </Button>
              ) : null}
            </div>
            {breaks.fields.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                No scheduled breaks. Employees can still take breaks the Break Rules allow.
              </p>
            ) : (
              <ul className="space-y-2">
                {breaks.fields.map((item, index) => (
                  <li
                    key={item.id}
                    className="grid grid-cols-[1fr_1fr_auto] items-start gap-2 rounded-lg border p-3"
                  >
                    <FormField
                      control={form.control}
                      name={`scheduledBreaks.${index}.offsetMinutesFromStart`}
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-xs">Starts after (min)</FormLabel>
                          <FormControl>
                            <Input
                              inputMode="numeric"
                              {...field}
                              disabled={readOnly}
                              aria-label={`Break ${index + 1} starts after minutes`}
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    <FormField
                      control={form.control}
                      name={`scheduledBreaks.${index}.durationMinutes`}
                      render={({ field }) => (
                        <FormItem>
                          <FormLabel className="text-xs">Length (min)</FormLabel>
                          <FormControl>
                            <Input
                              inputMode="numeric"
                              {...field}
                              disabled={readOnly}
                              aria-label={`Break ${index + 1} length in minutes`}
                            />
                          </FormControl>
                          <FormMessage />
                        </FormItem>
                      )}
                    />
                    {!readOnly ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-sm"
                        className="mt-5"
                        aria-label={`Remove break ${index + 1}`}
                        onClick={() => breaks.remove(index)}
                      >
                        <X aria-hidden="true" />
                      </Button>
                    ) : (
                      <span />
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>

          {/* Notes */}
          <TextareaField
            control={form.control}
            name="notes"
            label="Notes"
            placeholder="Anything the employee should know (optional)"
            rows={3}
            disabled={readOnly}
          />

          <Separator />

          {/* Repeat */}
          {shift ? (
            <div className="space-y-3">
              <Label className="flex items-center gap-2">
                <Repeat className="text-muted-foreground size-4" aria-hidden="true" />
                Repeats
              </Label>
              <p className="text-sm">
                {describeRecurrenceRule(shift.recurrenceRule) ??
                  (shift.parentRecurrenceId ? "Part of a repeating series" : "Does not repeat")}
              </p>
              {inSeries && !readOnly ? (
                <RadioGroup
                  value={scope}
                  onValueChange={(value) => setScope(value === "future" ? "future" : "this")}
                  aria-label="Apply changes to"
                  className="gap-2"
                >
                  <label className="flex items-center gap-2 text-sm">
                    <RadioGroupItem value="this" /> This shift only
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <RadioGroupItem value="future" /> This and future shifts in the series
                  </label>
                </RadioGroup>
              ) : null}
            </div>
          ) : (
            <div className="space-y-4">
              <FormField
                control={form.control}
                name="repeat"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel className="flex items-center gap-2">
                      <Repeat className="text-muted-foreground size-4" aria-hidden="true" />
                      Repeat
                    </FormLabel>
                    <Select value={field.value} onValueChange={field.onChange} disabled={readOnly}>
                      <FormControl>
                        <SelectTrigger className="w-full" onBlur={field.onBlur} ref={field.ref}>
                          <SelectValue />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {REPEAT_OPTIONS.map((option) => (
                          <SelectItem key={option} value={option}>
                            {REPEAT_OPTION_LABELS[option]}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              {repeat === "weekly" ? (
                <FormField
                  control={form.control}
                  name="weekdays"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>On these days</FormLabel>
                      <FormControl>
                        <ToggleGroup
                          type="multiple"
                          variant="outline"
                          size="sm"
                          value={(field.value ?? []).filter(isWeekdayCode)}
                          onValueChange={(value) =>
                            field.onChange(
                              RECURRENCE_WEEKDAY_CODES.filter((code) => value.includes(code)),
                            )
                          }
                          aria-label="Weekdays"
                          className="flex-wrap"
                          disabled={readOnly}
                        >
                          {RECURRENCE_WEEKDAY_CODES.map((code) => (
                            <ToggleGroupItem
                              key={code}
                              value={code}
                              aria-label={WEEKDAY_LABELS[code].long}
                            >
                              {WEEKDAY_LABELS[code].short}
                            </ToggleGroupItem>
                          ))}
                        </ToggleGroup>
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              ) : null}
              {repeat === "custom" ? (
                <FormField
                  control={form.control}
                  name="customRule"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Rule (RFC 5545)</FormLabel>
                      <FormControl>
                        <Input
                          {...field}
                          placeholder="FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TU"
                          spellCheck={false}
                          disabled={readOnly}
                          className="font-mono text-sm"
                        />
                      </FormControl>
                      <FormDescription>
                        FREQ=DAILY, WEEKLY or MONTHLY with INTERVAL, BYDAY, BYMONTHDAY… The end date
                        is set below, not with UNTIL.
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              ) : null}
              {repeat !== "none" ? (
                <FormField
                  control={form.control}
                  name="until"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel htmlFor={untilId}>Repeat until</FormLabel>
                      <FormControl>
                        <Input id={untilId} type="date" {...field} disabled={readOnly} />
                      </FormControl>
                      <FormDescription>
                        Last date a shift in this series may start on. At most{" "}
                        {SHIFT_LIMITS.maxRecurrenceOccurrences} shifts are created.
                      </FormDescription>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              ) : null}
            </div>
          )}
        </div>

        <SheetFooter className="border-t px-6 py-4">
          {shift && !readOnly ? (
            <div className="flex flex-wrap items-center gap-2">
              <Popover
                open={duplicateOpen}
                onOpenChange={(next) => {
                  setDuplicateOpen(next);
                  if (!next) setDuplicateError(null);
                }}
              >
                <PopoverTrigger asChild>
                  <Button type="button" variant="outline" size="sm" disabled={pending}>
                    <Copy aria-hidden="true" />
                    Duplicate
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-72 space-y-3">
                  <div className="space-y-1">
                    <p className="text-sm font-medium">Copy this shift to another date</p>
                    <p className="text-muted-foreground text-xs">
                      Same times and breaks, in {formatTimeZoneLabel(shift.timezone)}.
                    </p>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor={`${idPrefix}-dup`}>Date</Label>
                    <Input
                      id={`${idPrefix}-dup`}
                      type="date"
                      value={duplicateDate}
                      onChange={(event) => setDuplicateDate(event.target.value)}
                    />
                  </div>
                  {duplicateError ? (
                    <InlineAlert variant="danger">
                      {hasErrorCode(duplicateError, "SHIFT_OVERLAP")
                        ? "The employee already has a shift at that time on that date."
                        : getErrorMessage(duplicateError)}
                    </InlineAlert>
                  ) : null}
                  <div className="flex justify-end gap-2">
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setDuplicateOpen(false)}
                    >
                      Close
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      onClick={() => void onDuplicate()}
                      disabled={
                        duplicateShift.isPending || !/^\d{4}-\d{2}-\d{2}$/.test(duplicateDate)
                      }
                    >
                      {duplicateShift.isPending ? (
                        <LoaderCircle className="animate-spin" aria-hidden="true" />
                      ) : (
                        <CalendarPlus aria-hidden="true" />
                      )}
                      Duplicate
                    </Button>
                  </div>
                </PopoverContent>
              </Popover>

              {shift.status === "SCHEDULED" ? (
                <ConfirmDialog
                  title={
                    scope === "future" && inSeries
                      ? "Cancel this and future shifts?"
                      : "Cancel this shift?"
                  }
                  description={
                    scope === "future" && inSeries
                      ? "Every shift in the series from this one onwards is cancelled. If one is in progress, Work Mode ends immediately."
                      : "The shift stays in the schedule as cancelled. If it is in progress, Work Mode ends immediately."
                  }
                  confirmLabel="Cancel shift"
                  cancelLabel="Keep shift"
                  destructive
                  onConfirm={() => runSeriesAction("CANCEL")}
                  onOpenChange={(open) => {
                    if (!open) setCancelReason("");
                  }}
                  trigger={
                    <Button type="button" variant="outline" size="sm" disabled={pending}>
                      <Ban aria-hidden="true" />
                      Cancel shift
                    </Button>
                  }
                >
                  <div className="space-y-1.5">
                    <Label htmlFor={`${idPrefix}-reason`}>Reason (optional)</Label>
                    <Textarea
                      id={`${idPrefix}-reason`}
                      value={cancelReason}
                      onChange={(event) => setCancelReason(event.target.value)}
                      maxLength={500}
                      rows={2}
                      placeholder="Shown in the audit log"
                    />
                  </div>
                </ConfirmDialog>
              ) : null}

              <ConfirmDialog
                title={
                  scope === "future" && inSeries
                    ? "Delete this and future shifts?"
                    : "Delete this shift?"
                }
                description="This permanently removes the shift. To keep a record, cancel it instead."
                confirmLabel="Delete"
                destructive
                onConfirm={() => runSeriesAction("DELETE")}
                trigger={
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="text-destructive hover:text-destructive"
                    disabled={pending}
                  >
                    <Trash2 aria-hidden="true" />
                    Delete
                  </Button>
                }
              />
            </div>
          ) : null}
          <div
            className={cn(
              "flex items-center justify-end gap-2",
              shift && !readOnly && "sm:ml-auto",
            )}
          >
            <Button type="button" variant="outline" onClick={onClose} disabled={pending}>
              {readOnly ? "Close" : "Discard"}
            </Button>
            {!readOnly ? (
              <SubmitButton isPending={pending} pendingLabel="Saving…">
                {shift
                  ? scope === "future" && inSeries
                    ? "Save this and future"
                    : "Save changes"
                  : repeat !== "none"
                    ? "Create series"
                    : "Create shift"}
              </SubmitButton>
            ) : null}
          </div>
        </SheetFooter>
      </form>
    </Form>
  );
}
