import { prisma, type ManagerOverride } from "@clockoff/db";
import {
  expiredBreakSessionClosures,
  type BreakSessionClosure,
} from "@clockoff/shared/breaks/breakRules";
import { isAppError } from "@clockoff/shared/errors";
import { resolutionWarningKey } from "@clockoff/shared/policy/resolvePolicy";
import { endOfLocalDay, startOfLocalDay } from "@clockoff/shared/time/time";
import { diffStates } from "@clockoff/shared/workMode/workModeMachine";
import { childLogger, errorSummary, type Logger } from "@/lib/logger";
import { publishActivity, recordActivity } from "@/server/activity/recordActivity";
import { applyBreakClosures } from "@/server/breaks/breaks.repository";
import { recordClosureEvents, startBreak } from "@/server/breaks/breaks.service";
import {
  DIGEST_BADGES,
  sendOrganisationDigest,
  type DigestAttentionEmployee,
} from "@/server/digest/digest.service";
import { publishEvent } from "@/server/events";
import {
  ambiguousTeamWarnings,
  type EmployeePolicyResolution,
} from "@/server/sync/policyResolution";
import { scheduledBreakWindow } from "@/server/sync/mobileMappers";
import { markCompletedShifts, materialiseRecurrences } from "./externalServices";
import { DAY_MS, findJobCandidates, type WorkStateInputs } from "./workState.repository";
import {
  evaluateOrganisation,
  persistEvaluation,
  publishWorkStateChanged,
  recordSyncDelayedEpisode,
  type EmployeeEvaluation,
} from "./workState.service";

/**
 * The server Work Mode job (§10) — `runWorkModeTick(now)`. The worker process (`src/worker`) runs it every
 * minute as three jobs, each under its own Postgres advisory lock: `work-mode-tick` (steps 1–3, with
 * `sweepOverrides: false, scheduleUpkeep: false`), `override-expiry` (step 4, `sweepExpiredOverrides`) and
 * `schedule-upkeep` (step 5, `runScheduleUpkeep`). Called without options it runs all five steps (tests,
 * scripts). See docs/WORK_MODE_SERVER_JOB.md.
 *
 * Order of work (every step idempotent, every write guarded so concurrent ticks never double-emit):
 *   1. Break sweep — ACTIVE sessions whose effective end has passed are closed (`expiredBreakSessionClosures`:
 *      EXPIRED, or SHIFT_ENDED when the shift end cut them short) and sessions of cancelled / deleted shifts
 *      are ended SHIFT_ENDED; one SYSTEM BREAK_EXPIRED / BREAK_ENDED per closure THIS tick applied.
 *   2. Scheduled breaks — `ScheduledBreak` windows that are open now start server-side (trigger SCHEDULED,
 *      `clientBreakId = scheduled:<id>`), subject to the break policy.
 *   3. Evaluation — for every candidate employee (shift within ±1 day, ACTIVE break, active override, or a
 *      stored state not yet back at OFF_SHIFT): `computeExpectedState`, upsert `EmployeeWorkState`,
 *      DEVICE_SYNC_DELAYED once per episode, POLICY_RESOLUTION_WARNING once per (employee, key) per day,
 *      `employee.work_state.changed` for changed rows, and the hourly manager digest.
 *   4. Override sweep — rows past `expiresAt` with no `expiredEventEmittedAt` get OVERRIDE_EXPIRED exactly once.
 *   5. Schedule upkeep — `materialiseRecurrences()` and `markCompletedShifts()` from the shifts service.
 */

export interface WorkModeTickOptions {
  log?: Logger;
  /** Skip the manager digest (tests of other steps). Default true. */
  sendDigest?: boolean;
  /**
   * Step 4, the override sweep. Default true; the worker's `work-mode-tick` job passes false because the
   * `override-expiry` job runs it under its own lock.
   */
  sweepOverrides?: boolean;
  /**
   * Step 5, schedule upkeep. Default true; the worker's `work-mode-tick` job passes false because the
   * `schedule-upkeep` job runs it under its own lock.
   */
  scheduleUpkeep?: boolean;
}

export interface WorkModeTickReport {
  now: string;
  durationMs: number;
  organisations: number;
  employeesEvaluated: number;
  stateRowsChanged: number;
  /** ActivityEvent-bearing transitions `diffStates` observed against the previously stored expectation. */
  transitions: number;
  breaksExpired: number;
  breaksEndedByShift: number;
  scheduledBreaksStarted: number;
  scheduledBreaksSkipped: number;
  syncDelayedEpisodes: number;
  resolutionWarnings: number;
  overridesExpired: number;
  digestsSent: number;
  recurrencesCreated: number;
  shiftsCompleted: number;
  /** Organisation ids whose evaluation failed (logged with the error summary; others continue). */
  errors: string[];
}

/** Loaded 2 days ahead so `nextTransitionAt` is meaningful (docs/WORK_MODE_STATE_MACHINE.md §4). */
const EVALUATION_WINDOW = { backMs: DAY_MS, aheadMs: 2 * DAY_MS } as const;

export function scheduledBreakClientId(scheduledBreakId: string): string {
  return `scheduled:${scheduledBreakId}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Break sweep
// ─────────────────────────────────────────────────────────────────────────────

export interface BreakSweepReport {
  expired: number;
  endedByShift: number;
}

/**
 * Close every ACTIVE break session whose time is up. For SCHEDULED shifts the pure
 * `expiredBreakSessionClosures` decides (effective end `min(plannedEndsAt, shift.endsAt)` ≤ now); a session
 * whose shift was cancelled, completed or deleted is ended SHIFT_ENDED at `min(now, plannedEndsAt, shift.endsAt)`.
 */
export async function sweepExpiredBreakSessions(
  now: Date,
  log: Logger = childLogger({ module: "workModeTick" }),
): Promise<BreakSweepReport> {
  const report: BreakSweepReport = { expired: 0, endedByShift: 0 };
  const active = await prisma.breakSession.findMany({
    where: { status: "ACTIVE" },
    include: {
      shift: { select: { id: true, startsAt: true, endsAt: true, status: true, deletedAt: true } },
    },
    orderBy: [{ startedAt: "asc" }],
  });
  if (active.length === 0) return report;

  const byShift = new Map<string, typeof active>();
  for (const session of active) {
    const list = byShift.get(session.shiftId);
    if (list) list.push(session);
    else byShift.set(session.shiftId, [session]);
  }

  for (const sessions of byShift.values()) {
    const first = sessions[0]!;
    const { shift } = first;
    const shiftUsable = shift.status === "SCHEDULED" && shift.deletedAt === null;
    let closures: BreakSessionClosure[];
    try {
      closures = shiftUsable
        ? expiredBreakSessionClosures(shift, sessions, now)
        : sessions.map((s) => ({
            sessionId: s.id,
            endedAt: new Date(
              Math.max(
                s.startedAt.getTime(),
                Math.min(now.getTime(), s.plannedEndsAt.getTime(), shift.endsAt.getTime()),
              ),
            ),
            endReason: "SHIFT_ENDED" as const,
          }));
    } catch (err) {
      log.error(
        { error: errorSummary(err), shiftId: shift.id },
        "break sweep: closure computation failed",
      );
      continue;
    }
    if (closures.length === 0) continue;
    const applied = await applyBreakClosures(first.organisationId, closures);
    const events = await recordClosureEvents(
      prisma,
      first.organisationId,
      first.employeeId,
      shift.id,
      applied,
    );
    for (const event of events) publishActivity(event);
    for (const closure of applied) {
      if (closure.endReason === "EXPIRED") report.expired += 1;
      else report.endedByShift += 1;
    }
  }
  return report;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Scheduled breaks
// ─────────────────────────────────────────────────────────────────────────────

export interface ScheduledBreaksReport {
  started: number;
  /** Refused by the break policy (e.g. scheduledBreaksAllowed false, limits) — retried while the window is open. */
  skipped: number;
}

export async function startDueScheduledBreaks(
  now: Date,
  log: Logger = childLogger({ module: "workModeTick" }),
): Promise<ScheduledBreaksReport> {
  const report: ScheduledBreaksReport = { started: 0, skipped: 0 };
  const candidates = await prisma.scheduledBreak.findMany({
    where: {
      shift: {
        status: "SCHEDULED",
        deletedAt: null,
        startsAt: { lte: now },
        endsAt: { gt: now },
        employee: { employmentStatus: "ACTIVE", deletedAt: null },
      },
    },
    include: {
      shift: {
        select: { id: true, organisationId: true, employeeId: true, startsAt: true, endsAt: true },
      },
    },
  });
  const due = candidates
    .map((sb) => ({ sb, window: scheduledBreakWindow(sb.shift, sb) }))
    .filter(
      ({ window }) =>
        window.startsAt.getTime() <= now.getTime() && now.getTime() < window.endsAt.getTime(),
    );
  if (due.length === 0) return report;

  const existing = new Set(
    (
      await prisma.breakSession.findMany({
        where: { clientBreakId: { in: due.map(({ sb }) => scheduledBreakClientId(sb.id)) } },
        select: { clientBreakId: true },
      })
    ).map((row) => row.clientBreakId),
  );

  for (const { sb, window } of due) {
    const clientBreakId = scheduledBreakClientId(sb.id);
    if (existing.has(clientBreakId)) continue;
    try {
      const result = await startBreak({
        organisationId: sb.shift.organisationId,
        employeeId: sb.shift.employeeId,
        deviceId: null,
        clientBreakId,
        shiftId: sb.shift.id,
        requestedAt: window.startsAt,
        receivedAt: now,
        requestedDurationMinutes: sb.durationMinutes,
        trigger: "SCHEDULED",
        skewSeconds: null,
        actorType: "SYSTEM",
        reconcileLateRefusals: false,
      });
      if (result.outcome !== "ALREADY_RECORDED") report.started += 1;
    } catch (err) {
      if (isAppError(err)) {
        report.skipped += 1;
        log.debug(
          { code: err.code, scheduledBreakId: sb.id, shiftId: sb.shift.id },
          "scheduled break refused",
        );
      } else {
        log.error(
          { error: errorSummary(err), scheduledBreakId: sb.id },
          "scheduled break start failed",
        );
      }
    }
  }
  return report;
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. Evaluation helpers
// ─────────────────────────────────────────────────────────────────────────────

/** `POLICY_RESOLUTION_WARNING` for AMBIGUOUS_TEAM_ASSIGNMENT, at most once per (employee, key) per day. */
export async function recordResolutionWarnings(
  organisationId: string,
  employeeId: string,
  policy: EmployeePolicyResolution | null,
  now: Date,
): Promise<number> {
  if (!policy) return 0;
  const warnings = ambiguousTeamWarnings(policy);
  if (warnings.length === 0) return 0;
  const workWarnings = new Set(policy.workWarnings);
  let recorded = 0;
  for (const warning of warnings) {
    const kind = workWarnings.has(warning) ? "work" : "break";
    const key = `${kind}:${resolutionWarningKey(warning)}`;
    const existing = await prisma.activityEvent.findFirst({
      where: {
        organisationId,
        employeeId,
        type: "POLICY_RESOLUTION_WARNING",
        occurredAt: { gte: new Date(now.getTime() - DAY_MS) },
        metadata: { path: ["resolutionWarningKey"], equals: key },
      },
      select: { id: true },
    });
    if (existing) continue;
    await recordActivity({
      organisationId,
      employeeId,
      actorType: "SYSTEM",
      type: "POLICY_RESOLUTION_WARNING",
      occurredAt: now,
      metadata: {
        code: warning.code,
        kind,
        resolutionWarningKey: key,
        message: warning.message,
        details: warning.details,
      },
    });
    recorded += 1;
  }
  return recorded;
}

/** An employee belongs in the digest when flagged AND has a shift on the local calendar day of `now`. */
export function digestCandidate(
  evaluation: EmployeeEvaluation,
  inputs: WorkStateInputs,
  now: Date,
): DigestAttentionEmployee | null {
  const badge = evaluation.badge;
  if (!badge || !DIGEST_BADGES.has(badge.badge)) return null;
  const dayStart = startOfLocalDay(now, evaluation.timezone);
  const dayEnd = endOfLocalDay(now, evaluation.timezone);
  const shifts = inputs.shiftsByEmployee.get(evaluation.employee.id) ?? [];
  const hasShiftToday = shifts.some(
    (s) => s.startsAt.getTime() < dayEnd.getTime() && s.endsAt.getTime() > dayStart.getTime(),
  );
  if (!hasShiftToday) return null;
  return {
    employeeId: evaluation.employee.id,
    firstName: evaluation.employee.firstName,
    lastName: evaluation.employee.lastName,
    badge: badge.badge,
    reason: badge.reason ?? null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. Override sweep
// ─────────────────────────────────────────────────────────────────────────────

export function publishOverrideEvent(
  action: "OVERRIDE_CREATED" | "OVERRIDE_REVOKED" | "OVERRIDE_EXPIRED",
  override: Pick<
    ManagerOverride,
    "id" | "organisationId" | "employeeId" | "type" | "startsAt" | "expiresAt"
  >,
): void {
  const payload = {
    overrideId: override.id,
    type: override.type,
    employeeId: override.employeeId,
    startsAt: override.startsAt.toISOString(),
    expiresAt: override.expiresAt.toISOString(),
  };
  const employee = override.employeeId ? { employeeId: override.employeeId } : {};
  publishEvent({ type: action, organisationId: override.organisationId, ...employee, payload });
  publishEvent({
    type: "override.changed",
    organisationId: override.organisationId,
    ...employee,
    payload: { ...payload, action },
  });
}

/**
 * OVERRIDE_EXPIRED for every override past `expiresAt` that was never revoked and has no
 * `expiredEventEmittedAt`; the column is claimed with a guarded update so the event is emitted exactly once.
 */
export async function sweepExpiredOverrides(now: Date): Promise<number> {
  const rows = await prisma.managerOverride.findMany({
    where: { expiresAt: { lte: now }, expiredEventEmittedAt: null, revokedAt: null },
    orderBy: [{ expiresAt: "asc" }],
  });
  let emitted = 0;
  for (const row of rows) {
    const claimed = await prisma.managerOverride.updateMany({
      where: { id: row.id, expiredEventEmittedAt: null },
      data: { expiredEventEmittedAt: now },
    });
    if (claimed.count !== 1) continue;
    await recordActivity({
      organisationId: row.organisationId,
      employeeId: row.employeeId,
      actorType: "SYSTEM",
      type: "OVERRIDE_EXPIRED",
      occurredAt: row.expiresAt,
      metadata: {
        overrideId: row.id,
        type: row.type,
        startsAt: row.startsAt.toISOString(),
        expiresAt: row.expiresAt.toISOString(),
        orgWide: row.employeeId === null,
      },
    });
    publishOverrideEvent("OVERRIDE_EXPIRED", row);
    emitted += 1;
  }
  return emitted;
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. Schedule upkeep
// ─────────────────────────────────────────────────────────────────────────────

export interface ScheduleUpkeepReport {
  recurrencesCreated: number;
  shiftsCompleted: number;
  /** `"recurrences"` / `"shifts"` for a step that failed (logged with the error summary). */
  errors: string[];
}

/**
 * Materialise recurring shifts up to the horizon and mark ended shifts COMPLETED (both owned by the shifts
 * service and idempotent). A failing step is logged and reported; it never prevents the other.
 */
export async function runScheduleUpkeep(
  now: Date,
  log: Logger = childLogger({ module: "workModeTick" }),
): Promise<ScheduleUpkeepReport> {
  const report: ScheduleUpkeepReport = { recurrencesCreated: 0, shiftsCompleted: 0, errors: [] };
  try {
    const recurrences = await materialiseRecurrences(undefined, undefined, now);
    report.recurrencesCreated = recurrences.created;
  } catch (err) {
    log.error({ error: errorSummary(err) }, "schedule upkeep: recurrence materialisation failed");
    report.errors.push("recurrences");
  }
  try {
    report.shiftsCompleted = await markCompletedShifts(now);
  } catch (err) {
    log.error({ error: errorSummary(err) }, "schedule upkeep: completing shifts failed");
    report.errors.push("shifts");
  }
  return report;
}

// ─────────────────────────────────────────────────────────────────────────────
// The tick
// ─────────────────────────────────────────────────────────────────────────────

export async function runWorkModeTick(
  now: Date = new Date(),
  options: WorkModeTickOptions = {},
): Promise<WorkModeTickReport> {
  const startedAt = Date.now();
  const log = options.log ?? childLogger({ module: "workModeTick", tickAt: now.toISOString() });
  const report: WorkModeTickReport = {
    now: now.toISOString(),
    durationMs: 0,
    organisations: 0,
    employeesEvaluated: 0,
    stateRowsChanged: 0,
    transitions: 0,
    breaksExpired: 0,
    breaksEndedByShift: 0,
    scheduledBreaksStarted: 0,
    scheduledBreaksSkipped: 0,
    syncDelayedEpisodes: 0,
    resolutionWarnings: 0,
    overridesExpired: 0,
    digestsSent: 0,
    recurrencesCreated: 0,
    shiftsCompleted: 0,
    errors: [],
  };

  // 1–2. Breaks first, so the evaluation below sees closed / started sessions.
  const sweep = await sweepExpiredBreakSessions(now, log);
  report.breaksExpired = sweep.expired;
  report.breaksEndedByShift = sweep.endedByShift;
  const scheduled = await startDueScheduledBreaks(now, log);
  report.scheduledBreaksStarted = scheduled.started;
  report.scheduledBreaksSkipped = scheduled.skipped;

  // 3. Evaluate every candidate employee, organisation by organisation.
  const candidates = await findJobCandidates(now);
  for (const [organisationId, employeeIds] of candidates) {
    report.organisations += 1;
    try {
      const evaluated = await evaluateOrganisation({
        organisationId,
        employeeIds: [...employeeIds],
        now,
        shiftWindow: {
          from: new Date(now.getTime() - EVALUATION_WINDOW.backMs),
          to: new Date(now.getTime() + EVALUATION_WINDOW.aheadMs),
        },
      });
      const attention: DigestAttentionEmployee[] = [];
      for (const evaluation of evaluated.evaluations) {
        const previousExpected = evaluation.previous?.expectedState ?? null;
        const { row, startedSyncDelayedEpisode } = await persistEvaluation(evaluation);
        report.employeesEvaluated += 1;
        if (previousExpected) {
          const transitions = diffStates(previousExpected, evaluation.expected).filter(
            (t) => t.eventType,
          );
          report.transitions += transitions.length;
          if (transitions.length > 0) {
            log.debug(
              {
                employeeId: evaluation.employee.id,
                transitions: transitions.map((t) => t.eventType),
              },
              "expected state transition",
            );
          }
        }
        if (startedSyncDelayedEpisode) {
          await recordSyncDelayedEpisode(evaluation, now);
          report.syncDelayedEpisodes += 1;
        }
        if (evaluation.changed) {
          publishWorkStateChanged(evaluation, row);
          report.stateRowsChanged += 1;
        }
        report.resolutionWarnings += await recordResolutionWarnings(
          organisationId,
          evaluation.employee.id,
          evaluation.policy,
          now,
        );
        const candidate = digestCandidate(evaluation, evaluated.inputs, now);
        if (candidate) attention.push(candidate);
      }
      if ((options.sendDigest ?? true) && attention.length > 0) {
        const digest = await sendOrganisationDigest({ organisationId, now, employees: attention });
        if (digest.sent) report.digestsSent += 1;
      }
    } catch (err) {
      log.error(
        { error: errorSummary(err), organisationId },
        "work mode tick: organisation failed",
      );
      report.errors.push(organisationId);
    }
  }

  // 4. Overrides that expired without shaping anyone's output still get their event.
  if (options.sweepOverrides ?? true) {
    try {
      report.overridesExpired = await sweepExpiredOverrides(now);
    } catch (err) {
      log.error({ error: errorSummary(err) }, "work mode tick: override sweep failed");
      report.errors.push("overrides");
    }
  }

  // 5. Schedule upkeep (owned by the shifts service; failures never block the tick).
  if (options.scheduleUpkeep ?? true) {
    const upkeep = await runScheduleUpkeep(now, log);
    report.recurrencesCreated = upkeep.recurrencesCreated;
    report.shiftsCompleted = upkeep.shiftsCompleted;
    report.errors.push(...upkeep.errors);
  }

  report.durationMs = Date.now() - startedAt;
  log.info(
    {
      organisations: report.organisations,
      employees: report.employeesEvaluated,
      changed: report.stateRowsChanged,
      breaksExpired: report.breaksExpired,
      overridesExpired: report.overridesExpired,
      digests: report.digestsSent,
      errors: report.errors.length,
      durationMs: report.durationMs,
    },
    "work mode tick",
  );
  return report;
}
