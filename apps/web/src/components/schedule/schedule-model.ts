import { updateShiftSchema, type Shift } from "@clockoff/validation/shifts";
import type { z } from "zod";
import {
  addLocalDays,
  buildShiftInstants,
  formatShiftRange,
  instantToLocal,
  isValidLocalDate,
  isValidTimeZone,
  localDateOf,
  localDateRange,
  overlaps,
  weekStart,
  type IsoWeekday,
  type LocalDateString,
} from "@clockoff/shared/time/time";
import { isResourceId } from "@/config/navigation";

/**
 * Pure view-model helpers for the schedule page. Every date here is a local `YYYY-MM-DD` in the display
 * timezone (the organisation's zone) and every instant is a UTC `Date`; the timezone maths all goes through
 * `@clockoff/shared/time` so the grid can never disagree with the server about which day a shift is on.
 */

export const SCHEDULE_VIEWS = ["week", "day", "employee"] as const;
export type ScheduleView = (typeof SCHEDULE_VIEWS)[number];

export const SCHEDULE_VIEW_LABELS: Record<ScheduleView, string> = {
  week: "Week",
  day: "Day",
  employee: "Employee",
};

export interface ScheduleParams {
  view: ScheduleView;
  /** Anchor date (`YYYY-MM-DD`): the day shown in the day view, any day of the week in the week view. */
  date: LocalDateString;
  locationId: string | null;
  employeeId: string | null;
  /** Whether cancelled shifts are drawn (struck through). Default true. */
  showCancelled: boolean;
}

export type RawSearchParams = Readonly<Record<string, string | string[] | undefined>>;

function firstValue(value: string | string[] | undefined): string | null {
  const first = Array.isArray(value) ? value[0] : value;
  return first && first.length > 0 ? first : null;
}

export function isScheduleView(value: unknown): value is ScheduleView {
  return typeof value === "string" && (SCHEDULE_VIEWS as readonly string[]).includes(value);
}

/** `?view=&date=&location=&employee=&cancelled=` → params; anything invalid falls back to the default. */
export function parseScheduleParams(raw: RawSearchParams, today: LocalDateString): ScheduleParams {
  const view = firstValue(raw.view);
  const date = firstValue(raw.date);
  const locationId = firstValue(raw.location);
  const employeeId = firstValue(raw.employee);
  const cancelled = firstValue(raw.cancelled);
  return {
    view: isScheduleView(view) ? view : "week",
    date: date && isValidLocalDate(date) ? date : today,
    locationId: isResourceId(locationId) ? locationId : null,
    employeeId: isResourceId(employeeId) ? employeeId : null,
    showCancelled: cancelled === null ? true : !/^(0|false|no|off)$/i.test(cancelled),
  };
}

/** Inverse of `parseScheduleParams`; defaults are omitted so the canonical URL is `/schedule`. */
export function scheduleParamsToSearch(params: ScheduleParams, today: LocalDateString): string {
  const search = new URLSearchParams();
  if (params.view !== "week") search.set("view", params.view);
  if (params.date !== today) search.set("date", params.date);
  if (params.locationId) search.set("location", params.locationId);
  if (params.employeeId) search.set("employee", params.employeeId);
  if (!params.showCancelled) search.set("cancelled", "0");
  const qs = search.toString();
  return qs ? `?${qs}` : "";
}

export type WeekStartsOn = "MONDAY" | "SUNDAY";

export function weekStartsOnToIso(weekStartsOn: WeekStartsOn | undefined): IsoWeekday {
  return weekStartsOn === "SUNDAY" ? 7 : 1;
}

/** Local midnight (as an instant) at the start of `date` in `timezone`. */
export function localMidnight(date: LocalDateString, timezone: string): Date {
  return localDateRange(date, date, timezone)[0];
}

/** Today's local date in `timezone`. */
export function todayIn(timezone: string, now: Date = new Date()): LocalDateString {
  return localDateOf(now, timezone);
}

export interface ScheduleRange {
  /** Visible local days, in order. */
  days: LocalDateString[];
  /** First and last visible day. */
  startDate: LocalDateString;
  endDate: LocalDateString;
  /**
   * Query window `[from, to)`. `from` starts one local day before the first visible day so overnight shifts
   * that began the previous evening still render their continuation chip on the first column.
   */
  from: Date;
  to: Date;
}

/** First visible day of the week containing `date`. */
export function weekStartDate(
  date: LocalDateString,
  timezone: string,
  weekStartsOn: WeekStartsOn | undefined,
): LocalDateString {
  const start = weekStart(localMidnight(date, timezone), timezone, weekStartsOnToIso(weekStartsOn));
  return localDateOf(start, timezone);
}

export function computeRange(
  view: ScheduleView,
  date: LocalDateString,
  timezone: string,
  weekStartsOn: WeekStartsOn | undefined,
): ScheduleRange {
  const startDate = view === "day" ? date : weekStartDate(date, timezone, weekStartsOn);
  const length = view === "day" ? 1 : 7;
  const days = Array.from({ length }, (_, i) => addLocalDays(startDate, i));
  const endDate = days[days.length - 1] ?? startDate;
  const [from] = localDateRange(addLocalDays(startDate, -1), endDate, timezone);
  const [, to] = localDateRange(startDate, endDate, timezone);
  return { days, startDate, endDate, from, to };
}

/** Anchor date after pressing previous/next: one day in the day view, one week otherwise. */
export function navigateDate(
  view: ScheduleView,
  date: LocalDateString,
  direction: -1 | 1,
): LocalDateString {
  return addLocalDays(date, (view === "day" ? 1 : 7) * direction);
}

// ── Chips ───────────────────────────────────────────────────────────────────

export const MINUTES_PER_DAY = 24 * 60;

function dayIndex(date: LocalDateString): number {
  // Local dates are ISO strings, so the UTC epoch day of the same calendar date is a stable ordinal.
  return Math.round(
    Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))) /
      86_400_000,
  );
}

function minutesOf(time: string): number {
  return Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
}

export interface ShiftChipModel {
  /** Stable React key (`<shiftId>:<day>`). */
  key: string;
  shift: Shift;
  /** The local day column this chip is drawn in. */
  day: LocalDateString;
  /** `start` on the day the shift begins, `continuation` on later days of an overnight shift. */
  kind: "start" | "continuation";
  /** Local wall-clock labels in the display timezone. */
  startLabel: string;
  endLabel: string;
  /** Local days between the start day and the end day (0 for a same-day shift). */
  dayOffset: number;
  /** True when the shift ends on a later local day than it starts. */
  overnight: boolean;
  /** Chip text: `09:00–15:00`, `22:00 → 06:00 (+1)` or `→ 06:00` for a continuation. */
  label: string;
  /** Portion of the shift that falls inside `day`, in minutes from local midnight (`[start, end)`). */
  startMinutes: number;
  endMinutes: number;
}

export interface ShiftLocalTimes {
  startDate: LocalDateString;
  startTime: string;
  endDate: LocalDateString;
  endTime: string;
  dayOffset: number;
}

/** The shift's wall-clock start/end in `timezone`. */
export function shiftLocalTimes(
  shift: Pick<Shift, "startsAt" | "endsAt">,
  timezone: string,
): ShiftLocalTimes {
  const start = instantToLocal(new Date(shift.startsAt), timezone);
  const end = instantToLocal(new Date(shift.endsAt), timezone);
  return {
    startDate: start.date,
    startTime: start.time,
    endDate: end.date,
    endTime: end.time,
    dayOffset: dayIndex(end.date) - dayIndex(start.date),
  };
}

/** `09:00–15:00`, or `22:00 → 06:00 (+1)` when the shift ends on a later local day. */
export function shiftTimeLabel(
  times: Pick<ShiftLocalTimes, "startTime" | "endTime" | "dayOffset">,
): string {
  if (times.dayOffset > 0) return `${times.startTime} → ${times.endTime} (+${times.dayOffset})`;
  return `${times.startTime}–${times.endTime}`;
}

/**
 * Splits every shift into one chip per visible local day it touches. A shift ending exactly at midnight
 * produces no zero-length chip on the following day.
 */
export function placeShiftsOnDays(
  shifts: readonly Shift[],
  days: readonly LocalDateString[],
  timezone: string,
): Map<LocalDateString, ShiftChipModel[]> {
  const byDay = new Map<LocalDateString, ShiftChipModel[]>();
  for (const day of days) byDay.set(day, []);
  const visible = new Set(days);

  for (const shift of shifts) {
    const times = shiftLocalTimes(shift, timezone);
    const startMin = minutesOf(times.startTime);
    const endMin = minutesOf(times.endTime);
    const overnight = times.dayOffset > 0;
    for (let offset = 0; offset <= times.dayOffset; offset += 1) {
      const day = offset === 0 ? times.startDate : addLocalDays(times.startDate, offset);
      const segmentStart = offset === 0 ? startMin : 0;
      const segmentEnd = offset === times.dayOffset ? endMin : MINUTES_PER_DAY;
      if (segmentEnd <= segmentStart) continue;
      if (!visible.has(day)) continue;
      const kind = offset === 0 ? "start" : "continuation";
      byDay.get(day)?.push({
        key: `${shift.id}:${day}`,
        shift,
        day,
        kind,
        startLabel: times.startTime,
        endLabel: times.endTime,
        dayOffset: times.dayOffset,
        overnight,
        label: kind === "start" ? shiftTimeLabel(times) : `→ ${times.endTime}`,
        startMinutes: segmentStart,
        endMinutes: segmentEnd,
      });
    }
  }
  for (const chips of byDay.values())
    chips.sort((a, b) => a.startMinutes - b.startMinutes || a.endMinutes - b.endMinutes);
  return byDay;
}

export interface LaneAssignment<T> {
  item: T;
  lane: number;
}

/**
 * Greedy interval partitioning: chips that overlap in time go on different lanes, reusing the lowest free
 * lane. Returns the assignments and the number of lanes needed.
 */
export function assignLanes<T extends { startMinutes: number; endMinutes: number }>(
  items: readonly T[],
): { lanes: LaneAssignment<T>[]; laneCount: number } {
  const sorted = [...items].sort(
    (a, b) => a.startMinutes - b.startMinutes || a.endMinutes - b.endMinutes,
  );
  const laneEnds: number[] = [];
  const lanes: LaneAssignment<T>[] = [];
  for (const item of sorted) {
    let lane = laneEnds.findIndex((end) => end <= item.startMinutes);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(item.endMinutes);
    } else {
      laneEnds[lane] = item.endMinutes;
    }
    lanes.push({ item, lane });
  }
  return { lanes, laneCount: Math.max(laneEnds.length, 1) };
}

// ── Conflicts ───────────────────────────────────────────────────────────────

/**
 * Shifts for the same employee whose `[startsAt, endsAt)` intervals overlap. Cancelled shifts never
 * conflict. Returns, per shift id, the other shifts it overlaps with.
 */
export function findConflicts(shifts: readonly Shift[]): Map<string, Shift[]> {
  const conflicts = new Map<string, Shift[]>();
  const byEmployee = new Map<string, Shift[]>();
  for (const shift of shifts) {
    if (shift.status === "CANCELLED") continue;
    const list = byEmployee.get(shift.employee.id) ?? [];
    list.push(shift);
    byEmployee.set(shift.employee.id, list);
  }
  for (const list of byEmployee.values()) {
    list.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
    for (let i = 0; i < list.length; i += 1) {
      const a = list[i]!;
      for (let j = i + 1; j < list.length; j += 1) {
        const b = list[j]!;
        if (b.startsAt >= a.endsAt) break;
        if (
          overlaps(
            new Date(a.startsAt),
            new Date(a.endsAt),
            new Date(b.startsAt),
            new Date(b.endsAt),
          )
        ) {
          conflicts.set(a.id, [...(conflicts.get(a.id) ?? []), b]);
          conflicts.set(b.id, [...(conflicts.get(b.id) ?? []), a]);
        }
      }
    }
  }
  return conflicts;
}

// ── Rows ────────────────────────────────────────────────────────────────────

export interface EmployeeRow {
  id: string;
  firstName: string;
  lastName: string;
  jobTitle: string | null;
  name: string;
}

export function employeeName(employee: { firstName: string; lastName: string }): string {
  return `${employee.firstName} ${employee.lastName}`.trim();
}

/** Distinct employees appearing in `shifts`, sorted by last then first name. */
export function employeeRows(shifts: readonly Shift[]): EmployeeRow[] {
  const map = new Map<string, EmployeeRow>();
  for (const shift of shifts) {
    const e = shift.employee;
    if (!map.has(e.id)) {
      map.set(e.id, {
        id: e.id,
        firstName: e.firstName,
        lastName: e.lastName,
        jobTitle: e.jobTitle,
        name: employeeName(e),
      });
    }
  }
  return [...map.values()].sort(
    (a, b) => a.lastName.localeCompare(b.lastName) || a.firstName.localeCompare(b.firstName),
  );
}

/** Filters applied client-side so toggles are instant. */
export function visibleShifts(
  shifts: readonly Shift[],
  options: { showCancelled: boolean },
): Shift[] {
  return options.showCancelled ? [...shifts] : shifts.filter((s) => s.status !== "CANCELLED");
}

// ── Drag & drop ─────────────────────────────────────────────────────────────

/** What the client sends to `PATCH /api/shifts/:id` (the schema's input type; `notes` is a transform). */
export type ShiftPatchBody = z.input<typeof updateShiftSchema>;

export interface MoveShiftPlan {
  /** `PATCH /api/shifts/:id` body: the shift's own wall-clock times on the new date, in its own timezone. */
  patch: ShiftPatchBody;
  /** The shift as it will look once moved, for an optimistic cache update (null when it cannot be predicted). */
  optimistic: Shift | null;
  deltaDays: number;
}

/**
 * Moving a chip from `fromDay` to `toDay` (both display-timezone days) shifts the shift by that many
 * calendar days while keeping its wall-clock times in its own timezone. Returns null when nothing moves.
 * The optimistic shift also carries the derived fields the API would answer with (`localDate`,
 * `isOvernight`, `displayRange`, …) so the drawer never shows the old date while the PATCH is in flight.
 */
export function planShiftMove(
  shift: Shift,
  fromDay: LocalDateString,
  toDay: LocalDateString,
): MoveShiftPlan | null {
  const deltaDays = dayIndex(toDay) - dayIndex(fromDay);
  if (deltaDays === 0) return null;
  if (!isValidTimeZone(shift.timezone)) return null;
  const own = shiftLocalTimes(shift, shift.timezone);
  const date = addLocalDays(own.startDate, deltaDays);
  const patch: ShiftPatchBody = {
    date,
    startTime: own.startTime,
    endTime: own.endTime,
    timezone: shift.timezone,
    expectedVersion: shift.version,
  };
  let optimistic: Shift | null = null;
  try {
    const built = buildShiftInstants({
      date,
      startTime: own.startTime,
      endTime: own.endTime,
      timezone: shift.timezone,
    });
    optimistic = {
      ...shift,
      startsAt: built.startsAt.toISOString(),
      endsAt: built.endsAt.toISOString(),
      durationMinutes: built.durationMinutes,
      isOvernight: built.isOvernight,
      localDate: date,
      localStartTime: own.startTime,
      localEndTime: own.endTime,
      displayRange: formatShiftRange(built.startsAt, built.endsAt, shift.timezone),
    };
  } catch {
    optimistic = null;
  }
  return { patch, optimistic, deltaDays };
}

// ── Series ──────────────────────────────────────────────────────────────────

/** Id of the recurrence series a shift belongs to (its anchor), or null for a one-off shift. */
export function seriesIdOf(
  shift: Pick<Shift, "id" | "recurrenceRule" | "parentRecurrenceId">,
): string | null {
  if (shift.parentRecurrenceId) return shift.parentRecurrenceId;
  return shift.recurrenceRule ? shift.id : null;
}

/** Shifts of the same series starting at or after `shift` (including `shift` itself), oldest first. */
export function futureSeriesShifts(shift: Shift, candidates: readonly Shift[]): Shift[] {
  const seriesId = seriesIdOf(shift);
  if (!seriesId) return [shift];
  return candidates
    .filter(
      (c) =>
        (c.id === seriesId || c.parentRecurrenceId === seriesId) && c.startsAt >= shift.startsAt,
    )
    .filter((c, index, all) => all.findIndex((o) => o.id === c.id) === index)
    .sort((a, b) => a.startsAt.localeCompare(b.startsAt));
}

// ── Display helpers ─────────────────────────────────────────────────────────

const WEEKDAY_SHORT = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
const MONTH_SHORT = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

export function localDateParts(date: LocalDateString): {
  year: number;
  month: number;
  day: number;
  weekday: IsoWeekday;
} {
  const year = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  // ISO weekday from the UTC calendar: Sunday (0) becomes 7.
  const jsDay = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return { year, month, day, weekday: (jsDay === 0 ? 7 : jsDay) as IsoWeekday };
}

/** `Mon 6` (column header) or `Mon 6 Oct` / `Mon 6 Oct 2026`. */
export function formatLocalDay(
  date: LocalDateString,
  style: "short" | "medium" | "long" = "medium",
): string {
  const { year, month, day, weekday } = localDateParts(date);
  const wd = WEEKDAY_SHORT[weekday - 1] ?? "";
  const mo = MONTH_SHORT[month - 1] ?? "";
  if (style === "short") return `${wd} ${day}`;
  if (style === "medium") return `${wd} ${day} ${mo}`;
  return `${wd} ${day} ${mo} ${year}`;
}

/** Range heading: `6 – 12 Oct 2026`, `28 Sep – 4 Oct 2026`, `28 Dec 2026 – 3 Jan 2027`, or one day. */
export function formatRangeHeading(range: Pick<ScheduleRange, "startDate" | "endDate">): string {
  const a = localDateParts(range.startDate);
  const b = localDateParts(range.endDate);
  if (range.startDate === range.endDate) return formatLocalDay(range.startDate, "long");
  const aMonth = MONTH_SHORT[a.month - 1] ?? "";
  const bMonth = MONTH_SHORT[b.month - 1] ?? "";
  if (a.year !== b.year) return `${a.day} ${aMonth} ${a.year} – ${b.day} ${bMonth} ${b.year}`;
  if (a.month !== b.month) return `${a.day} ${aMonth} – ${b.day} ${bMonth} ${b.year}`;
  return `${a.day} – ${b.day} ${bMonth} ${b.year}`;
}

/** Hour ticks for the day view axis (`00`, `03`, … `24`). */
export function hourTicks(step = 3): { hour: number; label: string; percent: number }[] {
  const ticks: { hour: number; label: string; percent: number }[] = [];
  for (let hour = 0; hour <= 24; hour += step) {
    ticks.push({ hour, label: String(hour).padStart(2, "0"), percent: (hour / 24) * 100 });
  }
  return ticks;
}

/** Converts `YYYY-MM-DD` to a browser-local `Date` for calendar widgets (and back). */
export function localDateToJsDate(date: LocalDateString): Date {
  const { year, month, day } = localDateParts(date);
  return new Date(year, month - 1, day);
}

export function jsDateToLocalDate(date: Date): LocalDateString {
  const y = String(date.getFullYear()).padStart(4, "0");
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}
