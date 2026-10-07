import {
  RECURRENCE_WEEKDAY_CODES,
  validateRecurrenceRule,
  type RecurrenceWeekdayCode,
} from "@clockoff/shared/time/time";

/**
 * Turns the drawer's "Repeat" controls into the RFC 5545 RRULE body the API expects (`FREQ=…;BYDAY=…`,
 * never UNTIL/COUNT — the end date travels separately as `until`), and describes stored rules in plain
 * English. Pure, so it is unit-tested in node.
 */

export const REPEAT_OPTIONS = ["none", "daily", "weekly", "custom"] as const;
export type RepeatOption = (typeof REPEAT_OPTIONS)[number];

export const REPEAT_OPTION_LABELS: Record<RepeatOption, string> = {
  none: "Does not repeat",
  daily: "Every day",
  weekly: "Every week on selected days",
  custom: "Custom (RRULE)",
};

export const WEEKDAY_LABELS: Record<RecurrenceWeekdayCode, { short: string; long: string }> = {
  MO: { short: "Mon", long: "Monday" },
  TU: { short: "Tue", long: "Tuesday" },
  WE: { short: "Wed", long: "Wednesday" },
  TH: { short: "Thu", long: "Thursday" },
  FR: { short: "Fri", long: "Friday" },
  SA: { short: "Sat", long: "Saturday" },
  SU: { short: "Sun", long: "Sunday" },
};

export interface RecurrenceOptions {
  repeat: RepeatOption;
  /** Weekly only. */
  weekdays: readonly RecurrenceWeekdayCode[];
  /** Custom only: raw RRULE text typed by the manager. */
  customRule: string;
}

export type BuildRuleResult = { ok: true; rule: string | null } | { ok: false; error: string };

export function isWeekdayCode(value: unknown): value is RecurrenceWeekdayCode {
  return (
    typeof value === "string" && (RECURRENCE_WEEKDAY_CODES as readonly string[]).includes(value)
  );
}

/** Sorts weekday codes Monday → Sunday and drops duplicates. */
export function normaliseWeekdays(
  weekdays: readonly RecurrenceWeekdayCode[],
): RecurrenceWeekdayCode[] {
  return RECURRENCE_WEEKDAY_CODES.filter((code) => weekdays.includes(code));
}

/**
 * Builds the rule for the create-shift request. `null` means "no recurrence". Custom text is validated with
 * the same parser the server uses and returned in its canonical form; UNTIL/COUNT are rejected because the
 * series end is the separate `until` date.
 */
export function buildRecurrenceRule(options: RecurrenceOptions): BuildRuleResult {
  switch (options.repeat) {
    case "none":
      return { ok: true, rule: null };
    case "daily":
      return { ok: true, rule: "FREQ=DAILY" };
    case "weekly": {
      const days = normaliseWeekdays(options.weekdays);
      if (days.length === 0) return { ok: false, error: "Choose at least one weekday" };
      return { ok: true, rule: `FREQ=WEEKLY;BYDAY=${days.join(",")}` };
    }
    case "custom": {
      const text = options.customRule.trim().replace(/^RRULE:/i, "");
      if (!text)
        return { ok: false, error: "Enter a repeat rule, e.g. FREQ=WEEKLY;INTERVAL=2;BYDAY=MO" };
      if (/(^|;)(UNTIL|COUNT)=/i.test(text)) {
        return {
          ok: false,
          error: "Set the end with the 'Repeat until' date instead of UNTIL or COUNT",
        };
      }
      const result = validateRecurrenceRule(text);
      if (!result.ok) return { ok: false, error: result.error };
      if (result.parsed.count !== null) {
        return { ok: false, error: "Set the end with the 'Repeat until' date instead of COUNT" };
      }
      return { ok: true, rule: result.normalised };
    }
  }
}

/** Best-effort inverse of `buildRecurrenceRule`, for pre-filling the controls from a stored rule. */
export function recurrenceOptionsFromRule(rule: string | null | undefined): RecurrenceOptions {
  if (!rule) return { repeat: "none", weekdays: [], customRule: "" };
  const result = validateRecurrenceRule(rule);
  if (!result.ok) return { repeat: "custom", weekdays: [], customRule: rule };
  const { parsed } = result;
  const simple =
    parsed.interval === 1 &&
    parsed.count === null &&
    parsed.byMonth.length === 0 &&
    parsed.byMonthDay.length === 0 &&
    parsed.bySetPos.length === 0;
  if (simple && parsed.freq === "DAILY" && parsed.byDay.length === 0) {
    return { repeat: "daily", weekdays: [], customRule: "" };
  }
  if (
    simple &&
    parsed.freq === "WEEKLY" &&
    parsed.byDay.length > 0 &&
    parsed.byDay.every((d) => d.ordinal === undefined)
  ) {
    const weekdays = parsed.byDay
      .map((d) => RECURRENCE_WEEKDAY_CODES[d.weekday - 1])
      .filter(isWeekdayCode);
    return { repeat: "weekly", weekdays: normaliseWeekdays(weekdays), customRule: "" };
  }
  return { repeat: "custom", weekdays: [], customRule: result.normalised };
}

function listWeekdays(codes: readonly RecurrenceWeekdayCode[]): string {
  return codes.map((code) => WEEKDAY_LABELS[code].short).join(", ");
}

/**
 * Plain-English summary of a stored rule: `Every day`, `Every week on Mon, Wed`, `Every 2 weeks on Fri`,
 * `Every month`; falls back to the rule text for anything more exotic.
 */
export function describeRecurrenceRule(rule: string | null | undefined): string | null {
  if (!rule) return null;
  const result = validateRecurrenceRule(rule);
  if (!result.ok) return rule;
  const { parsed } = result;
  const unit = parsed.freq === "DAILY" ? "day" : parsed.freq === "WEEKLY" ? "week" : "month";
  const every = parsed.interval === 1 ? `Every ${unit}` : `Every ${parsed.interval} ${unit}s`;
  const plainWeekdays = parsed.byDay
    .filter((d) => d.ordinal === undefined)
    .map((d) => RECURRENCE_WEEKDAY_CODES[d.weekday - 1])
    .filter(isWeekdayCode);
  const ordinalDays = parsed.byDay.filter((d) => d.ordinal !== undefined);
  if (
    parsed.byMonth.length > 0 ||
    parsed.byMonthDay.length > 0 ||
    parsed.bySetPos.length > 0 ||
    ordinalDays.length > 0
  ) {
    return result.normalised;
  }
  const on =
    plainWeekdays.length > 0 ? ` on ${listWeekdays(normaliseWeekdays(plainWeekdays))}` : "";
  return `${every}${on}`;
}
