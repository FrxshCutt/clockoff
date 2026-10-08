import { Prisma, prisma, type ActivityEvent, type BreakSession } from "@clockoff/db";
import {
  breakRefusalToAppError,
  breakStartInstant,
  canStartBreak,
  computeBreakAllowance,
  deviceInstantToServerTime,
  expiredBreakSessionClosures,
  resolveBreakBehaviour,
  type BreakAllowance,
  type BreakPolicyLike,
  type BreakRefusalCode,
  type BreakSessionClosure,
  type BreakTrigger,
} from "@clockoff/shared/breaks/breakRules";
import type { ActorType, BreakEndReason } from "@clockoff/shared/enums";
import { AppError } from "@clockoff/shared/errors";
import { BREAK_POLICY_DEFAULTS } from "@clockoff/validation/breakPolicies";
import type {
  MobileBreakResponse,
  MobileEndBreakInput,
  MobileStartBreakInput,
} from "@clockoff/validation/mobile";
import { toBreakAllowanceDto, toBreakSessionDto } from "@/server/sync/mobileMappers";
import type { DeviceContext } from "@/server/tenancy/context";
import { updateDevice } from "@/server/sync/sync.repository";
import { publishActivity, recordActivity } from "@/server/activity/recordActivity";
import {
  resolveEmployeePolicies,
  type ResolvedBreakPolicy,
} from "@/server/workState/externalServices";
import { recomputeEmployeeWorkState } from "@/server/workState/workState.service";
import {
  applyBreakClosures,
  endSessionIfActive,
  findEmployeeSession,
  findSessionByClientBreakId,
  listSessionsForShift,
  lockShiftForEmployee,
  type ShiftForBreaks,
} from "./breaks.repository";

/**
 * Break sessions (§6.3). The rules are the pure functions in @clockoff/shared/breaks; this service owns the
 * transaction: per-shift lock → idempotency → close expired rows → validate at the server-clock start
 * instant → insert → allowance. See docs/BREAK_RULES.md ("Starting a break through the API").
 */

type Db = Prisma.TransactionClient | typeof prisma;

/** Oldest `requestedAt` (on the server clock) accepted as an offline reconciliation. */
export const MAX_RECONCILIATION_AGE_MS = 24 * 60 * 60 * 1000;
/** A start instant older than this is a late (offline) report rather than a live tap. */
export const LATE_REQUEST_THRESHOLD_MS = 60_000;

/**
 * Refusals that mean "the policy disagrees with what the device did while offline". A late request refused
 * for one of these is recorded as an ENDED session with `endReason = POLICY_CHANGED` so the record reflects
 * the relaxation that really happened on the phone; structural refusals (not on shift, overlapping break,
 * invalid input) are never written because the session would overlap a recorded break or fall outside the shift.
 */
const RECONCILABLE_REFUSALS: ReadonlySet<BreakRefusalCode> = new Set<BreakRefusalCode>([
  "BREAKS_DISABLED",
  "EMPLOYEE_BREAKS_NOT_ALLOWED",
  "BREAK_TOO_LONG",
  "BREAK_LIMIT_REACHED",
  "BREAK_TOO_SOON",
]);

/** Allowance when no break policy resolves: nothing is granted. */
const NO_BREAKS_POLICY: BreakPolicyLike = { ...BREAK_POLICY_DEFAULTS, breaksEnabled: false };

export type BreakStartOutcome =
  "STARTED" | "ALREADY_RECORDED" | "EXPIRED_ON_ARRIVAL" | "RECONCILED_POLICY_CHANGED";

export interface StartBreakParams {
  organisationId: string;
  employeeId: string;
  /** The reporting device (null for SCHEDULED / MANAGER starts). */
  deviceId: string | null;
  clientBreakId: string;
  shiftId: string;
  /** Device time of the tap (or the scheduled start). */
  requestedAt: Date;
  /** Server clock when the request arrived (or the tick). */
  receivedAt: Date;
  requestedDurationMinutes?: number | null;
  trigger: BreakTrigger;
  /** `Device.lastClockSkewSeconds`; null when unknown. */
  skewSeconds: number | null;
  actorType: ActorType;
  actorUserId?: string | null;
  /** Record a late, policy-refused request as POLICY_CHANGED instead of refusing (mobile EMPLOYEE requests). */
  reconcileLateRefusals: boolean;
}

export interface BreakOperationResult {
  session: BreakSession;
  allowance: BreakAllowance;
  outcome: BreakStartOutcome;
}

interface TransactionOutcome {
  session: BreakSession;
  allowance: BreakAllowance;
  outcome: BreakStartOutcome;
  published: ActivityEvent[];
}

function resolvedBreakPolicy(row: ResolvedBreakPolicy | null): BreakPolicyLike {
  return row ? row.rules : NO_BREAKS_POLICY;
}

function behaviourColumns(policy: {
  restrictionBehaviour: BreakPolicyLike["restrictionBehaviour"];
  relaxedCategories: unknown;
}) {
  const behaviour = resolveBreakBehaviour(policy);
  return {
    restrictionBehaviour: behaviour.restrictionBehaviour,
    relaxedCategories: behaviour.relaxedCategories as unknown as Prisma.InputJsonValue,
  };
}

function uniqueTarget(err: Prisma.PrismaClientKnownRequestError): string {
  const target = (err.meta as { target?: unknown } | undefined)?.target;
  return Array.isArray(target) ? target.join(",") : String(target ?? "");
}

async function closeExpiredSessions(
  tx: Prisma.TransactionClient,
  organisationId: string,
  employeeId: string,
  shift: ShiftForBreaks,
  sessions: BreakSession[],
  now: Date,
): Promise<{ sessions: BreakSession[]; events: ActivityEvent[] }> {
  const closures = expiredBreakSessionClosures(shift, sessions, now);
  if (closures.length === 0) return { sessions, events: [] };
  const applied = await applyBreakClosures(organisationId, closures, tx);
  const events = await recordClosureEvents(tx, organisationId, employeeId, shift.id, applied);
  const byId = new Map(applied.map((c) => [c.sessionId, c]));
  const updated = sessions.map((s) => {
    const closure = byId.get(s.id);
    return closure
      ? { ...s, status: "ENDED" as const, endedAt: closure.endedAt, endReason: closure.endReason }
      : s;
  });
  return { sessions: updated, events };
}

/** SYSTEM events for closures this call applied: BREAK_EXPIRED, or BREAK_ENDED (SHIFT_ENDED) when the shift end cut it. */
export async function recordClosureEvents(
  db: Db,
  organisationId: string,
  employeeId: string,
  shiftId: string,
  applied: readonly BreakSessionClosure[],
): Promise<ActivityEvent[]> {
  const events: ActivityEvent[] = [];
  for (const closure of applied) {
    const { event } = await recordActivity(
      {
        organisationId,
        employeeId,
        actorType: "SYSTEM",
        type: closure.endReason === "EXPIRED" ? "BREAK_EXPIRED" : "BREAK_ENDED",
        occurredAt: closure.endedAt,
        metadata: { breakSessionId: closure.sessionId, shiftId, endReason: closure.endReason },
      },
      { db, publish: false },
    );
    events.push(event);
  }
  return events;
}

function isUniqueViolation(err: unknown): err is Prisma.PrismaClientKnownRequestError {
  return err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002";
}

export async function startBreak(params: StartBreakParams): Promise<BreakOperationResult> {
  const { organisationId, employeeId, receivedAt } = params;
  // The break policy CURRENTLY assigned to the employee (never the one the device cached). Resolved before the
  // transaction: the policies service reads through the shared client and nothing it reads is locked below.
  const policyRow = (await resolveEmployeePolicies(organisationId, employeeId, receivedAt))
    .breakPolicy;
  const policy = resolvedBreakPolicy(policyRow);

  let result: TransactionOutcome;
  try {
    result = await startBreakTransaction(params, policyRow, policy);
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    // Postgres aborts the whole transaction on a unique violation (every later statement fails until the
    // rollback), so recovery happens HERE, after `$transaction` rolled back — never inside it.
    const target = uniqueTarget(err);
    if (target.includes("client_break_id") || target.includes("clientBreakId")) {
      // A concurrent request with the same clientBreakId committed first (a different shift, so the per-shift
      // lock did not serialise it): re-run so the idempotency step answers with that row. A key that belongs to
      // another employee is a client bug — never that employee's session.
      const existing = await findSessionByClientBreakId(
        organisationId,
        employeeId,
        params.clientBreakId,
      );
      if (!existing) throw new AppError("CONFLICT", "clientBreakId is already in use");
      result = await startBreakTransaction(params, policyRow, policy);
    } else {
      // break_sessions_one_active_per_shift: two different starts raced past the lock.
      throw new AppError("BREAK_ALREADY_ACTIVE", "A break is already in progress.", {
        details: { reason: "BREAK_IN_PROGRESS" },
      });
    }
  }

  for (const event of result.published) publishActivity(event);
  await recomputeEmployeeWorkState({ organisationId, employeeId, now: receivedAt });
  return { session: result.session, allowance: result.allowance, outcome: result.outcome };
}

/** One attempt at the break-start transaction (docs/BREAK_RULES.md steps 1–7). A unique violation propagates. */
async function startBreakTransaction(
  params: StartBreakParams,
  policyRow: ResolvedBreakPolicy | null,
  policy: BreakPolicyLike,
): Promise<TransactionOutcome> {
  const { organisationId, employeeId, receivedAt } = params;
  return prisma.$transaction(async (tx): Promise<TransactionOutcome> => {
    const published: ActivityEvent[] = [];

    // 1. Lock the shift row (serialises starts per shift) and check ownership.
    const shift = await lockShiftForEmployee(tx, {
      organisationId,
      employeeId,
      shiftId: params.shiftId,
    });
    if (!shift) throw new AppError("NOT_FOUND", "Shift not found");

    // 2. Idempotency: a retry of the same clientBreakId returns the recorded session unchanged.
    const existing = await findSessionByClientBreakId(
      organisationId,
      employeeId,
      params.clientBreakId,
      tx,
    );
    if (existing) {
      const sessions = await listSessionsForShift(organisationId, existing.shiftId, tx);
      const window =
        existing.shiftId === shift.id
          ? shift
          : await tx.shift.findUniqueOrThrow({ where: { id: existing.shiftId } });
      return {
        session: existing,
        allowance: computeBreakAllowance(policy, window, sessions, receivedAt),
        outcome: "ALREADY_RECORDED",
        published,
      };
    }
    if (shift.status !== "SCHEDULED") {
      throw new AppError("NOT_ON_SHIFT", "This shift is no longer scheduled.", {
        details: { reason: "SHIFT_NOT_SCHEDULED", status: shift.status },
      });
    }

    // 3. Close expired-but-unclosed rows first (break_sessions_one_active_per_shift).
    const loaded = await listSessionsForShift(organisationId, shift.id, tx);
    const closed = await closeExpiredSessions(
      tx,
      organisationId,
      employeeId,
      shift,
      loaded,
      receivedAt,
    );
    published.push(...closed.events);
    const sessions = closed.sessions;

    // 4. Start instant on the server clock (never later than receivedAt).
    const startAt =
      params.trigger === "EMPLOYEE"
        ? breakStartInstant(params.requestedAt, receivedAt, params.skewSeconds)
        : new Date(Math.min(params.requestedAt.getTime(), receivedAt.getTime()));
    if (receivedAt.getTime() - startAt.getTime() > MAX_RECONCILIATION_AGE_MS) {
      throw new AppError("VALIDATION_ERROR", "requestedAt is more than 24 hours in the past", {
        details: { field: "requestedAt", reason: "TOO_OLD" },
      });
    }
    const isLate = receivedAt.getTime() - startAt.getTime() > LATE_REQUEST_THRESHOLD_MS;

    // 5. Validate.
    const decision = canStartBreak({
      policy,
      shift,
      existingSessions: sessions,
      now: startAt,
      requestedDurationMinutes: params.requestedDurationMinutes ?? null,
      trigger: params.trigger,
    });

    let session: BreakSession;
    let outcome: BreakStartOutcome;
    if (decision.ok) {
      const alreadyOver = decision.plannedEndsAt.getTime() <= receivedAt.getTime();
      session = await insertSession(tx, {
        organisationId,
        employeeId,
        shiftId: shift.id,
        deviceId: params.deviceId,
        breakPolicyId: policyRow?.id ?? null,
        clientBreakId: params.clientBreakId,
        startedAt: decision.startsAt,
        plannedEndsAt: decision.plannedEndsAt,
        status: alreadyOver ? "ENDED" : "ACTIVE",
        endedAt: alreadyOver ? decision.plannedEndsAt : null,
        endReason: alreadyOver ? "EXPIRED" : null,
        ...behaviourColumns(decision.behaviour),
      });
      outcome = alreadyOver ? "EXPIRED_ON_ARRIVAL" : "STARTED";
    } else if (params.reconcileLateRefusals && isLate && RECONCILABLE_REFUSALS.has(decision.code)) {
      // The phone relaxed restrictions while offline; the current policy says it should not have. Record what
      // happened and end it now so the device lifts the relaxation immediately.
      const minutes = Math.max(
        1,
        Math.floor(params.requestedDurationMinutes ?? policy.maxBreakDurationMinutes ?? 1),
      );
      const plannedMs = Math.max(
        startAt.getTime(),
        Math.min(startAt.getTime() + minutes * 60_000, shift.endsAt.getTime()),
      );
      const endedMs = Math.max(startAt.getTime(), Math.min(receivedAt.getTime(), plannedMs));
      session = await insertSession(tx, {
        organisationId,
        employeeId,
        shiftId: shift.id,
        deviceId: params.deviceId,
        breakPolicyId: policyRow?.id ?? null,
        clientBreakId: params.clientBreakId,
        startedAt: startAt,
        plannedEndsAt: new Date(plannedMs),
        status: "ENDED",
        endedAt: new Date(endedMs),
        endReason: "POLICY_CHANGED",
        ...behaviourColumns(policy),
      });
      outcome = "RECONCILED_POLICY_CHANGED";
    } else {
      throw breakRefusalToAppError(decision);
    }

    // 6. Activity: BREAK_STARTED (+ the end event when the session arrived already over).
    const idempotency = params.deviceId ? { deviceId: params.deviceId } : {};
    const started = await recordActivity(
      {
        organisationId,
        employeeId,
        ...idempotency,
        actorType: params.actorType,
        actorUserId: params.actorUserId ?? null,
        type: "BREAK_STARTED",
        occurredAt: session.startedAt,
        metadata: {
          breakSessionId: session.id,
          shiftId: shift.id,
          clientBreakId: session.clientBreakId,
          trigger: params.trigger,
          plannedEndsAt: session.plannedEndsAt.toISOString(),
          durationMinutes: Math.ceil(
            (session.plannedEndsAt.getTime() - session.startedAt.getTime()) / 60_000,
          ),
          restrictionBehaviour: session.restrictionBehaviour,
          ...(outcome === "RECONCILED_POLICY_CHANGED"
            ? { refusalCode: decision.ok ? null : decision.code }
            : {}),
        },
        clientEventId: params.deviceId ? `break:${params.clientBreakId}:started` : null,
      },
      { db: tx, publish: false },
    );
    published.push(started.event);
    if (session.status === "ENDED" && session.endedAt) {
      const ended = await recordActivity(
        {
          organisationId,
          employeeId,
          ...idempotency,
          actorType: session.endReason === "POLICY_CHANGED" ? "SYSTEM" : params.actorType,
          type: session.endReason === "EXPIRED" ? "BREAK_EXPIRED" : "BREAK_ENDED",
          occurredAt: session.endedAt,
          metadata: { breakSessionId: session.id, shiftId: shift.id, endReason: session.endReason },
          clientEventId: params.deviceId ? `break:${params.clientBreakId}:ended` : null,
        },
        { db: tx, publish: false },
      );
      published.push(ended.event);
    }

    const after = [...sessions, session];
    return {
      session,
      allowance: computeBreakAllowance(policy, shift, after, receivedAt),
      outcome,
      published,
    };
  });
}

/** Plain insert: a unique violation (clientBreakId, one-active-per-shift) is handled by `startBreak` after the rollback. */
async function insertSession(
  tx: Prisma.TransactionClient,
  data: Prisma.BreakSessionUncheckedCreateInput,
): Promise<BreakSession> {
  return tx.breakSession.create({ data });
}

export interface EndBreakParams {
  organisationId: string;
  employeeId: string;
  deviceId: string | null;
  sessionId: string;
  /** Device time of the end (converted with the device's skew). */
  endedAt: Date;
  receivedAt: Date;
  reason: Extract<BreakEndReason, "EMPLOYEE_ENDED" | "EXPIRED" | "SHIFT_ENDED" | "MANAGER_ENDED">;
  skewSeconds: number | null;
  actorType: ActorType;
  actorUserId?: string | null;
}

export interface EndBreakResult {
  session: BreakSession;
  allowance: BreakAllowance;
  /** False when the session was already ended (idempotent replay). */
  ended: boolean;
}

export async function endBreak(params: EndBreakParams): Promise<EndBreakResult> {
  const { organisationId, employeeId, receivedAt } = params;
  const found = await findEmployeeSession(organisationId, employeeId, params.sessionId);
  if (!found) throw new AppError("NOT_FOUND", "Break session not found");
  const { shift, ...current } = found;

  const policy = resolvedBreakPolicy(
    (await resolveEmployeePolicies(organisationId, employeeId, receivedAt)).breakPolicy,
  );
  const allowanceFor = async (): Promise<BreakAllowance> =>
    computeBreakAllowance(
      policy,
      shift,
      await listSessionsForShift(organisationId, shift.id),
      receivedAt,
    );

  if (current.status === "ENDED") {
    return { session: current, allowance: await allowanceFor(), ended: false };
  }

  // Clamp the reported end to [startedAt, min(plannedEndsAt, shift.endsAt, receivedAt)].
  const reported = deviceInstantToServerTime(params.endedAt, params.skewSeconds ?? 0).getTime();
  const cap = Math.min(
    current.plannedEndsAt.getTime(),
    shift.endsAt.getTime(),
    receivedAt.getTime(),
  );
  const endedAt = new Date(Math.max(current.startedAt.getTime(), Math.min(reported, cap)));

  const { session, ended } = await endSessionIfActive(organisationId, current.id, {
    endedAt,
    endReason: params.reason,
  });
  if (ended) {
    await recordActivity({
      organisationId,
      employeeId,
      deviceId: params.deviceId,
      actorType: params.actorType,
      actorUserId: params.actorUserId ?? null,
      type: params.reason === "EXPIRED" ? "BREAK_EXPIRED" : "BREAK_ENDED",
      occurredAt: endedAt,
      metadata: {
        breakSessionId: session.id,
        shiftId: shift.id,
        endReason: params.reason,
        minutes: Math.ceil((endedAt.getTime() - session.startedAt.getTime()) / 60_000),
      },
      clientEventId: params.deviceId ? `break:${session.clientBreakId}:ended` : null,
    });
    await recomputeEmployeeWorkState({ organisationId, employeeId, now: receivedAt });
  }
  return { session, allowance: await allowanceFor(), ended };
}

/** Allowance for a shift under the employee's current break policy (null when no policy resolves). */
export async function allowanceForShift(
  params: {
    organisationId: string;
    employeeId: string;
    shift: { id: string; startsAt: Date; endsAt: Date };
    now: Date;
  },
  db: Db = prisma,
): Promise<BreakAllowance | null> {
  const policyRow = (
    await resolveEmployeePolicies(params.organisationId, params.employeeId, params.now)
  ).breakPolicy;
  if (!policyRow) return null;
  const sessions = await listSessionsForShift(params.organisationId, params.shift.id, db);
  return computeBreakAllowance(policyRow.rules, params.shift, sessions, params.now);
}

// ─────────────────────────────────────────────────────────────────────────────
// Mobile endpoints (`POST /api/mobile/v1/breaks/start`, `POST /api/mobile/v1/breaks/:id/end`)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * `POST /breaks/start` for the verified device: trigger EMPLOYEE, start instant from the device's last
 * known clock skew, late policy refusals reconciled as POLICY_CHANGED (docs/BREAK_RULES.md). Also marks the
 * device as seen.
 */
export async function startBreakFromDevice(
  ctx: DeviceContext,
  input: MobileStartBreakInput,
  now: Date = new Date(),
): Promise<MobileBreakResponse> {
  const result = await startBreak({
    organisationId: ctx.organisation.id,
    employeeId: ctx.employee.id,
    deviceId: ctx.device.id,
    clientBreakId: input.clientBreakId,
    shiftId: input.shiftId,
    requestedAt: new Date(input.requestedAt),
    receivedAt: now,
    requestedDurationMinutes: input.requestedDurationMinutes ?? null,
    trigger: "EMPLOYEE",
    skewSeconds: ctx.device.lastClockSkewSeconds,
    actorType: "EMPLOYEE_DEVICE",
    reconcileLateRefusals: true,
  });
  await updateDevice(ctx.device.id, { lastSeenAt: now });
  return {
    breakSession: toBreakSessionDto(result.session),
    allowance: toBreakAllowanceDto(result.allowance),
  };
}

/** `POST /breaks/:id/end` for the verified device (idempotent; another employee's session is NOT_FOUND). */
export async function endBreakFromDevice(
  ctx: DeviceContext,
  sessionId: string,
  input: MobileEndBreakInput,
  now: Date = new Date(),
): Promise<MobileBreakResponse> {
  const result = await endBreak({
    organisationId: ctx.organisation.id,
    employeeId: ctx.employee.id,
    deviceId: ctx.device.id,
    sessionId,
    endedAt: new Date(input.endedAt),
    receivedAt: now,
    reason: input.reason,
    skewSeconds: ctx.device.lastClockSkewSeconds,
    actorType: "EMPLOYEE_DEVICE",
  });
  await updateDevice(ctx.device.id, { lastSeenAt: now });
  return {
    breakSession: toBreakSessionDto(result.session),
    allowance: toBreakAllowanceDto(result.allowance),
  };
}
