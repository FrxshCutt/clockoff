import { randomUUID } from "node:crypto";
import { prisma, type Device, type IntegrationSyncRun, type Prisma, type User } from "@clockoff/db";
import {
  abortErrorFor,
  createPlandayProvider,
  PlandayBudgets,
  isPlandayConnectedCredentials,
  type PlandayConnectMethod,
  type PlandayProvider,
} from "@clockoff/integrations";
import {
  createMockPlanday,
  FROZEN_NOW,
  MOCK_PORTAL_CREDENTIALS,
  MOCK_PORTAL_ID,
  type MockPlanday,
} from "@clockoff/integrations/planday/mock";
import type {
  ActivationMode,
  IntegrationSyncRunKind,
  IntegrationSyncTrigger,
} from "@clockoff/shared/enums";
import { registerProvider, unregisterProvider } from "@clockoff/shared/providers/workforceProvider";
import type {
  PlandayEmployeeResolution,
  PlandayEmployeeSelection,
} from "@clockoff/validation/planday";
import type { Logger } from "@/lib/logger";
import { encryptCredentialColumns } from "@/server/integrations/credentials";
import { resetProvidersForTesting } from "@/server/integrations/providers";
import {
  announceRunQueued,
  enqueueRun,
  type EnqueueRunResult,
} from "@/server/integrations/runs/enqueue";
import { runSyncSlice, type SliceOutcome } from "@/server/integrations/runs/executor";
import { acquireLease } from "@/server/integrations/runs/runs.repository";
import { resetRunProgressThrottleForTesting } from "@/server/integrations/runs/progress";
import {
  resolvingPlandayTransport,
  setPlandayTransportForTesting,
} from "@/server/integrations/transport";
import { createManagedLocations } from "@/server/locations/locations.integration";
import { issueMobileTokens } from "@/server/mobileAuth";
import { createManagedTeams } from "@/server/teams/teams.integration";
import { addMember, createTestOrg, createTestUser } from "../../helpers";

/**
 * The Planday integration harness (docs/integrations/PLANDAY_IMPLEMENTATION_PLAN.md §13.2): an organisation with an
 * OWNER, an ADMIN and a MANAGER, the in-process Mock Planday as the transport, a connection made the way the
 * connect transaction stores it (§5.5), the wizard's database effects (`completeOnboarding`), and
 * `driveRunToCompletion`, which takes the lease with a test holder and loops `runSyncSlice` exactly as the worker's
 * runner does. Tests never start the runner: they call the same functions it calls.
 *
 * Clocks: the mock's clock (a fixed base, FROZEN_NOW, moved only by `advance` and by the HTTP layer's waits) is the
 * provider's clock and the run's business clock, so token expiry, pacing, sync windows and "now" agree.
 */

export const PORTAL = String(MOCK_PORTAL_ID);
export const DAY_MS = 86_400_000;

export interface PlandayTestContext {
  mock: MockPlanday;
  /** The business clock (the mock's clock). */
  now: () => Date;
  /** Moves the mock's clock (and so the business clock). */
  advance: (ms: number) => void;
  provider: PlandayProvider;
}

let active: PlandayTestContext | null = null;

/**
 * Installs a fresh Mock Planday as the transport and registers a Planday provider whose waits advance the mock
 * clock (no real sleeping) with its own budgets. Call in `beforeEach`; `uninstallPlanday` in `afterEach`.
 */
export function installPlanday(
  options: { anchor?: Date; clockMode?: boolean; partnerAppIds?: string[] } = {},
): PlandayTestContext {
  let base = (options.anchor ?? FROZEN_NOW).getTime();
  const mock = createMockPlanday({
    now: () => base,
    ...(options.anchor ? { anchor: options.anchor } : {}),
    ...(options.partnerAppIds ? { partnerAppIds: options.partnerAppIds } : {}),
  });
  const now = () => new Date(mock.state.now());
  setPlandayTransportForTesting({
    fetch: mock.fetch,
    authorizeBaseUrl: mock.authorizeBaseUrl,
    clock: now,
  });
  resetProvidersForTesting();
  const provider = createPlandayProvider({
    transport: resolvingPlandayTransport,
    budgets: new PlandayBudgets(),
    clock: now,
    sleep: async (ms, signal) => {
      if (signal?.aborted) throw abortErrorFor(signal);
      base += Math.max(0, ms);
    },
    random: () => 0,
    config: { clockModeEnabled: options.clockMode === true },
  });
  registerProvider(provider);
  resetRunProgressThrottleForTesting();
  active = {
    mock,
    now,
    advance: (ms) => {
      base += ms;
    },
    provider,
  };
  return active;
}

export function uninstallPlanday(): void {
  unregisterProvider("PLANDAY");
  setPlandayTransportForTesting(null);
  active = null;
}

function current(): PlandayTestContext {
  if (!active) throw new Error("installPlanday() first");
  return active;
}

// ── Organisations and connections ────────────────────────────────────────────

export interface PlandayOrg {
  organisationId: string;
  integrationId: string;
  owner: User;
  admin: User;
  manager: User;
  portalId: string;
}

/** An organisation with OWNER, ADMIN and MANAGER, its Planday integration, mapping config and wizard session. */
export async function createPlandayOrg(
  options: { timezone?: string; name?: string } = {},
): Promise<PlandayOrg> {
  const org = await createTestOrg({
    timezone: options.timezone ?? "Europe/London",
    ...(options.name ? { name: options.name } : {}),
  });
  const organisationId = org.organisation.id;
  const admin = (await createTestUser()).user;
  const manager = (await createTestUser()).user;
  await addMember(organisationId, admin, "ADMIN");
  await addMember(organisationId, manager, "MANAGER");
  const integration = await prisma.integration.create({
    data: { organisationId, provider: "PLANDAY", status: "NOT_CONNECTED" },
  });
  await prisma.integrationMappingConfig.create({
    data: { organisationId, integrationId: integration.id },
  });
  await prisma.integrationOnboardingSession.create({
    data: {
      organisationId,
      integrationId: integration.id,
      provider: "PLANDAY",
      startedByUserId: org.owner.id,
    },
  });
  return {
    organisationId,
    integrationId: integration.id,
    owner: org.owner,
    admin,
    manager,
    portalId: PORTAL,
  };
}

/**
 * The connect proof against the mock and the connect transaction's writes (§5.5, §5.6), without the HTTP layer of
 * build stage 5: `provider.connect()` with method C (or B), then the encrypted columns, the portal and CONNECTED.
 */
export async function connectViaMethod(
  org: PlandayOrg,
  options: { method?: PlandayConnectMethod; portalId?: number } = {},
): Promise<void> {
  const { provider, now } = current();
  const portalId = options.portalId ?? MOCK_PORTAL_ID;
  const credentials = MOCK_PORTAL_CREDENTIALS[portalId]!;
  const method = options.method ?? "CUSTOMER_OWN_APP";
  if (method === "OAUTH") throw new Error("connectViaMethod: method A needs the OAuth flow");
  const result = await provider.connect(
    {
      organisationId: org.organisationId,
      integrationId: org.integrationId,
      settings: {},
      now: now(),
    },
    {
      activationMode: "SCHEDULED",
      credentials: { method, clientId: credentials.appId, refreshToken: credentials.refreshToken },
    },
  );
  if (result.kind !== "CONNECTED" || !isPlandayConnectedCredentials(result.credentials)) {
    throw new Error("connectViaMethod: the proof did not connect");
  }
  const connected = result.credentials;
  const columns = encryptCredentialColumns(org.integrationId, connected.credentials);
  const data = {
    status: "CONNECTED" as const,
    authMethod: method,
    isMock: true,
    ...columns,
    credentialVersion: 1,
    scopesGranted: [...connected.scopesGranted],
    externalPortalId: connected.portal.externalId,
    externalPortalName: connected.portal.name,
    externalPortalTimezone: connected.portal.timezone,
    connectedByUserId: org.owner.id,
    connectedAt: now(),
    statusChangedAt: now(),
  };
  await prisma.integrationConnection.upsert({
    where: { integrationId: org.integrationId },
    create: { integrationId: org.integrationId, ...data },
    update: data,
  });
  await prisma.integration.update({
    where: { id: org.integrationId },
    data: { status: "CONNECTED" },
  });
  org.portalId = connected.portal.externalId;
}

// ── Runs ─────────────────────────────────────────────────────────────────────

export async function enqueue(
  org: PlandayOrg,
  kind: IntegrationSyncRunKind,
  trigger: IntegrationSyncTrigger,
  extra: { retryAuth?: boolean; replaceShiftIds?: string[]; requestedByUserId?: string } = {},
  db: Prisma.TransactionClient | typeof prisma = prisma,
): Promise<EnqueueRunResult> {
  const result = await enqueueRun(db, {
    organisationId: org.organisationId,
    integrationId: org.integrationId,
    kind,
    trigger,
    requestedByUserId: extra.requestedByUserId ?? org.owner.id,
    ...(extra.retryAuth ? { retryAuth: true } : {}),
    ...(extra.replaceShiftIds ? { replaceShiftIds: extra.replaceShiftIds } : {}),
  });
  if (result.outcome === "QUEUED") announceRunQueued(result.run);
  return result;
}

/** Logs of every slice the harness drives (the data-minimisation suite captures them). */
let sliceLogger: Logger | undefined;

export function setSliceLoggerForTesting(log: Logger | undefined): void {
  sliceLogger = log;
}

export interface DriveResult {
  run: IntegrationSyncRun;
  outcomes: SliceOutcome[];
}

/**
 * Loops slices of `runId` with a test holder until it is DONE (or SKIPPED; or PARKED when `ignoreResumeAfter` is
 * false), as the runner would. `ignoreResumeAfter` (default true) moves the mock clock to a park's `resume_after` and
 * clears it before the next slice.
 */
export async function driveRunToCompletion(
  runId: string,
  options: {
    now?: () => Date;
    ignoreResumeAfter?: boolean;
    maxSlices?: number;
    maxMs?: number;
    signal?: AbortSignal;
  } = {},
): Promise<DriveResult> {
  const now = options.now ?? current().now;
  const outcomes: SliceOutcome[] = [];
  const maxSlices = options.maxSlices ?? 60;
  for (let i = 0; i < maxSlices; i++) {
    const run = await prisma.integrationSyncRun.findUniqueOrThrow({ where: { id: runId } });
    if (run.status !== "RUNNING") break;
    if (options.ignoreResumeAfter !== false && run.resumeAfter) {
      // Time passes until the run may resume (the client's own rate-limit pause runs on the mock clock).
      const wait = run.resumeAfter.getTime() - now().getTime();
      if (wait > 0 && active) active.advance(wait);
      await prisma.integrationSyncRun.update({ where: { id: runId }, data: { resumeAfter: null } });
    }
    const holder = randomUUID();
    if (!(await acquireLease(run.integrationId, holder))) {
      throw new Error("driveRunToCompletion: the portal is leased by someone else");
    }
    const outcome = await runSyncSlice(runId, {
      holder,
      instanceId: "test-runner",
      signal: options.signal ?? new AbortController().signal,
      now,
      ...(options.maxMs !== undefined ? { maxMs: options.maxMs } : {}),
      ...(sliceLogger ? { log: sliceLogger } : {}),
    });
    outcomes.push(outcome);
    if (outcome.state === "DONE" || outcome.state === "SKIPPED") break;
    if (outcome.state === "PARKED" && options.ignoreResumeAfter === false) break;
  }
  const run = await prisma.integrationSyncRun.findUniqueOrThrow({ where: { id: runId } });
  return { run, outcomes };
}

/** Enqueues a run and drives it to completion; throws when nothing was queued. */
export async function runKind(
  org: PlandayOrg,
  kind: IntegrationSyncRunKind,
  trigger: IntegrationSyncTrigger,
  extra: { retryAuth?: boolean; replaceShiftIds?: string[] } = {},
): Promise<DriveResult> {
  const result = await enqueue(org, kind, trigger, extra);
  if (result.outcome !== "QUEUED")
    throw new Error(`runKind: ${kind} was not queued (${result.outcome})`);
  return driveRunToCompletion(result.run.id);
}

/** A SYNC (default MANUAL) driven to completion. */
export function runSync(
  org: PlandayOrg,
  options: { trigger?: IntegrationSyncTrigger; retryAuth?: boolean } = {},
): Promise<DriveResult> {
  return runKind(org, "SYNC", options.trigger ?? "MANUAL", {
    ...(options.retryAuth ? { retryAuth: true } : {}),
  });
}

// ── The wizard's database effects ────────────────────────────────────────────

export interface OnboardingChoices {
  /** Included Planday departments (default Bar and Kitchen; "none" counts). */
  includedDepartmentIds?: string[];
  /** Planday groups mapped to new teams (default none). */
  newTeamGroupIds?: string[];
  selection?: PlandayEmployeeSelection;
  resolutions?: PlandayEmployeeResolution[];
  autoIncludeNewEmployees?: boolean;
  importEmails?: boolean;
  respectHiddenDays?: boolean;
  syncWindowDays?: number;
  activationMode?: ActivationMode;
  replaceShiftIds?: string[];
  /** Stop before Finish (no SYNC run). */
  stopBeforeFinish?: boolean;
}

export interface OnboardingResult {
  structure: DriveResult;
  directory: DriveResult;
  importEmployees: DriveResult;
  /** The INITIAL SYNC (absent with `stopBeforeFinish`). */
  initialSync?: DriveResult;
  locationIds: Record<string, string>;
  teamIds: Record<string, string>;
}

/**
 * The nine steps' database effects in order (§9.5): STRUCTURE; step 3 creates a location per included department and
 * stores the mappings; step 4 maps groups to new teams; DIRECTORY; step 5 stores the selection and imports
 * (IMPORT_EMPLOYEES); Finish sets `onboardingCompletedAt`, completes the session and runs the INITIAL SYNC.
 */
export async function completeOnboarding(
  org: PlandayOrg,
  choices: OnboardingChoices = {},
): Promise<OnboardingResult> {
  const { now } = current();
  const structure = await runKind(org, "STRUCTURE", "INITIAL");
  if (structure.run.status === "FAILED")
    throw new Error(`STRUCTURE failed: ${structure.run.errorCode}`);

  const included = choices.includedDepartmentIds ?? ["101", "102"];
  const connection = await prisma.integrationConnection.findUniqueOrThrow({
    where: { integrationId: org.integrationId },
  });
  const config = await prisma.integrationMappingConfig.findUniqueOrThrow({
    where: { integrationId: org.integrationId },
  });
  const catalog = config.catalog as { departments?: Array<{ externalId: string; name: string }> };
  const names = new Map((catalog.departments ?? []).map((d) => [d.externalId, d.name] as const));
  const actor = { organisationId: org.organisationId, integrationId: org.integrationId };
  const locations = await prisma.$transaction((tx) =>
    createManagedLocations(
      tx,
      actor,
      included.map((id) => ({
        externalId: id,
        name: names.get(id) ?? connection.externalPortalName ?? `Department ${id}`,
        timezone: connection.externalPortalTimezone,
        lastHash: null,
      })),
      now(),
    ),
  );
  const locationIds = Object.fromEntries(locations.map((l) => [l.externalId, l.locationId]));
  const teams = choices.newTeamGroupIds?.length
    ? await prisma.$transaction((tx) => {
        const groupNames = new Map(
          (
            (config.catalog as { groups?: Array<{ externalId: string; name: string }> }).groups ??
            []
          ).map((g) => [g.externalId, g.name] as const),
        );
        return createManagedTeams(
          tx,
          actor,
          choices.newTeamGroupIds!.map((id) => ({
            externalId: id,
            name: groupNames.get(id) ?? `Group ${id}`,
            lastHash: null,
          })),
          now(),
        );
      })
    : [];
  const teamIds = Object.fromEntries(
    (teams as Array<{ externalId: string; teamId: string }>).map((t) => [t.externalId, t.teamId]),
  );
  await prisma.integrationMappingConfig.update({
    where: { integrationId: org.integrationId },
    data: {
      includedDepartmentIds: included,
      departmentMappings: Object.fromEntries(
        Object.entries(locationIds).map(([id, locationId]) => [
          id,
          { target: "LOCATION", locationId },
        ]),
      ),
      groupMappings: Object.fromEntries(
        Object.entries(teamIds).map(([id, teamId]) => [id, { target: "TEAM", teamId }]),
      ),
      ...(choices.respectHiddenDays !== undefined
        ? { respectHiddenDays: choices.respectHiddenDays }
        : {}),
      ...(choices.syncWindowDays !== undefined ? { syncWindowDays: choices.syncWindowDays } : {}),
      mappingVersion: { increment: 1 },
    },
  });

  const directory = await runKind(org, "DIRECTORY", "INITIAL");
  if (directory.run.status === "FAILED")
    throw new Error(`DIRECTORY failed: ${directory.run.errorCode}`);

  const autoInclude = choices.autoIncludeNewEmployees ?? true;
  const importEmails = choices.importEmails ?? true;
  const session = await prisma.integrationOnboardingSession.findFirstOrThrow({
    where: { integrationId: org.integrationId, status: "ACTIVE" },
  });
  await prisma.integrationOnboardingSession.update({
    where: { id: session.id },
    data: {
      state: {
        employees: {
          savedAt: now().toISOString(),
          selection: choices.selection ?? { mode: "ALL_EXCEPT", externalIds: [] },
          resolutions: choices.resolutions ?? [],
          autoIncludeNewEmployees: autoInclude,
          importEmails,
        },
      },
    },
  });
  await prisma.integrationMappingConfig.update({
    where: { integrationId: org.integrationId },
    data: { autoIncludeNewEmployees: autoInclude, importEmails },
  });
  const importEmployees = await runKind(org, "IMPORT_EMPLOYEES", "INITIAL");
  if (importEmployees.run.status === "FAILED") {
    throw new Error(`IMPORT_EMPLOYEES failed: ${importEmployees.run.errorCode}`);
  }
  const result: OnboardingResult = { structure, directory, importEmployees, locationIds, teamIds };
  if (choices.stopBeforeFinish) return result;

  result.initialSync = await finishOnboarding(org, {
    ...(choices.activationMode ? { activationMode: choices.activationMode } : {}),
    ...(choices.replaceShiftIds ? { replaceShiftIds: choices.replaceShiftIds } : {}),
  });
  return result;
}

/**
 * Finish (§9.5 step 9): `onboardingCompletedAt`, the session COMPLETED, preview rows purged, and the INITIAL SYNC
 * with the ticked conflicts, driven to completion.
 */
export async function finishOnboarding(
  org: PlandayOrg,
  options: { activationMode?: ActivationMode; replaceShiftIds?: string[] } = {},
): Promise<DriveResult> {
  const { now } = current();
  if (options.activationMode) {
    await prisma.integration.update({
      where: { id: org.integrationId },
      data: { activationMode: options.activationMode },
    });
  }
  await prisma.$transaction(async (tx) => {
    await tx.integrationMappingConfig.update({
      where: { integrationId: org.integrationId },
      data: { onboardingCompletedAt: now() },
    });
    await tx.integrationOnboardingSession.updateMany({
      where: { integrationId: org.integrationId, status: "ACTIVE" },
      data: { status: "COMPLETED", completedAt: now() },
    });
    await tx.integrationPreviewShift.deleteMany({ where: { integrationId: org.integrationId } });
  });
  return runKind(org, "SYNC", "INITIAL", {
    ...(options.replaceShiftIds ? { replaceShiftIds: options.replaceShiftIds } : {}),
  });
}

// ── Lookups ──────────────────────────────────────────────────────────────────

/** The ClockOff employee mapped to a Planday employee id (null when none). */
export async function employeeFor(org: PlandayOrg, plandayId: number | string) {
  const map = await prisma.externalEntityMap.findUnique({
    where: {
      integrationId_entityType_externalId: {
        integrationId: org.integrationId,
        entityType: "EMPLOYEE",
        externalId: String(plandayId),
      },
    },
  });
  return map ? prisma.employee.findUnique({ where: { id: map.internalId } }) : null;
}

/** The ClockOff shift mapped to a Planday shift id (null when none). */
export async function shiftFor(org: PlandayOrg, plandayId: number | string) {
  const map = await prisma.externalEntityMap.findUnique({
    where: {
      integrationId_entityType_externalId: {
        integrationId: org.integrationId,
        entityType: "SHIFT",
        externalId: String(plandayId),
      },
    },
  });
  return map ? prisma.shift.findUnique({ where: { id: map.internalId } }) : null;
}

export async function connectionOf(org: PlandayOrg) {
  return prisma.integrationConnection.findUniqueOrThrow({
    where: { integrationId: org.integrationId },
  });
}

/** A device linked to an existing employee (mobile token for `GET /api/mobile/v1/sync`). */
export async function deviceFor(
  organisationId: string,
  employeeId: string,
): Promise<{ device: Device; headers: Record<string, string> }> {
  const mobileUser = await prisma.mobileUser.create({
    data: { firstName: "Device", lastName: "Owner" },
  });
  await prisma.employeeUserLink.create({ data: { employeeId, mobileUserId: mobileUser.id } });
  const device = await prisma.device.create({
    data: { organisationId, employeeId, mobileUserId: mobileUser.id, isActive: true },
  });
  const { accessToken } = await issueMobileTokens(device);
  return { device, headers: { authorization: `Bearer ${accessToken}` } };
}

// ── Database operations per transaction (§6.1 "500 changed shifts") ─────────

const RAW_OPERATIONS = new Set([
  "$queryRaw",
  "$executeRaw",
  "$queryRawUnsafe",
  "$executeRawUnsafe",
]);

type AnyFunction = (...args: unknown[]) => unknown;

/** The transaction client, recording every operation issued through it into `operations`. */
function recordingClient<T extends object>(tx: T, operations: string[]): T {
  return new Proxy(tx, {
    get(target, prop) {
      const value: unknown = Reflect.get(target, prop, target);
      if (typeof prop !== "string") return value;
      if (RAW_OPERATIONS.has(prop) && typeof value === "function") {
        return (...args: unknown[]) => {
          operations.push(prop);
          return Reflect.apply(value as AnyFunction, target, args);
        };
      }
      if (prop.startsWith("$") || prop.startsWith("_") || !value || typeof value !== "object") {
        return value;
      }
      // A model delegate (`tx.shift`, …): each call is one operation.
      return new Proxy(value, {
        get(delegate, operation) {
          const fn: unknown = Reflect.get(delegate, operation, delegate);
          if (typeof fn !== "function" || typeof operation !== "string") return fn;
          return (...args: unknown[]) => {
            operations.push(`${prop}.${operation}`);
            return Reflect.apply(fn as AnyFunction, delegate, args);
          };
        },
      });
    },
  });
}

/**
 * Records the database operations of every interactive `prisma.$transaction` until `stop()`: one list per
 * transaction, in order. An operation is one call through the transaction client, a raw statement or a model call
 * (Prisma may run a `findMany` with relations as one SQL statement per relation).
 *
 * The client's own `$transaction` is shadowed and `stop()` deletes the shadow (`vi.spyOn` cannot restore it: the
 * Prisma client is a proxy whose property descriptors read `undefined`).
 */
export function recordTransactionOperations(): { transactions: string[][]; stop: () => void } {
  const transactions: string[][] = [];
  const client = prisma as unknown as { $transaction?: AnyFunction };
  const original = prisma.$transaction.bind(prisma) as unknown as AnyFunction;
  client.$transaction = (...args: unknown[]) => {
    const [work, ...rest] = args;
    if (typeof work !== "function") return original(...args);
    const operations: string[] = [];
    transactions.push(operations);
    return original(
      (tx: Prisma.TransactionClient) => (work as AnyFunction)(recordingClient(tx, operations)),
      ...rest,
    );
  };
  return {
    transactions,
    stop: () => {
      delete client.$transaction;
    },
  };
}

/**
 * Runs `before` (outside the transaction, on its own connection) the first time a transaction calls
 * `tx[model][operation]` with arguments `when` accepts, then lets the call proceed: a concurrent writer committing
 * between a step's reads and its write. `stop()` deletes the `$transaction` shadow, as for
 * `recordTransactionOperations`.
 */
export function interceptTransactionCall(
  model: string,
  operation: string,
  before: () => Promise<void>,
  when: (args: unknown) => boolean = () => true,
): { fired: () => boolean; stop: () => void } {
  let fired = false;
  const client = prisma as unknown as { $transaction?: AnyFunction };
  const original = prisma.$transaction.bind(prisma) as unknown as AnyFunction;
  const wrap = (tx: Prisma.TransactionClient) =>
    new Proxy(tx, {
      get(target, prop) {
        const value: unknown = Reflect.get(target, prop, target);
        if (prop !== model || !value || typeof value !== "object") return value;
        return new Proxy(value, {
          get(delegate, name) {
            const fn: unknown = Reflect.get(delegate, name, delegate);
            if (name !== operation || typeof fn !== "function") return fn;
            return async (...args: unknown[]) => {
              if (!fired && when(args[0])) {
                fired = true;
                await before();
              }
              return Reflect.apply(fn as AnyFunction, delegate, args);
            };
          },
        });
      },
    });
  client.$transaction = (...args: unknown[]) => {
    const [work, ...rest] = args;
    if (typeof work !== "function") return original(...args);
    return original((tx: Prisma.TransactionClient) => (work as AnyFunction)(wrap(tx)), ...rest);
  };
  return {
    fired: () => fired,
    stop: () => {
      delete client.$transaction;
    },
  };
}
