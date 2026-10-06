/**
 * Cross-row and database-aware validation: duplicates, overlaps, unknown locations, minimum length.
 * Pure — the caller loads the employee's existing shifts and the organisation's locations.
 */
import {
  IMPORT_LIMITS,
  problem,
  type ImportProblem,
  type ImportRowStatus,
  type NormalisedRow,
  type ParsedShiftRow,
  type ValidatedRow,
} from "./types";

/** A shift already in the database, as `validateRows` needs it. Prisma `Date`s are accepted as-is. */
export interface ImportExistingShift {
  id?: string;
  employeeId: string;
  startsAt: string | Date;
  endsAt: string | Date;
}

export interface ValidateRowsContext {
  /**
   * Live shifts (not cancelled, not soft-deleted) for the employees in the file that overlap
   * `importShiftWindow(rows)`. Shifts outside the window are harmless but unnecessary.
   */
  existingShifts: readonly ImportExistingShift[];
  /** Location names in the organisation; compared case/whitespace-insensitively. */
  knownLocations: readonly string[];
  /** Minimum shift length in minutes (default IMPORT_LIMITS.minShiftMinutes = 15). */
  minShiftMinutes?: number;
  /** Maximum shift length in minutes (default IMPORT_LIMITS.maxShiftMinutes = 1440). */
  maxShiftMinutes?: number;
  /** When provided, shifts that end at or before this instant get a SHIFT_IN_PAST warning. */
  now?: string | Date;
}

function ms(value: string | Date): number {
  return typeof value === "string" ? Date.parse(value) : value.getTime();
}

/** Half-open interval overlap on epoch ms: [aStart, aEnd) ∩ [bStart, bEnd) ≠ ∅. Touching shifts do not overlap. */
export function intervalsOverlap(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number,
): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/** ERROR if any error; else SKIPPED if a duplicate; else WARNING if any warning; else VALID. */
export function importRowStatus(problems: readonly ImportProblem[]): ImportRowStatus {
  if (problems.some((p) => p.severity === "ERROR")) return "ERROR";
  if (problems.some((p) => p.code === "DUPLICATE_SHIFT")) return "SKIPPED";
  if (problems.some((p) => p.severity === "WARNING")) return "WARNING";
  return "VALID";
}

/** Case-, width- and whitespace-insensitive comparison key for free text (location names, roles, ...). */
function textKey(name: string): string {
  return name.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

/**
 * Everything on a row besides employee and times. Two rows of the same file are duplicates only when this
 * matches too: rows with equal times but a different location, department, role or break contradict each
 * other, and picking one of them would be a guess, so they are reported as overlapping instead.
 */
function shiftDetailsKey(parsed: ParsedShiftRow): string {
  const text = (value: string | undefined): string | null =>
    value === undefined ? null : textKey(value);
  return JSON.stringify([
    text(parsed.locationName),
    text(parsed.departmentName),
    text(parsed.role),
    parsed.breakMinutes ?? 0,
  ]);
}

function formatInstant(iso: string | Date): string {
  const d = typeof iso === "string" ? new Date(iso) : iso;
  return d.toISOString().replace(".000Z", "Z");
}

interface Timed {
  index: number;
  employeeId: string;
  start: number;
  end: number;
}

export interface ImportShiftWindow {
  /** Distinct matched employee ids, in first-seen order. */
  employeeIds: string[];
  /** Earliest row start (ISO, UTC). Load existing shifts with `endsAt > from`. */
  from: string;
  /** Latest row end (ISO, UTC). Load existing shifts with `startsAt < to`. */
  to: string;
}

/**
 * What the caller must load from the database before `validateRows`: existing shifts of these employees
 * that overlap [from, to). Null when no row has both a matched employee and parsed instants.
 */
export function importShiftWindow(rows: readonly NormalisedRow[]): ImportShiftWindow | null {
  const employeeIds: string[] = [];
  const seen = new Set<string>();
  let from = Infinity;
  let to = -Infinity;
  for (const row of rows) {
    if (
      row.employeeId == null ||
      row.parsed.startsAt === undefined ||
      row.parsed.endsAt === undefined
    )
      continue;
    if (!seen.has(row.employeeId)) {
      seen.add(row.employeeId);
      employeeIds.push(row.employeeId);
    }
    from = Math.min(from, ms(row.parsed.startsAt));
    to = Math.max(to, ms(row.parsed.endsAt));
  }
  if (employeeIds.length === 0) return null;
  return { employeeIds, from: new Date(from).toISOString(), to: new Date(to).toISOString() };
}

/**
 * Annotates rows with cross-row and database problems and assigns a status. Rows are expected to have
 * been through `normaliseRows` and `matchRows` (rows without an employee or instants keep their problems
 * and skip the time-based checks). Returns new objects; the input is not mutated.
 */
export function validateRows(
  rows: readonly NormalisedRow[],
  context: ValidateRowsContext,
): ValidatedRow[] {
  const minShiftMinutes = context.minShiftMinutes ?? IMPORT_LIMITS.minShiftMinutes;
  const maxShiftMinutes = context.maxShiftMinutes ?? IMPORT_LIMITS.maxShiftMinutes;
  const nowMs = context.now !== undefined ? ms(context.now) : undefined;
  const knownLocationKeys = new Set(context.knownLocations.map(textKey));

  const existingByEmployee = new Map<string, Array<{ id?: string; start: number; end: number }>>();
  for (const s of context.existingShifts) {
    const list = existingByEmployee.get(s.employeeId) ?? [];
    const entry: { id?: string; start: number; end: number } = {
      start: ms(s.startsAt),
      end: ms(s.endsAt),
    };
    if (s.id !== undefined) entry.id = s.id;
    list.push(entry);
    existingByEmployee.set(s.employeeId, list);
  }

  const out: Array<{ row: NormalisedRow; problems: ImportProblem[] }> = rows.map((row) => ({
    row,
    problems: [...row.problems],
  }));

  // Rows that can take part in time-based checks: matched employee + both instants.
  const timed: Timed[] = [];
  out.forEach(({ row }, index) => {
    if (
      row.employeeId == null ||
      row.parsed.startsAt === undefined ||
      row.parsed.endsAt === undefined
    )
      return;
    timed.push({
      index,
      employeeId: row.employeeId,
      start: ms(row.parsed.startsAt),
      end: ms(row.parsed.endsAt),
    });
  });

  // ── Duplicates (against the database, then within the file) ───────────────────────────────────
  const skipped = new Set<number>(); // indexes excluded from overlap / length checks
  const candidates: Timed[] = [];
  for (const t of timed) {
    const existing = (existingByEmployee.get(t.employeeId) ?? []).find(
      (s) => s.start === t.start && s.end === t.end,
    );
    if (existing === undefined) {
      candidates.push(t);
      continue;
    }
    out[t.index]!.problems.push(
      problem(
        "DUPLICATE_SHIFT",
        `This employee already has a shift with the same start and end (${formatInstant(new Date(t.start))} – ${formatInstant(new Date(t.end))}); the row is skipped.`,
        { details: existing.id !== undefined ? { existingShiftId: existing.id } : {} },
      ),
    );
    skipped.add(t.index);
  }

  // Within the file, a duplicate is the same employee, start, end and details (see shiftDetailsKey). The
  // kept occurrence is the first one that has no errors of its own (else the first one): a clean row must
  // never be skipped as a duplicate of a row that cannot be imported.
  const hasError = (index: number): boolean =>
    out[index]!.row.problems.some((p) => p.severity === "ERROR");
  const shiftKey = (t: Timed): string =>
    `${t.employeeId}|${t.start}|${t.end}|${shiftDetailsKey(out[t.index]!.row.parsed)}`;
  const kept = new Map<string, Timed>();
  for (const t of candidates) {
    const current = kept.get(shiftKey(t));
    if (current === undefined || (hasError(current.index) && !hasError(t.index))) {
      kept.set(shiftKey(t), t);
    }
  }
  for (const t of candidates) {
    const keeper = kept.get(shiftKey(t))!;
    if (keeper.index === t.index) continue;
    const keptRow = out[keeper.index]!.row.rowNumber;
    out[t.index]!.problems.push(
      problem("DUPLICATE_SHIFT", `Identical to row ${keptRow} in this file; the row is skipped.`, {
        details: { duplicateOfRow: keptRow },
      }),
    );
    skipped.add(t.index);
  }

  const active = timed.filter((t) => !skipped.has(t.index));

  // ── Length, past shifts ───────────────────────────────────────────────────────────────────────
  for (const t of active) {
    const minutes = (t.end - t.start) / 60_000;
    if (minutes < minShiftMinutes) {
      out[t.index]!.problems.push(
        problem(
          "SHIFT_TOO_SHORT",
          `Shift is ${Math.round(minutes)} minutes long; the minimum is ${minShiftMinutes} minutes.`,
          {
            field: "end_time",
            details: { minutes, minShiftMinutes },
          },
        ),
      );
    } else if (minutes > maxShiftMinutes) {
      out[t.index]!.problems.push(
        problem(
          "SHIFT_TOO_LONG",
          `Shift is ${(minutes / 60).toLocaleString("en-GB", { maximumFractionDigits: 2 })} hours long; the maximum is ${maxShiftMinutes / 60} hours.`,
          { field: "end_time", details: { minutes, maxShiftMinutes } },
        ),
      );
    }
    if (nowMs !== undefined && t.end <= nowMs) {
      out[t.index]!.problems.push(
        problem("SHIFT_IN_PAST", "This shift has already ended.", { field: "date" }),
      );
    }
  }

  // ── Overlaps against existing shifts ──────────────────────────────────────────────────────────
  for (const t of active) {
    for (const s of existingByEmployee.get(t.employeeId) ?? []) {
      if (intervalsOverlap(t.start, t.end, s.start, s.end)) {
        out[t.index]!.problems.push(
          problem(
            "OVERLAPPING_SHIFT",
            `Overlaps an existing shift (${formatInstant(new Date(s.start))} – ${formatInstant(new Date(s.end))}).`,
            { details: s.id !== undefined ? { existingShiftId: s.id } : {} },
          ),
        );
      }
    }
  }

  // ── Overlaps within the file (sweep per employee) ─────────────────────────────────────────────
  const byEmployee = new Map<string, Timed[]>();
  for (const t of active) {
    const list = byEmployee.get(t.employeeId) ?? [];
    list.push(t);
    byEmployee.set(t.employeeId, list);
  }
  for (const list of byEmployee.values()) {
    list.sort((a, b) => a.start - b.start || a.index - b.index);
    for (let i = 0; i < list.length; i++) {
      const a = list[i]!;
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j]!;
        if (b.start >= a.end) break; // sorted by start: nothing later can overlap `a`
        if (!intervalsOverlap(a.start, a.end, b.start, b.end)) continue;
        const rowA = out[a.index]!.row.rowNumber;
        const rowB = out[b.index]!.row.rowNumber;
        // Equal times here means the details differ (true duplicates were skipped above).
        const sameTimes = a.start === b.start && a.end === b.end;
        const overlap = (other: number) =>
          problem(
            "OVERLAPPING_SHIFT",
            sameTimes
              ? `Same employee and times as row ${other} in this file, but a different location, department, role or break, so neither row can be skipped as a duplicate. Remove or correct one of them.`
              : `Overlaps row ${other} in this file (same employee).`,
            {
              details: sameTimes ? { conflictingRow: other, sameTimes } : { conflictingRow: other },
            },
          );
        out[a.index]!.problems.push(overlap(rowB));
        out[b.index]!.problems.push(overlap(rowA));
      }
    }
  }

  // ── Locations ─────────────────────────────────────────────────────────────────────────────────
  out.forEach(({ row, problems }, index) => {
    if (skipped.has(index)) return;
    const name = row.parsed.locationName;
    if (name !== undefined && !knownLocationKeys.has(textKey(name))) {
      problems.push(
        problem(
          "UNKNOWN_LOCATION",
          `Location "${name}" does not exist yet; create it or import without a location.`,
          {
            field: "location",
            details: { locationName: name },
          },
        ),
      );
    }
  });

  return out.map(({ row, problems }) => ({ ...row, problems, status: importRowStatus(problems) }));
}
