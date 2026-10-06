/**
 * Header detection helpers: normalising CSV header text and suggesting a column → field mapping.
 *
 * The suggestion is exactly that — the wizard shows it for confirmation. When two headers compete for
 * the same field, or one header could be two different fields, we leave it unmapped rather than guess.
 */
import {
  EMPLOYEE_IDENTIFIER_FIELDS,
  IMPORT_FIELDS,
  REQUIRED_IMPORT_FIELDS,
  type ColumnMapping,
  type ImportField,
} from "./types";

/**
 * Alias phrases per field, already normalised (lower-case, single spaces, no punctuation). Matching is done
 * on the normalised header, so "Shift_Start", "SHIFT START" and "shift-start" all become "shift start".
 */
export const FIELD_ALIASES: Record<ImportField, readonly string[]> = {
  employee_name: [
    "employee name",
    "employee",
    "name",
    "full name",
    "fullname",
    "staff",
    "staff name",
    "staff member",
    "team member",
    "team member name",
    "worker",
    "worker name",
    "colleague",
    "person",
    "member",
    "employee full name",
    "colleague name",
    "crew",
    "crew member",
  ],
  employee_id: [
    "employee id",
    "employee number",
    "employee no",
    "employee ref",
    "employee reference",
    "staff id",
    "staff number",
    "staff no",
    "payroll id",
    "payroll number",
    "payroll no",
    "payroll code",
    "employee code",
    "staff code",
    "emp id",
    "emp no",
    "id",
    "external id",
    "external employee id",
    "worker id",
    "person id",
    "badge",
    "badge id",
    "badge number",
    "clock id",
    "clock number",
    "clock no",
    "ref",
    "reference",
  ],
  email: [
    "email",
    "e mail",
    "email address",
    "e mail address",
    "mail",
    "employee email",
    "staff email",
    "work email",
    "login email",
  ],
  date: [
    "date",
    "shift date",
    "day",
    "work date",
    "working date",
    "start date",
    "rota date",
    "date of shift",
    "schedule date",
    "shift day",
  ],
  start_time: [
    "start time",
    "start",
    "starts",
    "starts at",
    "start at",
    "shift start",
    "shift start time",
    "time in",
    "clock in",
    "begin",
    "begins",
    "from",
    "in",
    "start hour",
  ],
  end_time: [
    "end time",
    "end",
    "ends",
    "ends at",
    "end at",
    "shift end",
    "shift end time",
    "finish",
    "finish time",
    "finishes",
    "finishing time",
    "time out",
    "clock out",
    "stop",
    "to",
    "until",
    "out",
    "end hour",
  ],
  location: [
    "location",
    "location name",
    "site",
    "site name",
    "store",
    "store name",
    "branch",
    "venue",
    "shop",
    "workplace",
    "place",
    "unit",
    "outlet",
    "office",
    "restaurant",
    "building",
  ],
  department: [
    "department",
    "department name",
    "dept",
    "team",
    "team name",
    "section",
    "area",
    "division",
    "group",
  ],
  role: ["role", "position", "job", "job title", "job role", "shift role", "duty"],
  break_minutes: [
    "break minutes",
    "break mins",
    "break min",
    "break",
    "breaks",
    "break length",
    "break duration",
    "break time",
    "unpaid break",
    "unpaid break minutes",
    "unpaid break mins",
    "break minutes unpaid",
    "break mins unpaid",
    "break unpaid",
    "rest minutes",
  ],
};

/**
 * Lower-case, Unicode-normalised, punctuation → spaces, collapsed whitespace, BOM removed. camelCase /
 * PascalCase words are split ("StartTime" → "start time", "EmployeeID" → "employee id") and "#" reads as
 * "number" ("Employee #" → "employee number", so it is an ID column, not a name column).
 */
export function normaliseHeader(header: string): string {
  return header
    .replace(/^\uFEFF/, "")
    .normalize("NFKC")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/#/g, " number ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** Confidence tiers returned by `suggestMapping`. */
export const MAPPING_CONFIDENCE = {
  /** Header is the canonical field name (start_time / "Start Time"). */
  EXACT: 1,
  /** Header is a known alias ("Shift Start"). */
  ALIAS: 0.9,
  /** A distinctive alias appears inside a longer header ("Shift Start (24h)"). Needs confirmation. */
  PARTIAL: 0.6,
  NONE: 0,
} as const;

/**
 * Mappings below this confidence (i.e. PARTIAL) must be highlighted for the manager to confirm before the
 * import continues. EXACT and ALIAS mappings are pre-selected but still editable.
 */
export const MAPPING_CONFIDENCE_THRESHOLD = MAPPING_CONFIDENCE.ALIAS;

/**
 * Aliases that are fine as a whole header ("In", "Out", "ID", "Name") but far too generic to trigger a
 * partial match inside a longer header ("Shift ID", "Notes on shift", "Pay Group", "Company Name"). They
 * still count as covered words once a distinctive alias of the same field has matched.
 */
const WEAK_ALIASES: ReadonlySet<string> = new Set([
  "in",
  "out",
  "to",
  "from",
  "until",
  "stop",
  "begin",
  "begins",
  "id",
  "ref",
  "reference",
  "day",
  "name",
  "member",
  "person",
  "place",
  "unit",
  "group",
  "area",
  "section",
  "division",
  "job",
  "duty",
  "mail",
  "team",
  "office",
  "building",
  "crew",
]);

/**
 * The only words a longer header may contain besides the matched alias for a partial match: format and
 * unit annotations ("(24h)", "(DD/MM/YYYY)", "(mins)") and words that merely say the column belongs to the
 * shift ("Scheduled Start", "Work Location", "Rota Date"). Any other word means the column is probably
 * about something else ("Store ID", "Location Code", "Employee Notes", "Pay Date", "Contract Start",
 * "Manager Email", "Date of Birth", "Break (hours)"), so it stays unmapped for the manager to decide.
 */
const NEUTRAL_WORDS: ReadonlySet<string> = new Set([
  // format / unit annotations
  "24h",
  "24hr",
  "24hrs",
  "12h",
  "12hr",
  "hh",
  "mm",
  "ss",
  "hhmm",
  "dd",
  "yy",
  "yyyy",
  "am",
  "pm",
  "min",
  "mins",
  "minutes",
  "local",
  "format",
  // "this belongs to the shift"
  "shift",
  "shifts",
  "rota",
  "roster",
  "rostered",
  "schedule",
  "scheduled",
  "planned",
  "work",
  "working",
  "assigned",
  // filler
  "the",
  "of",
  "for",
  "e",
  "g",
]);

function isNeutral(word: string): boolean {
  return NEUTRAL_WORDS.has(word) || /^\d+$/.test(word);
}

export interface HeaderScore {
  field: ImportField | null;
  confidence: number;
}

function phraseAt(words: readonly string[], phrase: readonly string[], i: number): boolean {
  for (let j = 0; j < phrase.length; j++) {
    if (words[i + j] !== phrase[j]) return false;
  }
  return true;
}

function containsPhrase(words: readonly string[], phrase: readonly string[]): boolean {
  if (phrase.length === 0 || phrase.length > words.length) return false;
  for (let i = 0; i + phrase.length <= words.length; i++) {
    if (phraseAt(words, phrase, i)) return true;
  }
  return false;
}

const NONE: HeaderScore = { field: null, confidence: MAPPING_CONFIDENCE.NONE };

/** Space-free spellings ("starttime", "employeeid") → field, built once. */
const COMPACT_LOOKUP: ReadonlyMap<string, { field: ImportField; exact: boolean }> = (() => {
  const map = new Map<string, { field: ImportField; exact: boolean }>();
  for (const field of IMPORT_FIELDS) {
    map.set(field.replace(/_/g, ""), { field, exact: true });
  }
  for (const field of IMPORT_FIELDS) {
    for (const alias of FIELD_ALIASES[field]) {
      const key = alias.replace(/ /g, "");
      if (!map.has(key)) map.set(key, { field, exact: false });
    }
  }
  return map;
})();

/** Scores a single header against the canonical names and aliases. Pure; no cross-header reasoning. */
export function scoreHeader(header: string): HeaderScore {
  const n = normaliseHeader(header);
  if (n === "") return NONE;

  for (const field of IMPORT_FIELDS) {
    if (n === field.replace(/_/g, " ")) return { field, confidence: MAPPING_CONFIDENCE.EXACT };
  }
  for (const field of IMPORT_FIELDS) {
    if (FIELD_ALIASES[field].includes(n)) return { field, confidence: MAPPING_CONFIDENCE.ALIAS };
  }
  // "starttime", "employeeid", "fullname": a known name written without spaces.
  const compact = COMPACT_LOOKUP.get(n.replace(/ /g, ""));
  if (compact !== undefined) return { field: compact.field, confidence: MAPPING_CONFIDENCE.ALIAS };

  // Partial: the longest distinctive alias contained in the header decides the field; two fields tied
  // on length are ambiguous. Every other word must be neutral (format annotation or "shift"-like word).
  const words = n.split(" ");
  let bestLength = 0;
  const bestFields = new Set<ImportField>();
  for (const field of IMPORT_FIELDS) {
    for (const alias of FIELD_ALIASES[field]) {
      if (WEAK_ALIASES.has(alias)) continue;
      const phrase = alias.split(" ");
      if (phrase.length < bestLength || !containsPhrase(words, phrase)) continue;
      if (phrase.length > bestLength) {
        bestLength = phrase.length;
        bestFields.clear();
      }
      bestFields.add(field);
    }
  }
  if (bestFields.size !== 1) return NONE;
  const [field] = [...bestFields] as [ImportField];

  const covered = words.map(() => false);
  for (const alias of FIELD_ALIASES[field]) {
    const phrase = alias.split(" ");
    for (let i = 0; i + phrase.length <= words.length; i++) {
      if (phraseAt(words, phrase, i)) for (let j = 0; j < phrase.length; j++) covered[i + j] = true;
    }
  }
  const onlyNeutralExtras = words.every((w, i) => covered[i] === true || isNeutral(w));
  return onlyNeutralExtras ? { field, confidence: MAPPING_CONFIDENCE.PARTIAL } : NONE;
}

/** True when the header is a whole-header match on a generic alias ("In", "Day", "Name"). */
function isWeakAliasHeader(header: string): boolean {
  return WEAK_ALIASES.has(normaliseHeader(header));
}

export interface MappingSuggestion {
  /** `{ header: field | null }`, ready to be stored or edited by the wizard. */
  mapping: ColumnMapping;
  /** `{ header: 0..1 }` — 1 exact, 0.9 alias, 0.6 partial, 0 unmapped. */
  confidence: Record<string, number>;
  /**
   * Headers whose suggested field needs explicit confirmation: confidence below
   * MAPPING_CONFIDENCE_THRESHOLD (partial matches); a generic one-word header ("ID", "Ref", "Name",
   * "In", "Day", "Team"), which other exports use for something else (an "ID" or "Reference" column is
   * often the shift's own id, and a numeric one could coincide with an employee's payroll ID); or the field
   * was contested by another header that scored just as well (e.g. "Start" and "Shift Start").
   */
  needsConfirmation: string[];
}

/**
 * Suggests a field for every header. Each field is used at most once: when several headers score for the
 * same field the highest confidence keeps it; between equal confidences a specific alias beats a generic
 * one ("Shift Date" beats "Day"), then the leftmost header wins — and is flagged for confirmation, since
 * the choice between equally good candidates is a guess. Generic one-word headers are flagged too.
 */
export function suggestMapping(headers: readonly string[]): MappingSuggestion {
  const scores = headers.map((h) => {
    const score = scoreHeader(h);
    const generic = score.field !== null && isWeakAliasHeader(h);
    // Rank: confidence first, then specific (non-generic) aliases.
    return { header: h, ...score, generic, rank: score.confidence * 10 + (generic ? 0 : 1) };
  });
  const winner = new Map<ImportField, number>(); // field → index of the header that keeps it
  const contested = new Set<ImportField>();
  scores.forEach((s, i) => {
    if (s.field === null) return;
    const current = winner.get(s.field);
    if (current === undefined) {
      winner.set(s.field, i);
      return;
    }
    const best = scores[current]!.rank;
    if (s.rank > best) {
      winner.set(s.field, i);
      contested.delete(s.field);
    } else if (s.rank === best) {
      contested.add(s.field);
    }
  });

  // Object.fromEntries keeps every header as an own key, even "__proto__".
  const mappingEntries: Array<[string, ImportField | null]> = [];
  const confidenceEntries: Array<[string, number]> = [];
  const needsConfirmation: string[] = [];
  scores.forEach((s, i) => {
    const keeps = s.field !== null && winner.get(s.field) === i;
    mappingEntries.push([s.header, keeps ? s.field : null]);
    confidenceEntries.push([s.header, keeps ? s.confidence : MAPPING_CONFIDENCE.NONE]);
    if (
      keeps &&
      s.field !== null &&
      (s.confidence < MAPPING_CONFIDENCE_THRESHOLD || s.generic || contested.has(s.field))
    ) {
      needsConfirmation.push(s.header);
    }
  });
  return {
    mapping: Object.fromEntries(mappingEntries),
    confidence: Object.fromEntries(confidenceEntries),
    needsConfirmation,
  };
}

export interface MappingCheck {
  complete: boolean;
  /** Required fields (date/start_time/end_time) with no header mapped to them. */
  missingRequired: ImportField[];
  /** True when none of employee_id / email / employee_name is mapped. */
  missingIdentifier: boolean;
  /** Fields mapped from more than one header — the wizard must resolve these. */
  duplicated: ImportField[];
}

/** Checks a (possibly user-edited) mapping is usable. Mirrors the API's IMPORT_MAPPING_INCOMPLETE rule. */
export function checkMapping(mapping: ColumnMapping): MappingCheck {
  const counts = new Map<ImportField, number>();
  for (const field of Object.values(mapping)) {
    if (field === null) continue;
    counts.set(field, (counts.get(field) ?? 0) + 1);
  }
  const missingRequired = REQUIRED_IMPORT_FIELDS.filter((f) => !counts.has(f));
  const missingIdentifier = !EMPLOYEE_IDENTIFIER_FIELDS.some((f) => counts.has(f));
  const duplicated = IMPORT_FIELDS.filter((f) => (counts.get(f) ?? 0) > 1);
  return {
    complete: missingRequired.length === 0 && !missingIdentifier && duplicated.length === 0,
    missingRequired,
    missingIdentifier,
    duplicated,
  };
}

/** `{ field: header }` — the first header mapped to each field, in header order. */
export function invertMapping(mapping: ColumnMapping): Partial<Record<ImportField, string>> {
  const out: Partial<Record<ImportField, string>> = {};
  for (const [header, field] of Object.entries(mapping)) {
    if (field !== null && out[field] === undefined) out[field] = header;
  }
  return out;
}
