import { Prisma } from "@clockoff/db";
import {
  decideShiftAction,
  departmentKeyOf,
  EARLY_CLOCK_IN_MS,
  hashDecisionInputs,
  incomingShift,
  plandayShiftExternalId,
  plandayWarningCode,
  removalIncoming,
  selectAbsentShiftRechecks,
  shiftDecisionInputs,
  shiftTimeState,
  type ExistingShift,
  type IncomingShift,
  type ShiftDecision,
  type ShiftScope,
  type ShiftTarget,
} from "@clockoff/integrations";
import type {
  ExternalShift,
  ShiftRemovalReason,
  SyncError,
  SyncRange,
} from "@clockoff/shared/providers/workforceProvider";
import { localDateOf } from "@clockoff/shared/time/zone";
import {
  bulkRescheduleIntegrationShifts,
  cancelIntegrationShifts,
  cancelReplacedShift,
  createIntegrationShifts,
  recreateIntegrationShift,
  reinstateIntegrationShift,
  supersedeIntegrationShift,
  type IntegrationShiftActor,
  type IntegrationShiftCancelReason,
  type IntegrationShiftCurrent,
  type IntegrationShiftInput,
  type IntegrationShiftWriteResult,
  type ReschedulePatch,
} from "@/server/shifts/shifts.integration";
import type { SinkContext } from "./context";
import {
  findMapRows,
  mappedEmployeeIds,
  recordMapRows,
  type MapRow,
} from "./entityMaps.repository";

/**
 * Shifts (docs/integrations/PLANDAY_IMPLEMENTATION_PLAN.md §6.6): the SHIFTS, DELETED_SHIFTS and ABSENT_SHIFTS phases
 * of a SYNC, and the wizard's PREVIEW_SHIFTS. Per page: the employee mapping, the department's target and the hidden
 * days resolve each record (`incomingShift`), the decision-input hash is compared with the map row, and
 * `decideShiftAction` (the 17-row table) says what to write; the writes are batched through `shifts.integration.ts`
 * (one createMany, one version-checked bulk UPDATE, one bulk cancel), so every change bumps `version` and reaches
 * device sync. Ended shifts are never modified; uncertainty never creates or cancels; a removal cancels, never deletes.
 */

type Tx = Prisma.TransactionClient;

const CURRENT_SELECT = {
  id: true,
  organisationId: true,
  employeeId: true,
  locationId: true,
  startsAt: true,
  endsAt: true,
  timezone: true,
  status: true,
  version: true,
  externalShiftId: true,
  managedByIntegrationId: true,
  deletedAt: true,
} as const;

function actorOf(ctx: SinkContext): IntegrationShiftActor {
  return {
    organisationId: ctx.organisationId,
    actorType: "SYSTEM",
    actorUserId: null,
    integrationId: ctx.integrationId,
  };
}

/** The scope `incomingShift` checks: included departments, the employee mapping and (opt-in) hidden days. */
function shiftScope(ctx: SinkContext, mapped: ReadonlyMap<string, string>): ShiftScope {
  const hidden = new Set(ctx.state.hiddenDays);
  return {
    includedDepartmentIds: ctx.config.includedDepartmentIds,
    isEmployeeMapped: (externalEmployeeId) => mapped.has(externalEmployeeId),
    ...(ctx.config.respectHiddenDays
      ? { isHiddenDay: (department: string, date: string) => hidden.has(`${department}:${date}`) }
      : {}),
  };
}

/** Where a published shift goes: the mapped employee and its department's location or ClockOff department. */
function shiftTarget(
  ctx: SinkContext,
  record: ExternalShift,
  mapped: ReadonlyMap<string, string>,
): ShiftTarget | null {
  const employeeId = record.externalEmployeeId ? mapped.get(record.externalEmployeeId) : undefined;
  if (!employeeId) return null;
  const mapping = ctx.config.departmentMappings[departmentKeyOf(record.externalLocationId)];
  if (mapping?.target === "LOCATION") {
    return { employeeId, locationId: mapping.locationId, departmentId: null };
  }
  if (mapping?.target === "DEPARTMENT") {
    return { employeeId, locationId: null, departmentId: mapping.departmentId };
  }
  return { employeeId, locationId: null, departmentId: null };
}

function countExcluded(ctx: SinkContext, reason: ShiftRemovalReason | "OUT_OF_WINDOW"): void {
  switch (reason) {
    case "DRAFT":
      ctx.tally.exclude("drafts");
      break;
    case "UNASSIGNED":
      ctx.tally.exclude("open");
      break;
    case "OUT_OF_SCOPE":
      ctx.tally.exclude("outOfScope");
      break;
    case "HIDDEN_DAY":
      ctx.tally.exclude("hiddenDays");
      break;
    default:
      break;
  }
}

const SHIFT_WARNINGS: Readonly<Record<string, string>> = {
  IN_PROGRESS_START_IGNORED:
    "Planday moved the start of a shift that had already started; the start was kept",
  HIDDEN_DAY_IN_PROGRESS:
    "Planday hid the day of a shift that had already started; the shift was kept until it ends",
  SHIFT_NOT_MANAGED:
    "A Planday shift is linked to a ClockOff shift the integration does not manage",
};

interface ShiftItem {
  externalId: string;
  record: ExternalShift | null;
  incoming: IncomingShift;
  target: ShiftTarget | null;
}

/**
 * §6.8: clock reconciliation moves a future shift's start to an early clock-in, so the shift is in progress while
 * Planday's start is still ahead. For each such item (rare: row 13's situation), the employee's latest CLOCK_IN from
 * this portal at most EARLY_CLOCK_IN_MS before Planday's start and not after now; the decision then keeps the start
 * (row 12) instead of making the shift FUTURE again, which would end Work Mode. One query, only when needed.
 */
async function earlyClockIns(
  tx: Tx,
  ctx: SinkContext,
  candidates: ReadonlyArray<{ externalId: string; employeeId: string; plandayStart: Date }>,
): Promise<Map<string, Date>> {
  const found = new Map<string, Date>();
  if (candidates.length === 0) return found;
  const earliest = Math.min(...candidates.map((c) => c.plandayStart.getTime())) - EARLY_CLOCK_IN_MS;
  const punches = await tx.clockEvent.findMany({
    where: {
      organisationId: ctx.organisationId,
      source: ctx.provider,
      type: "CLOCK_IN",
      employeeId: { in: [...new Set(candidates.map((c) => c.employeeId))] },
      externalId: { startsWith: `${ctx.portalId}:` },
      occurredAt: { gte: new Date(earliest), lte: ctx.now },
    },
    select: { employeeId: true, occurredAt: true },
  });
  for (const candidate of candidates) {
    const start = candidate.plandayStart.getTime();
    let latest: number | null = null;
    for (const punch of punches) {
      const at = punch.occurredAt.getTime();
      if (punch.employeeId !== candidate.employeeId) continue;
      if (at >= start || start - at > EARLY_CLOCK_IN_MS) continue;
      if (latest === null || at > latest) latest = at;
    }
    if (latest !== null) found.set(candidate.externalId, new Date(latest));
  }
  return found;
}

interface DecideResult {
  /** Created and rescheduled shifts (overlap warnings and conflict replacement). */
  written: IntegrationShiftWriteResult[];
  created: IntegrationShiftWriteResult | null;
}

/**
 * Decides and writes a batch of shifts (§6.6 table), batched: cancels, then reschedules, then creations; reinstates,
 * recreations and row 14 supersedes one by one (rare). Map rows: one `last_seen_at` / `last_hash` update for the
 * batch.
 */
async function decideAndWrite(
  tx: Tx,
  ctx: SinkContext,
  items: readonly ShiftItem[],
): Promise<DecideResult> {
  if (items.length === 0) return { written: [], created: null };
  const mapRows = await findMapRows(
    tx,
    ctx.integrationId,
    ["SHIFT"],
    items.map((i) => i.externalId),
  );
  const shiftIds = [...mapRows.values()].map((m) => m.internalId);
  const shifts = new Map(
    (shiftIds.length === 0
      ? []
      : await tx.shift.findMany({
          where: { organisationId: ctx.organisationId, id: { in: shiftIds } },
          select: CURRENT_SELECT,
        })
    ).map((s) => [s.id, s] as const),
  );
  const clockedIn = await earlyClockIns(
    tx,
    ctx,
    items.flatMap((item) => {
      const mapRow = mapRows.get(item.externalId);
      const shift = mapRow ? shifts.get(mapRow.internalId) : undefined;
      if (
        !shift ||
        shift.deletedAt !== null ||
        shift.status !== "SCHEDULED" ||
        item.incoming.kind !== "PUBLISHED" ||
        item.incoming.startsAt.getTime() <= ctx.now.getTime() ||
        shiftTimeState(shift, ctx.now) !== "IN_PROGRESS"
      ) {
        return [];
      }
      return [
        {
          externalId: item.externalId,
          employeeId: shift.employeeId,
          plandayStart: item.incoming.startsAt,
        },
      ];
    }),
  );
  const actor = actorOf(ctx);
  const touch: string[] = [];
  const hashes: Array<{ id: string; lastHash: string | null }> = [];
  const creates: IntegrationShiftInput[] = [];
  const cancels: Array<{ current: IntegrationShiftCurrent; reason: IntegrationShiftCancelReason }> =
    [];
  const changes: Array<{ current: IntegrationShiftCurrent; patch: ReschedulePatch }> = [];
  const singles: Array<() => Promise<IntegrationShiftWriteResult>> = [];
  const seen = new Set<string>();

  for (const item of items) {
    if (seen.has(item.externalId)) continue;
    seen.add(item.externalId);
    const mapRow: MapRow | null = mapRows.get(item.externalId) ?? null;
    const shift = mapRow ? (shifts.get(mapRow.internalId) ?? null) : null;
    const live = shift && shift.deletedAt === null ? shift : null;
    if (live && live.managedByIntegrationId !== ctx.integrationId) {
      if (mapRow) touch.push(mapRow.id);
      ctx.tally.warn(
        "SHIFT_NOT_MANAGED",
        SHIFT_WARNINGS.SHIFT_NOT_MANAGED as string,
        item.externalId,
      );
      ctx.tally.count("shifts", "skipped");
      continue;
    }
    const existing: ExistingShift | null =
      live && mapRow
        ? {
            id: live.id,
            status: live.status,
            startsAt: live.startsAt,
            endsAt: live.endsAt,
            employeeId: live.employeeId,
            locationId: live.locationId,
            lastHash: mapRow.lastHash,
            upstreamRemovedAt: mapRow.upstreamRemovedAt,
          }
        : null;
    const hash = hashDecisionInputs(
      ctx.hasher,
      shiftDecisionInputs({
        record: item.record,
        incoming: item.incoming,
        target: item.target,
        respectHiddenDays: ctx.config.respectHiddenDays,
      }),
    );
    const decision: ShiftDecision = decideShiftAction({
      existing,
      incoming: item.incoming,
      target: item.target,
      now: ctx.now,
      hash,
      clockedInAt: clockedIn.get(item.externalId) ?? null,
    });
    if (decision.warning && decision.warning in SHIFT_WARNINGS) {
      ctx.tally.warn(decision.warning, SHIFT_WARNINGS[decision.warning] as string, item.externalId);
    }
    const zoneChange =
      item.incoming.kind === "PUBLISHED" && live && item.incoming.timezone !== live.timezone
        ? { timezone: item.incoming.timezone }
        : {};
    switch (decision.action) {
      case "SKIP":
        ctx.tally.count("shifts", "skipped");
        break;
      case "UNCHANGED":
        if (mapRow) touch.push(mapRow.id);
        ctx.tally.count("shifts", "skipped");
        break;
      case "REHASH_ONLY":
        if (mapRow) hashes.push({ id: mapRow.id, lastHash: hash });
        ctx.tally.count("shifts", "skipped");
        break;
      case "CREATE":
        creates.push({
          externalId: item.externalId,
          externalShiftId: plandayShiftExternalId(ctx.portalId, item.externalId),
          employeeId: decision.create.employeeId,
          locationId: decision.create.locationId,
          startsAt: decision.create.startsAt,
          endsAt: decision.create.endsAt,
          timezone: decision.create.timezone,
          lastHash: hash,
        });
        ctx.tally.count("shifts", "created");
        break;
      case "UPDATE":
        changes.push({ current: live!, patch: { ...decision.patch, ...zoneChange } });
        if (mapRow) hashes.push({ id: mapRow.id, lastHash: hash });
        ctx.tally.count("shifts", "updated");
        break;
      case "REASSIGN":
        changes.push({ current: live!, patch: { ...decision.patch, ...zoneChange } });
        if (mapRow) hashes.push({ id: mapRow.id, lastHash: hash });
        ctx.tally.count("shifts", "updated");
        break;
      case "UPDATE_END":
        changes.push({ current: live!, patch: { ...decision.patch } });
        if (mapRow) hashes.push({ id: mapRow.id, lastHash: hash });
        ctx.tally.count("shifts", "updated");
        break;
      case "END_NOW":
        changes.push({
          current: live!,
          patch: {
            endsAt: decision.endsAt,
            ...(decision.locationId !== undefined ? { locationId: decision.locationId } : {}),
            endRunningBreak: true,
            reason: "END_NOW",
          },
        });
        if (mapRow) hashes.push({ id: mapRow.id, lastHash: hash });
        ctx.tally.count("shifts", "updated");
        break;
      case "CANCEL":
        cancels.push({ current: live!, reason: decision.reason });
        if (mapRow) hashes.push({ id: mapRow.id, lastHash: hash });
        ctx.tally.count("shifts", "cancelled");
        break;
      case "REINSTATE": {
        const current = live!;
        const target = decision.target;
        singles.push(() =>
          reinstateIntegrationShift(
            tx,
            actor,
            current,
            {
              startsAt: target.startsAt,
              endsAt: target.endsAt,
              employeeId: target.employeeId,
              locationId: target.locationId,
              timezone: target.timezone,
            },
            ctx.now,
          ),
        );
        if (mapRow) hashes.push({ id: mapRow.id, lastHash: hash });
        ctx.tally.count("shifts", "updated");
        break;
      }
      case "RECREATE": {
        const current = live!;
        const create = decision.create;
        singles.push(() =>
          recreateIntegrationShift(
            tx,
            actor,
            current,
            {
              externalId: item.externalId,
              externalShiftId: plandayShiftExternalId(ctx.portalId, item.externalId),
              employeeId: create.employeeId,
              locationId: create.locationId,
              startsAt: create.startsAt,
              endsAt: create.endsAt,
              timezone: create.timezone,
              lastHash: hash,
              reason: "REINSTATED",
            },
            ctx.now,
          ),
        );
        ctx.tally.count("shifts", "created");
        break;
      }
      case "CANCEL_AND_CREATE": {
        const current = live!;
        const create = decision.create;
        singles.push(() =>
          supersedeIntegrationShift(
            tx,
            actor,
            current,
            {
              externalId: item.externalId,
              externalShiftId: plandayShiftExternalId(ctx.portalId, item.externalId),
              employeeId: create.employeeId,
              locationId: create.locationId,
              startsAt: create.startsAt,
              endsAt: create.endsAt,
              timezone: create.timezone,
              lastHash: hash,
              reason: "REASSIGNED",
            },
            ctx.now,
          ),
        );
        ctx.tally.count("shifts", "cancelled");
        ctx.tally.count("shifts", "created");
        break;
      }
    }
  }

  const written: IntegrationShiftWriteResult[] = [];
  if (cancels.length > 0) written.push(await cancelIntegrationShifts(tx, actor, cancels, ctx.now));
  if (changes.length > 0) {
    written.push(await bulkRescheduleIntegrationShifts(tx, actor, changes, ctx.now));
  }
  for (const single of singles) written.push(await single());
  let created: IntegrationShiftWriteResult | null = null;
  if (creates.length > 0) {
    // The first SYNC after onboarding records one INTEGRATION_SYNCED summary instead of a row per shift (§6.9).
    const firstSync = ctx.run.kind === "SYNC" && ctx.run.trigger === "INITIAL";
    created = await createIntegrationShifts(tx, actor, ctx.integrationId, creates, {
      recordActivity: !firstSync,
      now: ctx.now,
    });
    written.push(created);
  }
  for (const result of written) ctx.effects.shiftWrites.push(result);
  await recordMapRows(tx, { touched: touch, hashed: hashes }, ctx.now);
  return { written, created };
}

/**
 * §6.6 Overlaps: the INITIAL SYNC cancels each manual or CSV shift the manager ticked at step 6 that overlaps a Planday
 * shift it just created for the same employee, in this transaction (`cancelReplacedShift`); every other overlap with a
 * ClockOff-added shift is reported as warning CONFLICT with both ids.
 */
async function handleOverlaps(tx: Tx, ctx: SinkContext, result: DecideResult): Promise<void> {
  const rows = result.written.flatMap((w) => w.rows).filter((r) => r.status === "SCHEDULED");
  if (rows.length === 0) return;
  const replaceable =
    ctx.run.kind === "SYNC" && ctx.run.trigger === "INITIAL" && result.created
      ? ctx.run.replaceShiftIds.filter((id) => !(ctx.state.replacedShiftIds ?? []).includes(id))
      : [];
  const employeeIds = [...new Set(rows.map((r) => r.employeeId))];
  const minStart = new Date(Math.min(...rows.map((r) => r.startsAt.getTime())));
  const maxEnd = new Date(Math.max(...rows.map((r) => r.endsAt.getTime())));
  const others = await tx.shift.findMany({
    where: {
      organisationId: ctx.organisationId,
      employeeId: { in: employeeIds },
      status: "SCHEDULED",
      deletedAt: null,
      OR: [
        { managedByIntegrationId: null },
        { managedByIntegrationId: { not: ctx.integrationId } },
      ],
      startsAt: { lt: maxEnd },
      endsAt: { gt: minStart },
    },
    select: { id: true, employeeId: true, startsAt: true, endsAt: true },
  });
  if (others.length === 0) return;
  const createdIds = new Set((result.created?.rows ?? []).map((r) => r.id));
  const replaced = new Set<string>();
  for (const row of rows) {
    const overlapping = others.filter(
      (o) =>
        o.employeeId === row.employeeId &&
        o.startsAt.getTime() < row.endsAt.getTime() &&
        o.endsAt.getTime() > row.startsAt.getTime() &&
        !replaced.has(o.id),
    );
    for (const other of overlapping) {
      if (createdIds.has(row.id) && replaceable.includes(other.id)) {
        const cancelled = await cancelReplacedShift(tx, {
          organisationId: ctx.organisationId,
          shiftId: other.id,
          approvedByUserId: ctx.run.requestedByUserId,
          now: ctx.now,
          replacedByExternalShiftId: row.externalShiftId,
          provider: ctx.provider,
        });
        if (cancelled) {
          replaced.add(other.id);
          ctx.effects.shiftWrites.push(cancelled);
          continue;
        }
      }
      const externalId = row.externalShiftId?.split(":")[2] ?? null;
      ctx.tally.warn(
        "CONFLICT",
        `A Planday shift overlaps ClockOff shift ${other.id}, added in ClockOff`,
        externalId,
      );
    }
  }
  if (replaced.size > 0) {
    ctx.state.replacedShiftIds = [...(ctx.state.replacedShiftIds ?? []), ...replaced];
  }
}

/** One SHIFTS batch (the SHIFTS phase, or an ABSENT_SHIFTS by-id body). */
export async function applyShifts(
  tx: Tx,
  ctx: SinkContext,
  batch: { records: readonly ExternalShift[]; window: SyncRange },
): Promise<void> {
  const mapped = await mappedEmployeeIds(tx, {
    organisationId: ctx.organisationId,
    integrationId: ctx.integrationId,
    externalIds: batch.records.flatMap((r) => (r.externalEmployeeId ? [r.externalEmployeeId] : [])),
  });
  const scope = shiftScope(ctx, mapped);
  const items: ShiftItem[] = batch.records.map((record) => {
    const { incoming } = incomingShift(record, scope, batch.window);
    if (incoming.kind === "REMOVED") countExcluded(ctx, incoming.reason);
    return {
      externalId: record.externalId,
      record,
      incoming,
      target: incoming.kind === "PUBLISHED" ? shiftTarget(ctx, record, mapped) : null,
    };
  });
  const result = await decideAndWrite(tx, ctx, items);
  await handleOverlaps(tx, ctx, result);
}

/** One SHIFT_REMOVALS batch (the deleted list, a by-id 404 or a reclassified by-id body). */
export async function applyShiftRemovals(
  tx: Tx,
  ctx: SinkContext,
  records: ReadonlyArray<{ externalId: string; reason: ShiftRemovalReason }>,
): Promise<void> {
  await decideAndWrite(
    tx,
    ctx,
    records.map((r) => ({
      externalId: r.externalId,
      record: null,
      incoming: removalIncoming(r.reason),
      target: null,
    })),
  );
}

/**
 * Row 17 for provider warnings about a mapped shift (an unknown status, unreadable times): never act on uncertainty,
 * but mark the map row seen, so ABSENT_SHIFTS does not re-read the shift on every run.
 */
export async function applyUncertainShifts(
  tx: Tx,
  ctx: SinkContext,
  warnings: readonly SyncError[],
): Promise<void> {
  const ids: string[] = [];
  for (const warning of warnings) {
    const code = plandayWarningCode(warning);
    if (code === "UNKNOWN_STATUS") ctx.tally.exclude("unknownStatus");
    if ((code === "UNKNOWN_STATUS" || code === "INVALID_TIME") && warning.externalId) {
      ids.push(warning.externalId);
    }
  }
  if (ids.length === 0) return;
  const mapRows = await findMapRows(tx, ctx.integrationId, ["SHIFT"], ids);
  await recordMapRows(tx, { touched: [...mapRows.values()].map((m) => m.id) }, ctx.now);
}

/** Row 16: mapped future shifts that now start at or after the window's end (not read) are cancelled, 100 per run. */
export async function cancelOutOfWindowShifts(
  tx: Tx,
  ctx: SinkContext,
  window: SyncRange,
): Promise<void> {
  const rows = await tx.$queryRaw<Array<{ external_id: string }>>`
    SELECT m.external_id
      FROM external_entity_maps m
      JOIN shifts s ON s.id = m.internal_id AND s.organisation_id = ${ctx.organisationId}::uuid
     WHERE m.integration_id = ${ctx.integrationId}::uuid AND m.entity_type = 'SHIFT'
       AND s.status = 'SCHEDULED' AND s.deleted_at IS NULL
       AND s.managed_by_integration_id = ${ctx.integrationId}::uuid
       AND s.starts_at >= ${window.to}::timestamptz AND s.starts_at > ${ctx.now}::timestamptz
       AND m.last_seen_at < ${new Date(ctx.state.startedAt)}::timestamptz
     ORDER BY s.starts_at
     LIMIT 100`;
  if (rows.length === 0) return;
  await decideAndWrite(
    tx,
    ctx,
    rows.map((r) => ({
      externalId: r.external_id,
      record: null,
      incoming: removalIncoming("OUT_OF_WINDOW"),
      target: null,
    })),
  );
}

/**
 * Entering ABSENT_SHIFTS: mapped, non-ended, non-cancelled shifts inside the window that this run's complete SHIFTS
 * phase did not see; at most 50 (the rest wait for the next run). Absence alone never cancels: each is read by id.
 */
export async function selectAbsentShifts(
  tx: Tx,
  ctx: SinkContext,
  window: SyncRange,
): Promise<string[]> {
  const startedAt = new Date(ctx.state.startedAt);
  const rows = await tx.$queryRaw<
    Array<{
      external_id: string;
      status: "SCHEDULED" | "CANCELLED" | "COMPLETED";
      starts_at: Date;
      ends_at: Date;
      last_seen_at: Date;
    }>
  >`
    SELECT m.external_id, s.status::text AS status, s.starts_at, s.ends_at, m.last_seen_at
      FROM external_entity_maps m
      JOIN shifts s ON s.id = m.internal_id AND s.organisation_id = ${ctx.organisationId}::uuid
     WHERE m.integration_id = ${ctx.integrationId}::uuid AND m.entity_type = 'SHIFT'
       AND s.deleted_at IS NULL AND s.status = 'SCHEDULED'
       AND s.managed_by_integration_id = ${ctx.integrationId}::uuid
       AND m.last_seen_at < ${startedAt}::timestamptz
       AND s.ends_at > ${window.from}::timestamptz AND s.starts_at < ${window.to}::timestamptz`;
  return selectAbsentShiftRechecks({
    mapped: rows.map((r) => ({
      externalId: r.external_id,
      status: r.status,
      startsAt: r.starts_at,
      endsAt: r.ends_at,
      lastSeenAt: r.last_seen_at,
    })),
    runStartedAt: startedAt,
    window,
    now: ctx.now,
  });
}

/**
 * FINALISE of the INITIAL SYNC: ticked conflicts that no Planday shift replaced stay as they are and are listed as
 * unresolved (§6.6 Overlaps).
 */
export async function reportUnresolvedConflicts(tx: Tx, ctx: SinkContext): Promise<void> {
  if (!(ctx.run.kind === "SYNC" && ctx.run.trigger === "INITIAL")) return;
  const replaced = new Set(ctx.state.replacedShiftIds ?? []);
  const remaining = ctx.run.replaceShiftIds.filter((id) => !replaced.has(id));
  if (remaining.length === 0) return;
  const open = await tx.shift.findMany({
    where: {
      organisationId: ctx.organisationId,
      id: { in: remaining },
      status: "SCHEDULED",
      deletedAt: null,
    },
    select: { id: true },
  });
  for (const shift of open) {
    ctx.tally.warn(
      "UNRESOLVED_CONFLICT",
      `ClockOff shift ${shift.id} was ticked for replacement, but no Planday shift replaced it`,
    );
  }
}

// ── DIRECTORY: PREVIEW_SHIFTS (staging) ──────────────────────────────────────

/** Entering PREVIEW_SHIFTS: the previous preview is replaced by this run's. */
export async function purgeOtherPreviews(tx: Tx, ctx: SinkContext): Promise<void> {
  await tx.integrationPreviewShift.deleteMany({
    where: { integrationId: ctx.integrationId, syncRunId: { not: ctx.run.id } },
  });
}

/**
 * One PREVIEW_SHIFTS page (wizard step 6): published shifts of staged or imported people in included departments
 * become `IntegrationPreviewShift` rows (spec §8 shift fields only); drafts, open shifts, excluded departments and
 * people, and (with `respectHiddenDays`) hidden days are counted, never stored.
 */
export async function stagePreviewShifts(
  tx: Tx,
  ctx: SinkContext,
  batch: { records: readonly ExternalShift[]; window: SyncRange },
): Promise<void> {
  const employeeIds = [
    ...new Set(batch.records.flatMap((r) => (r.externalEmployeeId ? [r.externalEmployeeId] : []))),
  ];
  const excluded = new Set(ctx.config.excludedEmployeeIds);
  const known = new Set<string>();
  if (employeeIds.length > 0) {
    const [staged, mapped] = await Promise.all([
      tx.pendingExternalEmployee.findMany({
        where: { integrationId: ctx.integrationId, externalId: { in: employeeIds } },
        select: { externalId: true },
      }),
      mappedEmployeeIds(tx, {
        organisationId: ctx.organisationId,
        integrationId: ctx.integrationId,
        externalIds: employeeIds,
      }),
    ]);
    for (const row of staged) known.add(row.externalId);
    for (const id of mapped.keys()) known.add(id);
  }
  const scope: ShiftScope = {
    includedDepartmentIds: ctx.config.includedDepartmentIds,
    isEmployeeMapped: (id) => known.has(id) && !excluded.has(id),
    ...(ctx.config.respectHiddenDays
      ? {
          isHiddenDay: (department: string, date: string) =>
            ctx.state.hiddenDays.includes(`${department}:${date}`),
        }
      : {}),
  };
  const rows: Prisma.Sql[] = [];
  const removed: string[] = [];
  for (const record of batch.records) {
    const { incoming } = incomingShift(record, scope, batch.window);
    if (incoming.kind !== "PUBLISHED" || !incoming.inWindow || !record.externalEmployeeId) {
      if (incoming.kind === "REMOVED") countExcluded(ctx, incoming.reason);
      removed.push(record.externalId);
      continue;
    }
    const overnight =
      localDateOf(record.startsAt, record.timezone) !== localDateOf(record.endsAt, record.timezone);
    rows.push(
      Prisma.sql`(${ctx.organisationId}::uuid, ${ctx.integrationId}::uuid, ${ctx.run.id}::uuid,
        ${record.externalId}, ${record.externalEmployeeId}, ${record.externalLocationId ?? null},
        ${record.startsAt}::timestamptz, ${record.endsAt}::timestamptz, ${record.timezone}, ${overnight},
        ${record.timeWarning ?? null})`,
    );
  }
  if (removed.length > 0) {
    await tx.integrationPreviewShift.deleteMany({
      where: { integrationId: ctx.integrationId, externalShiftId: { in: removed } },
    });
  }
  if (rows.length === 0) return;
  await tx.$executeRaw`
    INSERT INTO integration_preview_shifts
      (organisation_id, integration_id, sync_run_id, external_shift_id, external_employee_id,
       external_department_id, starts_at, ends_at, timezone, is_overnight, time_warning)
    VALUES ${Prisma.join(rows)}
    ON CONFLICT (integration_id, external_shift_id) DO UPDATE SET
      sync_run_id = EXCLUDED.sync_run_id, external_employee_id = EXCLUDED.external_employee_id,
      external_department_id = EXCLUDED.external_department_id, starts_at = EXCLUDED.starts_at,
      ends_at = EXCLUDED.ends_at, timezone = EXCLUDED.timezone, is_overnight = EXCLUDED.is_overnight,
      time_warning = EXCLUDED.time_warning`;
}

/** SCHEDULE_DAYS: days hidden from employees, kept in the run's state for the shift phase that follows. */
export function recordHiddenDays(
  ctx: SinkContext,
  days: ReadonlyArray<{ externalDepartmentId: string; date: string }>,
): void {
  const set = new Set(ctx.state.hiddenDays);
  for (const day of days) set.add(`${day.externalDepartmentId}:${day.date}`);
  ctx.state.hiddenDays = [...set];
}
