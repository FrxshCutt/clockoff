/**
 * Papa Parse wrapper: file checks, header detection and row extraction. Pure — takes the file text,
 * returns rows; never throws for bad input (problems are returned), so the API decides the HTTP response.
 *
 * Row numbers are spreadsheet-style (header row = 1, first data row = 2) so a manager can find the row in
 * Excel / Google Sheets. Blank lines are skipped but still counted. A quoted cell containing a line break
 * is still one row, exactly as a spreadsheet shows it.
 */
import Papa from "papaparse";
import { AppError } from "../errors";
import { scoreHeader } from "./headerMapping";
import { parseImportTime } from "./parseDateTime";
import { IMPORT_LIMITS, problem, type ImportProblem } from "./types";

/** Delimiters Papa may choose between when auto-detecting. */
export const CSV_DELIMITERS = [",", ";", "\t", "|"] as const;
export type CsvDelimiter = (typeof CSV_DELIMITERS)[number];

/** File extensions accepted by `validateImportFile` (case-insensitive). */
export const IMPORT_FILE_EXTENSIONS = [".csv", ".txt", ".tsv"] as const;

export interface DetectHeadersResult {
  /** Header names (deduplicated; blank headers become "Column N"), or "Column N" for every column when no header row. */
  headers: string[];
  /** Up to IMPORT_LIMITS.sampleRows data rows, cells trimmed and padded/truncated to the header count. */
  sampleRows: string[][];
  delimiter: string;
  hasHeaderRow: boolean;
}

/** A data row with its spreadsheet row number and any structural problems. */
export interface CsvRow {
  rowNumber: number;
  /** Trimmed cell values keyed by header. Extra non-empty cells beyond the headers appear as "Column N". */
  values: Record<string, string>;
  /** Structural problems for this row (more cells than headers). */
  problems: ImportProblem[];
}

export interface ParseCsvOptions {
  /** Maximum data rows accepted (default IMPORT_LIMITS.maxRows = 5000); more → TOO_MANY_ROWS and no rows returned. */
  maxRows?: number;
  /** Set false when `detectHeaders` found no header row; columns are then "Column 1".."Column N". Default true. */
  hasHeaderRow?: boolean;
  /** Force a delimiter (e.g. `detectHeaders().delimiter`) instead of auto-detecting. */
  delimiter?: string;
}

export interface ParseCsvResult {
  headers: string[];
  /** Cell values keyed by header, one per data row (§6.5 shape). `rows[i] === records[i].values`. */
  rows: Array<Record<string, string>>;
  /** The same rows with spreadsheet row numbers and structural problems — feed these to `normaliseRows`. */
  records: CsvRow[];
  /** File-level errors (empty file, no data rows, too many rows). Non-empty means the file is unusable. */
  errors: ImportProblem[];
  delimiter: string;
}

interface PreparedText {
  text: string;
  /** Delimiter declared by an Excel `sep=;` first line, which is removed (Excel does not show it as a row). */
  declaredDelimiter?: CsvDelimiter;
}

const SEP_DIRECTIVE = /^sep=(.)(?:\n|$)/i;

function isCsvDelimiter(value: string): value is CsvDelimiter {
  return (CSV_DELIMITERS as readonly string[]).includes(value);
}

/**
 * BOM removed; CRLF and lone CR normalised to LF so mixed line endings cannot merge rows; an Excel
 * `sep=<delimiter>` directive line is consumed.
 */
function prepare(text: string): PreparedText {
  const noBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const normalised = noBom.replace(/\r\n?/g, "\n");
  const sep = SEP_DIRECTIVE.exec(normalised);
  if (sep !== null && isCsvDelimiter(sep[1]!)) {
    return { text: normalised.slice(sep[0].length), declaredDelimiter: sep[1] };
  }
  return { text: normalised };
}

/**
 * NUL characters never occur in a text CSV; they mean an Excel workbook (.xlsx / .xls) renamed to .csv,
 * or a UTF-16 "Unicode text" export decoded as UTF-8. Parsing either would produce garbage rows.
 */
function looksBinary(text: string): boolean {
  return text.includes("\u0000");
}

const NOT_TEXT_MESSAGE =
  "The file is not a plain-text CSV (it may be an Excel workbook or saved as UTF-16). In Excel use Save As → 'CSV UTF-8 (Comma delimited)' and upload that file.";

/**
 * Picks the delimiter from the first lines. Blank lines are ignored for the guess (Papa otherwise counts a
 * trailing newline as a one-column row and rejects every candidate on small files). Defaults to ",".
 */
function guessDelimiter(text: string): string {
  const result = Papa.parse<string[]>(text, {
    delimiter: "",
    delimitersToGuess: [...CSV_DELIMITERS],
    skipEmptyLines: "greedy",
    preview: 10,
  });
  return result.meta.delimiter || ",";
}

interface RawParse {
  records: string[][];
  delimiter: string;
  errors: Papa.ParseError[];
}

function rawParse(text: string, delimiter: string | undefined, preview?: number): RawParse {
  const { text: prepared, declaredDelimiter } = prepare(text);
  const chosen =
    delimiter !== undefined && delimiter !== ""
      ? delimiter
      : (declaredDelimiter ?? guessDelimiter(prepared));
  const result = Papa.parse<string[]>(prepared, {
    delimiter: chosen,
    newline: "\n",
    header: false,
    dynamicTyping: false,
    skipEmptyLines: false,
    ...(preview !== undefined ? { preview } : {}),
  });
  return { records: result.data, delimiter: chosen, errors: result.errors };
}

function isBlank(cells: readonly string[]): boolean {
  return cells.every((c) => c.trim() === "");
}

/**
 * `base`, or `base (2)`, `base (3)`, ... — the first that is not `taken`. `alwaysSuffix` skips the bare
 * name (used for a repeated header, whose bare name belongs to its first occurrence).
 */
function uniqueName(base: string, taken: (name: string) => boolean, alwaysSuffix = false): string {
  if (!alwaysSuffix && !taken(base)) return base;
  for (let n = 2; ; n++) {
    const name = `${base} (${n})`;
    if (!taken(name)) return name;
  }
}

/**
 * Trims headers, names blanks "Column N" and suffixes repeats " (2)", " (3)", ... The result is always
 * unique (rows are keyed by header, so two equal names would silently overwrite a cell), and a name
 * written in the file is never taken by a generated one: `Start, Start, Start (2)` becomes
 * `Start, Start (3), Start (2)`.
 */
export function normaliseHeaders(cells: readonly string[]): string[] {
  const trimmed = cells.map((cell) => cell.trim());
  const written = new Set(trimmed.filter((cell) => cell !== ""));
  const used = new Set<string>();
  const taken = (name: string): boolean => written.has(name) || used.has(name);
  return trimmed.map((cell, i) => {
    let name: string;
    if (cell === "") name = uniqueName(`Column ${i + 1}`, taken);
    else if (!used.has(cell)) name = cell;
    else name = uniqueName(cell, taken, true);
    used.add(name);
    return name;
  });
}

function positionalHeaders(count: number): string[] {
  return Array.from({ length: count }, (_, i) => `Column ${i + 1}`);
}

const DATE_LIKE = /^\d{1,4}[/.-]\d{1,2}[/.-]\d{1,4}$/;
const EMAIL_LIKE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Heuristic: does this cell look like data (date, time, number, email) rather than a column name? */
export function looksLikeData(cell: string): boolean {
  const v = cell.trim();
  if (v === "") return false;
  if (/^-?\d+(\.\d+)?$/.test(v)) return true;
  if (DATE_LIKE.test(v)) return true;
  if (EMAIL_LIKE.test(v)) return true;
  if (/\d/.test(v) && parseImportTime(v).ok) return true;
  return false;
}

/**
 * Decides whether the first non-blank line is a header row:
 *  - any data-like cell (date, time, number, email) → it is data, not a header;
 *  - otherwise any cell that maps to an import field → header;
 *  - otherwise header iff the next line contains data-like cells (or there is no next line).
 */
export function detectHeaderRow(
  first: readonly string[],
  second: readonly string[] | undefined,
): boolean {
  if (first.some(looksLikeData)) return false;
  if (first.some((c) => scoreHeader(c).field !== null)) return true;
  return second === undefined || second.some(looksLikeData);
}

/** Reads the first few lines to drive the mapping step. Never throws; an empty file yields no headers. */
export function detectHeaders(csvText: string): DetectHeadersResult {
  if (looksBinary(csvText)) {
    return { headers: [], sampleRows: [], delimiter: ",", hasHeaderRow: false };
  }
  const { records, delimiter } = rawParse(csvText, undefined, 50);
  const lines = records.filter((r) => !isBlank(r)).slice(0, IMPORT_LIMITS.sampleRows + 1);
  const first = lines[0];
  if (first === undefined) return { headers: [], sampleRows: [], delimiter, hasHeaderRow: false };

  const hasHeaderRow = detectHeaderRow(first, lines[1]);
  const headers = hasHeaderRow ? normaliseHeaders(first) : positionalHeaders(first.length);
  const dataLines = hasHeaderRow ? lines.slice(1) : lines;
  const sampleRows = dataLines
    .slice(0, IMPORT_LIMITS.sampleRows)
    .map((cells) => headers.map((_, i) => (cells[i] ?? "").trim()));
  return { headers, sampleRows, delimiter, hasHeaderRow };
}

/**
 * Parses the whole file into keyed rows. File-level failures are reported in `errors` (never thrown);
 * per-row structural issues are attached to the row so they show up next to its other problems.
 */
export function parseCsv(csvText: string, options: ParseCsvOptions = {}): ParseCsvResult {
  const maxRows = options.maxRows ?? IMPORT_LIMITS.maxRows;
  const hasHeaderRow = options.hasHeaderRow ?? true;
  if (looksBinary(csvText)) {
    return {
      headers: [],
      rows: [],
      records: [],
      delimiter: options.delimiter ?? ",",
      errors: [problem("INVALID_CSV", NOT_TEXT_MESSAGE)],
    };
  }
  const { records: raw, delimiter, errors: papaErrors } = rawParse(csvText, options.delimiter);

  // A quote error means Papa could not tell where cells and rows end: an unclosed quote swallows every
  // following line into one cell. Nothing after it can be trusted, so the whole file is rejected rather
  // than silently dropping the swallowed rows.
  const quoteError = papaErrors.find((e) => e.type === "Quotes");
  if (quoteError !== undefined) {
    const rowNumber = (quoteError.row ?? 0) + 1; // Papa's 0-based record index → spreadsheet row
    const what =
      quoteError.code === "MissingQuotes"
        ? 'a cell opens a quote (") that is never closed'
        : "a quoted cell has extra characters after its closing quote";
    return {
      headers: [],
      rows: [],
      records: [],
      delimiter,
      errors: [
        problem(
          "INVALID_CSV",
          `Row ${rowNumber}: ${what}, so the rest of the file cannot be read reliably. Fix the quotes in the source file and upload it again.`,
          { details: { rowNumber, reason: quoteError.code } },
        ),
      ],
    };
  }

  let headers: string[] | null = null;
  let dataCount = 0;
  const records: CsvRow[] = [];

  for (let i = 0; i < raw.length; i++) {
    const cells = raw[i]!;
    if (isBlank(cells)) continue;
    const rowNumber = i + 1;

    if (headers === null) {
      if (hasHeaderRow) {
        headers = normaliseHeaders(cells);
        continue;
      }
      headers = positionalHeaders(cells.length);
    }

    dataCount++;
    if (dataCount > maxRows) {
      return {
        headers,
        rows: [],
        records: [],
        delimiter,
        errors: [
          problem(
            "TOO_MANY_ROWS",
            `The file has more than ${maxRows.toLocaleString("en-GB")} rows; split it and import the parts separately.`,
            { details: { maxRows } },
          ),
        ],
      };
    }

    const columnCount = headers.length;
    // Built with Object.fromEntries so every header — even "__proto__" — becomes an own property.
    const entries: Array<[string, string]> = headers.map((h, j) => [h, (cells[j] ?? "").trim()]);
    const problems: ImportProblem[] = [];

    const nonEmptyExtras = cells
      .slice(columnCount)
      .map((c, k) => ({ index: columnCount + k, value: c.trim() }))
      .filter((e) => e.value !== "");
    if (nonEmptyExtras.length > 0) {
      // Extra cells are kept as "Column N", renamed if a real header already has that name.
      const names = new Set(headers);
      for (const e of nonEmptyExtras) {
        const name = uniqueName(`Column ${e.index + 1}`, (n) => names.has(n));
        names.add(name);
        entries.push([name, e.value]);
      }
      problems.push(
        problem(
          "INVALID_CSV",
          `Row has ${nonEmptyExtras.length} more value${nonEmptyExtras.length === 1 ? "" : "s"} than there are headers, so its cells may be shifted (an unquoted comma in a cell?). Quote the cell or add a header for the extra column.`,
          { details: { extraCells: nonEmptyExtras.length } },
        ),
      );
    }

    records.push({ rowNumber, values: Object.fromEntries(entries), problems });
  }

  if (headers === null) {
    return {
      headers: [],
      rows: [],
      records: [],
      delimiter,
      errors: [problem("INVALID_CSV", "The file is empty.")],
    };
  }
  if (records.length === 0) {
    return {
      headers,
      rows: [],
      records,
      delimiter,
      errors: [problem("INVALID_CSV", "The file has a header row but no data rows.")],
    };
  }
  return { headers, rows: records.map((r) => r.values), records, delimiter, errors: [] };
}

export interface ImportFileInfo {
  /** Original filename, used only for the extension check. */
  name: string;
  /** Size in bytes. */
  size: number;
}

/**
 * Upload-time checks shared by the web dropzone and the upload endpoint: non-empty, at most 5 MB, and a
 * .csv / .txt / .tsv extension. Returns file-level problems (empty when acceptable).
 */
export function validateImportFile(
  file: ImportFileInfo,
  maxBytes: number = IMPORT_LIMITS.maxFileBytes,
): ImportProblem[] {
  const problems: ImportProblem[] = [];
  const lower = file.name.trim().toLowerCase();
  if (!IMPORT_FILE_EXTENSIONS.some((ext) => lower.endsWith(ext))) {
    problems.push(
      problem("INVALID_CSV", "Upload a .csv file (comma, semicolon or tab separated).", {
        details: { name: file.name },
      }),
    );
  }
  if (file.size <= 0) {
    problems.push(problem("INVALID_CSV", "The file is empty."));
  } else if (file.size > maxBytes) {
    const mb = (n: number) =>
      `${(n / (1024 * 1024)).toLocaleString("en-GB", { maximumFractionDigits: 1 })} MB`;
    problems.push(
      problem("FILE_TOO_LARGE", `The file is ${mb(file.size)}; the limit is ${mb(maxBytes)}.`, {
        details: { size: file.size, maxBytes },
      }),
    );
  }
  return problems;
}

/**
 * Converts file-level problems (from `validateImportFile` or `parseCsv().errors`) into the API error:
 * FILE_TOO_LARGE → PAYLOAD_TOO_LARGE (413), everything else → INVALID_CSV (400). `details.problems`
 * carries all of them. Call only with a non-empty list.
 */
export function importFileErrorToAppError(problems: readonly ImportProblem[]): AppError {
  const first = problems[0];
  if (first === undefined) return new AppError("INVALID_CSV", "The file could not be read.");
  const code = problems.some((p) => p.code === "FILE_TOO_LARGE")
    ? "PAYLOAD_TOO_LARGE"
    : "INVALID_CSV";
  const lead = problems.find((p) => p.code === "FILE_TOO_LARGE") ?? first;
  return new AppError(code, lead.message, { details: { problems } });
}
