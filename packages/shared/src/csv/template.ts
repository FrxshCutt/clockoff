/**
 * The downloadable template. `docs/templates/shift-import-template.csv` must equal `generateTemplateCsv()`;
 * `template.test.ts` guards that.
 */
import Papa from "papaparse";
import { IMPORT_FIELDS, type ImportField } from "./types";

export const IMPORT_TEMPLATE_ROWS: ReadonlyArray<Record<ImportField, string>> = [
  {
    employee_name: "Jane Smith",
    employee_id: "E1042",
    email: "jane.smith@example.com",
    date: "2030-03-05",
    start_time: "09:00",
    end_time: "17:00",
    location: "High Street",
    department: "Front of house",
    role: "Barista",
    break_minutes: "30",
  },
  {
    employee_name: "Smith, John",
    employee_id: "E1043",
    email: "",
    date: "2030-03-05",
    start_time: "2pm",
    end_time: "10pm",
    location: "High Street",
    department: "Kitchen",
    role: "Chef",
    break_minutes: "",
  },
  {
    employee_name: "",
    employee_id: "E1044",
    email: "amira.khan@example.com",
    date: "2030-03-06",
    start_time: "07:30",
    end_time: "15:30",
    location: "Station Road",
    department: "",
    role: "Supervisor",
    break_minutes: "45",
  },
];

/**
 * Header + three example rows: full identifiers, a 'Last, First' name with 12-hour times, and a row
 * identified by ID and email only. Every row is clean — the template goes through the same pipeline as
 * an upload with zero problems (no warnings either), which `template.test.ts` checks end to end. The
 * dates are deliberately years ahead so an unedited template never gets SHIFT_IN_PAST warnings.
 */
export function generateTemplateCsv(): string {
  const data = IMPORT_TEMPLATE_ROWS.map((row) => IMPORT_FIELDS.map((f) => row[f]));
  return Papa.unparse({ fields: [...IMPORT_FIELDS], data }, { newline: "\r\n" }) + "\r\n";
}
