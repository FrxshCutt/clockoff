import {
  TEST_SHIFT_LIMITS,
  testShiftWindow,
  type CreateTestShiftInput,
} from "@clockoff/validation/testTools";

/** Every user-facing string of the "Create test shift…" tool (quoted by docs/DEVICE_TESTING.md). */
export const TEST_SHIFT_COPY = {
  action: "Create test shift…",
  title: "Create test shift",
  description:
    "A real shift for checking Work Mode on a phone. It is scheduled like any other shift: the phone receives it on its next sync and it shows on the schedule.",
  employeeLabel: "Employee",
  employeePlaceholder: "Choose an employee",
  startsInLabel: "Starts in (minutes)",
  durationLabel: "Lasts (minutes)",
  note: `Apple requires at least ${TEST_SHIFT_LIMITS.minDurationMinutes} minutes; leave time for the phone to sync before it starts.`,
  submit: "Create test shift",
  pending: "Creating…",
  cancel: "Cancel",
  errorTitle: "Couldn't create the test shift",
  successTitle: "Test shift created",
} as const;

export interface TestShiftFormValues {
  employeeId: string | null;
  /** Raw text of the "Starts in (minutes)" field. */
  startsIn: string;
  /** Raw text of the "Lasts (minutes)" field. */
  duration: string;
}

export type TestShiftField = "employee" | "startsIn" | "duration";

export type TestShiftFormResult =
  { ok: true; input: CreateTestShiftInput } | { ok: false; field: TestShiftField; message: string };

export const DEFAULT_TEST_SHIFT_VALUES: Omit<TestShiftFormValues, "employeeId"> = {
  startsIn: String(TEST_SHIFT_LIMITS.defaultStartsInMinutes),
  duration: String(TEST_SHIFT_LIMITS.defaultDurationMinutes),
};

function wholeMinutes(raw: string): number | null {
  const trimmed = raw.trim();
  return /^\d{1,4}$/.test(trimmed) ? Number(trimmed) : null;
}

/** Validates the dialog's fields with the same limits as the API (`createTestShiftSchema`). */
export function buildTestShiftInput(values: TestShiftFormValues): TestShiftFormResult {
  if (!values.employeeId) {
    return { ok: false, field: "employee", message: "Choose an employee." };
  }
  const startsInMinutes = wholeMinutes(values.startsIn);
  if (
    startsInMinutes === null ||
    startsInMinutes < TEST_SHIFT_LIMITS.minStartsInMinutes ||
    startsInMinutes > TEST_SHIFT_LIMITS.maxStartsInMinutes
  ) {
    return {
      ok: false,
      field: "startsIn",
      message: `Enter a whole number of minutes from ${TEST_SHIFT_LIMITS.minStartsInMinutes} to ${TEST_SHIFT_LIMITS.maxStartsInMinutes}.`,
    };
  }
  const durationMinutes = wholeMinutes(values.duration);
  if (durationMinutes !== null && durationMinutes < TEST_SHIFT_LIMITS.minDurationMinutes) {
    return {
      ok: false,
      field: "duration",
      message: `Apple requires at least ${TEST_SHIFT_LIMITS.minDurationMinutes} minutes.`,
    };
  }
  if (durationMinutes === null || durationMinutes > TEST_SHIFT_LIMITS.maxDurationMinutes) {
    return {
      ok: false,
      field: "duration",
      message: `Enter a whole number of minutes from ${TEST_SHIFT_LIMITS.minDurationMinutes} to ${TEST_SHIFT_LIMITS.maxDurationMinutes}.`,
    };
  }
  return { ok: true, input: { employeeId: values.employeeId, startsInMinutes, durationMinutes } };
}

/** The window the server will create if the form is submitted at `now` (null while a field is invalid). */
export function previewTestShift(
  values: Omit<TestShiftFormValues, "employeeId">,
  now: Date,
): { startsAt: Date; endsAt: Date } | null {
  const built = buildTestShiftInput({ ...values, employeeId: "preview" });
  return built.ok ? testShiftWindow(built.input, now) : null;
}

/** Success toast body: who, when (the shift's own display range, in its timezone) and what to do next. */
export function testShiftSuccessDescription(employeeName: string, displayRange: string): string {
  return `${employeeName}, ${displayRange}. Sync ClockOff on the phone before it starts.`;
}
