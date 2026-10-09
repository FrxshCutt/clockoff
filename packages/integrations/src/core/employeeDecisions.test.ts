import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ExternalEmployee } from "@clockoff/shared/providers/syncSink";
import { hashDecisionInputs, type RecordHasher } from "./hash";
import {
  ABSENT_EMPLOYEE_RECHECK_LIMIT,
  countPlandayNames,
  decideEmployeeAction,
  decideEmployeeStatusAction,
  decideImportAction,
  decideReactivation,
  employeeCreateFor,
  employeeDecisionInputs,
  employeeUpdateFor,
  indexEmployeeCandidates,
  isEmployeeInScope,
  matchExternalEmployee,
  matchFromPendingFields,
  pendingMatchFields,
  resolveDuplicateMatches,
  resolveEmployeeTargets,
  selectAbsentEmployeeRechecks,
  shouldQueueMissingReview,
  type EmployeeCandidate,
  type EmployeeDecisionInput,
  type EmployeeMapRow,
  type EmployeeMappingConfig,
  type EmployeeMatch,
  type ExistingEmployee,
} from "./employeeDecisions";

/** docs/integrations/PLANDAY_IMPLEMENTATION_PLAN.md §6.5: scope, matching rules 1 to 6, the decision table. */

const PORTAL = "4100001";
const NOW = new Date("2026-10-21T10:30:00Z");
const hmac: RecordHasher = (canonical) => createHmac("sha256", "k").update(canonical).digest("hex");

const CONFIG: EmployeeMappingConfig = {
  includedDepartmentIds: ["101", "102"],
  excludedEmployeeIds: [],
  departmentMappings: {
    "101": { target: "LOCATION", locationId: "loc-bar" },
    "102": { target: "LOCATION", locationId: "loc-kitchen" },
  },
  groupMappings: {
    "201": { target: "TEAM", teamId: "team-bartenders" },
    "204": { target: "TEAM", teamId: "team-supervisors" },
  },
  autoIncludeNewEmployees: true,
  importEmails: true,
};

function planday(partial: Partial<ExternalEmployee> = {}): ExternalEmployee {
  return {
    externalId: "1001",
    firstName: "Aisha",
    lastName: "Khan",
    email: "aisha.khan@mockbistro.test",
    externalLocationIds: ["101"],
    externalTeamIds: ["201"],
    primaryExternalLocationId: "101",
    active: true,
    ...partial,
  };
}

function candidate(partial: Partial<EmployeeCandidate> & { id: string }): EmployeeCandidate {
  return {
    firstName: "Someone",
    lastName: "Else",
    email: null,
    externalEmployeeId: null,
    mappedExternalId: null,
    ...partial,
  };
}

function clockoff(partial: Partial<ExistingEmployee> = {}): ExistingEmployee {
  return {
    id: "emp-aisha",
    firstName: "Aisha",
    lastName: "Khan",
    email: "aisha.khan@mockbistro.test",
    externalEmployeeId: `PLANDAY:${PORTAL}:1001`,
    primaryLocationId: "loc-bar",
    departmentId: null,
    employmentStatus: "ACTIVE",
    locationIds: ["loc-bar"],
    teamIds: ["team-bartenders"],
    ...partial,
  };
}

function mapRow(partial: Partial<EmployeeMapRow> = {}): EmployeeMapRow {
  return {
    internalId: "emp-aisha",
    lastHash: "old-hash",
    upstreamRemovedAt: null,
    upstreamMissingSince: null,
    reviewDismissedAt: null,
    ...partial,
  };
}

const match = (
  external: ExternalEmployee,
  candidates: EmployeeCandidate[],
  mode: "WIZARD" | "SYNC",
  counts: Record<string, number> = {},
  claimed?: ReadonlySet<string>,
): EmployeeMatch =>
  matchExternalEmployee(external, candidates, counts, {
    portalId: PORTAL,
    mode,
    ...(claimed ? { claimedEmployeeIds: claimed } : {}),
  });

describe("scope and targets", () => {
  it("is in scope with an included department, or no department when 'none' is included, unless excluded", () => {
    expect(isEmployeeInScope(planday(), CONFIG)).toBe(true);
    expect(isEmployeeInScope(planday({ externalLocationIds: ["103"] }), CONFIG)).toBe(false);
    expect(isEmployeeInScope(planday({ externalLocationIds: ["103", "102"] }), CONFIG)).toBe(true);
    expect(isEmployeeInScope(planday({ externalLocationIds: [] }), CONFIG)).toBe(false);
    expect(
      isEmployeeInScope(planday({ externalLocationIds: [] }), {
        ...CONFIG,
        includedDepartmentIds: ["none"],
      }),
    ).toBe(true);
    expect(isEmployeeInScope(planday(), { ...CONFIG, excludedEmployeeIds: ["1001"] })).toBe(false);
  });

  it("resolves the primary location first, ClockOff departments, and mapped teams only", () => {
    const config: EmployeeMappingConfig = {
      ...CONFIG,
      includedDepartmentIds: ["101", "102", "105"],
      departmentMappings: {
        ...CONFIG.departmentMappings,
        "105": { target: "DEPARTMENT", departmentId: "dept-ops" },
      },
    };
    const targets = resolveEmployeeTargets(
      planday({
        externalLocationIds: ["101", "102", "105", "103"],
        primaryExternalLocationId: "102",
        externalTeamIds: ["201", "202", "204"],
      }),
      config,
    );
    expect(targets).toEqual({
      inScope: true,
      primaryLocationId: "loc-kitchen",
      departmentId: "dept-ops",
      locationIds: ["loc-bar", "loc-kitchen"],
      teamIds: ["team-bartenders", "team-supervisors"],
    });
    // An excluded primary department falls back to the first included one.
    expect(
      resolveEmployeeTargets(
        planday({ externalLocationIds: ["103", "102"], primaryExternalLocationId: "103" }),
        config,
      ).primaryLocationId,
    ).toBe("loc-kitchen");
  });

  it("hashes the targets, not the mapping version: a save that keeps every target keeps the hash", () => {
    const external = planday();
    const hash = (config: EmployeeMappingConfig) =>
      hashDecisionInputs(
        hmac,
        employeeDecisionInputs(external, resolveEmployeeTargets(external, config), config),
      );
    const base = hash(CONFIG);
    expect(hash({ ...CONFIG, autoIncludeNewEmployees: false })).toBe(base);
    // A department that maps elsewhere but not for this person changes nothing for them.
    expect(
      hash({
        ...CONFIG,
        departmentMappings: {
          ...CONFIG.departmentMappings,
          "102": { target: "LOCATION", locationId: "loc-elsewhere" },
        },
      }),
    ).toBe(base);
    expect(
      hash({
        ...CONFIG,
        departmentMappings: {
          ...CONFIG.departmentMappings,
          "101": { target: "LOCATION", locationId: "loc-new" },
        },
      }),
    ).not.toBe(base);
    expect(hash({ ...CONFIG, importEmails: false })).not.toBe(base);
    expect(hash({ ...CONFIG, excludedEmployeeIds: ["1001"] })).not.toBe(base);
  });
});

describe("matchExternalEmployee (rules 1 to 6)", () => {
  it("rule 1: a map row wins over everything", () => {
    const candidates = [
      candidate({ id: "emp-mapped", mappedExternalId: "1001" }),
      candidate({ id: "emp-email", email: "aisha.khan@mockbistro.test" }),
    ];
    expect(match(planday(), candidates, "SYNC")).toEqual({
      kind: "MAPPED",
      employeeId: "emp-mapped",
    });
  });

  it("rule 2a: the portal-qualified id this integration wrote; another portal's never matches", () => {
    const ours = candidate({ id: "emp-ours", externalEmployeeId: `PLANDAY:${PORTAL}:1001` });
    expect(match(planday({ email: null }), [ours], "SYNC")).toEqual({
      kind: "MATCHED",
      employeeId: "emp-ours",
      signal: "EXTERNAL_ID",
    });
    const other = candidate({ id: "emp-other", externalEmployeeId: "PLANDAY:4100002:1001" });
    expect(match(planday({ email: null }), [other], "SYNC")).toEqual({ kind: "NONE" });
    // Mapped to another Planday id: not a candidate.
    const taken = candidate({
      id: "emp-taken",
      externalEmployeeId: `PLANDAY:${PORTAL}:1001`,
      mappedExternalId: "1009",
    });
    expect(match(planday({ email: null }), [taken], "SYNC")).toEqual({ kind: "NONE" });
  });

  it("rule 2b: a raw CSV id links only when the email or the name agrees", () => {
    const priya = planday({
      externalId: "1007",
      firstName: "Priya",
      lastName: "Patel",
      email: "priya.patel@mockbistro.test",
    });
    const csv = candidate({
      id: "emp-priya",
      firstName: "Priya",
      lastName: "Patel",
      email: "PRIYA.PATEL@mockbistro.test",
      externalEmployeeId: "1007",
    });
    expect(match(priya, [csv], "SYNC")).toEqual({
      kind: "MATCHED",
      employeeId: "emp-priya",
      signal: "EXTERNAL_ID_RAW",
    });
    // fixtureCsvCollision: Sam Jones with raw id 1008 must never link to Tom Harris (1008).
    const tom = planday({
      externalId: "1008",
      firstName: "Tom",
      lastName: "Harris",
      email: "tom.harris@mockbistro.test",
    });
    const sam = candidate({
      id: "emp-sam",
      firstName: "Sam",
      lastName: "Jones",
      email: "sam.jones@example.test",
      externalEmployeeId: "1008",
    });
    for (const mode of ["WIZARD", "SYNC"] as const) {
      expect(match(tom, [sam], mode)).toEqual({
        kind: "POSSIBLE_MATCH",
        employeeId: "emp-sam",
        signal: "EXTERNAL_ID_RAW",
      });
    }
  });

  it("rule 3: one email match links; two are ambiguous; mapped employees are not candidates", () => {
    const one = candidate({ id: "emp-1", email: "Aisha.Khan@MockBistro.test" });
    expect(match(planday(), [one], "SYNC")).toEqual({
      kind: "MATCHED",
      employeeId: "emp-1",
      signal: "EMAIL",
    });
    const two = candidate({ id: "emp-2", email: "aisha.khan@mockbistro.test" });
    expect(match(planday(), [one, two], "SYNC")).toEqual({
      kind: "AMBIGUOUS",
      candidateEmployeeIds: ["emp-1", "emp-2"],
    });
    const mapped = candidate({
      id: "emp-3",
      email: "aisha.khan@mockbistro.test",
      mappedExternalId: "1009",
    });
    expect(match(planday(), [one, mapped], "SYNC")).toMatchObject({
      kind: "MATCHED",
      employeeId: "emp-1",
    });
  });

  it("rule 4: a unique exact name matches in the wizard and is only a possible match after onboarding", () => {
    const namesake = candidate({ id: "emp-aisha", firstName: "aisha", lastName: " KHAN " });
    const external = planday({ email: null });
    expect(match(external, [namesake], "WIZARD", countPlandayNames([external]))).toEqual({
      kind: "MATCHED",
      employeeId: "emp-aisha",
      signal: "NAME",
    });
    expect(match(external, [namesake], "SYNC")).toEqual({
      kind: "POSSIBLE_MATCH",
      employeeId: "emp-aisha",
      signal: "NAME",
    });
  });

  it("rule 4: a ClockOff namesake with a different email or external id is someone else", () => {
    const external = planday({ email: "aisha.khan@mockbistro.test" });
    const otherEmail = candidate({
      id: "emp-x",
      firstName: "Aisha",
      lastName: "Khan",
      email: "a.k@else.test",
    });
    expect(match(external, [otherEmail], "WIZARD")).toEqual({ kind: "NONE" });
    const otherId = candidate({
      id: "emp-y",
      firstName: "Aisha",
      lastName: "Khan",
      externalEmployeeId: "PAYROLL-77",
    });
    expect(match(planday({ email: null }), [otherId], "WIZARD")).toEqual({ kind: "NONE" });
    // A ClockOff email with no Planday email to compare is not a contradiction.
    const withEmail = candidate({
      id: "emp-z",
      firstName: "Aisha",
      lastName: "Khan",
      email: "a.k@else.test",
    });
    expect(match(planday({ email: null }), [withEmail], "WIZARD")).toMatchObject({
      kind: "MATCHED",
    });
  });

  it("rule 5: namesakes are never merged (fixtureNamesake and the two Alex Morgans)", () => {
    const alexBar = planday({
      externalId: "1005",
      firstName: "Alex",
      lastName: "Morgan",
      email: "alex.morgan@mockbistro.test",
    });
    const alexKitchen = planday({
      externalId: "1006",
      firstName: "Alex",
      lastName: "Morgan",
      email: "alex.j.morgan@mockbistro.test",
    });
    const counts = countPlandayNames([alexBar, alexKitchen]);
    expect(counts["alex morgan"]).toBe(2);
    const fixtureNamesake = candidate({ id: "emp-alex", firstName: "Alex", lastName: "Morgan" });
    for (const external of [alexBar, alexKitchen]) {
      for (const mode of ["WIZARD", "SYNC"] as const) {
        expect(match(external, [fixtureNamesake], mode, counts)).toEqual({
          kind: "AMBIGUOUS",
          candidateEmployeeIds: ["emp-alex"],
        });
      }
    }
    // Two ClockOff namesakes: ambiguous even for a single Planday person.
    const two = [
      fixtureNamesake,
      candidate({ id: "emp-alex-2", firstName: "Alex", lastName: "Morgan" }),
    ];
    expect(
      match(planday({ firstName: "Alex", lastName: "Morgan", email: null }), two, "WIZARD"),
    ).toEqual({
      kind: "AMBIGUOUS",
      candidateEmployeeIds: ["emp-alex", "emp-alex-2"],
    });
  });

  it("rule 6: nobody", () => {
    expect(match(planday(), [candidate({ id: "emp-x" })], "SYNC")).toEqual({ kind: "NONE" });
    expect(match(planday(), [], "WIZARD")).toEqual({ kind: "NONE" });
  });

  it("SYNC: a candidate linked earlier in the run by another Planday record makes the match ambiguous", () => {
    // Two Planday people sharing one email, on different pages: the first linked, the second must not merge.
    const linked = candidate({
      id: "emp-1",
      email: "shared@mockbistro.test",
      mappedExternalId: "1001",
    });
    const second = planday({
      externalId: "1002",
      firstName: "Ben",
      lastName: "Carter",
      email: "shared@mockbistro.test",
    });
    expect(match(second, [linked], "SYNC", {}, new Set(["emp-1"]))).toEqual({
      kind: "AMBIGUOUS",
      candidateEmployeeIds: ["emp-1"],
    });
    // Without the claim the mapped employee is simply not a candidate.
    expect(match(second, [linked], "SYNC")).toEqual({ kind: "NONE" });
  });

  it("accepts a prebuilt index", () => {
    const index = indexEmployeeCandidates([
      candidate({ id: "emp-1", email: "aisha.khan@mockbistro.test" }),
    ]);
    expect(
      matchExternalEmployee(planday(), index, {}, { portalId: PORTAL, mode: "SYNC" }),
    ).toMatchObject({
      kind: "MATCHED",
    });
  });

  it("resolveDuplicateMatches: two Planday people matched to one ClockOff employee both become ambiguous", () => {
    const entries = resolveDuplicateMatches([
      {
        externalId: "1001",
        match: { kind: "MATCHED", employeeId: "emp-1", signal: "EMAIL" } as EmployeeMatch,
      },
      {
        externalId: "1002",
        match: { kind: "MATCHED", employeeId: "emp-1", signal: "EMAIL" } as EmployeeMatch,
      },
      {
        externalId: "1003",
        match: { kind: "MATCHED", employeeId: "emp-3", signal: "EMAIL" } as EmployeeMatch,
      },
    ]);
    expect(entries.map((e) => e.match.kind)).toEqual(["AMBIGUOUS", "AMBIGUOUS", "MATCHED"]);
  });

  it("pending match columns round-trip, telling a possible match from a strong one", () => {
    const matches: EmployeeMatch[] = [
      { kind: "MATCHED", employeeId: "emp-1", signal: "EMAIL" },
      { kind: "MATCHED", employeeId: "emp-1", signal: "EXTERNAL_ID_RAW" },
      { kind: "POSSIBLE_MATCH", employeeId: "emp-1", signal: "EXTERNAL_ID_RAW" },
      { kind: "POSSIBLE_MATCH", employeeId: "emp-1", signal: "NAME" },
      { kind: "AMBIGUOUS", candidateEmployeeIds: ["emp-1", "emp-2"] },
      { kind: "NONE" },
    ];
    for (const m of matches) expect(matchFromPendingFields(pendingMatchFields(m))).toEqual(m);
    expect(
      matchFromPendingFields(pendingMatchFields({ kind: "MAPPED", employeeId: "emp-1" })),
    ).toEqual({
      kind: "MATCHED",
      employeeId: "emp-1",
      signal: "EXTERNAL_ID",
    });
    // An unknown signal is never trusted as a match.
    expect(
      matchFromPendingFields({
        matchedEmployeeId: "emp-1",
        matchSignal: "GUESS",
        candidateEmployeeIds: [],
      }),
    ).toEqual({ kind: "AMBIGUOUS", candidateEmployeeIds: ["emp-1"] });
  });
});

describe("employee writes", () => {
  it("creates with the portal-qualified id, the email only with importEmails, and the targets", () => {
    const external = planday();
    const targets = resolveEmployeeTargets(external, CONFIG);
    expect(employeeCreateFor(external, targets, CONFIG, PORTAL)).toEqual({
      firstName: "Aisha",
      lastName: "Khan",
      email: "aisha.khan@mockbistro.test",
      externalEmployeeId: `PLANDAY:${PORTAL}:1001`,
      primaryLocationId: "loc-bar",
      departmentId: null,
      locationIds: ["loc-bar"],
      teamIds: ["team-bartenders"],
    });
    expect(employeeCreateFor(external, targets, { importEmails: false }, PORTAL).email).toBeNull();
  });

  it("updates managed fields only; memberships of unmapped teams are never touched", () => {
    const external = planday({
      firstName: "Aisha ",
      lastName: "Khan-Smith",
      email: "aisha@new.test",
      externalLocationIds: ["102"],
      primaryExternalLocationId: "102",
      externalTeamIds: ["204"],
    });
    const update = employeeUpdateFor(
      external,
      resolveEmployeeTargets(external, CONFIG),
      clockoff({ teamIds: ["team-bartenders", "team-clockoff-only"] }),
      CONFIG,
    );
    expect(update).toEqual({
      patch: { lastName: "Khan-Smith", email: "aisha@new.test", primaryLocationId: "loc-kitchen" },
      locations: { add: ["loc-kitchen"], remove: ["loc-bar"] },
      teams: { add: ["team-supervisors"], remove: ["team-bartenders"] },
    });
  });

  it("never writes the email with importEmails off, and never erases it when Planday has none", () => {
    const external = planday({ email: "other@new.test" });
    const targets = resolveEmployeeTargets(external, CONFIG);
    expect(
      employeeUpdateFor(external, targets, clockoff(), { ...CONFIG, importEmails: false }),
    ).toBeNull();
    const noEmail = planday({ email: null });
    expect(
      employeeUpdateFor(noEmail, resolveEmployeeTargets(noEmail, CONFIG), clockoff(), CONFIG),
    ).toBeNull();
    // Case only: the same address.
    const shouting = planday({ email: "AISHA.KHAN@MOCKBISTRO.TEST" });
    expect(
      employeeUpdateFor(shouting, resolveEmployeeTargets(shouting, CONFIG), clockoff(), CONFIG),
    ).toBeNull();
  });

  it("linking sets the portal-qualified id only when the employee has none (a CSV id stays)", () => {
    const external = planday();
    const targets = resolveEmployeeTargets(external, CONFIG);
    const link = { link: { portalId: PORTAL } };
    expect(
      employeeUpdateFor(external, targets, clockoff({ externalEmployeeId: null }), CONFIG, link)
        ?.patch,
    ).toEqual({
      externalEmployeeId: `PLANDAY:${PORTAL}:1001`,
    });
    expect(
      employeeUpdateFor(external, targets, clockoff({ externalEmployeeId: "1001" }), CONFIG, link),
    ).toBeNull();
  });
});

function decideFor(partial: Partial<EmployeeDecisionInput>) {
  return decideEmployeeAction({
    external: planday(),
    match: { kind: "NONE" },
    mapRow: null,
    employee: null,
    config: CONFIG,
    phase: "SYNC",
    portalId: PORTAL,
    hash: "new-hash",
    capacityRemaining: 10,
    ...partial,
  });
}

describe("decideEmployeeAction (§6.5 table)", () => {
  const mapped = {
    match: { kind: "MAPPED", employeeId: "emp-aisha" } as const,
    mapRow: mapRow(),
    employee: clockoff(),
  };

  it("wizard: stages in-scope people only; out-of-scope people are never persisted", () => {
    expect(decideFor({ phase: "DIRECTORY" })).toMatchObject({ action: "STAGE", writeHash: false });
    expect(
      decideFor({ phase: "DIRECTORY", external: planday({ externalLocationIds: ["103"] }) }),
    ).toMatchObject({
      action: "OUT_OF_SCOPE",
      dropPending: true,
    });
    expect(decideFor({ phase: "DIRECTORY", ...mapped })).toMatchObject({ action: "STAGE" });
  });

  it("SYNC, mapped, fields changed → UPDATE; nothing changed → UNCHANGED or REHASH_ONLY", () => {
    expect(decideFor({ ...mapped, external: planday({ lastName: "Khan-Smith" }) })).toMatchObject({
      action: "UPDATE",
      writeHash: true,
      update: { patch: { lastName: "Khan-Smith" } },
    });
    expect(decideFor({ ...mapped, hash: "old-hash" })).toMatchObject({
      action: "UNCHANGED",
      writeHash: false,
    });
    expect(decideFor({ ...mapped })).toMatchObject({ action: "REHASH_ONLY", writeHash: true });
    // A drifted employee is corrected even when the hash is equal (§6.2 step 3).
    expect(
      decideFor({ ...mapped, employee: clockoff({ firstName: "Aysha" }), hash: "old-hash" }),
    ).toMatchObject({ action: "UPDATE", update: { patch: { firstName: "Aisha" } } });
  });

  it("SYNC, mapped employee seen again clears the missing marks", () => {
    expect(
      decideFor({
        ...mapped,
        mapRow: mapRow({ upstreamMissingSince: NOW, reviewDismissedAt: NOW }),
        hash: "old-hash",
      }),
    ).toMatchObject({ action: "UNCHANGED", clearMissing: true });
  });

  it("SYNC, mapped but no longer in scope → kept as is with EMPLOYEE_OUT_OF_SCOPE (never deactivated)", () => {
    expect(
      decideFor({ ...mapped, external: planday({ externalLocationIds: ["103"] }) }),
    ).toMatchObject({
      action: "KEEP_OUT_OF_SCOPE",
      warning: "EMPLOYEE_OUT_OF_SCOPE",
      writeHash: false,
    });
  });

  it("SYNC, deactivated by the sync and back on the active list → queued for REACTIVATIONS", () => {
    const d = decideFor({
      ...mapped,
      mapRow: mapRow({ upstreamRemovedAt: NOW }),
      employee: clockoff({ employmentStatus: "INACTIVE" }),
      hash: "old-hash",
    });
    expect(d).toMatchObject({ action: "QUEUE_REACTIVATION", update: null });
    // Never from the active list once the dismissal date has passed.
    expect(
      decideFor({
        ...mapped,
        mapRow: mapRow({ upstreamRemovedAt: NOW }),
        employee: clockoff({ employmentStatus: "INACTIVE" }),
        external: planday({ active: false }),
        hash: "old-hash",
      }),
    ).toMatchObject({ action: "UNCHANGED" });
  });

  it("SYNC, new in scope: auto-include imports (NOT_INVITED), off queues NEW_EMPLOYEE, a full plan queues PLAN_LIMIT", () => {
    expect(decideFor({})).toMatchObject({
      action: "IMPORT",
      writeHash: true,
      create: { externalEmployeeId: `PLANDAY:${PORTAL}:1001`, primaryLocationId: "loc-bar" },
    });
    expect(decideFor({ config: { ...CONFIG, autoIncludeNewEmployees: false } })).toMatchObject({
      action: "PENDING",
      reason: "NEW_EMPLOYEE",
    });
    expect(decideFor({ capacityRemaining: 0 })).toMatchObject({
      action: "PENDING",
      reason: "PLAN_LIMIT",
    });
  });

  it("SYNC, possible or ambiguous match → pending for the manager, never linked", () => {
    expect(
      decideFor({ match: { kind: "POSSIBLE_MATCH", employeeId: "emp-x", signal: "NAME" } }),
    ).toMatchObject({
      action: "PENDING",
      reason: "POSSIBLE_MATCH",
      match: { matchedEmployeeId: "emp-x", matchSignal: "NAME", candidateEmployeeIds: ["emp-x"] },
    });
    expect(
      decideFor({ match: { kind: "AMBIGUOUS", candidateEmployeeIds: ["emp-x", "emp-y"] } }),
    ).toMatchObject({
      action: "PENDING",
      reason: "AMBIGUOUS_MATCH",
      match: { matchedEmployeeId: null, candidateEmployeeIds: ["emp-x", "emp-y"] },
    });
  });

  it("SYNC, a strong match links (auto-include on) with the link update; with auto-include off it waits", () => {
    const d = decideFor({
      match: { kind: "MATCHED", employeeId: "emp-aisha", signal: "EMAIL" },
      employee: clockoff({ externalEmployeeId: null }),
    });
    expect(d).toMatchObject({
      action: "LINK",
      employeeId: "emp-aisha",
      signal: "EMAIL",
      update: { patch: { externalEmployeeId: `PLANDAY:${PORTAL}:1001` } },
    });
    expect(
      decideFor({
        match: { kind: "MATCHED", employeeId: "emp-aisha", signal: "EMAIL" },
        config: { ...CONFIG, autoIncludeNewEmployees: false },
      }),
    ).toMatchObject({
      action: "PENDING",
      reason: "NEW_EMPLOYEE",
      match: { matchedEmployeeId: "emp-aisha" },
    });
  });

  it("unmapped people out of scope, excluded or dismissed are never persisted", () => {
    expect(decideFor({ external: planday({ externalLocationIds: ["103"] }) })).toMatchObject({
      action: "OUT_OF_SCOPE",
      dropPending: true,
      writeHash: false,
    });
    expect(decideFor({ config: { ...CONFIG, excludedEmployeeIds: ["1001"] } })).toMatchObject({
      action: "OUT_OF_SCOPE",
    });
    expect(decideFor({ external: planday({ active: false }) })).toMatchObject({
      action: "IGNORE_DISMISSED",
      dropPending: true,
    });
  });
});

describe("decideImportAction (APPLY_EMPLOYEES)", () => {
  const base = {
    externalId: "1001",
    match: { kind: "NONE" } as EmployeeMatch,
    selection: { mode: "ALL_EXCEPT" as const, externalIds: [] },
    resolution: null,
    mapped: false,
    capacityRemaining: 5,
  };

  it("unticked or excluded → EXCLUDE; already imported → ALREADY_LINKED", () => {
    expect(
      decideImportAction({ ...base, selection: { mode: "ALL_EXCEPT", externalIds: ["1001"] } }),
    ).toEqual({
      action: "EXCLUDE",
    });
    expect(decideImportAction({ ...base, selection: { mode: "ONLY", externalIds: [] } })).toEqual({
      action: "EXCLUDE",
    });
    expect(decideImportAction({ ...base, resolution: { action: "EXCLUDE" } })).toEqual({
      action: "EXCLUDE",
    });
    expect(decideImportAction({ ...base, mapped: true })).toEqual({ action: "ALREADY_LINKED" });
  });

  it("a strong match links, a possible match or nobody is created, an unresolved ambiguity stays pending", () => {
    expect(
      decideImportAction({
        ...base,
        match: { kind: "MATCHED", employeeId: "emp-1", signal: "NAME" },
      }),
    ).toEqual({ action: "LINK", employeeId: "emp-1", signal: "NAME" });
    expect(
      decideImportAction({
        ...base,
        match: { kind: "POSSIBLE_MATCH", employeeId: "emp-1", signal: "EXTERNAL_ID_RAW" },
      }),
    ).toEqual({ action: "IMPORT" });
    expect(decideImportAction(base)).toEqual({ action: "IMPORT" });
    expect(
      decideImportAction({
        ...base,
        match: { kind: "AMBIGUOUS", candidateEmployeeIds: ["emp-1", "emp-2"] },
      }),
    ).toEqual({ action: "PENDING", reason: "AMBIGUOUS_MATCH" });
    expect(decideImportAction({ ...base, capacityRemaining: 0 })).toEqual({
      action: "PENDING",
      reason: "PLAN_LIMIT",
    });
  });

  it("the manager's LINK or CREATE wins", () => {
    expect(
      decideImportAction({
        ...base,
        match: { kind: "AMBIGUOUS", candidateEmployeeIds: ["emp-1", "emp-2"] },
        resolution: { action: "LINK", employeeId: "emp-2" },
      }),
    ).toEqual({ action: "LINK", employeeId: "emp-2", signal: null });
    expect(
      decideImportAction({
        ...base,
        match: { kind: "MATCHED", employeeId: "emp-1", signal: "EMAIL" },
        resolution: { action: "CREATE" },
      }),
    ).toEqual({ action: "IMPORT" });
  });
});

describe("deactivation evidence (positive only, D-045)", () => {
  const status = (
    phase: "DEACTIVATED_EMPLOYEES" | "ABSENT_EMPLOYEES",
    value: "DEACTIVATED" | "ACTIVE" | "REMOVED",
    partial: { mapRow?: EmployeeMapRow | null; employmentStatus?: "ACTIVE" | "INACTIVE" } = {},
  ) =>
    decideEmployeeStatusAction({
      phase,
      status: value,
      mapRow: partial.mapRow === undefined ? mapRow() : partial.mapRow,
      employee: { employmentStatus: partial.employmentStatus ?? "ACTIVE" },
    });

  it("deactivated list, date passed → deactivate (DEACTIVATED_IN_PLANDAY)", () => {
    expect(status("DEACTIVATED_EMPLOYEES", "DEACTIVATED")).toEqual({
      action: "DEACTIVATE",
      reason: "DEACTIVATED_IN_PLANDAY",
    });
    expect(
      status("DEACTIVATED_EMPLOYEES", "DEACTIVATED", { employmentStatus: "INACTIVE" }),
    ).toEqual({
      action: "UNCHANGED",
    });
  });

  it("deactivated list with a future date → no change, DEACTIVATION_SCHEDULED", () => {
    expect(status("DEACTIVATED_EMPLOYEES", "ACTIVE")).toEqual({
      action: "UNCHANGED",
      warning: "DEACTIVATION_SCHEDULED",
    });
  });

  it("by id: isDeactivated (date passed) deactivates; 400/404 or an active body only flags the person", () => {
    expect(status("ABSENT_EMPLOYEES", "DEACTIVATED")).toEqual({
      action: "DEACTIVATE",
      reason: "REMOVED_FROM_PLANDAY",
    });
    for (const value of ["REMOVED", "ACTIVE"] as const) {
      expect(status("ABSENT_EMPLOYEES", value)).toEqual({
        action: "MARK_MISSING",
        setMissingSince: true,
        warning: "EMPLOYEE_NOT_VISIBLE",
      });
    }
    expect(
      status("ABSENT_EMPLOYEES", "REMOVED", { mapRow: mapRow({ upstreamMissingSince: NOW }) }),
    ).toMatchObject({
      setMissingSince: false,
    });
  });

  it("people ClockOff does not map are ignored (a deactivated one leaves the pending queue)", () => {
    expect(status("DEACTIVATED_EMPLOYEES", "DEACTIVATED", { mapRow: null })).toEqual({
      action: "IGNORE",
      dropPending: true,
    });
    expect(status("ABSENT_EMPLOYEES", "ACTIVE", { mapRow: null })).toEqual({
      action: "IGNORE",
      dropPending: false,
    });
  });

  it("missing review after 24 h unless dismissed", () => {
    const since = new Date(NOW.getTime() - 24 * 3_600_000);
    expect(
      shouldQueueMissingReview({ upstreamMissingSince: since, reviewDismissedAt: null }, NOW),
    ).toBe(true);
    expect(
      shouldQueueMissingReview(
        { upstreamMissingSince: new Date(since.getTime() + 1), reviewDismissedAt: null },
        NOW,
      ),
    ).toBe(false);
    expect(
      shouldQueueMissingReview({ upstreamMissingSince: since, reviewDismissedAt: NOW }, NOW),
    ).toBe(false);
    expect(
      shouldQueueMissingReview({ upstreamMissingSince: null, reviewDismissedAt: null }, NOW),
    ).toBe(false);
  });

  it("selects absent rechecks: active, unseen, not listed deactivated, at most 20", () => {
    const mappedRows = [
      { externalId: "a", employmentStatus: "ACTIVE" as const },
      { externalId: "seen", employmentStatus: "ACTIVE" as const },
      { externalId: "listed", employmentStatus: "ACTIVE" as const },
      { externalId: "inactive", employmentStatus: "INACTIVE" as const },
    ];
    expect(
      selectAbsentEmployeeRechecks({
        mapped: mappedRows,
        seenExternalIds: ["seen"],
        listedDeactivatedIds: ["listed"],
      }),
    ).toEqual(["a"]);
    const many = Array.from({ length: 30 }, (_, i) => ({
      externalId: `e${i}`,
      employmentStatus: "ACTIVE" as const,
    }));
    expect(
      selectAbsentEmployeeRechecks({ mapped: many, seenExternalIds: [], listedDeactivatedIds: [] }),
    ).toHaveLength(ABSENT_EMPLOYEE_RECHECK_LIMIT);
  });
});

describe("decideReactivation", () => {
  it("reactivates only people the sync deactivated and this run did not list as deactivated", () => {
    const removed = { upstreamRemovedAt: NOW };
    expect(
      decideReactivation({
        mapRow: removed,
        employee: { employmentStatus: "INACTIVE" },
        listedDeactivated: false,
      }),
    ).toEqual({
      action: "REACTIVATE",
    });
    // A future dismissal on both lists: listed, so two SYNCs never alternate.
    expect(
      decideReactivation({
        mapRow: removed,
        employee: { employmentStatus: "INACTIVE" },
        listedDeactivated: true,
      }),
    ).toEqual({
      action: "SKIP",
      reason: "LISTED_DEACTIVATED",
    });
    expect(
      decideReactivation({
        mapRow: removed,
        employee: { employmentStatus: "ACTIVE" },
        listedDeactivated: false,
      }),
    ).toEqual({
      action: "CLEAR_REMOVED",
    });
    expect(
      decideReactivation({
        mapRow: { upstreamRemovedAt: null },
        employee: { employmentStatus: "INACTIVE" },
        listedDeactivated: false,
      }),
    ).toEqual({ action: "KEEP_INACTIVE", warning: "EMPLOYEE_INACTIVE_IN_CLOCKOFF" });
    expect(decideReactivation({ mapRow: null, employee: null, listedDeactivated: false })).toEqual({
      action: "SKIP",
      reason: "NOT_MAPPED",
    });
  });

  it("a manager-deactivated employee active in Planday is queued and then kept inactive", () => {
    const d = decideFor({
      match: { kind: "MAPPED", employeeId: "emp-aisha" },
      mapRow: mapRow(),
      employee: clockoff({ employmentStatus: "INACTIVE" }),
    });
    expect(d.action).toBe("QUEUE_REACTIVATION");
  });
});
