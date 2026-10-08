/**
 * The Mock Planday fixture (spec §11, plan §12.3). `buildPlandayFixture({ anchor })` lays out four weeks from
 * the Monday of `anchor`'s week in Europe/London; tests use `anchor = FROZEN_NOW` (weeks of 19 Oct, 26 Oct,
 * 2 Nov and 9 Nov 2026), the e2e suite and `scripts/mock-planday.mts` the real date.
 *
 * Main portal 4100001 "Mock Bistro Group": 3 departments (Head Office is the one tests exclude), 4 employee
 * groups, 12 employees and 60 shifts at `FROZEN_NOW` (a weekly pattern of 51 plus 9 specials). Portal 4100002
 * "Mock Cafe Co" reuses employee and shift ids (tenant isolation, portal switch); portal 4100003 "Mock Kiosk"
 * has no departments at all ("Not in any department", plan §6.3). Every raw employee carries the strip-set
 * fields of notes §9.2 filled with sentinels, and every shift a sentinel `comment`, so the data-minimisation
 * suite can prove none of them is persisted or logged.
 */
import { addLocalDays, resolveWallClock, weekStart } from "@clockoff/shared/time/zone";
import { isoZ, localDateOfMs, localToMs, msToLocal, parseLocalDateTime } from "./datetime";
import type {
  PlandayJsonDepartment,
  PlandayJsonEmployee,
  PlandayJsonEmployeeDetailsExtra,
  PlandayJsonEmployeeGroup,
  PlandayJsonPortalInfo,
} from "./raw";

// ---------------------------------------------------------------------------------------------------------
// Constants tests refer to
// ---------------------------------------------------------------------------------------------------------

/** The frozen test time: Wednesday 21 October 2026, 11:30 BST. */
export const FROZEN_NOW = new Date("2026-10-21T10:30:00Z");
/** Every fixture portal's `timeZone`. */
export const MOCK_TIME_ZONE = "Europe/London";

export const MOCK_PORTAL_ID = 4100001;
export const MOCK_SECOND_PORTAL_ID = 4100002;
export const MOCK_NO_DEPARTMENTS_PORTAL_ID = 4100003;

/** The read scopes of notes §5.2 (every fixture app has them unless a test calls `setScopes`). */
export const MOCK_READ_SCOPES = [
  "department:read",
  "employeegroup:read",
  "employee:read",
  "shift:read",
  "punchclockshift:read",
] as const;

/** Method C credentials of the main portal: the customer's own App ID and its Token column value. */
export const MOCK_CUSTOMER_APP_ID = "5f0c6a3e-0000-4000-8000-00000000c0de";
export const MOCK_REFRESH_TOKEN = "mock-refresh-portal-4100001";

/** Method C credentials of every fixture portal ("Fill test credentials" uses the main portal's; not customer secrets). */
export const MOCK_PORTAL_CREDENTIALS: Readonly<
  Record<number, { readonly appId: string; readonly refreshToken: string }>
> = {
  [MOCK_PORTAL_ID]: { appId: MOCK_CUSTOMER_APP_ID, refreshToken: MOCK_REFRESH_TOKEN },
  [MOCK_SECOND_PORTAL_ID]: {
    appId: "5f0c6a3e-0000-4000-8000-000004100002",
    refreshToken: "mock-refresh-portal-4100002",
  },
  [MOCK_NO_DEPARTMENTS_PORTAL_ID]: {
    appId: "5f0c6a3e-0000-4000-8000-000004100003",
    refreshToken: "mock-refresh-portal-4100003",
  },
};

/** The values the connect step's "Fill test credentials" button fills in mock mode (plan §12.5). */
export const MOCK_TEST_CREDENTIALS = MOCK_PORTAL_CREDENTIALS[MOCK_PORTAL_ID]!;

export const MOCK_DEPARTMENT_IDS = { BAR: 101, KITCHEN: 102, HEAD_OFFICE: 103 } as const;
export const MOCK_EMPLOYEE_GROUP_IDS = {
  BARTENDERS: 201,
  CHEFS: 202,
  FLOOR_STAFF: 203,
  SUPERVISORS: 204,
} as const;
export const MOCK_EMPLOYEE_IDS = {
  AISHA_KHAN: 1001,
  BEN_CARTER: 1002,
  CHLOE_DAVIES: 1003,
  DANIEL_EVANS: 1004,
  ALEX_MORGAN_BAR: 1005,
  ALEX_MORGAN_KITCHEN: 1006,
  PRIYA_PATEL: 1007,
  TOM_HARRIS: 1008,
  GRACE_LEE: 1009,
  OMAR_SAID: 1010,
  HANNAH_WRIGHT: 1011,
  LEO_TURNER: 1012,
} as const;

/** Prefix of every personal-data sentinel string (`SENTINEL-PII-<field>-<id>`). */
export const SENTINEL_PII_PREFIX = "SENTINEL-PII";
/** Every raw employee's `birthDate`. */
export const SENTINEL_BIRTH_DATE = "1901-02-03T00:00:00Z";
/** Every raw employee's `hiredDate` / `hiredFrom`. */
export const SENTINEL_HIRED_DATE = "1903-04-05";
/** Domain of every raw employee's `userName` (the Planday login, strip set E). */
export const SENTINEL_USERNAME_DOMAIN = "pii.invalid";
/** Every raw employee's `cellPhone` and `phone`: `+4470090<id>`. */
export const sentinelPhone = (employeeId: number): string => `+4470090${employeeId}`;
/** `SENTINEL-PII-<field>-<id>`. */
export const sentinel = (field: string, id: number | string): string =>
  `${SENTINEL_PII_PREFIX}-${field}-${id}`;
/** `deletedBy` on deleted shifts (the id of the Planday user who deleted it). */
export const MOCK_DELETED_BY_USER_ID = 900001;

// ---------------------------------------------------------------------------------------------------------
// Fixture types (plain JSON, so a fixture can be cloned, compared and sent over HTTP)
// ---------------------------------------------------------------------------------------------------------

export type MockEmployeeStatus = "ACTIVE" | "DEACTIVATED" | "REMOVED";

export interface MockEmployeeFixture {
  /** The `/hr/v1.0/employees` list shape (deactivation fields included). */
  raw: PlandayJsonEmployee;
  /** Fields only the by-id read returns (strip set E+). */
  details: PlandayJsonEmployeeDetailsExtra;
  /** ACTIVE: on `/employees`; DEACTIVATED: on `/employees/deactivated`; REMOVED: on neither, by-id → 400. */
  status: MockEmployeeStatus;
  /** A DEACTIVATED employee with a future `deactivationDate` who is also still on the active list (plan §6.5). */
  stayOnActiveList: boolean;
}

/** A shift as the mock stores it: wall-clock `start` / `end` in `timeZone` (`date` is derived from `start`). */
export interface MockShiftFixture {
  id: number;
  departmentId: number | null;
  employeeId: number | null;
  employeeGroupId: number | null;
  positionId: number | null;
  shiftTypeId: number | null;
  timeZone: string;
  /** `YYYY-MM-DDTHH:mm:ss`, wall-clock in `timeZone`. */
  start: string;
  /** `YYYY-MM-DDTHH:mm:ss`, wall-clock in `timeZone`. */
  end: string;
  status: string;
  comment: string | null;
  punchClockShiftId: number | null;
  skillIds: number[];
  dateTimeCreated: string;
  dateTimeModified: string;
}

export interface MockDeletedShiftFixture extends MockShiftFixture {
  dateTimeDeleted: string;
  deletedBy: number;
}

/** A Punch Clock record; `start` / `end` are wall-clock in the portal zone (punch records carry no zone). */
export interface MockPunchClockFixture {
  id: number;
  shiftId: number | null;
  departmentId: number;
  employeeId: number | null;
  start: string;
  end: string | null;
  description: string | null;
  isApproved: boolean | null;
}

export interface MockPunchClockBreakFixture {
  id: number;
  punchClockShiftId: number;
  start: string;
  end: string | null;
}

export interface MockPortalFixture {
  info: PlandayJsonPortalInfo;
  departments: PlandayJsonDepartment[];
  employeeGroups: PlandayJsonEmployeeGroup[];
  employees: MockEmployeeFixture[];
  shifts: MockShiftFixture[];
  deletedShifts: MockDeletedShiftFixture[];
  /** `scheduleDay.isVisible === false` for these department days. */
  hiddenDays: Array<{ departmentId: number; date: string }>;
  punchClockShifts: MockPunchClockFixture[];
  punchClockBreaks: MockPunchClockBreakFixture[];
}

/** An API app known to the mock. Customer apps (method C) belong to one portal. */
export interface MockAppFixture {
  appId: string;
  kind: "CUSTOMER" | "PARTNER";
  /** The portal a customer app was created in; null for ClockOff's own (partner) App IDs. */
  portalId: number | null;
  scopes: string[];
  /** The Token column value of the app's grant on `portalId`, if it was authorised there. */
  refreshToken: string | null;
}

/** Ids of the spec §11 specials on the main portal. */
export interface MockFixtureSpecials {
  inProgressShiftId: number;
  overnightShiftIds: number[];
  openShiftId: number;
  draftShiftId: number;
  /** The shift spanning a DST change, or null when no transition falls inside the four weeks. */
  dstShiftId: number | null;
  excludedDepartmentShiftId: number;
  hiddenDay: { departmentId: number; date: string; shiftIds: number[] };
  forSaleShiftId: number;
  approvedShiftId: number;
  /** Punch record of the in-progress shift: punched in 08:58, no punch-out. */
  inProgressPunchClockShiftId: number;
  /** Finished, approved punch record with one break. */
  finishedPunchClockShiftId: number;
  /** A punch-in without a shift in the excluded Head Office department (no ClockEvent may come of it). */
  excludedDepartmentPunchClockShiftId: number;
}

export interface PlandayFixture {
  /** ISO instant the fixture was laid out around. */
  anchor: string;
  timeZone: string;
  /** The four Mondays (`YYYY-MM-DD`, Europe/London). */
  weekStarts: string[];
  portals: MockPortalFixture[];
  apps: MockAppFixture[];
  specials: MockFixtureSpecials;
}

/** A ClockOff-side employee the matching tests create themselves (never served by the mock). */
export interface ClockOffEmployeeFixture {
  readonly firstName: string;
  readonly lastName: string;
  readonly email: string | null;
  readonly externalEmployeeId: string | null;
}

/** Priya Patel from a CSV import: raw Planday id "1007" and the same email (a corroborated raw-id match). */
export const fixtureCsvEmployees: readonly ClockOffEmployeeFixture[] = [
  {
    firstName: "Priya",
    lastName: "Patel",
    email: "priya.patel@mockbistro.test",
    externalEmployeeId: "1007",
  },
];
/** Sam Jones: raw id "1008" (Tom Harris's Planday id) with another name and email; must never link to 1008. */
export const fixtureCsvCollision: ClockOffEmployeeFixture = {
  firstName: "Sam",
  lastName: "Jones",
  email: "sam.jones@example.test",
  externalEmployeeId: "1008",
};
/** A ClockOff "Alex Morgan" with no email or external id: never linked to 1005 or 1006. */
export const fixtureNamesake: ClockOffEmployeeFixture = {
  firstName: "Alex",
  lastName: "Morgan",
  email: null,
  externalEmployeeId: null,
};

// ---------------------------------------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------------------------------------

const DAY_MS = 86_400_000;

function piiFields(
  id: number,
): Omit<
  PlandayJsonEmployee,
  | "id"
  | "firstName"
  | "lastName"
  | "email"
  | "departments"
  | "primaryDepartmentId"
  | "employeeGroups"
  | "deactivationDate"
  | "dateTimeCreated"
  | "dateTimeModified"
  | "dateTimeDeleted"
> {
  const s = (field: string) => sentinel(field, id);
  return {
    userName: `sentinel-${id}@${SENTINEL_USERNAME_DOMAIN}`,
    cellPhone: sentinelPhone(id),
    cellPhoneWithoutCountryPrefix: `70090${id}`,
    cellPhoneCountryPrefix: s("cellPhoneCountryPrefix"),
    cellPhoneCountryCode: s("cellPhoneCountryCode"),
    phone: sentinelPhone(id),
    phoneWithoutCountryPrefix: `70090${id}`,
    phoneCountryPrefix: s("phoneCountryPrefix"),
    phoneCountryCode: s("phoneCountryCode"),
    street1: s("street1"),
    street2: s("street2"),
    zip: s("zip"),
    city: s("city"),
    hiredDate: SENTINEL_HIRED_DATE,
    salaryIdentifier: s("salaryIdentifier"),
    terminationTypeId: null,
    terminationTypeName: null,
    deactivationReason: null,
    ssn: s("ssn"),
    bankAccount: {
      registrationNumber: s("registrationNumber"),
      accountNumber: s("accountNumber"),
    },
    birthDate: SENTINEL_BIRTH_DATE,
    employeeTypeId: 1,
    isPublic: false,
    supervisorId: null,
    securityGroups: [1],
  };
}

/** The by-id-only fields of an employee, every string a sentinel (`custom_1` is the "Shoe size" of plan §12.3). */
export function sentinelEmployeeDetails(id: number): PlandayJsonEmployeeDetailsExtra {
  return {
    gender: id % 2 === 0 ? "Male" : "Female",
    jobTitle: sentinel("jobTitle", id),
    hiredFrom: SENTINEL_HIRED_DATE,
    countryId: 826,
    workHours: 160,
    contractRulesRuleId: 7,
    supervisorEmployeeId: null,
    skillIds: [3],
    customFields: {
      custom_1: {
        name: "Shoe size",
        type: "Text",
        value: `${SENTINEL_PII_PREFIX}-CUSTOM-${id}`,
        url: null,
      },
    },
  };
}

/**
 * A raw employee in the `/employees` list shape: the given core fields plus every strip-set field filled with
 * sentinels (exported for `addEmployee` and for tests that build their own records).
 */
export function sentinelRawEmployee(
  core: Pick<PlandayJsonEmployee, "id" | "firstName" | "lastName"> & Partial<PlandayJsonEmployee>,
  createdAt: string,
): PlandayJsonEmployee {
  return {
    email: null,
    departments: [],
    primaryDepartmentId: null,
    employeeGroups: [],
    deactivationDate: null,
    dateTimeCreated: createdAt,
    dateTimeModified: createdAt,
    dateTimeDeleted: null,
    ...piiFields(core.id),
    ...core,
  };
}

interface EmployeeSpec {
  id: number;
  firstName: string;
  lastName: string;
  email: string | null;
  departments: number[];
  groups: number[];
}

function employee(spec: EmployeeSpec, createdAt: string): MockEmployeeFixture {
  return {
    raw: sentinelRawEmployee(
      {
        id: spec.id,
        firstName: spec.firstName,
        lastName: spec.lastName,
        email: spec.email,
        departments: spec.departments,
        primaryDepartmentId: spec.departments[0] ?? null,
        employeeGroups: spec.groups,
      },
      createdAt,
    ),
    details: sentinelEmployeeDetails(spec.id),
    status: "ACTIVE",
    stayOnActiveList: false,
  };
}

interface ShiftDraft {
  tag?: "inProgress" | "overnight" | "open" | "draft" | "dst" | "excluded";
  employeeId: number | null;
  departmentId: number | null;
  employeeGroupId: number | null;
  start: string;
  end: string;
  status: string;
}

function draft(
  date: string,
  startTime: string,
  endTime: string,
  fields: Omit<ShiftDraft, "start" | "end" | "status"> & { status?: string; overnight?: boolean },
): ShiftDraft {
  const endDate = fields.overnight ? addLocalDays(date, 1) : date;
  const { overnight: _overnight, status, ...rest } = fields;
  return {
    ...rest,
    start: `${date}T${startTime}:00`,
    end: `${endDate}T${endTime}:00`,
    status: status ?? (rest.employeeId === null ? "Open" : "Assigned"),
  };
}

/** Sorts drafts chronologically and gives them ids from `firstId`, with sentinel comments. */
function finaliseShifts(
  drafts: ShiftDraft[],
  firstId: number,
  zone: string,
  createdAt: string,
): Array<{ draft: ShiftDraft; shift: MockShiftFixture }> {
  const ordered = [...drafts].sort(
    (a, b) =>
      localToMs(a.start, zone) - localToMs(b.start, zone) ||
      (a.departmentId ?? 0) - (b.departmentId ?? 0) ||
      (a.employeeId ?? 0) - (b.employeeId ?? 0),
  );
  return ordered.map((d, index) => {
    const id = firstId + index;
    return {
      draft: d,
      shift: {
        id,
        departmentId: d.departmentId,
        employeeId: d.employeeId,
        employeeGroupId: d.employeeGroupId,
        positionId: null,
        shiftTypeId: 1,
        timeZone: zone,
        start: d.start,
        end: d.end,
        status: d.status,
        comment: `${SENTINEL_PII_PREFIX}-COMMENT-${id}`,
        punchClockShiftId: null,
        skillIds: [],
        dateTimeCreated: createdAt,
        dateTimeModified: createdAt,
      },
    };
  });
}

/** Offset (minutes) in force at a wall-clock time in `zone`. */
function offsetAt(local: string, zone: string): number {
  const wc = parseLocalDateTime(local);
  if (!wc) throw new Error(`invalid local time ${local}`);
  return resolveWallClock(wc, zone).offsetMinutes;
}

/** Shifts a stored wall-clock time by `minutes` of real time. */
function plusMinutes(local: string, minutes: number, zone: string): string {
  return msToLocal(localToMs(local, zone) + minutes * 60_000, zone);
}

interface Week {
  day(week: number, weekday: number): string;
}

/** A weekly pattern: each entry works `weekdays` (0 = Monday) in every one of the four weeks. */
interface PatternEntry {
  employeeId: number;
  departmentId: number | null;
  employeeGroupId: number;
  weekdays: number[];
  startTime: string;
  endTime: string;
}

function patternDrafts(pattern: PatternEntry[], weeks: Week): ShiftDraft[] {
  const drafts: ShiftDraft[] = [];
  for (let w = 0; w < 4; w++) {
    for (const entry of pattern) {
      for (const weekday of entry.weekdays) {
        drafts.push(
          draft(weeks.day(w, weekday), entry.startTime, entry.endTime, {
            employeeId: entry.employeeId,
            departmentId: entry.departmentId,
            employeeGroupId: entry.employeeGroupId,
          }),
        );
      }
    }
  }
  return drafts;
}

function buildMainPortal(
  weeks: Week,
  anchorMs: number,
  zone: string,
  createdAt: string,
  employeesCreatedAt: string,
): { portal: MockPortalFixture; specials: MockFixtureSpecials } {
  const { BAR, KITCHEN, HEAD_OFFICE } = MOCK_DEPARTMENT_IDS;
  const { BARTENDERS, CHEFS, FLOOR_STAFF, SUPERVISORS } = MOCK_EMPLOYEE_GROUP_IDS;
  const E = MOCK_EMPLOYEE_IDS;
  const email = (local: string) => `${local}@mockbistro.test`;

  const employees: MockEmployeeFixture[] = [
    {
      id: E.AISHA_KHAN,
      firstName: "Aisha",
      lastName: "Khan",
      email: email("aisha.khan"),
      departments: [BAR],
      groups: [BARTENDERS],
    },
    {
      id: E.BEN_CARTER,
      firstName: "Ben",
      lastName: "Carter",
      email: email("ben.carter"),
      departments: [BAR],
      groups: [BARTENDERS, SUPERVISORS],
    },
    {
      id: E.CHLOE_DAVIES,
      firstName: "Chloe",
      lastName: "Davies",
      email: email("chloe.davies"),
      departments: [KITCHEN],
      groups: [CHEFS],
    },
    {
      id: E.DANIEL_EVANS,
      firstName: "Daniel",
      lastName: "Evans",
      email: null,
      departments: [KITCHEN],
      groups: [CHEFS],
    },
    {
      id: E.ALEX_MORGAN_BAR,
      firstName: "Alex",
      lastName: "Morgan",
      email: email("alex.morgan"),
      departments: [BAR],
      groups: [FLOOR_STAFF],
    },
    {
      id: E.ALEX_MORGAN_KITCHEN,
      firstName: "Alex",
      lastName: "Morgan",
      email: email("alex.j.morgan"),
      departments: [KITCHEN],
      groups: [FLOOR_STAFF],
    },
    {
      id: E.PRIYA_PATEL,
      firstName: "Priya",
      lastName: "Patel",
      email: email("priya.patel"),
      departments: [BAR, KITCHEN],
      groups: [SUPERVISORS],
    },
    {
      id: E.TOM_HARRIS,
      firstName: "Tom",
      lastName: "Harris",
      email: email("tom.harris"),
      departments: [KITCHEN],
      groups: [CHEFS],
    },
    {
      id: E.GRACE_LEE,
      firstName: "Grace",
      lastName: "Lee",
      email: email("grace.lee"),
      departments: [BAR],
      groups: [FLOOR_STAFF],
    },
    {
      id: E.OMAR_SAID,
      firstName: "Omar",
      lastName: "Said",
      email: email("omar.said"),
      departments: [HEAD_OFFICE],
      groups: [SUPERVISORS],
    },
    {
      id: E.HANNAH_WRIGHT,
      firstName: "Hannah",
      lastName: "Wright",
      email: email("hannah.wright"),
      departments: [BAR],
      groups: [FLOOR_STAFF],
    },
    {
      id: E.LEO_TURNER,
      firstName: "Leo",
      lastName: "Turner",
      email: email("leo.turner"),
      departments: [KITCHEN],
      groups: [FLOOR_STAFF],
    },
  ].map((spec) => employee(spec, employeesCreatedAt));

  // Hannah Wright left nine days before the anchor: only on /employees/deactivated.
  const anchorDate = localDateOfMs(anchorMs, zone);
  const hannah = employees.find((e) => e.raw.id === E.HANNAH_WRIGHT)!;
  const deactivationDate = addLocalDays(anchorDate, -9);
  const deactivatedAt = isoZ(localToMs(`${deactivationDate}T09:00:00`, zone));
  hannah.status = "DEACTIVATED";
  hannah.raw = {
    ...hannah.raw,
    deactivationDate,
    dateTimeDeleted: deactivatedAt,
    dateTimeModified: deactivatedAt,
    terminationTypeId: 2,
    terminationTypeName: sentinel("terminationTypeName", E.HANNAH_WRIGHT),
    deactivationReason: `${SENTINEL_PII_PREFIX}-REASON-${E.HANNAH_WRIGHT}`,
  };

  // Weekly pattern: Bar 10:00–18:00, Kitchen 08:00–16:00, staggered days (13 shifts a week).
  const bar = { departmentId: BAR, startTime: "10:00", endTime: "18:00" };
  const kitchen = { departmentId: KITCHEN, startTime: "08:00", endTime: "16:00" };
  const pattern: PatternEntry[] = [
    { ...bar, employeeId: E.AISHA_KHAN, employeeGroupId: BARTENDERS, weekdays: [0, 2] },
    { ...bar, employeeId: E.BEN_CARTER, employeeGroupId: BARTENDERS, weekdays: [1] },
    { ...bar, employeeId: E.ALEX_MORGAN_BAR, employeeGroupId: FLOOR_STAFF, weekdays: [3] },
    { ...bar, employeeId: E.PRIYA_PATEL, employeeGroupId: SUPERVISORS, weekdays: [5] },
    { ...bar, employeeId: E.GRACE_LEE, employeeGroupId: FLOOR_STAFF, weekdays: [2, 6] },
    { ...kitchen, employeeId: E.CHLOE_DAVIES, employeeGroupId: CHEFS, weekdays: [0, 3] },
    { ...kitchen, employeeId: E.DANIEL_EVANS, employeeGroupId: CHEFS, weekdays: [1] },
    { ...kitchen, employeeId: E.ALEX_MORGAN_KITCHEN, employeeGroupId: FLOOR_STAFF, weekdays: [2] },
    { ...kitchen, employeeId: E.TOM_HARRIS, employeeGroupId: CHEFS, weekdays: [3] },
    { ...kitchen, employeeId: E.LEO_TURNER, employeeGroupId: FLOOR_STAFF, weekdays: [4] },
  ];
  let drafts = patternDrafts(pattern, weeks);

  // In progress at the anchor: Aisha 09:00–17:00 on the anchor's day, replacing her pattern shift that day.
  drafts = drafts.filter(
    (d) => !(d.employeeId === E.AISHA_KHAN && d.start.startsWith(`${anchorDate}T`)),
  );
  const inProgress = draft(anchorDate, "09:00", "17:00", {
    tag: "inProgress",
    employeeId: E.AISHA_KHAN,
    departmentId: BAR,
    employeeGroupId: BARTENDERS,
    status: "PunchclockStarted",
  });
  const inProgressStartMs = localToMs(inProgress.start, zone);

  // Approved for payroll: the latest finished pattern shift before it (Aisha's Monday at FROZEN_NOW).
  const finishedBefore = (d: ShiftDraft) => localToMs(d.end, zone) <= inProgressStartMs;
  const latest = (list: ShiftDraft[]) =>
    list.reduce<ShiftDraft | undefined>(
      (best, d) => (!best || localToMs(d.start, zone) > localToMs(best.start, zone) ? d : best),
      undefined,
    );
  const approved =
    latest(drafts.filter((d) => d.employeeId === E.AISHA_KHAN && finishedBefore(d))) ??
    latest(drafts.filter(finishedBefore)) ??
    drafts[0]!;
  approved.status = "Approved";

  // For sale: Alex Morgan (Bar), Thursday of week 2.
  const forSale = drafts.find(
    (d) => d.employeeId === E.ALEX_MORGAN_BAR && d.start.startsWith(`${weeks.day(1, 3)}T`),
  )!;
  forSale.status = "ForSale";

  const specialsDrafts: ShiftDraft[] = [inProgress];
  // Overnight: Ben, every Friday 20:00 → Saturday 02:00 (Bar).
  for (let w = 0; w < 4; w++) {
    specialsDrafts.push(
      draft(weeks.day(w, 4), "20:00", "02:00", {
        tag: "overnight",
        overnight: true,
        employeeId: E.BEN_CARTER,
        departmentId: BAR,
        employeeGroupId: BARTENDERS,
      }),
    );
  }
  // Open, unassigned: Bar, Saturday of week 1.
  specialsDrafts.push(
    draft(weeks.day(0, 5), "10:00", "18:00", {
      tag: "open",
      employeeId: null,
      departmentId: BAR,
      employeeGroupId: BARTENDERS,
      status: "Open",
    }),
  );
  // Draft: Chloe, Wednesday of week 2.
  specialsDrafts.push(
    draft(weeks.day(1, 2), "08:00", "16:00", {
      tag: "draft",
      employeeId: E.CHLOE_DAVIES,
      departmentId: KITCHEN,
      employeeGroupId: CHEFS,
      status: "Draft",
    }),
  );
  // Excluded department: Omar, Head Office, Tuesday of week 2.
  specialsDrafts.push(
    draft(weeks.day(1, 1), "09:00", "17:00", {
      tag: "excluded",
      employeeId: E.OMAR_SAID,
      departmentId: HEAD_OFFICE,
      employeeGroupId: SUPERVISORS,
    }),
  );
  // Spanning a DST change: Ben, Saturday 22:00 → Sunday 06:00 before the first transition Sunday in the four
  // weeks (24/25 Oct 2026 at FROZEN_NOW: 9 real hours); omitted when no transition falls inside.
  for (let w = 0; w < 4; w++) {
    const sunday = weeks.day(w, 6);
    if (offsetAt(`${sunday}T00:30:00`, zone) !== offsetAt(`${sunday}T12:00:00`, zone)) {
      specialsDrafts.push(
        draft(weeks.day(w, 5), "22:00", "06:00", {
          tag: "dst",
          overnight: true,
          employeeId: E.BEN_CARTER,
          departmentId: BAR,
          employeeGroupId: BARTENDERS,
        }),
      );
      break;
    }
  }

  const finalised = finaliseShifts([...drafts, ...specialsDrafts], 500001, zone, createdAt);
  const idOf = (d: ShiftDraft) => finalised.find((f) => f.draft === d)!.shift.id;
  const idsTagged = (tag: ShiftDraft["tag"]) =>
    finalised.filter((f) => f.draft.tag === tag).map((f) => f.shift.id);
  const shifts = finalised.map((f) => f.shift);

  // Hidden day: Kitchen, Thursday of week 3.
  const hiddenDay = { departmentId: KITCHEN, date: weeks.day(2, 3) };
  const hiddenShiftIds = shifts
    .filter((s) => s.departmentId === KITCHEN && s.start.startsWith(`${hiddenDay.date}T`))
    .map((s) => s.id);

  // Punch clock (Beta): the in-progress shift punched in at 08:58 with no punch-out; a finished, approved record
  // with a break; a punch-in without a shift in the excluded Head Office department.
  const inProgressShift = shifts.find((s) => s.id === idOf(inProgress))!;
  const approvedShift = shifts.find((s) => s.id === idOf(approved))!;
  inProgressShift.punchClockShiftId = 800001;
  approvedShift.punchClockShiftId = 800002;
  const punchClockShifts: MockPunchClockFixture[] = [
    {
      id: 800001,
      shiftId: inProgressShift.id,
      departmentId: BAR,
      employeeId: E.AISHA_KHAN,
      start: `${anchorDate}T08:58:00`,
      end: null,
      description: `${SENTINEL_PII_PREFIX}-PUNCHNOTE-800001`,
      isApproved: false,
    },
    {
      id: 800002,
      shiftId: approvedShift.id,
      departmentId: approvedShift.departmentId ?? BAR,
      employeeId: approvedShift.employeeId,
      start: plusMinutes(approvedShift.start, -5, zone),
      end: plusMinutes(approvedShift.end, 4, zone),
      description: `${SENTINEL_PII_PREFIX}-PUNCHNOTE-800002`,
      isApproved: true,
    },
    {
      id: 800003,
      shiftId: null,
      departmentId: HEAD_OFFICE,
      employeeId: E.OMAR_SAID,
      start: `${anchorDate}T09:05:00`,
      end: null,
      description: `${SENTINEL_PII_PREFIX}-PUNCHNOTE-800003`,
      isApproved: false,
    },
  ];
  const punchClockBreaks: MockPunchClockBreakFixture[] = [
    {
      id: 810001,
      punchClockShiftId: 800002,
      start: plusMinutes(approvedShift.start, 180, zone),
      end: plusMinutes(approvedShift.start, 210, zone),
    },
  ];

  const portal: MockPortalFixture = {
    info: {
      id: MOCK_PORTAL_ID,
      name: "Mock Bistro Group",
      companyName: "Mock Bistro Group Ltd",
      country: "GB",
      timeZone: zone,
      maxDepartments: null,
      aliases: ["mockbistro"],
      portals: [],
    },
    departments: [
      { id: BAR, name: "Bar", number: "BAR-01" },
      { id: KITCHEN, name: "Kitchen", number: "KIT-01" },
      { id: HEAD_OFFICE, name: "Head Office", number: "HO-01" },
    ],
    employeeGroups: [
      { id: BARTENDERS, name: "Bartenders" },
      { id: CHEFS, name: "Chefs" },
      { id: FLOOR_STAFF, name: "Floor Staff" },
      { id: SUPERVISORS, name: "Supervisors" },
    ],
    employees,
    shifts,
    deletedShifts: [],
    hiddenDays: [hiddenDay],
    punchClockShifts,
    punchClockBreaks,
  };
  const dst = idsTagged("dst");
  const specials: MockFixtureSpecials = {
    inProgressShiftId: inProgressShift.id,
    overnightShiftIds: idsTagged("overnight"),
    openShiftId: idsTagged("open")[0]!,
    draftShiftId: idsTagged("draft")[0]!,
    dstShiftId: dst[0] ?? null,
    excludedDepartmentShiftId: idsTagged("excluded")[0]!,
    hiddenDay: { ...hiddenDay, shiftIds: hiddenShiftIds },
    forSaleShiftId: idOf(forSale),
    approvedShiftId: approvedShift.id,
    inProgressPunchClockShiftId: 800001,
    finishedPunchClockShiftId: 800002,
    excludedDepartmentPunchClockShiftId: 800003,
  };
  return { portal, specials };
}

function buildSecondPortal(
  weeks: Week,
  zone: string,
  createdAt: string,
  employeesCreatedAt: string,
): MockPortalFixture {
  // Overlapping ids on purpose: department 101, group 201, employees 1001–1003, shifts from 500001.
  const email = (local: string) => `${local}@mockcafe.test`;
  const employees = [
    {
      id: 1001,
      firstName: "Maya",
      lastName: "Brooks",
      email: email("maya.brooks"),
      departments: [101],
      groups: [201],
    },
    {
      id: 1002,
      firstName: "Noah",
      lastName: "Price",
      email: email("noah.price"),
      departments: [101],
      groups: [201],
    },
    // An empty email (the other "no email" encoding next to the main portal's null).
    { id: 1003, firstName: "Zara", lastName: "Ali", email: "", departments: [101], groups: [201] },
  ].map((spec) => employee(spec, employeesCreatedAt));
  const cafe = { departmentId: 101, employeeGroupId: 201, startTime: "09:00", endTime: "15:00" };
  const drafts = patternDrafts(
    [
      { ...cafe, employeeId: 1001, weekdays: [0] },
      { ...cafe, employeeId: 1002, weekdays: [2] },
      { ...cafe, employeeId: 1003, weekdays: [4] },
    ],
    weeks,
  );
  return {
    info: {
      id: MOCK_SECOND_PORTAL_ID,
      name: "Mock Cafe Co",
      companyName: "Mock Cafe Co Ltd",
      country: "GB",
      timeZone: zone,
      maxDepartments: null,
      aliases: ["mockcafe"],
      portals: [],
    },
    departments: [{ id: 101, name: "Cafe", number: "CAFE-01" }],
    employeeGroups: [{ id: 201, name: "Baristas" }],
    employees,
    shifts: finaliseShifts(drafts, 500001, zone, createdAt).map((f) => f.shift),
    deletedShifts: [],
    hiddenDays: [],
    punchClockShifts: [],
    punchClockBreaks: [],
  };
}

function buildNoDepartmentsPortal(
  weeks: Week,
  zone: string,
  createdAt: string,
  employeesCreatedAt: string,
): MockPortalFixture {
  // No departments: empty departments[] on every employee and departmentId null on every shift (plan §6.3).
  const email = (local: string) => `${local}@mockkiosk.test`;
  const employees = [
    {
      id: 3001,
      firstName: "Ivy",
      lastName: "Chen",
      email: email("ivy.chen"),
      departments: [],
      groups: [301],
    },
    {
      id: 3002,
      firstName: "Jack",
      lastName: "Wilson",
      email: email("jack.wilson"),
      departments: [],
      groups: [301],
    },
    {
      id: 3003,
      firstName: "Ruby",
      lastName: "Hall",
      email: email("ruby.hall"),
      departments: [],
      groups: [301],
    },
  ].map((spec) => employee(spec, employeesCreatedAt));
  const kiosk = { departmentId: null, employeeGroupId: 301, startTime: "07:00", endTime: "13:00" };
  const drafts = patternDrafts(
    [
      { ...kiosk, employeeId: 3001, weekdays: [1] },
      { ...kiosk, employeeId: 3002, weekdays: [3] },
      { ...kiosk, employeeId: 3003, weekdays: [5] },
    ],
    weeks,
  );
  return {
    info: {
      id: MOCK_NO_DEPARTMENTS_PORTAL_ID,
      name: "Mock Kiosk",
      companyName: "Mock Kiosk Ltd",
      country: "GB",
      timeZone: zone,
      maxDepartments: null,
      aliases: ["mockkiosk"],
      portals: [],
    },
    departments: [],
    employeeGroups: [{ id: 301, name: "Kiosk Team" }],
    employees,
    shifts: finaliseShifts(drafts, 700001, zone, createdAt).map((f) => f.shift),
    deletedShifts: [],
    hiddenDays: [],
    punchClockShifts: [],
    punchClockBreaks: [],
  };
}

export interface BuildPlandayFixtureOptions {
  /** The instant the four weeks are laid out around (default `FROZEN_NOW`). */
  anchor?: Date;
}

/**
 * Builds the spec §11 fixture around `anchor` (plan §12.3). With `FROZEN_NOW` the main portal has exactly the
 * counts and specials of the plan; with another anchor the in-progress shift moves to the anchor's day
 * (09:00–17:00), and the DST shift to the late-October or late-March transition inside the four weeks, or is
 * omitted.
 */
export function buildPlandayFixture(options: BuildPlandayFixtureOptions = {}): PlandayFixture {
  const anchor = options.anchor ?? FROZEN_NOW;
  const anchorMs = anchor.getTime();
  if (Number.isNaN(anchorMs)) throw new Error("buildPlandayFixture: invalid anchor");
  const zone = MOCK_TIME_ZONE;
  const monday = localDateOfMs(weekStart(anchor, zone, 1).getTime(), zone);
  const weeks: Week = { day: (week, weekday) => addLocalDays(monday, week * 7 + weekday) };
  // Shifts were created a week before the first Monday; employees long before.
  const createdAt = isoZ(localToMs(`${addLocalDays(monday, -7)}T09:00:00`, zone));
  const employeesCreatedAt = isoZ(Math.floor((anchorMs - 200 * DAY_MS) / 3_600_000) * 3_600_000);

  const main = buildMainPortal(weeks, anchorMs, zone, createdAt, employeesCreatedAt);
  const portals = [
    main.portal,
    buildSecondPortal(weeks, zone, createdAt, employeesCreatedAt),
    buildNoDepartmentsPortal(weeks, zone, createdAt, employeesCreatedAt),
  ];
  const apps: MockAppFixture[] = portals.map((portal) => ({
    appId: MOCK_PORTAL_CREDENTIALS[portal.info.id]!.appId,
    kind: "CUSTOMER",
    portalId: portal.info.id,
    scopes: [...MOCK_READ_SCOPES],
    refreshToken: MOCK_PORTAL_CREDENTIALS[portal.info.id]!.refreshToken,
  }));
  return {
    anchor: anchor.toISOString(),
    timeZone: zone,
    weekStarts: [0, 1, 2, 3].map((w) => weeks.day(w, 0)),
    portals,
    apps,
    specials: main.specials,
  };
}
