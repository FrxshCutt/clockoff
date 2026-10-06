import type { ClockEventType } from "../enums";

/**
 * How a provider writes what it fetched (§6.6). Providers never touch the database: the integration service
 * hands them a `WorkforceSyncSink` (via `ProviderContext.sink`) whose implementation goes through the normal
 * services — the shifts service validates, versions and publishes shift changes exactly as for manual or CSV
 * shifts. Records are already mapped to Work Mode's vocabulary and carry UTC instants.
 *
 * Every write is an idempotent upsert keyed by the provider's id, so re-running a sync is safe. Providers pass
 * their raw ids; the sink namespaces employee and shift ids as `<PROVIDER>:<id>` before storing them, because
 * Employee.externalEmployeeId and Shift.externalShiftId are unique per organisation, not per provider.
 */

export type UpsertOutcome = "CREATED" | "UPDATED" | "UNCHANGED" | "SKIPPED";

export interface ExternalLocation {
  readonly externalId: string;
  readonly name: string;
  /** IANA zone of the site, when the provider knows it. */
  readonly timezone?: string | null;
}

export interface ExternalTeam {
  readonly externalId: string;
  readonly name: string;
  readonly externalLocationId?: string | null;
}

export interface ExternalEmployee {
  /** The provider's raw id; stored as Employee.externalEmployeeId = `<PROVIDER>:<externalId>`. */
  readonly externalId: string;
  readonly firstName: string;
  readonly lastName: string;
  readonly email?: string | null;
  readonly phone?: string | null;
  readonly jobTitle?: string | null;
  readonly externalLocationIds?: readonly string[];
  readonly externalTeamIds?: readonly string[];
  /** False when the provider marks the person as deactivated / terminated. */
  readonly active: boolean;
}

export interface ExternalShift {
  /** The provider's raw id; stored as Shift.externalShiftId = `<PROVIDER>:<externalId>`. */
  readonly externalId: string;
  /** Null for an open (unassigned) shift; the sink skips those. */
  readonly externalEmployeeId: string | null;
  readonly externalLocationId?: string | null;
  /** UTC instants. Providers that return local wall-clock times convert with the site's zone first. */
  readonly startsAt: Date;
  readonly endsAt: Date;
  /** IANA zone the local times were interpreted in; stored on Shift.timezone for display and DST reasoning. */
  readonly timezone: string;
  /** Deleted or cancelled upstream → Shift.status CANCELLED (never hard-deleted). */
  readonly cancelled: boolean;
  readonly notes?: string | null;
}

export interface ExternalClockEvent {
  /** Stored as ClockEvent.externalId, with ClockEvent.source = the provider id. */
  readonly externalId: string;
  readonly externalEmployeeId: string;
  readonly type: ClockEventType;
  readonly occurredAt: Date;
}

export interface WorkforceSyncSink {
  upsertLocation(record: ExternalLocation): Promise<UpsertOutcome>;
  upsertTeam(record: ExternalTeam): Promise<UpsertOutcome>;
  upsertEmployee(record: ExternalEmployee): Promise<UpsertOutcome>;
  upsertShift(record: ExternalShift): Promise<UpsertOutcome>;
  recordClockEvent(record: ExternalClockEvent): Promise<UpsertOutcome>;
  /** Persists refreshed credentials (encrypted by the caller) after `refreshAuthentication`. */
  saveCredentials(credentials: unknown, tokenExpiresAt: Date | null): Promise<void>;
}
