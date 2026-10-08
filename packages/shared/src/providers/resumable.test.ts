import { describe, expect, it } from "vitest";
import { INTEGRATION_SYNC_RUN_KINDS } from "../enums";
import {
  ComingSoonProvider,
  CredentialPersistError,
  CredentialsWipedError,
  DATABASE_ONLY_PHASES,
  LeaseLostError,
  SHIFT_REMOVAL_REASONS,
  SYNC_ERROR_CODES,
  SYNC_PHASES,
  emptySyncReport,
  isCredentialPersistError,
  isCredentialsWipedError,
  isDatabaseOnlyPhase,
  isLeaseLostError,
  isResumableProvider,
  isSyncPhase,
  ProviderError,
  type PhaseStepResult,
  type ResumableWorkforceProvider,
  type SyncPhase,
  type WorkforceProvider,
} from "./workforceProvider";

/** The provider contracts added for Planday (docs/integrations/PLANDAY_IMPLEMENTATION_PLAN.md §3.3). */

const NOW = new Date("2026-10-08T10:00:00Z");

function resumableStub(): ResumableWorkforceProvider {
  const report = async () => emptySyncReport("PLANDAY", NOW);
  return {
    id: "PLANDAY",
    displayName: "Planday (stub)",
    status: "AVAILABLE",
    connect: async () => ({ kind: "CONNECTED", credentials: null, tokenExpiresAt: null }),
    disconnect: async () => {},
    refreshAuthentication: async () => {},
    syncEmployees: report,
    syncShifts: report,
    syncLocations: report,
    syncTeams: report,
    syncClockEvents: report,
    getConnectionStatus: async () => ({
      status: "CONNECTED",
      connected: true,
      lastSyncAt: null,
      tokenExpiresAt: null,
      lastError: null,
    }),
    phasesFor: (kind) => (kind === "STRUCTURE" ? ["PORTAL_CHECK", "DEPARTMENTS"] : ["FINALISE"]),
    runPhaseStep: async (): Promise<PhaseStepResult> => ({ done: true, cursor: {}, requests: 0 }),
  };
}

describe("resumable providers", () => {
  it("recognises a resumable implementation and never a ComingSoonProvider", () => {
    expect(isResumableProvider(resumableStub())).toBe(true);
    expect(isResumableProvider(new ComingSoonProvider("PLANDAY", "Planday"))).toBe(false);
    const halfway = { ...resumableStub(), runPhaseStep: undefined } as unknown as WorkforceProvider;
    expect(isResumableProvider(halfway)).toBe(false);
  });

  it("phases are unique, and the database-only ones are phases", () => {
    expect(new Set(SYNC_PHASES).size).toBe(SYNC_PHASES.length);
    for (const phase of DATABASE_ONLY_PHASES) {
      expect(isSyncPhase(phase)).toBe(true);
      expect(isDatabaseOnlyPhase(phase)).toBe(true);
    }
    expect(isDatabaseOnlyPhase("EMPLOYEES")).toBe(false);
    // The run's initial phase name is not a provider phase.
    expect(isSyncPhase("START")).toBe(false);
    expect(isSyncPhase(42)).toBe(false);
  });

  it("phasesFor accepts every run kind", () => {
    const provider = resumableStub();
    for (const kind of INTEGRATION_SYNC_RUN_KINDS) {
      const phases: readonly SyncPhase[] = provider.phasesFor(kind, {
        clockEvents: false,
        hiddenDays: false,
      });
      expect(phases.every(isSyncPhase)).toBe(true);
    }
  });

  it("names every shift removal reason once", () => {
    expect(new Set(SHIFT_REMOVAL_REASONS).size).toBe(SHIFT_REMOVAL_REASONS.length);
    expect(SHIFT_REMOVAL_REASONS).toEqual(
      expect.arrayContaining(["DELETED", "NOT_FOUND", "DRAFT", "UNASSIGNED"]),
    );
  });
});

describe("credential store errors", () => {
  it("are distinct, named and recognisable", () => {
    const errors = [
      [new CredentialPersistError(), "CredentialPersistError", isCredentialPersistError],
      [new CredentialsWipedError(), "CredentialsWipedError", isCredentialsWipedError],
      [new LeaseLostError(), "LeaseLostError", isLeaseLostError],
    ] as const;
    for (const [error, name, guard] of errors) {
      expect(error).toBeInstanceOf(Error);
      expect(error.name).toBe(name);
      expect(guard(error)).toBe(true);
      for (const [other, , otherGuard] of errors)
        if (other !== error) expect(otherGuard(error)).toBe(false);
    }
    const cause = new Error("P1001");
    expect(new CredentialPersistError("x", { cause }).cause).toBe(cause);
  });
});

describe("INVALID_RESPONSE", () => {
  it("is a sync error code that is not retryable (the next schedule retries)", () => {
    expect(SYNC_ERROR_CODES).toContain("INVALID_RESPONSE");
    expect(new ProviderError("PLANDAY", "INVALID_RESPONSE", "malformed page").retryable).toBe(
      false,
    );
  });
});
