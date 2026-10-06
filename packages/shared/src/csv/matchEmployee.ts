/**
 * Matches a parsed row to an organisation's employees.
 *
 * Priority: external employee id → email (case-insensitive) → exact full name (case/whitespace-insensitive,
 * "First Last" or "Last, First"). The first identifier that matches exactly one employee wins. An identifier
 * that matches several employees stops the search with MULTIPLE_MATCHES — we never fall through an
 * ambiguous signal to a weaker one.
 *
 * Falling back to a weaker identifier is only allowed when the stronger one is merely unknown: if the
 * employee found by the weaker identifier has a *different* ID / email recorded, the row contradicts
 * itself (often a second person with the same name) and is reported as EMPLOYEE_NOT_FOUND instead of
 * being assigned to the wrong person.
 *
 * When the winning identifier is contradicted by a lower-priority one — it belongs to another employee,
 * or it is an email that matches nobody while the matched employee has a different email on file — the
 * match stands (priority decides) and the row gets an EMPLOYEE_IDENTIFIER_MISMATCH warning.
 */
import { problem, type ImportProblem, type NormalisedRow, type ParsedShiftRow } from "./types";

export interface EmployeeCandidate {
  id: string;
  firstName: string;
  lastName: string;
  email?: string | null;
  externalEmployeeId?: string | null;
}

export type MatchSignal = "external_id" | "email" | "name";

export interface SuggestedEmployee {
  firstName: string;
  lastName: string;
  email?: string;
  externalEmployeeId?: string;
}

export type MatchEmployeeResult =
  | { employeeId: string; matchedBy: MatchSignal; warnings: ImportProblem[] }
  | { employeeId: null; problem: ImportProblem; candidates?: string[] };

export type MatchInput = Pick<ParsedShiftRow, "employeeName" | "employeeExternalId" | "email">;

/** NFKC, lower-case, trimmed, single spaces. */
export function normaliseName(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

function normaliseId(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase();
}

/** "Smith, Jane" → "jane smith"; "Jane  Smith" → "jane smith". */
export function nameKey(value: string): string {
  const comma = value.indexOf(",");
  if (comma >= 0) {
    const last = value.slice(0, comma);
    const first = value.slice(comma + 1);
    return normaliseName(`${first} ${last}`);
  }
  return normaliseName(value);
}

/** Splits a row's name into first/last for the "create employee" option. */
export function splitName(value: string): { firstName: string; lastName: string } {
  const comma = value.indexOf(",");
  if (comma >= 0) {
    return {
      firstName: value
        .slice(comma + 1)
        .trim()
        .replace(/\s+/g, " "),
      lastName: value.slice(0, comma).trim(),
    };
  }
  const parts = value.trim().split(/\s+/);
  if (parts.length === 1) return { firstName: parts[0] ?? "", lastName: "" };
  return { firstName: parts[0] ?? "", lastName: parts.slice(1).join(" ") };
}

export function suggestedEmployee(input: MatchInput): SuggestedEmployee {
  const base =
    input.employeeName !== undefined
      ? splitName(input.employeeName)
      : { firstName: "", lastName: "" };
  const out: SuggestedEmployee = { ...base };
  if (input.email !== undefined) out.email = input.email;
  if (input.employeeExternalId !== undefined) out.externalEmployeeId = input.employeeExternalId;
  return out;
}

interface Signal {
  kind: MatchSignal;
  label: string;
  value: string;
  matches: EmployeeCandidate[];
}

function emailKey(value: string): string {
  return value.normalize("NFKC").trim().toLowerCase();
}

/** Candidates keyed by each identifier, built once per import instead of scanning per row. */
export interface CandidateIndex {
  byExternalId: Map<string, EmployeeCandidate[]>;
  byEmail: Map<string, EmployeeCandidate[]>;
  byName: Map<string, EmployeeCandidate[]>;
}

function push(
  map: Map<string, EmployeeCandidate[]>,
  key: string,
  candidate: EmployeeCandidate,
): void {
  if (key === "") return;
  const list = map.get(key);
  if (list) list.push(candidate);
  else map.set(key, [candidate]);
}

export function indexCandidates(candidates: readonly EmployeeCandidate[]): CandidateIndex {
  const index: CandidateIndex = { byExternalId: new Map(), byEmail: new Map(), byName: new Map() };
  for (const c of candidates) {
    if (c.externalEmployeeId != null)
      push(index.byExternalId, normaliseId(c.externalEmployeeId), c);
    if (c.email != null) push(index.byEmail, emailKey(c.email), c);
    push(index.byName, normaliseName(`${c.firstName} ${c.lastName}`), c);
  }
  return index;
}

function signals(input: MatchInput, index: CandidateIndex): Signal[] {
  const out: Signal[] = [];
  if (input.employeeExternalId !== undefined) {
    out.push({
      kind: "external_id",
      label: `employee ID "${input.employeeExternalId}"`,
      value: input.employeeExternalId,
      matches: index.byExternalId.get(normaliseId(input.employeeExternalId)) ?? [],
    });
  }
  if (input.email !== undefined) {
    out.push({
      kind: "email",
      label: `email "${input.email}"`,
      value: input.email,
      matches: index.byEmail.get(emailKey(input.email)) ?? [],
    });
  }
  if (input.employeeName !== undefined) {
    out.push({
      kind: "name",
      label: `name "${input.employeeName}"`,
      value: input.employeeName,
      matches: index.byName.get(nameKey(input.employeeName)) ?? [],
    });
  }
  return out;
}

/**
 * Matches one row's identifiers against the organisation's employees (pass active employees only).
 * `candidates` may be a prepared `indexCandidates()` result when matching many rows.
 */
export function matchEmployee(
  input: MatchInput,
  candidates: readonly EmployeeCandidate[] | CandidateIndex,
): MatchEmployeeResult {
  const index = isCandidateIndex(candidates) ? candidates : indexCandidates(candidates);
  const tried = signals(input, index);
  if (tried.length === 0) {
    return {
      employeeId: null,
      problem: problem(
        "EMPLOYEE_NOT_FOUND",
        "No usable employee identifier (employee ID, valid email or name) on this row.",
        { field: "employee_name" },
      ),
    };
  }

  for (let i = 0; i < tried.length; i++) {
    const signal = tried[i]!;
    if (signal.matches.length > 1) {
      const ids = signal.matches.map((c) => c.id);
      return {
        employeeId: null,
        candidates: ids,
        problem: problem(
          "MULTIPLE_MATCHES",
          `${signal.matches.length} employees match ${signal.label}; add an employee ID or email to disambiguate.`,
          { field: fieldFor(signal.kind), details: { candidateIds: ids, matchedBy: signal.kind } },
        ),
      };
    }
    if (signal.matches.length === 1) {
      const match = signal.matches[0]!;
      const warnings: ImportProblem[] = [];
      // Higher-priority identifiers were present but matched nobody.
      for (const earlier of tried.slice(0, i)) {
        const recorded = recordedValue(match, earlier.kind);
        if (recorded !== null) {
          // The employee has a different ID / email on file: the row contradicts itself.
          return {
            employeeId: null,
            candidates: [match.id],
            problem: problem(
              "EMPLOYEE_NOT_FOUND",
              `No employee has ${earlier.label}. ${capitalise(signal.label)} matches ${match.firstName} ${match.lastName}, whose ${KIND_LABEL[earlier.kind]} is "${recorded}", so the row was not matched. Fix the row, pick the employee, or create a new employee.`,
              {
                field: fieldFor(earlier.kind),
                details: {
                  suggestedEmployee: suggestedEmployee(input),
                  conflictingEmployeeIds: [match.id],
                  matchedBy: signal.kind,
                  unmatched: earlier.kind,
                },
              },
            ),
          };
        }
        warnings.push(
          problem(
            "EMPLOYEE_IDENTIFIER_MISMATCH",
            `Matched by ${KIND_LABEL[signal.kind]}; ${earlier.label} does not belong to any employee (${match.firstName} ${match.lastName} has no ${KIND_LABEL[earlier.kind]} recorded).`,
            {
              field: fieldFor(earlier.kind),
              details: { matchedBy: signal.kind, unmatched: earlier.kind },
            },
          ),
        );
      }
      // Lower-priority identifiers contradict the match.
      for (const later of tried.slice(i + 1)) {
        if (later.matches.length > 0) {
          // ...because they belong to a different employee.
          if (later.matches.some((c) => c.id === match.id)) continue;
          warnings.push(
            problem(
              "EMPLOYEE_IDENTIFIER_MISMATCH",
              `Matched by ${KIND_LABEL[signal.kind]}, but ${later.label} belongs to a different employee.`,
              {
                field: fieldFor(later.kind),
                details: {
                  matchedBy: signal.kind,
                  conflicting: later.kind,
                  conflictingIds: later.matches.map((c) => c.id),
                },
              },
            ),
          );
        } else if (later.kind === "email" && recordedValue(match, "email") !== null) {
          // ...or because the row's email is unknown while the matched employee has another one on file
          // (a mistyped ID would otherwise assign the shift to the wrong person without a word). Names are
          // not compared this way: nicknames and middle names differ between systems all the time.
          warnings.push(
            problem(
              "EMPLOYEE_IDENTIFIER_MISMATCH",
              `Matched by ${KIND_LABEL[signal.kind]} to ${match.firstName} ${match.lastName}, but ${later.label} is not the email recorded for them.`,
              {
                field: "email",
                details: { matchedBy: signal.kind, conflicting: "email", conflictingIds: [] },
              },
            ),
          );
        }
      }
      return { employeeId: match.id, matchedBy: signal.kind, warnings };
    }
  }

  const described = tried.map((s) => s.label).join(", ");
  return {
    employeeId: null,
    problem: problem("EMPLOYEE_NOT_FOUND", `No employee matches ${described}.`, {
      field: fieldFor(tried[tried.length - 1]!.kind),
      details: { suggestedEmployee: suggestedEmployee(input) },
    }),
  };
}

const KIND_LABEL: Record<MatchSignal, string> = {
  external_id: "employee ID",
  email: "email",
  name: "name",
};

function capitalise(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

/** The candidate's own value for an identifier kind, or null when none is recorded. */
function recordedValue(candidate: EmployeeCandidate, kind: MatchSignal): string | null {
  switch (kind) {
    case "external_id": {
      const v = candidate.externalEmployeeId?.trim() ?? "";
      return v === "" ? null : v;
    }
    case "email": {
      const v = candidate.email?.trim() ?? "";
      return v === "" ? null : v;
    }
    case "name":
      return `${candidate.firstName} ${candidate.lastName}`.trim() || null;
  }
}

function isCandidateIndex(
  value: readonly EmployeeCandidate[] | CandidateIndex,
): value is CandidateIndex {
  return !Array.isArray(value);
}

function fieldFor(kind: MatchSignal): "employee_id" | "email" | "employee_name" {
  switch (kind) {
    case "external_id":
      return "employee_id";
    case "email":
      return "email";
    case "name":
      return "employee_name";
  }
}

const IDENTIFIER_FIELDS: ReadonlySet<string> = new Set(["employee_id", "email", "employee_name"]);

/**
 * Runs `matchEmployee` over normalised rows, setting `employeeId` and appending problems. Returns new
 * objects. A row already flagged MISSING_REQUIRED_FIELD for its identifier is not also flagged
 * EMPLOYEE_NOT_FOUND (one problem per cause).
 */
export function matchRows(
  rows: readonly NormalisedRow[],
  candidates: readonly EmployeeCandidate[],
): NormalisedRow[] {
  const index = indexCandidates(candidates);
  return rows.map((row) => {
    const result = matchEmployee(row.parsed, index);
    if (result.employeeId === null) {
      const alreadyMissing =
        result.problem.code === "EMPLOYEE_NOT_FOUND" &&
        row.problems.some(
          (p) =>
            p.code === "MISSING_REQUIRED_FIELD" &&
            p.field !== undefined &&
            IDENTIFIER_FIELDS.has(p.field),
        );
      return {
        ...row,
        employeeId: null,
        problems: alreadyMissing ? [...row.problems] : [...row.problems, result.problem],
      };
    }
    return {
      ...row,
      employeeId: result.employeeId,
      problems: [...row.problems, ...result.warnings],
    };
  });
}
