import type { Prisma } from "@clockoff/db";
import { plandayWarningCode } from "@clockoff/integrations";
import type { SyncPhase } from "@clockoff/shared/providers/workforceProvider";
import { notifyPendingEmployees } from "../notifications";
import { applyClockEvents } from "./clockEvents";
import type { RunSink, SinkContext } from "./context";
import {
  applyEmployees,
  applyEmployeesImportStep,
  applyEmployeeStatus,
  countPendingEmployees,
  reactivationsStep,
  selectAbsentEmployees,
} from "./employees";
import { applyPortal } from "./portal";
import {
  applyShiftRemovals,
  applyShifts,
  applyUncertainShifts,
  cancelOutOfWindowShifts,
  recordHiddenDays,
  reportUnresolvedConflicts,
  selectAbsentShifts,
} from "./shifts";
import { ensureRunWindow } from "./stagingSink";
import { applyDepartments, applyGroups, seenIdsOf } from "./structure";

/**
 * The apply sink (docs/integrations/PLANDAY_IMPLEMENTATION_PLAN.md §6.1) for IMPORT_EMPLOYEES, SYNC and CLOCK runs:
 * Planday's departments, groups, employees, published shifts and punches written into ClockOff's own locations,
 * teams, employees, shifts and clock events through the integration writers, one page per transaction.
 */

type Tx = Prisma.TransactionClient;

function windowDays(ctx: SinkContext): number {
  return ctx.config.syncWindowDays;
}

export function createApplySink(): RunSink {
  return {
    async apply(tx: Tx, ctx: SinkContext, phase: SyncPhase, step) {
      const warnings = step.warnings ?? [];
      for (const warning of warnings) {
        ctx.tally.warn(plandayWarningCode(warning), warning.message, warning.externalId ?? null);
      }
      if (phase === "SHIFTS" || phase === "ABSENT_SHIFTS") {
        await applyUncertainShifts(tx, ctx, warnings);
      }
      const batch = step.batch;
      if (batch) {
        switch (batch.kind) {
          case "PORTAL":
            await applyPortal(tx, ctx, batch.portal);
            break;
          case "LOCATIONS":
            await applyDepartments(tx, ctx, batch.records, {
              complete: batch.complete,
              seenIds: seenIdsOf(step.cursor),
            });
            break;
          case "TEAMS":
            await applyGroups(tx, ctx, batch.records, {
              complete: batch.complete,
              seenIds: seenIdsOf(step.cursor),
            });
            break;
          case "EMPLOYEES":
            await applyEmployees(tx, ctx, batch.records);
            break;
          case "EMPLOYEE_STATUS":
            if (phase !== "DEACTIVATED_EMPLOYEES" && phase !== "ABSENT_EMPLOYEES") {
              throw new TypeError(`EMPLOYEE_STATUS batch in ${phase}`);
            }
            await applyEmployeeStatus(tx, ctx, phase, batch.records);
            break;
          case "HIDDEN_DAYS":
            recordHiddenDays(ctx, batch.days);
            break;
          case "SHIFTS":
            await applyShifts(tx, ctx, batch);
            break;
          case "SHIFT_REMOVALS":
            await applyShiftRemovals(tx, ctx, batch.records);
            break;
          case "CLOCK_EVENTS":
            await applyClockEvents(tx, ctx, batch.records);
            break;
          case "EMPLOYEE_COUNTS":
            break;
        }
      }
      // Row 16: once every page was read, mapped future shifts that left the window are cancelled.
      if (phase === "SHIFTS" && step.done) {
        await cancelOutOfWindowShifts(tx, ctx, ensureRunWindow(ctx, windowDays(ctx)));
      }
    },

    async runDatabasePhaseStep(tx, ctx, phase, cursor) {
      switch (phase) {
        case "REACTIVATIONS":
          return reactivationsStep(tx, ctx, cursor);
        case "APPLY_EMPLOYEES":
          return applyEmployeesImportStep(tx, ctx, cursor);
        default:
          throw new TypeError(`${phase} is not a database-only phase of the apply sink`);
      }
    },

    async enterPhase(tx, ctx, phase) {
      switch (phase) {
        case "SCHEDULE_DAYS":
        case "SHIFTS":
          ensureRunWindow(ctx, windowDays(ctx));
          return { skip: false };
        case "ABSENT_EMPLOYEES": {
          ctx.state.absentEmployees = await selectAbsentEmployees(tx, ctx);
          return { skip: ctx.state.absentEmployees.length === 0 };
        }
        case "REACTIVATIONS":
          return { skip: ctx.state.reactivate.length === 0 };
        case "ABSENT_SHIFTS": {
          // Absence is evidence only after a complete SHIFTS phase (§6.6); otherwise the run ends PARTIAL.
          if (!ctx.state.completed.includes("SHIFTS")) return { skip: true, partial: true };
          ctx.state.absentShifts = await selectAbsentShifts(
            tx,
            ctx,
            ensureRunWindow(ctx, windowDays(ctx)),
          );
          return { skip: ctx.state.absentShifts.length === 0 };
        }
        default:
          return { skip: false };
      }
    },

    async finalise(tx, ctx) {
      if (ctx.run.kind !== "SYNC") return;
      await reportUnresolvedConflicts(tx, ctx);
      ctx.tally.counts.pending = await countPendingEmployees(tx, ctx);
      if (ctx.state.newPending > 0) {
        ctx.effects.alerts.push(
          await notifyPendingEmployees(tx, {
            organisationId: ctx.organisationId,
            integrationId: ctx.integrationId,
            provider: ctx.provider,
            kind: "NEW_EMPLOYEES",
            count: ctx.state.newPending,
          }),
        );
      }
    },
  };
}
