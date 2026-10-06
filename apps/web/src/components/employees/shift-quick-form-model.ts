import { localDateSchema, localTimeSchema } from "@workmode/validation/primitives";
import { createShiftSchema, type CreateShiftByLocalTimeInput } from "@workmode/validation/shifts";
import { z } from "zod";

/**
 * "Add shift" quick form on the employee detail page: date + wall-clock start/end (+ optional location and
 * notes), sent as the local-time form of `POST /api/shifts`. `endTime <= startTime` means an overnight shift.
 */
export const shiftQuickFormSchema = z
  .object({
    date: z.string().min(1, "Choose a date").pipe(localDateSchema),
    startTime: z.string().min(1, "Choose a start time").pipe(localTimeSchema),
    endTime: z.string().min(1, "Choose an end time").pipe(localTimeSchema),
    /** "" = use the employee's primary location / none. */
    locationId: z.string(),
    notes: z.string().trim().max(1000, "Keep notes under 1000 characters"),
  })
  .refine((v) => v.startTime !== v.endTime, {
    path: ["endTime"],
    message: "The end time must differ from the start time",
  });
export type ShiftQuickFormValues = z.infer<typeof shiftQuickFormSchema>;

/** `YYYY-MM-DD` for `now` in `timeZone` (what the date input defaults to). */
export function todayInZone(now: Date, timeZone: string): string {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(now);
  } catch {
    return now.toISOString().slice(0, 10);
  }
}

export function defaultShiftQuickFormValues(
  now: Date,
  timeZone: string,
  locationId: string | null = null,
): ShiftQuickFormValues {
  return {
    date: todayInZone(now, timeZone),
    startTime: "09:00",
    endTime: "17:00",
    locationId: locationId ?? "",
    notes: "",
  };
}

/** Whether the wall-clock range crosses midnight (shown as a hint under the end time). */
export function isOvernightRange(startTime: string, endTime: string): boolean {
  return (
    /^\d{2}:\d{2}$/.test(startTime) &&
    /^\d{2}:\d{2}$/.test(endTime) &&
    endTime <= startTime &&
    startTime !== endTime
  );
}

export function toCreateShiftInput(
  values: ShiftQuickFormValues,
  employeeId: string,
): CreateShiftByLocalTimeInput {
  const body: CreateShiftByLocalTimeInput = {
    employeeId,
    date: values.date,
    startTime: values.startTime,
    endTime: values.endTime,
    ...(values.locationId ? { locationId: values.locationId } : {}),
    ...(values.notes.trim() ? { notes: values.notes.trim() } : {}),
  };
  return createShiftSchema.parse(body) as CreateShiftByLocalTimeInput;
}
