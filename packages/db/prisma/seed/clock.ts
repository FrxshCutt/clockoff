import {
  addLocalDays,
  buildShiftInstants,
  instantToLocal,
  localDateOf,
  localToInstant,
  type LocalDateString,
} from "@workmode/shared/time/time";
import { DAY_MS, HOUR_MS, MINUTE_MS } from "./util";

/**
 * Every seeded instant is derived from one `now` and the organisation timezone, through the same shared
 * time helpers the API uses (`localToInstant`, `buildShiftInstants` — luxon underneath), so "today 09:00
 * Europe/London" and "22:00→06:00 overnight" resolve exactly as a manager-entered shift would, DST included.
 */
export class SeedClock {
  readonly now: Date;
  readonly timezone: string;
  /** Local calendar date of `now` in `timezone`, `YYYY-MM-DD`. */
  readonly today: LocalDateString;

  constructor(now: Date, timezone: string) {
    this.now = now;
    this.timezone = timezone;
    this.today = localDateOf(now, timezone);
  }

  /** Local date `offset` days from today (negative = past). */
  day(offset: number): LocalDateString {
    return addLocalDays(this.today, offset);
  }

  /** The instant of local wall-clock `time` (`HH:mm`) on the day `dayOffset` days from today. */
  at(dayOffset: number, time: string): Date {
    return localToInstant({ date: this.day(dayOffset), time, timezone: this.timezone }).instant;
  }

  /** Shift instants for typed local times; `endTime <= startTime` ends on the next local day. */
  shiftWindow(dayOffset: number, startTime: string, endTime: string): { startsAt: Date; endsAt: Date } {
    const built = buildShiftInstants({
      date: this.day(dayOffset),
      startTime,
      endTime,
      timezone: this.timezone,
    });
    return { startsAt: built.startsAt, endsAt: built.endsAt };
  }

  /** ISO weekday (1 = Monday … 7 = Sunday) of the local day `dayOffset` days from today. */
  weekdayOf(dayOffset: number): number {
    return instantToLocal(this.at(dayOffset, "12:00"), this.timezone).weekday;
  }

  minutesAgo(minutes: number): Date {
    return new Date(this.now.getTime() - minutes * MINUTE_MS);
  }

  hoursAgo(hours: number): Date {
    return new Date(this.now.getTime() - hours * HOUR_MS);
  }

  daysAgo(days: number): Date {
    return new Date(this.now.getTime() - days * DAY_MS);
  }

  minutesFromNow(minutes: number): Date {
    return new Date(this.now.getTime() + minutes * MINUTE_MS);
  }

  isPast(instant: Date): boolean {
    return instant.getTime() <= this.now.getTime();
  }
}

/**
 * `now` for the seed: `SEED_NOW` (ISO-8601, for reproducible fixtures) or the wall clock, floored to the
 * minute so relative instants ("break started 5 minutes ago") land on round times.
 */
export function resolveSeedNow(env: NodeJS.ProcessEnv = process.env): Date {
  const override = env.SEED_NOW;
  const base = override ? new Date(override) : new Date();
  if (Number.isNaN(base.getTime())) {
    throw new Error(`seed: SEED_NOW must be an ISO-8601 instant (got ${JSON.stringify(override)})`);
  }
  return new Date(Math.floor(base.getTime() / MINUTE_MS) * MINUTE_MS);
}
