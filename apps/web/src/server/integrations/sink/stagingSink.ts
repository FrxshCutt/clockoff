import type { Prisma } from "@clockoff/db";
import { PREVIEW_WINDOW_DAYS, plandayWarningCode, syncWindow } from "@clockoff/integrations";
import type { SyncPhase } from "@clockoff/shared/providers/workforceProvider";
import type { RunSink, SinkContext } from "./context";
import {
  matchEmployeesStep,
  prepareEmployeeMatching,
  purgeStaleStagedEmployees,
  stageEmployees,
} from "./employees";
import { applyPortal } from "./portal";
import { purgeOtherPreviews, recordHiddenDays, stagePreviewShifts } from "./shifts";
import { mergeCatalog, seenIdsOf, writeCatalogCounts } from "./structure";

/**
 * The staging sink (docs/integrations/PLANDAY_IMPLEMENTATION_PLAN.md §6.1) for the wizard's STRUCTURE and DIRECTORY
 * runs: the department and group catalogue, `PendingExternalEmployee(ONBOARDING)` rows with their matches, and the
 * shift preview. No ClockOff employee, location, team or shift is touched.
 */

type Tx = Prisma.TransactionClient;

/** The window a run's SCHEDULE_DAYS and shift phases share, fixed when the first of them starts. */
export function ensureRunWindow(ctx: SinkContext, days: number): { from: Date; to: Date } {
  if (!ctx.state.window) {
    const window = syncWindow(ctx.now, ctx.portalTimezone ?? "UTC", days);
    ctx.state.window = { from: window.from.toISOString(), to: window.to.toISOString() };
  }
  return { from: new Date(ctx.state.window.from), to: new Date(ctx.state.window.to) };
}

export function createStagingSink(): RunSink {
  return {
    async apply(tx: Tx, ctx: SinkContext, phase: SyncPhase, step) {
      for (const warning of step.warnings ?? []) {
        const code = plandayWarningCode(warning);
        if (code === "UNKNOWN_STATUS") ctx.tally.exclude("unknownStatus");
        ctx.tally.warn(code, warning.message, warning.externalId ?? null);
      }
      const batch = step.batch;
      if (!batch) return;
      switch (batch.kind) {
        case "PORTAL":
          await applyPortal(tx, ctx, batch.portal);
          return;
        case "LOCATIONS":
          await mergeCatalog(tx, ctx, "LOCATIONS", batch.records, {
            complete: batch.complete,
            seenIds: seenIdsOf(step.cursor),
          });
          return;
        case "TEAMS":
          await mergeCatalog(tx, ctx, "TEAMS", batch.records, {
            complete: batch.complete,
            seenIds: seenIdsOf(step.cursor),
          });
          return;
        case "EMPLOYEE_COUNTS":
          await writeCatalogCounts(tx, ctx, batch);
          return;
        case "EMPLOYEES":
          await stageEmployees(tx, ctx, batch.records);
          return;
        case "HIDDEN_DAYS":
          recordHiddenDays(ctx, batch.days);
          return;
        case "SHIFTS":
          await stagePreviewShifts(tx, ctx, batch);
          return;
        default:
          throw new TypeError(`The staging sink does not apply ${batch.kind} batches (${phase})`);
      }
    },

    async runDatabasePhaseStep(tx, ctx, phase, cursor) {
      if (phase === "MATCH_EMPLOYEES") return matchEmployeesStep(tx, ctx, cursor);
      throw new TypeError(`${phase} is not a database-only phase of the staging sink`);
    },

    async enterPhase(tx, ctx, phase) {
      switch (phase) {
        case "MATCH_EMPLOYEES":
          await prepareEmployeeMatching(tx, ctx);
          break;
        case "SCHEDULE_DAYS":
          ensureRunWindow(ctx, PREVIEW_WINDOW_DAYS);
          break;
        case "PREVIEW_SHIFTS":
          ensureRunWindow(ctx, PREVIEW_WINDOW_DAYS);
          await purgeOtherPreviews(tx, ctx);
          break;
        default:
          break;
      }
      return { skip: false };
    },

    async finalise(tx, ctx) {
      if (ctx.run.kind === "DIRECTORY") await purgeStaleStagedEmployees(tx, ctx);
    },
  };
}
