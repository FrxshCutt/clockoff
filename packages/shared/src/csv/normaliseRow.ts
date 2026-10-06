/**
 * Turns a raw CSV row into typed values plus UTC instants, reporting every problem instead of guessing.
 * Times are wall-clock times in `options.timezone`; the result carries UTC instants (ISO strings, Z).
 */
import { AppError } from "../errors";
import { invertMapping } from "./headerMapping";
import type { CsvRow } from "./parseCsv";
import {
  addCalendarDays,
  isValidTimezone,
  parseImportDate,
  parseImportTime,
  toUtcInstant,
} from "./parseDateTime";
import {
  EMPLOYEE_IDENTIFIER_FIELDS,
  IMPORT_FIELD_INFO,
  IMPORT_LIMITS,
  REQUIRED_IMPORT_FIELDS,
  problem,
  type ColumnMapping,
  type ImportField,
  type ImportProblem,
  type NormaliseRowOptions,
  type NormalisedRow,
  type ParsedShiftRow,
} from "./types";

export interface NormaliseRowResult {
  parsed: ParsedShiftRow;
  problems: ImportProblem[];
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BREAK_RE = /^(\d{1,3})\s*(m|min|mins|minute|minutes)?$/i;

/** Lower-cased, trimmed email or null when malformed. */
export function normaliseEmail(value: string): string | null {
  const v = value.trim().toLowerCase();
  return EMAIL_RE.test(v) ? v : null;
}

/** "30", "30 mins", "30m" → 30. Empty → undefined. Anything else → null. */
export function parseBreakMinutes(value: string): number | null | undefined {
  const v = value.trim();
  if (v === "") return undefined;
  const m = BREAK_RE.exec(v);
  return m ? Number(m[1]) : null;
}

/**
 * Parses one row. `raw` is keyed by CSV header; `mapping` says which header feeds which field (the first
 * header mapped to a field wins). Throws AppError(INVALID_TIMEZONE) for a bad `options.timezone`, since
 * that is a configuration error rather than a data problem.
 */
export function normaliseRow(
  raw: Readonly<Record<string, string>>,
  mapping: ColumnMapping,
  options: NormaliseRowOptions,
): NormaliseRowResult {
  if (!isValidTimezone(options.timezone)) {
    throw new AppError("INVALID_TIMEZONE", `"${options.timezone}" is not a valid IANA timezone.`);
  }

  const headerFor = invertMapping(mapping);
  const cell = (field: ImportField): string | undefined => {
    const header = headerFor[field];
    // Own properties only: a mapping naming a header the row does not have ("toString", "constructor")
    // must read as an empty cell, not as an inherited Object.prototype member.
    if (header === undefined || !Object.hasOwn(raw, header)) return undefined;
    const value: unknown = raw[header];
    const trimmed = typeof value === "string" ? value.trim() : "";
    return trimmed === "" ? undefined : trimmed;
  };

  const problems: ImportProblem[] = [];
  const parsed: ParsedShiftRow = { timezone: options.timezone, overnight: false };

  // ── Required fields ────────────────────────────────────────────────────────────────────────────
  for (const field of REQUIRED_IMPORT_FIELDS) {
    if (cell(field) === undefined) {
      const mapped = headerFor[field] !== undefined;
      problems.push(
        problem(
          "MISSING_REQUIRED_FIELD",
          mapped
            ? `${IMPORT_FIELD_INFO[field].label} is empty.`
            : `No column is mapped to ${IMPORT_FIELD_INFO[field].label}.`,
          { field },
        ),
      );
    }
  }
  if (!EMPLOYEE_IDENTIFIER_FIELDS.some((f) => cell(f) !== undefined)) {
    problems.push(
      problem(
        "MISSING_REQUIRED_FIELD",
        "An employee identifier is required: employee ID, email or employee name.",
        {
          field: "employee_name",
        },
      ),
    );
  }

  // ── Identifiers ────────────────────────────────────────────────────────────────────────────────
  const name = cell("employee_name");
  if (name !== undefined) parsed.employeeName = name.replace(/\s+/g, " ");
  const externalId = cell("employee_id");
  if (externalId !== undefined) parsed.employeeExternalId = externalId;
  const emailRaw = cell("email");
  if (emailRaw !== undefined) {
    const email = normaliseEmail(emailRaw);
    if (email === null) {
      problems.push(
        problem(
          "INVALID_EMAIL",
          `"${emailRaw}" is not a valid email address; it was not used for matching.`,
          { field: "email" },
        ),
      );
    } else {
      parsed.email = email;
    }
  }

  // ── Date and times ─────────────────────────────────────────────────────────────────────────────
  const dateRaw = cell("date");
  let isoDate: string | undefined;
  if (dateRaw !== undefined) {
    const r = parseImportDate(dateRaw, options.dateFormat);
    if (r.ok) {
      isoDate = r.isoDate;
      parsed.date = r.isoDate;
    } else {
      problems.push(problem("INVALID_DATE", r.message, { field: "date" }));
    }
  }

  const startRaw = cell("start_time");
  let startMinutes: number | undefined;
  if (startRaw !== undefined) {
    const r = parseImportTime(startRaw);
    if (r.ok && r.minutes >= 1440) {
      // "24:00" is only meaningful as an end time.
      problems.push(
        problem("INVALID_TIME", `"${startRaw}" cannot be used as a start time; use 00:00.`, {
          field: "start_time",
        }),
      );
    } else if (r.ok) {
      startMinutes = r.minutes;
      parsed.startTime = r.hhmm;
    } else {
      problems.push(problem("INVALID_TIME", r.message, { field: "start_time" }));
    }
  }

  const endRaw = cell("end_time");
  let endMinutes: number | undefined;
  if (endRaw !== undefined) {
    const r = parseImportTime(endRaw);
    if (r.ok) {
      endMinutes = r.minutes;
      parsed.endTime = r.hhmm;
    } else {
      problems.push(problem("INVALID_TIME", r.message, { field: "end_time" }));
    }
  }

  if (isoDate !== undefined && startMinutes !== undefined && endMinutes !== undefined) {
    const start = toUtcInstant(isoDate, startMinutes, options.timezone);
    let endDate = isoDate;
    if (endMinutes <= startMinutes) {
      endDate = addCalendarDays(isoDate, 1);
      parsed.overnight = true;
      problems.push(
        problem(
          "OVERNIGHT_SHIFT",
          `End time ${parsed.endTime} is not after start time ${parsed.startTime}; the shift is treated as ending on ${endDate}.`,
          { field: "end_time", details: { endDate } },
        ),
      );
    }
    const end = toUtcInstant(endDate, endMinutes, options.timezone);
    if (start.adjusted) {
      problems.push(
        problem(
          "DST_ADJUSTED_TIME",
          `${parsed.startTime} does not exist on ${isoDate} in ${options.timezone} (clocks go forward); the shift starts at the next valid time.`,
          { field: "start_time" },
        ),
      );
    }
    if (end.adjusted) {
      problems.push(
        problem(
          "DST_ADJUSTED_TIME",
          `${parsed.endTime} does not exist on ${endDate} in ${options.timezone} (clocks go forward); the shift ends at the next valid time.`,
          { field: "end_time" },
        ),
      );
    }
    if (start.ambiguous) {
      problems.push(
        problem(
          "DST_AMBIGUOUS_TIME",
          `${parsed.startTime} happens twice on ${isoDate} in ${options.timezone} (clocks go back); the first occurrence was used.`,
          { field: "start_time" },
        ),
      );
    }
    if (end.ambiguous) {
      problems.push(
        problem(
          "DST_AMBIGUOUS_TIME",
          `${parsed.endTime} happens twice on ${endDate} in ${options.timezone} (clocks go back); the first occurrence was used.`,
          { field: "end_time" },
        ),
      );
    }
    parsed.startsAt = start.iso;
    parsed.endsAt = end.iso;
  }

  // ── Optional fields ────────────────────────────────────────────────────────────────────────────
  const location = cell("location") ?? options.defaultLocationName?.trim();
  if (location !== undefined && location !== "") parsed.locationName = location;
  const department = cell("department");
  if (department !== undefined) parsed.departmentName = department;
  const role = cell("role");
  if (role !== undefined) parsed.role = role;

  const breakRaw = cell("break_minutes");
  if (breakRaw !== undefined) {
    const minutes = parseBreakMinutes(breakRaw);
    const shiftMinutes =
      parsed.startsAt !== undefined && parsed.endsAt !== undefined
        ? (Date.parse(parsed.endsAt) - Date.parse(parsed.startsAt)) / 60_000
        : undefined;
    if (minutes === null) {
      problems.push(
        problem("INVALID_BREAK_MINUTES", `"${breakRaw}" is not a whole number of minutes.`, {
          field: "break_minutes",
        }),
      );
    } else if (minutes !== undefined && minutes > IMPORT_LIMITS.maxBreakMinutes) {
      problems.push(
        problem(
          "INVALID_BREAK_MINUTES",
          `A ${minutes}-minute break is longer than the ${IMPORT_LIMITS.maxBreakMinutes}-minute maximum.`,
          {
            field: "break_minutes",
            details: { breakMinutes: minutes, maxBreakMinutes: IMPORT_LIMITS.maxBreakMinutes },
          },
        ),
      );
    } else if (
      minutes !== undefined &&
      shiftMinutes !== undefined &&
      minutes > 0 &&
      minutes >= shiftMinutes
    ) {
      problems.push(
        problem(
          "INVALID_BREAK_MINUTES",
          `A ${minutes}-minute break does not fit in a ${shiftMinutes}-minute shift.`,
          {
            field: "break_minutes",
            details: { breakMinutes: minutes, shiftMinutes },
          },
        ),
      );
    } else if (minutes !== undefined) {
      parsed.breakMinutes = minutes;
    }
  }

  return { parsed, problems };
}

/** Convenience: `parseCsv().records` → NormalisedRow[] (row numbers and structural row problems are carried over). */
export function normaliseRows(
  rows: readonly CsvRow[],
  mapping: ColumnMapping,
  options: NormaliseRowOptions,
): NormalisedRow[] {
  return rows.map((row) => {
    const { parsed, problems } = normaliseRow(row.values, mapping, options);
    return {
      rowNumber: row.rowNumber,
      raw: { ...row.values },
      parsed,
      problems: [...row.problems, ...problems],
    };
  });
}
