import type {
  ActivityEventType,
  ActorType,
  BreakEndReason,
  BreakRestrictionBehaviour,
  EmploymentStatus,
  InviteStatus,
  PermissionState,
  SelectionState,
  ShiftSource,
  WorkModeState,
} from "@workmode/shared/enums";
import type { SeedClock } from "./clock";
import { emptyRows, type SeedRows } from "./collector";
import { addSeconds, assertNoOverlaps, ceilMinutes, stableId, toJson } from "./util";
import {
  evaluateWorkState,
  expectedStateAt,
  type SeedBreakSession,
  type SeedOverride,
  type SeedShift,
  type WorkStateEvaluation,
} from "./workState";

/** A manager acting in the audit trail / activity feed, with the request metadata `audit()` records. */
export interface ActorMeta {
  userId: string;
  ip: string;
  userAgent: string;
}

export interface BuiltEmployee {
  key: string;
  id: string;
  firstName: string;
  lastName: string;
  inviteStatus: InviteStatus;
  employmentStatus: EmploymentStatus;
  teamIds: string[];
  primaryLocationId: string | null;
  /** From the resolved Work Policy's restriction config. */
  preShiftWarningMinutes: number;
  /** Current version of the resolved Work Policy (what the device has applied). */
  workPolicyVersionId: string | null;
}

export interface BuiltDevice {
  id: string;
  mobileUserId: string;
  employee: BuiltEmployee;
  linkedAt: Date;
  lastDeviceSyncAt: Date | null;
  lastSeenAt: Date | null;
  isActive: boolean;
  deactivatedAt: Date | null;
  permissionState: PermissionState;
  selectionState: SelectionState;
  counts: { categories: number; applications: number; webDomains: number };
  model: string;
  os: string;
  appVersion: string;
  /** Whether the device has ever reported an engine state. */
  reports: boolean;
  skewSeconds: number | null;
  scheduleVersion: number;
}

export interface BuiltShift extends SeedShift {
  key: string;
  employee: BuiltEmployee;
  locationId: string | null;
  source: ShiftSource;
  /** `[offsetMinutesFromStart, durationMinutes]` scheduled breaks. */
  breaks: ReadonlyArray<readonly [number, number]>;
  parentRecurrenceId: string | null;
  recurrenceRule: string | null;
  createdAt: Date;
  createdBy: ActorMeta;
  notes: string | null;
  importId: string | null;
}

export interface BuiltSession extends SeedBreakSession {
  employee: BuiltEmployee;
  shift: BuiltShift;
  deviceId: string | null;
  breakPolicyId: string | null;
  endReason: BreakEndReason | null;
  clientBreakId: string;
  trigger: "EMPLOYEE" | "SCHEDULED" | "MANAGER";
}

export interface AddShiftParams {
  key: string;
  employee: BuiltEmployee;
  startsAt: Date;
  endsAt: Date;
  locationId: string | null;
  createdBy: ActorMeta;
  createdAt: Date;
  breaks?: ReadonlyArray<readonly [number, number]>;
  source?: ShiftSource;
  parentRecurrenceId?: string | null;
  recurrenceRule?: string | null;
  notes?: string | null;
  importId?: string | null;
}

export interface AddSessionParams {
  key: string;
  shift: BuiltShift;
  device: BuiltDevice | null;
  startedAt: Date;
  plannedEndsAt: Date;
  endedAt: Date | null;
  endReason: BreakEndReason | null;
  breakPolicyId: string | null;
  restrictionBehaviour: BreakRestrictionBehaviour;
  trigger?: "EMPLOYEE" | "SCHEDULED" | "MANAGER";
}

export interface ActivityParams {
  type: ActivityEventType;
  at: Date;
  actor: ActorType;
  employeeId?: string | null;
  deviceId?: string | null;
  actorUserId?: string | null;
  metadata?: Record<string, unknown>;
  clientEventId?: string | null;
}

export interface DeviceEvaluation extends WorkStateEvaluation {
  device: BuiltDevice;
  reported: { state: WorkModeState; at: Date } | null;
}

/**
 * Builds one organisation's rows. Everything is buffered in `rows` (see `collector.ts`); the methods here
 * keep the derived data consistent the way the services do: shift status from its end time, break events
 * with the breaks service's metadata, devices + work states evaluated by the shared state machine.
 */
export class OrgBuilder {
  readonly rows: SeedRows = emptyRows();
  readonly shifts: BuiltShift[] = [];
  readonly sessions: BuiltSession[] = [];
  readonly overrides: SeedOverride[] = [];
  readonly devices: BuiltDevice[] = [];

  constructor(
    readonly clock: SeedClock,
    readonly orgKey: string,
    readonly organisationId: string,
    readonly timezone: string,
  ) {}

  /** Deterministic id for a key inside this organisation. */
  id(key: string): string {
    return stableId(`${this.orgKey}:${key}`);
  }

  /** `audit()` row: dotted action verb, entity, optional before/after snapshots (operational fields only). */
  audit(
    actor: ActorMeta,
    action: string,
    entityType: string,
    entityId: string | null,
    at: Date,
    snapshot: { before?: unknown; after?: unknown } = {},
  ): void {
    this.rows.auditLogs.push({
      organisationId: this.organisationId,
      actorUserId: actor.userId,
      action,
      entityType,
      entityId,
      ...(snapshot.before !== undefined ? { before: toJson(snapshot.before) } : {}),
      ...(snapshot.after !== undefined ? { after: toJson(snapshot.after) } : {}),
      ip: actor.ip,
      userAgent: actor.userAgent,
      occurredAt: at,
      createdAt: at,
    });
  }

  /** `recordActivity()` row: operational metadata only (ids, versions, states, counts — §12). */
  activity(p: ActivityParams): void {
    this.rows.activityEvents.push({
      organisationId: this.organisationId,
      employeeId: p.employeeId ?? null,
      deviceId: p.deviceId ?? null,
      actorType: p.actor,
      actorUserId: p.actorUserId ?? null,
      type: p.type,
      occurredAt: p.at,
      metadata: toJson(p.metadata ?? {}),
      clientEventId: p.clientEventId ?? null,
      createdAt: p.at,
    });
  }

  /** A shift (and its scheduled breaks); COMPLETED when its end has passed, exactly as the completion sweep leaves it. */
  addShift(p: AddShiftParams): BuiltShift {
    const shift: BuiltShift = {
      id: this.id(`shift:${p.key}`),
      key: p.key,
      employee: p.employee,
      startsAt: p.startsAt,
      endsAt: p.endsAt,
      status: this.clock.isPast(p.endsAt) ? "COMPLETED" : "SCHEDULED",
      version: 1,
      deletedAt: null,
      locationId: p.locationId,
      source: p.source ?? "MANUAL",
      breaks: p.breaks ?? [],
      parentRecurrenceId: p.parentRecurrenceId ?? null,
      recurrenceRule: p.recurrenceRule ?? null,
      createdAt: p.createdAt,
      createdBy: p.createdBy,
      notes: p.notes ?? null,
      importId: p.importId ?? null,
    };
    this.shifts.push(shift);
    this.rows.shifts.push({
      id: shift.id,
      organisationId: this.organisationId,
      employeeId: shift.employee.id,
      locationId: shift.locationId,
      startsAt: shift.startsAt,
      endsAt: shift.endsAt,
      timezone: this.timezone,
      status: shift.status,
      source: shift.source,
      notes: shift.notes,
      recurrenceRule: shift.recurrenceRule,
      parentRecurrenceId: shift.parentRecurrenceId,
      version: 1,
      createdAt: shift.createdAt,
    });
    shift.breaks.forEach(([offsetMinutesFromStart, durationMinutes], index) => {
      this.rows.scheduledBreaks.push({
        id: this.id(`scheduled-break:${p.key}:${index}`),
        shiftId: shift.id,
        offsetMinutesFromStart,
        durationMinutes,
        createdAt: shift.createdAt,
      });
    });
    return shift;
  }

  /** The shifts API refuses overlapping shifts for one employee; the seed must never contain any. */
  assertNoShiftOverlaps(): void {
    const byEmployee = new Map<string, BuiltShift[]>();
    for (const shift of this.shifts) {
      const list = byEmployee.get(shift.employee.id) ?? [];
      list.push(shift);
      byEmployee.set(shift.employee.id, list);
    }
    for (const [, list] of byEmployee) {
      const first = list[0];
      if (first) assertNoOverlaps(`${first.employee.firstName} ${first.employee.lastName}`, list);
    }
  }

  /** A break session plus the BREAK_STARTED / BREAK_ENDED / BREAK_EXPIRED events the breaks service records. */
  addSession(p: AddSessionParams): BuiltSession {
    const status = p.endedAt ? "ENDED" : "ACTIVE";
    const clientBreakId = `seed:${this.orgKey}:${p.key}`;
    const session: BuiltSession = {
      id: this.id(`break-session:${p.key}`),
      shiftId: p.shift.id,
      startedAt: p.startedAt,
      plannedEndsAt: p.plannedEndsAt,
      endedAt: p.endedAt,
      status,
      restrictionBehaviour: p.restrictionBehaviour,
      relaxedCategories: [],
      employee: p.shift.employee,
      shift: p.shift,
      deviceId: p.device?.id ?? null,
      breakPolicyId: p.breakPolicyId,
      endReason: p.endedAt ? p.endReason : null,
      clientBreakId,
      trigger: p.trigger ?? "EMPLOYEE",
    };
    this.sessions.push(session);
    this.rows.breakSessions.push({
      id: session.id,
      organisationId: this.organisationId,
      employeeId: session.employee.id,
      shiftId: session.shiftId,
      deviceId: session.deviceId,
      breakPolicyId: session.breakPolicyId,
      startedAt: session.startedAt,
      plannedEndsAt: session.plannedEndsAt,
      endedAt: session.endedAt,
      endReason: session.endReason,
      status: session.status,
      clientBreakId: session.clientBreakId,
      restrictionBehaviour: session.restrictionBehaviour,
      relaxedCategories: [],
      createdAt: session.startedAt,
    });

    const base = {
      actor: "EMPLOYEE_DEVICE" as const,
      employeeId: session.employee.id,
      deviceId: session.deviceId,
    };
    this.activity({
      ...base,
      type: "BREAK_STARTED",
      at: session.startedAt,
      clientEventId: session.deviceId ? `break:${clientBreakId}:started` : null,
      metadata: {
        breakSessionId: session.id,
        shiftId: session.shiftId,
        clientBreakId,
        trigger: session.trigger,
        plannedEndsAt: session.plannedEndsAt.toISOString(),
        durationMinutes: ceilMinutes(session.plannedEndsAt.getTime() - session.startedAt.getTime()),
        restrictionBehaviour: session.restrictionBehaviour,
      },
    });
    if (session.endedAt && session.endReason) {
      this.activity({
        ...base,
        type: session.endReason === "EXPIRED" ? "BREAK_EXPIRED" : "BREAK_ENDED",
        at: session.endedAt,
        clientEventId: session.deviceId ? `break:${clientBreakId}:ended` : null,
        metadata: {
          breakSessionId: session.id,
          shiftId: session.shiftId,
          endReason: session.endReason,
          minutes: ceilMinutes(session.endedAt.getTime() - session.startedAt.getTime()),
        },
      });
    }
    return session;
  }

  addOverride(override: SeedOverride): void {
    this.overrides.push(override);
  }

  addDevice(device: BuiltDevice): void {
    this.devices.push(device);
  }

  private shiftsOf(employee: BuiltEmployee): SeedShift[] {
    return this.shifts.filter((s) => s.employee.id === employee.id);
  }

  private sessionsOf(employee: BuiltEmployee): SeedBreakSession[] {
    return this.sessions.filter((s) => s.employee.id === employee.id);
  }

  private overridesOf(employee: BuiltEmployee): SeedOverride[] {
    return this.overrides.filter((o) => o.employeeId === null || o.employeeId === employee.id);
  }

  /**
   * Writes MobileUser / EmployeeUserLink / Device / EmployeeWorkState rows for every registered device. The
   * device's last report is what the state machine said at its last sync; the stored work state is the
   * evaluation at `now`, so the dashboard, the status badges and the state machine agree on first load.
   */
  materialiseDevices(): DeviceEvaluation[] {
    const evaluations: DeviceEvaluation[] = [];
    for (const device of this.devices) {
      const employee = device.employee;
      const inputs = {
        timezone: this.timezone,
        employeeId: employee.id,
        device: {
          isActive: device.isActive,
          permissionState: device.permissionState,
          selectionState: device.selectionState,
          lastDeviceSyncAt: device.lastDeviceSyncAt,
          lastClockSkewSeconds: device.skewSeconds,
        },
        shifts: this.shiftsOf(employee),
        sessions: this.sessionsOf(employee),
        overrides: this.overridesOf(employee),
        preShiftWarningMinutes: employee.preShiftWarningMinutes,
      };
      const reported =
        device.reports && device.lastDeviceSyncAt
          ? { state: expectedStateAt(inputs, device.lastDeviceSyncAt).state, at: device.lastDeviceSyncAt }
          : null;
      const evaluation = evaluateWorkState({
        ...inputs,
        now: this.clock.now,
        employee: {
          inviteStatus: employee.inviteStatus,
          employmentStatus: employee.employmentStatus,
          linkedAt: device.linkedAt,
        },
        reported,
      });

      this.rows.mobileUsers.push({
        id: device.mobileUserId,
        firstName: employee.firstName,
        lastName: employee.lastName,
        createdAt: device.linkedAt,
      });
      this.rows.employeeUserLinks.push({
        id: this.id(`link:${employee.key}`),
        employeeId: employee.id,
        mobileUserId: device.mobileUserId,
        linkedAt: device.linkedAt,
        createdAt: device.linkedAt,
      });
      this.rows.devices.push({
        id: device.id,
        mobileUserId: device.mobileUserId,
        employeeId: employee.id,
        organisationId: this.organisationId,
        platform: "IOS",
        appVersion: device.appVersion,
        osVersion: device.os,
        deviceModel: device.model,
        permissionState: device.permissionState,
        selectionState: device.selectionState,
        selectionCategoryCount: device.counts.categories,
        selectionAppCount: device.counts.applications,
        selectionDomainCount: device.counts.webDomains,
        restrictionEngineState: reported?.state ?? "UNKNOWN",
        policyVersionId: employee.workPolicyVersionId,
        scheduleVersion: device.scheduleVersion,
        timezone: this.timezone,
        lastDeviceSyncAt: device.lastDeviceSyncAt,
        lastPolicySyncAt: device.lastDeviceSyncAt,
        lastScheduleSyncAt: device.lastDeviceSyncAt,
        lastSeenAt: device.lastSeenAt ?? device.lastDeviceSyncAt,
        lastClockSkewSeconds: device.skewSeconds,
        isActive: device.isActive,
        deactivatedAt: device.deactivatedAt,
        createdAt: device.linkedAt,
      });
      this.rows.employeeWorkStates.push({ id: this.id(`work-state:${employee.key}`), ...evaluation.row });
      evaluations.push({ ...evaluation, device, reported });
    }
    return evaluations;
  }

  /**
   * WORK_MODE_STARTED / WORK_MODE_ENDED as the device would have reported them for every shift it enforced:
   * permission approved, selection configured, device registered before the shift and still active during it.
   */
  recordWorkModeEvents(device: BuiltDevice): void {
    if (!device.reports || device.permissionState !== "APPROVED" || device.selectionState !== "CONFIGURED") {
      return;
    }
    for (const shift of this.shifts) {
      if (shift.employee.id !== device.employee.id) continue;
      if (shift.startsAt < device.linkedAt || !this.clock.isPast(shift.startsAt)) continue;
      if (device.deactivatedAt && shift.startsAt >= device.deactivatedAt) continue;
      const base = {
        actor: "EMPLOYEE_DEVICE" as const,
        employeeId: device.employee.id,
        deviceId: device.id,
      };
      this.activity({
        ...base,
        type: "WORK_MODE_STARTED",
        at: addSeconds(shift.startsAt, 6),
        clientEventId: `shift:${shift.id}:started`,
        metadata: {
          shiftId: shift.id,
          engineState: "WORKING",
          policyVersion: device.employee.workPolicyVersionId,
          scheduleVersion: device.scheduleVersion,
        },
      });
      if (this.clock.isPast(shift.endsAt) && (!device.deactivatedAt || shift.endsAt < device.deactivatedAt)) {
        this.activity({
          ...base,
          type: "WORK_MODE_ENDED",
          at: addSeconds(shift.endsAt, 4),
          clientEventId: `shift:${shift.id}:ended`,
          metadata: { shiftId: shift.id, engineState: "OFF_SHIFT", reason: "SHIFT_ENDED" },
        });
      }
    }
  }
}
