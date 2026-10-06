import type { Location } from "@workmode/validation/locationsTeams";
import { localDateSchema, localTimeSchema } from "@workmode/validation/primitives";
import {
  SHIFT_LIMITS,
  shiftOverlapDetailsSchema,
  updateShiftSchema,
  type CreateShiftByLocalTimeInput,
  type ScheduledBreakInput,
  type Shift,
  type ShiftUpdateScope,
} from "@workmode/validation/shifts";
import { BREAK_POLICY_LIMITS } from "@workmode/validation/breakPolicies";
import {
  buildShiftInstants,
  isValidTimeZone,
  type LocalDateString,
  type ShiftTimeWarning,
} from "@workmode/shared/time/time";
import { z } from "zod";
import {
  REPEAT_OPTIONS,
  buildRecurrenceRule,
  isWeekdayCode,
  type RepeatOption,
} from "./rrule-builder";
import { shiftLocalTimes } from "./schedule-model";

/**
 * The shift drawer's form: a Zod schema the form validates against on the client, converters to the API's
 * `CreateShiftByLocalTime` / `UpdateShift` inputs, and the live DST / overnight preview. Breaks are kept as
 * strings in the form so empty inputs stay empty instead of becoming `NaN`.
 */

export const NO_LOCATION = "";

/**
 * Request body for `PATCH /api/shifts/:id`. The schema's `notes` field is a `patchStringSchema` (a transform),
 * so `z.infer` makes the key mandatory in the OUTPUT type; what the client sends is the INPUT type.
 */
export type UpdateShiftBody = z.input<typeof updateShiftSchema>;

export interface SaveShiftOptions {
  /** Retry after SHIFT_OVERLAP: the manager accepted the double booking. */
  allowOverlap?: boolean;
  /** Members of a recurring series: apply to this shift only (default) or this and every later one. */
  applyTo?: ShiftUpdateScope;
}

const minutesString = (max: number, label: string) =>
  z
    .string()
    .trim()
    .regex(/^\d{1,4}$/, `${label} must be a whole number of minutes`)
    .refine((v) => Number(v) <= max, `${label} must be at most ${max} minutes`);

export const scheduledBreakFormSchema = z.object({
  offsetMinutesFromStart: minutesString(SHIFT_LIMITS.maxDurationMinutes, "Start offset"),
  durationMinutes: minutesString(BREAK_POLICY_LIMITS.maxBreakDurationMinutes, "Length").refine(
    (v) => Number(v) >= 1,
    "Length must be at least 1 minute",
  ),
});

export const shiftFormSchema = z
  .object({
    employeeId: z.string().min(1, "Choose an employee"),
    /** Location id, or `""` for none. */
    locationId: z.string(),
    date: localDateSchema,
    startTime: localTimeSchema,
    endTime: localTimeSchema,
    notes: z.string().max(1000, "Notes can be at most 1000 characters"),
    scheduledBreaks: z
      .array(scheduledBreakFormSchema)
      .max(SHIFT_LIMITS.maxScheduledBreaks, `At most ${SHIFT_LIMITS.maxScheduledBreaks} breaks`),
    repeat: z.enum(REPEAT_OPTIONS),
    weekdays: z.array(z.string()),
    customRule: z.string(),
    /** Last date of the series (`YYYY-MM-DD`), required when `repeat !== "none"`. */
    until: z.string(),
  })
  .superRefine((value, ctx) => {
    if (value.startTime === value.endTime) {
      ctx.addIssue({
        code: "custom",
        path: ["endTime"],
        message: "End time must differ from the start time (equal times would be a 24-hour shift)",
      });
    }
    if (value.repeat !== "none") {
      if (!value.until) {
        ctx.addIssue({
          code: "custom",
          path: ["until"],
          message: "Choose the last date of the series",
        });
      } else if (!localDateSchema.safeParse(value.until).success) {
        ctx.addIssue({ code: "custom", path: ["until"], message: "Enter a valid date" });
      } else if (value.until <= value.date) {
        ctx.addIssue({
          code: "custom",
          path: ["until"],
          message: "The series must end after the first shift",
        });
      }
      const rule = buildRecurrenceRule({
        repeat: value.repeat,
        weekdays: value.weekdays.filter(isWeekdayCode),
        customRule: value.customRule,
      });
      if (!rule.ok) {
        ctx.addIssue({
          code: "custom",
          path: [value.repeat === "weekly" ? "weekdays" : "customRule"],
          message: rule.error,
        });
      }
    }
  });

export type ShiftFormValues = z.infer<typeof shiftFormSchema>;

export interface ShiftFormDefaultsInput {
  employeeId?: string | null;
  locationId?: string | null;
  date: LocalDateString;
}

export function emptyShiftForm(input: ShiftFormDefaultsInput): ShiftFormValues {
  return {
    employeeId: input.employeeId ?? "",
    locationId: input.locationId ?? NO_LOCATION,
    date: input.date,
    startTime: "09:00",
    endTime: "17:00",
    notes: "",
    scheduledBreaks: [],
    repeat: "none",
    weekdays: [],
    customRule: "",
    until: "",
  };
}

/**
 * Form values for editing an existing shift (wall-clock times in the shift's own timezone). The repeat
 * controls are always "none": `PATCH /api/shifts/:id` cannot change a recurrence (the drawer shows the stored
 * rule read-only), and pre-filling them would make the never-rendered `until` field fail validation and
 * silently block saving a series anchor.
 */
export function shiftToFormValues(shift: Shift): ShiftFormValues {
  // The API echoes the local wall-clock values; recompute them from the instants only if they are missing.
  const times =
    shift.localDate && shift.localStartTime && shift.localEndTime
      ? { startDate: shift.localDate, startTime: shift.localStartTime, endTime: shift.localEndTime }
      : shiftLocalTimes(shift, shift.timezone);
  return {
    employeeId: shift.employee.id,
    locationId: shift.location?.id ?? NO_LOCATION,
    date: times.startDate,
    startTime: times.startTime,
    endTime: times.endTime,
    notes: shift.notes ?? "",
    scheduledBreaks: shift.scheduledBreaks.map((b) => ({
      offsetMinutesFromStart: String(b.offsetMinutesFromStart),
      durationMinutes: String(b.durationMinutes),
    })),
    repeat: "none",
    weekdays: [],
    customRule: "",
    until: "",
  };
}

function toBreakInputs(breaks: ShiftFormValues["scheduledBreaks"]): ScheduledBreakInput[] {
  return breaks.map((b) => ({
    offsetMinutesFromStart: Number(b.offsetMinutesFromStart),
    durationMinutes: Number(b.durationMinutes),
  }));
}

/** `POST /api/shifts` body (local-time form). The timezone is left to the API: location → organisation. */
export function toCreateShiftInput(
  values: ShiftFormValues,
  options: SaveShiftOptions = {},
): CreateShiftByLocalTimeInput {
  const input: CreateShiftByLocalTimeInput = {
    employeeId: values.employeeId,
    date: values.date,
    startTime: values.startTime,
    endTime: values.endTime,
  };
  if (options.allowOverlap) input.allowOverlap = true;
  if (values.locationId) input.locationId = values.locationId;
  const notes = values.notes.trim();
  if (notes) input.notes = notes;
  if (values.scheduledBreaks.length > 0)
    input.scheduledBreaks = toBreakInputs(values.scheduledBreaks);
  if (values.repeat !== "none") {
    const rule = buildRecurrenceRule({
      repeat: values.repeat,
      weekdays: values.weekdays.filter(isWeekdayCode),
      customRule: values.customRule,
    });
    if (rule.ok && rule.rule) input.recurrence = { rule: rule.rule, until: values.until };
  }
  return input;
}

/**
 * `PATCH /api/shifts/:id` body for the edited shift. Every editable field is sent (the form always shows
 * them all) together with `expectedVersion` for optimistic concurrency. `timezone` is the shift's own zone
 * so the wall-clock values keep meaning what the form showed. With `applyTo: "THIS_AND_FUTURE"` the server
 * applies the same change to every later occurrence of the series (each keeps its own date).
 */
export function toUpdateShiftInput(
  values: ShiftFormValues,
  shift: Shift,
  options: SaveShiftOptions = {},
): UpdateShiftBody {
  const notes = values.notes.trim();
  const body: UpdateShiftBody = {
    locationId: values.locationId ? values.locationId : null,
    date: values.date,
    startTime: values.startTime,
    endTime: values.endTime,
    timezone: shift.timezone,
    notes: notes ? notes : null,
    scheduledBreaks: toBreakInputs(values.scheduledBreaks),
    expectedVersion: shift.version,
  };
  if (options.applyTo && options.applyTo !== "THIS") body.applyTo = options.applyTo;
  if (options.allowOverlap) body.allowOverlap = true;
  return body;
}

export interface ShiftTimePreview {
  /** True when `endTime <= startTime` (the shift ends on the next local day). */
  overnight: boolean;
  /** Elapsed minutes once DST is applied, or null when the inputs are incomplete/invalid. */
  durationMinutes: number | null;
  /** Shorter than the API minimum (SHIFT_TOO_SHORT would be returned). */
  tooShort: boolean;
  warnings: ShiftTimeWarning[];
  /** Zone the preview was computed in. */
  timezone: string;
}

export const DST_WARNING_COPY: Record<ShiftTimeWarning, string> = {
  START_NONEXISTENT_LOCAL_TIME_SHIFTED:
    "The start time doesn't exist on this date (clocks go forward), so the shift will start at the next valid time.",
  START_AMBIGUOUS_LOCAL_TIME_FIRST_OCCURRENCE:
    "The start time happens twice on this date (clocks go back); the first occurrence will be used.",
  END_NONEXISTENT_LOCAL_TIME_SHIFTED:
    "The end time doesn't exist on this date (clocks go forward), so the shift will end at the next valid time.",
  END_AMBIGUOUS_LOCAL_TIME_FIRST_OCCURRENCE:
    "The end time happens twice on this date (clocks go back); the first occurrence will be used.",
};

/** Resolves the timezone the form's wall-clock values are entered in: location → organisation. */
export function formTimezone(
  locationId: string,
  locations: readonly Pick<Location, "id" | "timezone">[],
  organisationTimezone: string,
): string {
  const location = locationId ? locations.find((l) => l.id === locationId) : undefined;
  const candidate = location?.timezone ?? organisationTimezone;
  return isValidTimeZone(candidate) ? candidate : organisationTimezone;
}

/** Live preview of what the typed times mean (overnight, DST adjustments, length). */
export function previewShiftTimes(
  values: Pick<ShiftFormValues, "date" | "startTime" | "endTime">,
  timezone: string,
): ShiftTimePreview {
  const base: ShiftTimePreview = {
    overnight: false,
    durationMinutes: null,
    tooShort: false,
    warnings: [],
    timezone,
  };
  if (!localDateSchema.safeParse(values.date).success) return base;
  if (
    !localTimeSchema.safeParse(values.startTime).success ||
    !localTimeSchema.safeParse(values.endTime).success
  )
    return base;
  if (!isValidTimeZone(timezone)) return base;
  try {
    const built = buildShiftInstants({
      date: values.date,
      startTime: values.startTime,
      endTime: values.endTime,
      timezone,
    });
    return {
      overnight: built.isOvernight,
      durationMinutes: built.durationMinutes,
      tooShort: built.durationMinutes < SHIFT_LIMITS.minDurationMinutes,
      warnings: built.warnings,
      timezone,
    };
  } catch {
    return { ...base, overnight: values.endTime <= values.startTime };
  }
}

/** Shape of the optional `warnings` array a create/update response may carry; unknown shapes are ignored. */
export function readResponseWarnings(payload: unknown): string[] {
  if (typeof payload !== "object" || payload === null) return [];
  const warnings = (payload as { warnings?: unknown }).warnings;
  if (!Array.isArray(warnings)) return [];
  return warnings
    .map((w) =>
      typeof w === "string"
        ? w
        : typeof w === "object" &&
            w !== null &&
            typeof (w as { message?: unknown }).message === "string"
          ? (w as { message: string }).message
          : null,
    )
    .filter((w): w is string => w !== null);
}

/**
 * Ids of the shifts a SHIFT_OVERLAP error collided with (`details.conflictingShiftIds`, see
 * `shiftOverlapDetailsSchema`). An unexpected `details` shape yields an empty list, never a crash.
 */
export function readOverlapConflictIds(details: unknown): string[] {
  const parsed = shiftOverlapDetailsSchema.safeParse(details);
  return parsed.success ? parsed.data.conflictingShiftIds : [];
}

export interface ConflictingShiftRef {
  id: string;
  /** The shift when it is already loaded on the page, so its times can be shown. */
  shift: Shift | null;
}

export function resolveConflicts(
  ids: readonly string[],
  known: readonly Shift[],
): ConflictingShiftRef[] {
  return ids.map((id) => ({ id, shift: known.find((s) => s.id === id) ?? null }));
}

/** Local day difference between two `YYYY-MM-DD` dates (positive when `to` is later). */
export function daysBetweenLocalDates(from: LocalDateString, to: LocalDateString): number {
  const ms = (d: string) =>
    Date.UTC(Number(d.slice(0, 4)), Number(d.slice(5, 7)) - 1, Number(d.slice(8, 10)));
  return Math.round((ms(to) - ms(from)) / 86_400_000);
}

export type RepeatOptionValue = RepeatOption;
