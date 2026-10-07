# CSV Shift Import (§6.5)

Source: `packages/shared/src/csv/` (`types.ts`, `headerMapping.ts`, `parseDateTime.ts`, `parseCsv.ts`,
`normaliseRow.ts`, `matchEmployee.ts`, `validateRows.ts`, `summarise.ts`, `template.ts`).
Import: `@clockoff/shared/csv/csvImport` (or the `@clockoff/shared` barrel).

Managers upload a rota export as CSV; ClockOff turns each row into a shift for one employee. The import
logic is a set of **pure functions** (Papa Parse + Luxon, no I/O, no database). The API feeds them the
file text, the organisation's employees, existing shifts and locations, and persists what comes back in
`ShiftImport` / `ShiftImportRow`.

The guiding rule is **never silently guess**. Anything ambiguous (an unclear header, a date that could be
day-first or month-first, a name shared by two employees, a clock-change time) is either decided by an
explicit organisation setting or reported to the manager as a problem on the row.

## Pipeline

```text
upload ─► validateImportFile({ name, size })            5 MB, .csv/.txt/.tsv
       ─► detectHeaders(text)                           headers, 5 sample rows, delimiter, header row?
       ─► suggestMapping(headers)                       header → field + confidence (manager confirms)
       ─► checkMapping(mapping)                         required fields + one identifier mapped?
       ─► parseCsv(text, { delimiter, hasHeaderRow })   ≤ 5,000 rows, spreadsheet row numbers
       ─► normaliseRows(records, mapping, options)      typed values, UTC instants, per-row problems
       ─► matchRows(rows, employees)                    employee ID → email → name
       ─► importShiftWindow(rows)  → load existing shifts from the DB
       ─► validateRows(rows, context)                   overlaps, duplicates, length, locations, status
       ─► summarise(rows) · toErrorsCsv(rows) · unknownLocations(rows) · employeesToCreate(rows)
```

Every function is deterministic and side-effect free; the same input always produces the same rows,
problems and statuses, so validation can be re-run after the manager fixes the mapping or options.

## Limits

| Limit                   | Value                         | Enforced by                            | Problem / API error                    |
| ----------------------- | ----------------------------- | -------------------------------------- | -------------------------------------- |
| File size               | 5 MB (`5 * 1024 * 1024`)      | `validateImportFile` + upload endpoint | `FILE_TOO_LARGE` → `PAYLOAD_TOO_LARGE` |
| File type               | `.csv`, `.txt`, `.tsv`        | `validateImportFile`                   | `INVALID_CSV`                          |
| Data rows               | 5,000 (header excluded)       | `parseCsv({ maxRows })`                | `TOO_MANY_ROWS` → `INVALID_CSV`        |
| Minimum shift length    | 15 minutes (org-configurable) | `validateRows({ minShiftMinutes })`    | `SHIFT_TOO_SHORT`                      |
| Maximum shift length    | 24 hours                      | `validateRows({ maxShiftMinutes })`    | `SHIFT_TOO_LONG`                       |
| Break per row           | 0–240 minutes, < shift length | `normaliseRow`                         | `INVALID_BREAK_MINUTES`                |
| Years                   | 2000–2099                     | `parseImportDate`                      | `INVALID_DATE`                         |
| Mapping preview samples | 5 rows                        | `detectHeaders`                        | —                                      |

The numbers live in `IMPORT_LIMITS` (file types in `IMPORT_FILE_EXTENSIONS`, years in
`IMPORT_MIN_YEAR` / `IMPORT_MAX_YEAR`). File-level problems are converted to the API error envelope with
`importFileErrorToAppError(problems)` (`FILE_TOO_LARGE` → `PAYLOAD_TOO_LARGE` 413, everything else →
`INVALID_CSV` 400, `details.problems` lists them all).

## Supported columns

Column order does not matter and extra columns are ignored (they are kept in `raw` and appear in the
errors CSV). Every row needs a date, a start time, an end time and **at least one** employee identifier.

| Field           | Required   | Meaning                                                                                     | Example                  |
| --------------- | ---------- | ------------------------------------------------------------------------------------------- | ------------------------ |
| `employee_name` | identifier | Full name, `First Last` or `Last, First`. Matched case- and whitespace-insensitively.       | `Jane Smith`             |
| `employee_id`   | identifier | Payroll / rota system ID; matches `Employee.externalEmployeeId`. Highest matching priority. | `E1042`                  |
| `email`         | identifier | Employee email, matched case-insensitively. A malformed email is ignored with a warning.    | `jane.smith@example.com` |
| `date`          | required   | Shift (start) date — see [Dates](#dates).                                                   | `2026-03-05`             |
| `start_time`    | required   | Local start time in the import timezone — see [Times](#times).                              | `09:00`                  |
| `end_time`      | required   | Local end time. At or before the start time means the shift ends the next day (overnight).  | `17:00`                  |
| `location`      | optional   | Location / site / store name. Unknown names produce a warning (create, map or ignore).      | `High Street`            |
| `department`    | optional   | Department / team, kept as text on the row.                                                 | `Front of house`         |
| `role`          | optional   | Role / position for the shift, kept as text on the row.                                     | `Barista`                |
| `break_minutes` | optional   | Unpaid break in whole minutes: `30`, `30m`, `30 mins`. Empty means no break.                | `30`                     |

`REQUIRED_IMPORT_FIELDS = ["date", "start_time", "end_time"]`;
`EMPLOYEE_IDENTIFIER_FIELDS = ["employee_id", "email", "employee_name"]`. UI labels and help text are in
`IMPORT_FIELD_INFO`.

Separate "First name" / "Last name" columns are not combined automatically (and are deliberately never
auto-mapped): join them into one name column in the spreadsheet, or map an employee ID or email column.

## File format

- **Encoding:** UTF-8. A byte-order mark (Excel's "CSV UTF-8") is stripped.
- **Delimiter:** auto-detected from the first lines among `,` `;` tab `|` (`CSV_DELIMITERS`); defaults to
  `,`. European Excel exports with `;` work without changes. The detected delimiter is returned by
  `detectHeaders` and should be passed back to `parseCsv` so both steps agree.
- **Quoting:** standard RFC 4180. Quoted cells may contain the delimiter (`"Smith, Jane"`), escaped quotes
  (`""`) and line breaks.
- **Line endings:** CRLF, LF and CR, including mixed endings in one file.
- **Blank lines** (including separator-only lines such as `,,,`) are skipped but still counted, so row
  numbers match the spreadsheet: the header is row 1 and the first data row is row 2.
- **Cells** are trimmed. Short rows are padded with empty cells. A row with more non-empty cells than
  headers keeps the extras as `Column N` and gets an `INVALID_CSV` **error** (usually an unquoted comma,
  so the cells may be shifted; importing it would be a guess).
- **Broken quotes** (a quote that is never closed, or text after a closing quote) reject the **whole
  file** with `INVALID_CSV` naming the row: an unclosed quote swallows every following line into one
  cell, so nothing after it can be trusted.
- **Not text:** a file containing NUL characters (an `.xlsx` renamed to `.csv`, or a UTF-16 export) is
  rejected with `INVALID_CSV` and a hint to save as "CSV UTF-8". Excel's `sep=;` first line is honoured
  and is not counted as a row.
- **Header row:** must be the first non-blank line. `detectHeaders` decides whether there is one: a first
  line containing a date, time, number or email is data; otherwise it is a header if any cell matches a
  known column name, or if the second line looks like data. Files without a header get positional column
  names (`Column 1`, `Column 2`, ...) and are parsed with `parseCsv(text, { hasHeaderRow: false })`.
  The wizard shows the decision with the sample rows so the manager can correct it.
- **Duplicate / blank headers** are renamed `Start (2)`, `Column 4`, ... so every column can be mapped.
  Generated names never reuse a name written in the file (`Start, Start, Start (2)` becomes
  `Start, Start (3), Start (2)`), and extra cells never take a real column's name, so no cell is ever
  overwritten. Every header, even one called `__proto__`, is an ordinary key in `raw` and the mapping.

## Dates

Dates are calendar dates in the import timezone. Year-first dates are always unambiguous; day/month order
for other numeric dates comes from the organisation's **date format** setting (`Organisation.dateFormat`,
default `DMY` for UK customers) and is **never guessed** from the data.

| Input                                                             | `DMY` (default) | `MDY`                                 | `YMD`        |
| ----------------------------------------------------------------- | --------------- | ------------------------------------- | ------------ |
| `2026-03-05`, `2026/03/05`, `2026.3.5`                            | 2026-03-05      | 2026-03-05                            | 2026-03-05   |
| `03/04/2026`                                                      | 2026-04-03      | 2026-03-04                            | INVALID_DATE |
| `5/3/2026`, `05-03-2026`, `05.03.2026`                            | 2026-03-05      | 2026-05-03                            | INVALID_DATE |
| `05/03/26` (2-digit year = 20xx)                                  | 2026-03-05      | 2026-05-03                            | INVALID_DATE |
| `5 Mar 2026`, `March 5, 2026`, `05-Mar-26`                        | 2026-03-05      | 2026-03-05                            | 2026-03-05   |
| `5 Sep 2026`, `5 Sept. 2026`, `5th September 2026`, `05/Sep/2026` | 2026-09-05      | 2026-09-05                            | 2026-09-05   |
| `Thu 05/03/2026` (weekday must agree)                             | 2026-03-05      | INVALID_DATE (3 May 2026 is a Sunday) | INVALID_DATE |
| `05/03/2026 00:00` (midnight suffix)                              | 2026-03-05      | 2026-05-03                            | INVALID_DATE |

Month names are read from a fixed English table (full names and three-letter abbreviations, plus
`Sept`), never from the runtime's locale data, whose abbreviations change between ICU versions. A leading
weekday is checked against the date: a mismatch usually means the day/month order is wrong, so it is an
error rather than ignored.

Rejected with `INVALID_DATE` (and a specific message): impossible dates (`31/02/2026` or `31 Feb 2026` →
"31 February 2026 is not a real date."), a month over 12 (with a hint that the file may use the other
order), years outside 2000–2099, dates without a year (`5 Mar`), mixed separators (`05/03-2026`), day or
month groups longer than two digits, Excel serial numbers (`46082`), a non-midnight time inside the date
cell, and anything else unrecognised.

## Times

Times are local wall-clock times in the import timezone (the organisation's timezone, or the timezone of
the location chosen in the wizard).

| Input                                | Parsed as                      |
| ------------------------------------ | ------------------------------ |
| `09:00`, `9:00`, `09:00:00`, `9`     | 09:00                          |
| `0900`, `900`                        | 09:00                          |
| `9am`, `9 AM`, `9 a.m.`              | 09:00                          |
| `9:30pm`, `9.30 pm`, `21.30`, `2130` | 21:30                          |
| `12am` / `12pm`                      | 00:00 / 12:00                  |
| `17:00 hrs`                          | 17:00                          |
| `24:00` (end time only)              | midnight at the end of the day |

Rejected with `INVALID_TIME`: `25:00`, `9:60`, `13pm`, `0am`, `24:01`, `9:3`, `noon`, decimal hours such as
`9.5`, and `24:00` as a start time.

**Overnight shifts.** When the end time is at or before the start time (`22:00`–`06:00`, or `09:00`–`09:00`
for a 24-hour shift), the shift ends on the next calendar day. This is a `OVERNIGHT_SHIFT` **warning**, not
an error, so the manager can confirm it was intended.

**UTC instants.** `normaliseRow` combines date + time in the timezone and returns `startsAt` / `endsAt` as
UTC ISO strings (`2026-06-01T08:00:00.000Z` for 09:00 BST). Clock changes are handled explicitly:

- A time that does not exist (spring forward, e.g. 01:30 on 29 March 2026 in London) moves forward by the
  gap (02:30 BST) with a `DST_ADJUSTED_TIME` warning.
- A time that happens twice (fall back, e.g. 01:30 on 25 October 2026 in London) uses the first occurrence
  (01:30 BST) with a `DST_AMBIGUOUS_TIME` warning.

## Automatic column mapping

`suggestMapping(headers)` returns `{ mapping, confidence, needsConfirmation }`. Headers are normalised
before comparison (lower-case, punctuation and underscores become spaces, BOM removed), so `Shift_Start`,
`SHIFT START` and `shift-start` are the same header.

| Confidence | Value | When                                                                       | Wizard behaviour                                          |
| ---------- | ----- | -------------------------------------------------------------------------- | --------------------------------------------------------- |
| Exact      | 1.0   | Header is the field name: `start_time`, `Start Time`, `START TIME`         | pre-selected                                              |
| Alias      | 0.9   | Header is a known alias: `Start`, `Shift Start`, `Finish`, `Staff`, `Site` | pre-selected (generic one-word aliases: **must confirm**) |
| Partial    | 0.6   | A distinctive alias appears inside a longer header: `Shift Start (24h)`    | pre-selected, **must confirm** (`needsConfirmation`)      |
| None       | 0     | Unknown or ambiguous                                                       | left unmapped                                             |

Some aliases (full list in `FIELD_ALIASES`):

| Field           | Recognised headers (examples)                                                                   |
| --------------- | ----------------------------------------------------------------------------------------------- |
| `employee_name` | Employee, Name, Full Name, Staff, Staff Name, Team Member, Worker, Colleague                    |
| `employee_id`   | Employee ID, Employee Number, Staff ID, Payroll ID, Payroll Number, Emp No, Badge, Clock No, ID |
| `email`         | Email, E-mail, Email Address, Work Email                                                        |
| `date`          | Date, Shift Date, Day, Work Date, Start Date, Rota Date                                         |
| `start_time`    | Start, Start Time, Shift Start, Starts At, Time In, Clock In, From, In                          |
| `end_time`      | End, End Time, Shift End, Finish, Finish Time, Time Out, Clock Out, To, Until, Out              |
| `location`      | Location, Site, Store, Branch, Venue, Shop, Workplace, Outlet, Restaurant                       |
| `department`    | Department, Dept, Team, Section, Area, Division                                                 |
| `role`          | Role, Position, Job, Job Title, Job Role, Shift Role                                            |
| `break_minutes` | Break, Break Minutes, Break (mins), Break Length, Unpaid Break                                  |

Rules that keep the suggestion honest:

- **Ambiguity is left unmapped.** `End Date` (end_time vs date), `Break Start` (break vs start_time) and
  `Shift Start Date` score nothing.
- **Generic words never match inside longer headers.** `ID`, `In`, `Out`, `To`, `Team` work as whole
  headers but `Shift ID`, `Notes on shift`, `Days Off`, `Pay Group` are not mapped.
- **Generic one-word headers must be confirmed.** `ID`, `Ref`, `Reference`, `Name`, `Day`, `In`, `Out`,
  `From`, `To`, `Team`, `Group`, `Unit`, `Office`, ... are pre-selected but listed in `needsConfirmation`:
  other exports use them for something else, and an `ID` or `Reference` column holding the shift's own
  number could coincide with an employee's payroll ID and assign shifts to the wrong person. When a
  specific header for the same field exists (`Employee ID`), it wins and the generic one stays unmapped.
- **Identifier columns never cross over.** `Email`, `E-mail`, `Work Email` map to `email` only;
  `Name`, `Employee`, `Staff Name` map to `employee_name` only; `Manager Email`, `Contact Email` and
  `Personal Email` are not mapped at all.
- **Columns about someone or something else are never partially mapped**: headers containing words such
  as manager, supervisor, first, last, birth, paid, hours, status or type (`Manager Email`, `First Name`,
  `Date of Birth`, `Paid Break`, `Break Hours`, `Employee Status`).
- **One header per field.** When several headers score for the same field, the highest confidence keeps
  it (the leftmost on a tie, which is then flagged for confirmation) and the others are unmapped.

`checkMapping(mapping)` reports `{ complete, missingRequired, missingIdentifier, duplicated }`; the API
answers `IMPORT_MAPPING_INCOMPLETE` until `complete` is true. If a mapping still names a field twice,
`normaliseRow` reads the first header.

## Employee matching

`matchEmployee(parsed, employees)` (or `matchRows` for all rows) tries identifiers in priority order:

1. **Employee ID** — `employee_id` vs `Employee.externalEmployeeId`, case- and whitespace-insensitive.
2. **Email** — case-insensitive.
3. **Full name** — exact `firstName + " " + lastName`, case-insensitive, whitespace collapsed; the CSV may
   also say `Last, First`. No fuzzy matching: `Amira`, `A. Khan` or `Khan Amira` do not match Amira Khan.

The first identifier that matches exactly **one** employee wins. If it matches **several**, matching stops
with `MULTIPLE_MATCHES` (candidate ids in `details.candidateIds`) — a weaker identifier is never used to
break the tie. If none matches, the row gets `EMPLOYEE_NOT_FOUND` with `details.suggestedEmployee`
(`{ firstName, lastName, email?, externalEmployeeId? }`) to pre-fill "create employee".

A weaker identifier is used only when the stronger one is merely **unknown**, never when it contradicts
the employee found: if the ID matches nobody and the name matches Jane Smith, but Jane has a different
employee ID on file (or the unknown email contradicts her recorded email), the row is probably a second
person with the same name. It gets `EMPLOYEE_NOT_FOUND` (with `details.conflictingEmployeeIds`) instead of
being assigned to Jane. If Jane has no ID on file, the name match stands with an
`EMPLOYEE_IDENTIFIER_MISMATCH` warning.

When the winning identifier is contradicted by a lower-priority one — it belongs to a different employee,
or it is an **email** that matches nobody while the matched employee has a different email on file — the
match stands (priority decides) and the row gets an `EMPLOYEE_IDENTIFIER_MISMATCH` warning naming the
field, so a mistyped ID cannot silently move a shift to someone else. A **name** that matches nobody is
not treated as a contradiction: nicknames and middle names differ between systems all the time.

Pass only employees that can receive shifts (active, not deleted) as candidates.

## Validation codes

Every problem is `{ code, message, field?, severity, details? }` (`ImportProblem`) and is stored as-is in
`ShiftImportRow.problems`. Codes are in `IMPORT_PROBLEM_CODES`; titles, default severities and resolution
copy are in `IMPORT_PROBLEM_INFO`.

| Code                           | Severity | Meaning                                                                                                                                                   | Resolution options in the UI                                              |
| ------------------------------ | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `INVALID_CSV`                  | ERROR    | File empty, not text or badly quoted (whole file); a row with more cells than headers (that row)                                                          | Re-export as UTF-8 CSV; fix quoting in the source file                    |
| `FILE_TOO_LARGE`               | ERROR    | Upload over 5 MB                                                                                                                                          | Remove columns or split the file                                          |
| `TOO_MANY_ROWS`                | ERROR    | More than 5,000 data rows                                                                                                                                 | Split the file and import the parts separately                            |
| `MISSING_REQUIRED_FIELD`       | ERROR    | Date, start, end or every identifier is empty / not mapped                                                                                                | Fill in the cell, or map another column                                   |
| `INVALID_DATE`                 | ERROR    | Date unparseable, impossible, out of range or wrong order for the date format                                                                             | Fix the cell, or change the date format option (DD/MM vs MM/DD)           |
| `INVALID_TIME`                 | ERROR    | Time unparseable or out of range; `24:00` as a start                                                                                                      | Fix the cell (09:00, 17:30, 9am, 5:30pm)                                  |
| `INVALID_BREAK_MINUTES`        | ERROR    | Not a whole number, over 240, or not shorter than the shift                                                                                               | Fix the cell or leave it empty                                            |
| `INVALID_EMAIL`                | WARNING  | Email malformed; ignored for matching                                                                                                                     | Fix the email; the row may still match by ID or name                      |
| `OVERNIGHT_SHIFT`              | WARNING  | End ≤ start, so the shift ends the next day                                                                                                               | Confirm, or correct the times                                             |
| `DST_ADJUSTED_TIME`            | WARNING  | Local time skipped by the clocks going forward; moved forward                                                                                             | Confirm, or correct the times                                             |
| `DST_AMBIGUOUS_TIME`           | WARNING  | Local time happens twice when the clocks go back; first occurrence used                                                                                   | Confirm, or correct the times                                             |
| `EMPLOYEE_NOT_FOUND`           | ERROR    | No employee matches, or the only match contradicts the row's ID / email                                                                                   | **Create employee** (pre-filled), fix the identifier, or skip the row     |
| `MULTIPLE_MATCHES`             | ERROR    | The highest-priority identifier matches several employees                                                                                                 | Pick the employee, or add an ID / email column                            |
| `EMPLOYEE_IDENTIFIER_MISMATCH` | WARNING  | A lower-priority identifier belongs to someone else (or is an unknown email that is not the one on file), or a higher-priority one matched nobody         | Check the row; the highest-priority match was used                        |
| `OVERLAPPING_SHIFT`            | ERROR    | Overlaps an existing shift or another row for the same employee (including a row with the same times but a different location, department, role or break) | Adjust or remove one of the shifts                                        |
| `DUPLICATE_SHIFT`              | WARNING  | The employee already has a shift with the same start and end, or an identical row (same times and details) appears in the file                            | None needed — the row is **skipped**                                      |
| `UNKNOWN_LOCATION`             | WARNING  | Location name not in the organisation                                                                                                                     | **Create location**, map to an existing one, or import without a location |
| `SHIFT_TOO_SHORT`              | ERROR    | Shorter than the minimum (default 15 minutes)                                                                                                             | Correct the times                                                         |
| `SHIFT_TOO_LONG`               | ERROR    | Longer than 24 hours (e.g. 09:00–09:00 across the autumn clock change)                                                                                    | Correct the times or split the shift                                      |
| `SHIFT_IN_PAST`                | WARNING  | Ends before `now` (only when the caller passes `now`)                                                                                                     | Confirm the date; past shifts never activate Work Mode                    |

Overlaps use **half-open intervals** `[start, end)`: a shift ending at 17:00 and another starting at 17:00
do not overlap. Only shifts of the same employee are compared. Duplicate rows are excluded from the
overlap and length checks.

Duplicates are **skipped, never errors**. Against the database a duplicate is the same employee, start and
end. Within the file it must also have the same location, department, role and break (compared
case- and whitespace-insensitively; an empty break equals `0`), and the kept occurrence is the first one
without errors of its own (else the first one). Two rows with the same times but different details
contradict each other, so neither is skipped: both get `OVERLAPPING_SHIFT` (`details.sameTimes: true`).

### Row status

`validateRows` gives each row a status (`ImportRowStatus`, a subset of the Prisma `ShiftImportRowStatus`):

| Status    | When                                             | Imported? |
| --------- | ------------------------------------------------ | --------- |
| `ERROR`   | at least one ERROR problem                       | no        |
| `SKIPPED` | no errors, and a `DUPLICATE_SHIFT`               | no        |
| `WARNING` | no errors, not a duplicate, at least one WARNING | yes       |
| `VALID`   | no problems                                      | yes       |

`IMPORTED` is set by the API after it creates the shift. `summarise(rows)` returns
`{ total, valid, warning, error, skipped, importable, problemCounts }` for `ShiftImport.*Count`.

### Errors CSV

`toErrorsCsv(rows)` produces a CSV (CRLF, header row) of every row with at least one problem:
`row_number, status, problems, <original columns in original order>`. `problems` is
`SEVERITY CODE (field): message` joined with `|`. Cells and headers starting with `=`, `+`, `-`, `@`, tab
or CR (or the full-width `＝ ＋ － ＠`) are prefixed with `'` so spreadsheets never run uploaded content as
a formula; only the first character is checked, so a multi-line cell such as `"=1+⏎1"` is escaped too
(Papa's built-in `escapeFormulae: true` pattern misses it). It returns `""` when every row is clean.

## Using it from the API

```ts
import {
  detectHeaders,
  suggestMapping,
  checkMapping,
  parseCsv,
  normaliseRows,
  matchRows,
  importShiftWindow,
  validateRows,
  summarise,
  importFileErrorToAppError,
} from "@clockoff/shared/csv/csvImport";
import { AppError } from "@clockoff/shared/errors";

// Upload: store the detection result and the suggestion; the wizard shows them for confirmation.
const detected = detectHeaders(text); // { headers, sampleRows, delimiter, hasHeaderRow }
const suggestion = suggestMapping(detected.headers); // { mapping, confidence, needsConfirmation }

// Validate (after the manager confirms `mapping` and the options):
if (!checkMapping(mapping).complete) throw new AppError("IMPORT_MAPPING_INCOMPLETE");
const parsed = parseCsv(text, {
  delimiter: detected.delimiter,
  hasHeaderRow: detected.hasHeaderRow,
});
if (parsed.errors.length > 0) throw importFileErrorToAppError(parsed.errors);

const normalised = normaliseRows(parsed.records, mapping, {
  dateFormat: org.dateFormat,
  timezone,
  defaultLocationName,
});
const matched = matchRows(normalised, activeEmployees); // { id, firstName, lastName, email, externalEmployeeId }
const window = importShiftWindow(matched); // { employeeIds, from, to } | null
const existingShifts = window
  ? await prisma.shift.findMany({
      where: {
        organisationId,
        employeeId: { in: window.employeeIds },
        deletedAt: null,
        status: { not: "CANCELLED" },
        startsAt: { lt: new Date(window.to) },
        endsAt: { gt: new Date(window.from) },
      },
      select: { id: true, employeeId: true, startsAt: true, endsAt: true },
    })
  : [];
const rows = validateRows(matched, { existingShifts, knownLocations, minShiftMinutes });
const summary = summarise(rows);
// Persist each row: rowNumber, raw, parsed, problems, status, matchedEmployeeId = row.employeeId.
```

- `normaliseRow` throws `AppError("INVALID_TIMEZONE")` for an invalid timezone option — a configuration
  error, not a data problem.
- `parseCsv` never throws; `rows` is the plain `Record<header, value>[]`, `records` adds `rowNumber` and
  structural problems and is what `normaliseRows` takes.
- `unknownLocations(rows)` and `employeesToCreate(rows)` return de-duplicated lists (with row numbers) for
  the "create these locations / employees" actions; re-run matching and validation afterwards.

## Template

Download: [`docs/templates/shift-import-template.csv`](templates/shift-import-template.csv) (served by the
app from `generateTemplateCsv()`; a test keeps the file identical to the generated content).

```csv
employee_name,employee_id,email,date,start_time,end_time,location,department,role,break_minutes
Jane Smith,E1042,jane.smith@example.com,2030-03-05,09:00,17:00,High Street,Front of house,Barista,30
"Smith, John",E1043,,2030-03-05,2pm,10pm,High Street,Kitchen,Chef,
,E1044,amira.khan@example.com,2030-03-06,07:30,15:30,Station Road,,Supervisor,45
```

It shows the canonical headers, a `Last, First` name, 12-hour times, and a row identified only by ID and
email. Every row is clean: `template.test.ts` runs the template through the same pipeline as an upload
(detect → map → parse → normalise → match → validate, with `now` set) under all three date formats and
expects **zero problems** — no errors and no warnings — and repeats that after an Excel-style round trip
(BOM, `;` delimiter, `DD/MM/YYYY` dates). The dates are deliberately years ahead so an unedited template
never gets `SHIFT_IN_PAST`, and there is no overnight row because that would be an `OVERNIGHT_SHIFT`
warning.

## Worked example

An organisation in `Europe/London` with date format `DMY`, one location (`High Street`) and three
employees:

| id      | Name       | Email                  | External ID |
| ------- | ---------- | ---------------------- | ----------- |
| `jane`  | Jane Smith | jane.smith@example.com | E1042       |
| `john`  | John Smith | —                      | E1043       |
| `amira` | Amira Khan | Amira.Khan@example.com | E1044       |

John already has a shift on 6 March 2026, 09:00–17:00 GMT. The manager uploads this semicolon-separated
Excel export (UTF-8 with BOM, CRLF):

```csv
Staff;Payroll Number;Email;Date;Shift Start;Finish;Site;Break (mins);Notes
Jane Smith;E1042;;05/03/2026;09:00;17:00;High Street;30;
Smith, John;;;05/03/2026;2pm;10pm;High Street;;late
;;amira.khan@example.com;05/03/2026;22:00;06:00;Station Road;45;
Jane Smith;E1042;;05/03/2026;16:00;20:00;High Street;;overlaps row 2
Sam Lee;;;05/03/2026;09:00;17:00;High Street;;not an employee
Jane Smith;;;31/02/2026;09:00;17:00;High Street;;bad date
John Smith;E1043;;06/03/2026;09:00;17:00;High Street;;already in the database
Jane Smith;E1042;;06/03/2026;09:00;09:10;High Street;;too short
```

**1. Detect and map.** Delimiter `;`, header row detected. Suggested mapping (nothing needs confirmation):
`Staff → employee_name`, `Payroll Number → employee_id`, `Email → email`, `Date → date`,
`Shift Start → start_time`, `Finish → end_time`, `Site → location`, `Break (mins) → break_minutes`,
`Notes → (unmapped)`.

**2. Validate.** 8 data rows (rows 2–9):

| Row | Employee | Starts (UTC)     | Ends (UTC)       | Status  | Problems                                               |
| --- | -------- | ---------------- | ---------------- | ------- | ------------------------------------------------------ |
| 2   | jane     | 2026-03-05 09:00 | 2026-03-05 17:00 | ERROR   | OVERLAPPING_SHIFT — overlaps row 5                     |
| 3   | john     | 2026-03-05 14:00 | 2026-03-05 22:00 | VALID   | — (`Smith, John` matched by name; `2pm`/`10pm` parsed) |
| 4   | amira    | 2026-03-05 22:00 | 2026-03-06 06:00 | WARNING | OVERNIGHT_SHIFT; UNKNOWN_LOCATION "Station Road"       |
| 5   | jane     | 2026-03-05 16:00 | 2026-03-05 20:00 | ERROR   | OVERLAPPING_SHIFT — overlaps row 2                     |
| 6   | —        | 2026-03-05 09:00 | 2026-03-05 17:00 | ERROR   | EMPLOYEE_NOT_FOUND — suggested employee Sam Lee        |
| 7   | jane     | —                | —                | ERROR   | INVALID_DATE — "31 February 2026 is not a real date."  |
| 8   | john     | 2026-03-06 09:00 | 2026-03-06 17:00 | SKIPPED | DUPLICATE_SHIFT — identical shift already exists       |
| 9   | jane     | 2026-03-06 09:00 | 2026-03-06 09:10 | ERROR   | SHIFT_TOO_SHORT — 10 minutes, minimum 15               |

Row 4 has no name or ID but matches Amira by email (case-insensitively).

**3. Summary.** `{ total: 8, valid: 1, warning: 1, error: 5, skipped: 1, importable: 2 }`. The wizard
offers "create location Station Road" (`unknownLocations`), "create employee Sam Lee"
(`employeesToCreate`), and the errors CSV, whose first lines are:

```csv
row_number,status,problems,Staff,Payroll Number,Email,Date,Shift Start,Finish,Site,Break (mins),Notes
2,ERROR,ERROR OVERLAPPING_SHIFT: Overlaps row 5 in this file (same employee).,Jane Smith,E1042,,05/03/2026,09:00,17:00,High Street,30,
```

This example is the fixture of `packages/shared/src/csv/csvImport.test.ts`, so the outcome above is
checked on every test run.

## Wizard

The web wizard drives the endpoints below (`apps/web/src/server/imports`). Every route is scoped to the
manager's organisation through the session; reads need `schedule:read`, writes `imports:write`. The file is
read once, at upload: every later step works from the rows stored then, so a committed import is fully
reproducible from the database.

| Step        | Request                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Upload   | `POST /api/imports` — `multipart/form-data` with `file` (≤ 5 MB; `.csv`, `.txt` or `.tsv`; type `text/csv`, `application/csv`, `application/vnd.ms-excel`, `text/plain` or none) plus optional `dateFormat`, `timezone`, `locationId` fields                                                                                                                                                                                                                                                                                                                                                                 | `201 { import, suggestion, sampleRows }`. The import is `UPLOADED`; every data row is stored (`raw` cells, status `ERROR` as a placeholder, structural `INVALID_CSV` problems). `suggestion` = `suggestMapping(headers)`: `mapping`, `confidence` and `needsConfirmation` — generic headers (`ID`, `Name`, `Day`, `In`, `Out`, …), partial matches and contested fields that the wizard must make the manager confirm. Options default to the organisation's date format and timezone (the location's timezone when `locationId` is given). Errors: `UNSUPPORTED_MEDIA_TYPE` 415 (not multipart / not a CSV type), `PAYLOAD_TOO_LARGE` 413, `INVALID_CSV` 400 (`details.problems`, incl. `TOO_MANY_ROWS` above 5,000 data rows), `NOT_FOUND` 404 for a `locationId` outside the organisation. |
| 2. Map      | `POST /api/imports/:id/mapping { mapping, options? }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `200 { import, suggestion }`, status `MAPPED`. Keys must be headers of the file (`VALIDATION_ERROR`), each field at most once, and date, start time, end time plus one of employee ID / email / name must be mapped — otherwise `IMPORT_MAPPING_INCOMPLETE` with the `MappingCheck` as `details`. `options.dateFormat` / `timezone` / `locationId` (the location applied to rows with an empty location cell; `null` clears it) merge into the stored options. Headers longer than 200 characters cannot be mapped and are left out of the mapping. Allowed while `UPLOADED`, `MAPPED` or `VALIDATED` (counts reset; validate again).                                                                                                                                                         |
| 3. Validate | `POST /api/imports/:id/validate {}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `200 { import, summary }`, status `VALIDATED`. Runs `normaliseRows` (stored date format / timezone / default location), `matchRows` against the organisation's ACTIVE employees, then `validateRows` against live shifts of those employees in the file's window (not cancelled, not deleted) and the organisation's location names (`SHIFT_IN_PAST` uses the current time), and persists `parsed`, `problems`, `status` and `matchedEmployeeId` on every row plus the counts on the import. Re-runnable and idempotent. `IMPORT_MAPPING_INCOMPLETE` while still `UPLOADED`; `IMPORT_INVALID_STATE` once committed.                                                                                                                                                                           |
| 4. Review   | `GET /api/imports/:id` · `GET /api/imports/:id/rows?status&page&pageSize` · `GET /api/imports/:id/errors.csv`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | The import (with the suggestion repeated until committed), rows in file order (`raw`, `parsed`, `problems`, `matchedEmployee`, `createEmployee`, `createdShiftId`) and `toErrorsCsv` over every row with a problem as a `text/csv` attachment named `<file>-errors.csv`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 5. Fix rows | `PATCH /api/imports/:id/rows/:rowId` with exactly one of `{ matchedEmployeeId }` (pin an active employee of the organisation — `EMPLOYEE_NOT_FOUND` otherwise; `null` returns the row to automatic matching), `{ createEmployee: { firstName, lastName, email?, externalEmployeeId?, jobTitle?, primaryLocationId? } }` (creates the employee immediately through the employees service — requires `employees:write` — and pins them), `{ skip: true \| false }`, `{ locationAction: "CREATE" \| "IGNORE" }` (creates the row's unknown location in the organisation, or imports the row without a location) | `200 { row, summary }`. Requires status `VALIDATED`. The decision is stored with the row and the whole import is re-validated, so a sibling that overlapped a now-skipped row becomes importable and every earlier fix survives later validations.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 6. Commit   | `POST /api/imports/:id/commit { includeWarnings?: true, skipErrors?: false }`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `200 { import, shiftsCreated, employeesCreated, rowsSkipped }`, status `IMPORTED`. `IMPORT_HAS_ERRORS` 409 (`details.errorCount`) while `ERROR` rows remain unless `skipErrors` (they stay `ERROR`; nothing is created for them); `WARNING` rows are imported unless `includeWarnings: false` (then `SKIPPED`); `IMPORT_INVALID_STATE` when nothing would be created. One transaction creates a `Shift` per row — `source: CSV_IMPORT`, the row's instants and timezone, the location matched by name unless ignored — and marks the row `IMPORTED` with `createdShiftId`; `IMPORT_COMPLETED` is recorded (counts only), `SCHEDULE_CHANGED` is published per employee so devices re-sync, and `import.completed` goes to the dashboard stream.                                                |

Also: `GET /api/imports?status&page&pageSize` lists an organisation's imports, newest first.

Notes:

- `break_minutes` becomes one scheduled break of that length centred in the shift
  (`offsetMinutesFromStart = floor((shift minutes − break) / 2)`); none is created when it does not fit.
- `department` and `role` are informational: they stay on the row's `parsed` data and are never written to
  the shift.
- `skippedCount` on the import is derived (`rowCount − valid − warning − error − imported`) once validated;
  `summary.readyToCommit` is true for a `VALIDATED` import with no `ERROR` rows and at least one importable row.
- Row decisions are stored under a private `resolution` key inside `ShiftImportRow.parsed` (never returned by
  the API).
- Commit trusts the last validation; shifts created by other means in between are not re-checked — re-run
  validate first if the wizard was left open for a long time. It does re-check that every matched employee
  is still active: `IMPORT_INVALID_STATE` with `details.reason = "EMPLOYEE_NOT_ACTIVE"` and the row numbers.
- If the commit transaction itself fails, nothing is written and the import is closed as `FAILED` (audited as
  `import.failed` with the error code only); the wizard starts over from a fresh upload. `FAILED` is
  terminal: every write answers `IMPORT_INVALID_STATE`.
