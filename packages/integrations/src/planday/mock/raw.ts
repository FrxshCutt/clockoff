/**
 * Raw Planday JSON, as Mock Planday serves it (plan §12.1). Written from docs/integrations/PLANDAY_API_NOTES.md
 * §9 and the OpenAPI output models it cites (HR `EmployeeOutput`, `DeactivatedEmployeeOutput`,
 * `EmployeeDetailsOutput`; Scheduling `GetShiftOutputModel`, `GetDeletedShiftOutputModel`,
 * `DaySchedulesOutputModel`; Punch Clock `PunchClockShiftResponse`, `BreakResponse`; Portal
 * `GetPortalInfoOutput`), personal-data fields included. These types are the mock's own and deliberately do not
 * import the client's Zod schemas (`../schemas.ts`), so a schema mistake is caught rather than mirrored.
 */

/** `{ offset, limit, total }` of the HR and Scheduling list endpoints (notes §7). */
export interface PlandayJsonPaging {
  offset: number;
  limit: number;
  total: number;
}

/** `{ data, paging }` (notes §7); `paging` is nullable in some specs, and `setPagingNull` serves it as null. */
export interface PlandayJsonPagedResponse<T> {
  paging: PlandayJsonPaging | null;
  data: T[];
}

/** `GET /portal/v1.0/info` → `data` (notes §9.1). */
export interface PlandayJsonPortalInfo {
  id: number;
  name: string;
  companyName: string;
  country: string;
  timeZone: string;
  maxDepartments: number | null;
  aliases: string[] | null;
  portals: Array<{ id: number; name: string; aliases: string[] | null }> | null;
}

/** `GET /hr/v1.0/departments` item (`DepartmentOutput`). */
export interface PlandayJsonDepartment {
  id: number;
  name: string;
  number: string;
}

/** `GET /hr/v1.0/employeegroups` item (`EmployeeGroupOutput`). */
export interface PlandayJsonEmployeeGroup {
  id: number;
  name: string;
}

/** `bankAccount` on every employee schema (strip set E). */
export interface PlandayJsonBankAccount {
  registrationNumber: string | null;
  accountNumber: string | null;
}

/**
 * `GET /hr/v1.0/employees` item (`EmployeeOutput`): the "Uses" fields of notes §9.2 plus the whole strip set E.
 * `email` is typed nullable because the fixture's employee without an email address answers `null` (the spec
 * types it as a plain string; another fixture employee answers `""`).
 */
export interface PlandayJsonEmployee {
  id: number;
  firstName: string;
  lastName: string;
  email: string | null;
  departments: number[];
  primaryDepartmentId: number | null;
  employeeGroups: number[];
  deactivationDate: string | null;
  dateTimeCreated: string;
  dateTimeModified: string | null;
  dateTimeDeleted: string | null;
  // Strip set E (notes §9.2): never parsed by the client.
  userName: string;
  cellPhone: string;
  cellPhoneWithoutCountryPrefix: string | null;
  cellPhoneCountryPrefix: string | null;
  cellPhoneCountryCode: string | null;
  phone: string;
  phoneWithoutCountryPrefix: string | null;
  phoneCountryPrefix: string | null;
  phoneCountryCode: string | null;
  street1: string;
  street2: string;
  zip: string;
  city: string;
  hiredDate: string | null;
  salaryIdentifier: string;
  terminationTypeId: number | null;
  terminationTypeName: string | null;
  deactivationReason: string | null;
  ssn: string | null;
  bankAccount: PlandayJsonBankAccount | null;
  birthDate: string | null;
  employeeTypeId: number | null;
  isPublic: boolean | null;
  supervisorId: number | null;
  securityGroups: number[];
}

/** `GET /hr/v1.0/employees/deactivated` item (`DeactivatedEmployeeOutput`: no `securityGroups`, `supervisorId`, `primaryDepartmentId`). */
export type PlandayJsonDeactivatedEmployee = Omit<
  PlandayJsonEmployee,
  "securityGroups" | "supervisorId" | "primaryDepartmentId"
>;

/** A portal-defined custom field on the by-id employee (`custom_<n>`, strip set E+). */
export interface PlandayJsonCustomField {
  name: string;
  type: "Text" | "Numeric" | "Boolean" | "Date" | "Dropdown" | "Image";
  value: string | number | boolean | null;
  url: string | null;
}

/** Fields only `GET /hr/v1.0/employees/{employeeId}` has (strip set E+, plus `jobTitle` and `isDeactivated`). */
export interface PlandayJsonEmployeeDetailsExtra {
  gender: "Male" | "Female" | null;
  jobTitle: string;
  hiredFrom: string | null;
  countryId: number | null;
  workHours: number | null;
  contractRulesRuleId: number | null;
  supervisorEmployeeId: number | null;
  skillIds: number[];
  /** Keyed `custom_<n>`; additional properties on `EmployeeDetailsOutput`. */
  customFields: Record<string, PlandayJsonCustomField>;
}

/**
 * `GET /hr/v1.0/employees/{employeeId}` → `data` (`EmployeeDetailsOutput`): the list fields minus `hiredDate`,
 * `dateTimeDeleted` and the `*WithoutCountryPrefix` phones, plus E+, `jobTitle` and `isDeactivated`.
 */
export type PlandayJsonEmployeeDetails = Omit<
  PlandayJsonEmployee,
  "hiredDate" | "dateTimeDeleted" | "cellPhoneWithoutCountryPrefix" | "phoneWithoutCountryPrefix"
> &
  Omit<PlandayJsonEmployeeDetailsExtra, "customFields"> & {
    isDeactivated: boolean;
    [customField: `custom_${number}`]: PlandayJsonCustomField;
  };

/** `ShiftStatusExtended` (notes §10.1): the values `status` takes on a shift read. */
export const PLANDAY_JSON_SHIFT_STATUSES = [
  "Open",
  "Assigned",
  "Approved",
  "ForSale",
  "Draft",
  "OnDuty",
  "PendingSwapAcceptance",
  "PendingApproval",
  "PunchclockStarted",
  "PunchclockFinished",
  "PunchclockApproved",
] as const;

/** `GET /scheduling/v1.0/shifts` item (`GetShiftOutputModel`, every field required, several nullable). */
export interface PlandayJsonShift {
  id: number;
  departmentId: number | null;
  employeeId: number | null;
  employeeGroupId: number | null;
  positionId: number | null;
  shiftTypeId: number | null;
  date: string | null;
  comment: string | null;
  timeZone: string;
  punchClockShiftId: number | null;
  startDateTime: string | null;
  endDateTime: string | null;
  /** A `ShiftStatusExtended` value; typed as string so tests can serve an undocumented status. */
  status: string;
  dateTimeCreated: string | null;
  dateTimeModified: string | null;
  skillIds: number[];
}

/** `GET /scheduling/v1.0/shifts/deleted` item (`GetDeletedShiftOutputModel`). */
export type PlandayJsonDeletedShift = Omit<PlandayJsonShift, "punchClockShiftId" | "skillIds"> & {
  dateTimeDeleted: string | null;
  deletedBy: number;
};

/** `GET /scheduling/v1.0/scheduleDay` item (`DaySchedulesOutputModel`). */
export interface PlandayJsonScheduleDay {
  date: string;
  title: string | null;
  description: string | null;
  isVisible: boolean | null;
  holiday: Array<{ name: string }> | null;
  lockState: "Unlocked" | "ManagerLocked" | "SalaryLocked";
  departmentId: number;
  id: number | null;
}

/** `GET /punchclock/v1.0/punchclockshifts` item (`PunchClockShiftResponse`). */
export interface PlandayJsonPunchClockShift {
  id: number;
  shiftId: number | null;
  departmentId: number;
  employeeId: number | null;
  startDateTime: string | null;
  endDateTime: string | null;
  shiftStartDateTime: string | null;
  shiftEndDateTime: string | null;
  description: string | null;
  isApproved: boolean | null;
}

/** `GET /punchclock/v1.0/punchclockshifts/{id}/breaks` item (`BreakResponse`; `punchClocksShiftId` is the spec spelling). */
export interface PlandayJsonPunchClockBreak {
  id: number;
  punchClocksShiftId: number | null;
  startDateTime: string;
  endDateTime: string | null;
  duration: string | null;
}

/** RFC 7807 `ProblemDetails` (notes §8). */
export interface PlandayJsonProblemDetails {
  type: string | null;
  title: string | null;
  status: number | null;
  detail: string | null;
  instance: string | null;
}

/** `POST /connect/token` success body (notes §3.2 A step 5; the refresh grant promises only `access_token`). */
export interface PlandayJsonTokenResponse {
  access_token: string;
  expires_in?: number;
  token_type?: "Bearer";
  refresh_token?: string;
  scope?: string;
  id_token?: string;
}
