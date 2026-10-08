import { createHash } from "node:crypto";
import type { z } from "zod";
import {
  isCredentialPersistError,
  type CredentialStore,
  type RefreshAtomicallyOptions,
  type StoredCredentials,
} from "@clockoff/shared/providers/credentialStore";
import {
  PAGE_LIMITS,
  PLANDAY_PATHS,
  REFRESH_MARGIN_MS,
  requiredScopes,
  type PlandayScope,
} from "./constants";
import { PlandayError } from "./errors";
import {
  createPlandayHttp,
  sharedPlandayBudgets,
  type PlandayBudgets,
  type PlandayHttp,
  type PlandayTransport,
  type Sleep,
  type TimeoutSignalFactory,
} from "./http";
import { noopPlandayLogger, pathTemplate, PLANDAY_LOG_EVENTS, type PlandayLogger } from "./logging";
import {
  mapDeactivatedEmployee,
  mapDeletedShift,
  mapDepartment,
  mapEmployee,
  mapEmployeeGroup,
  mapEmployeeStatus,
  mapPortal,
  mapPunchClockBreak,
  mapPunchClockShift,
  mapScheduleDay,
  mapShift,
  type PlandayDeactivatedEmployee,
  type PlandayDeletedShift,
  type PlandayDepartment,
  type PlandayEmployee,
  type PlandayEmployeeGroup,
  type PlandayEmployeeStatus,
  type PlandayPortal,
  type PlandayPunchClockBreak,
  type PlandayPunchClockShift,
  type PlandayScheduleDay,
  type PlandayShift,
} from "./mappers";
import { fetchPage, type PageRequest, type PlandayPage } from "./pagination";
import {
  deactivatedEmployeeSchema,
  deletedShiftSchema,
  departmentSchema,
  employeeDetailsSchema,
  employeeGroupSchema,
  employeeSchema,
  pagedResponseSchema,
  portalInfoResponseSchema,
  punchClockBreakSchema,
  punchClockShiftSchema,
  scheduleDaySchema,
  shiftSchema,
  singleResponseSchema,
} from "./schemas";
import { formatPlandayUtcDateTime, formatPlandayWallClock } from "./time";
import { refreshToken, type TokenRequestDeps } from "./tokens";

/**
 * The Planday API client (docs/integrations/PLANDAY_IMPLEMENTATION_PLAN.md §4): one method per endpoint of notes §9
 * that ClockOff calls, plus `probeScopes()` for the connect proof (§5.6). Every method returns allow-list mapped
 * records (§4.7); nothing raw leaves it. Credentials come from a `CredentialStore`: the web layer's
 * lease-guarded `PrismaCredentialStore` in sync runs, `createInMemoryCredentialStore` during the connect proof,
 * where nothing is persisted until the proof succeeds.
 */

export interface PlandayClientOptions {
  readonly transport: PlandayTransport;
  readonly credentialStore: CredentialStore;
  /** Serial-queue and budget key: the portal id, or the integration id before the portal is known (§4.5). */
  readonly portalKey: string;
  /** Budget key for the client id; defaults to a hash of the stored client id. */
  readonly clientIdKey?: string;
  readonly logger?: PlandayLogger;
  /** Process-wide rate state; `sharedPlandayBudgets()` unless given. */
  readonly budget?: PlandayBudgets;
  readonly now?: () => Date;
  /** Worker shutdown or lost lease. Aborts API requests and waits; never a token request in flight (§7.7). */
  readonly signal?: AbortSignal;
  /** The connect proof's bound (§4.1, §5.6). */
  readonly deadline?: { remainingMs(): number };
  /**
   * Keys the single in-flight token refresh per integration (§4.3) and appears in logs. Required: never the
   * portal id, which two organisations' mock connections can share.
   */
  readonly integrationId: string;
  readonly runId?: string;
  /** Optional hard cap on requests (the executor enforces RUN_REQUEST_BUDGET between steps, §4.5). */
  readonly maxRequests?: number;
  /** Test seams. */
  readonly sleep?: Sleep;
  readonly random?: () => number;
  readonly createTimeoutSignal?: TimeoutSignalFactory;
}

export interface ZoneOption {
  /** The portal's IANA zone: resolves wall-clock values without their own zone (UTC when null). */
  readonly portalZone: string | null;
}

export interface ScopeProbeResult {
  /** The required scopes whose probe answered 200 with a readable body. */
  readonly grantedScopes: PlandayScope[];
}

export interface PlandayClient {
  /**
   * Credentials holding an access token valid for at least REFRESH_MARGIN_MS, refreshing through
   * `credentialStore.refreshAtomically` when needed. `force: true` always runs the refresh grant (every SYNC's
   * PORTAL_CHECK and retryAuth runs, §4.3), which detects a revoked refresh token within one cycle.
   */
  accessToken(options?: { readonly force?: boolean }): Promise<StoredCredentials>;
  /** `GET /portal/v1.0/info`. A 403 → PLANDAY_SCOPE_MISSING naming "portal info" (Q11). */
  getPortalInfo(): Promise<PlandayPortal>;
  /** `GET /hr/v1.0/departments`. */
  listDepartments(page?: PageRequest): Promise<PlandayPage<PlandayDepartment>>;
  /** `GET /hr/v1.0/employeegroups`. */
  listEmployeeGroups(page?: PageRequest): Promise<PlandayPage<PlandayEmployeeGroup>>;
  /** `GET /hr/v1.0/employees` (active employees only). */
  listEmployees(page: PageRequest & ZoneOption): Promise<PlandayPage<PlandayEmployee>>;
  /** `GET /hr/v1.0/employees/deactivated?deactivatedFrom=…`. */
  listDeactivatedEmployees(
    page: PageRequest & ZoneOption & { readonly deactivatedFrom?: Date },
  ): Promise<PlandayPage<PlandayDeactivatedEmployee>>;
  /**
   * `GET /hr/v1.0/employees/{id}`, used only to confirm a deactivation (§6.5). 400, 404 or `data: null` →
   * PLANDAY_NOT_FOUND (record level).
   */
  getEmployeeStatus(employeeId: string, options: ZoneOption): Promise<PlandayEmployeeStatus>;
  /** `GET /scheduling/v1.0/shifts?from&to` (inclusive `YYYY-MM-DD` dates). */
  listShifts(
    page: PageRequest & ZoneOption & { readonly from: string; readonly to: string },
  ): Promise<PlandayPage<PlandayShift>>;
  /** `GET /scheduling/v1.0/shifts/{id}`. 404 or `data: null` → PLANDAY_NOT_FOUND. */
  getShift(shiftId: string, options: ZoneOption): Promise<PlandayShift>;
  /** `GET /scheduling/v1.0/shifts/deleted?deletedFrom=…`. */
  listDeletedShifts(
    page: PageRequest & { readonly deletedFrom: Date },
  ): Promise<PlandayPage<PlandayDeletedShift>>;
  /** `GET /scheduling/v1.0/scheduleDay?departmentId&from&to`. */
  listScheduleDays(
    page: PageRequest & {
      readonly departmentId: string;
      readonly from: string;
      readonly to: string;
    },
  ): Promise<PlandayPage<PlandayScheduleDay>>;
  /** `GET /punchclock/v1.0/punchclockshifts?from&to` (Beta); `from` / `to` sent as wall-clock in the portal zone. */
  listPunchClockShifts(
    page: PageRequest & { readonly from: Date; readonly to: Date; readonly portalZone: string },
  ): Promise<PlandayPage<PlandayPunchClockShift>>;
  /** `GET /punchclock/v1.0/punchclockshifts/{id}/breaks` (Beta; unpaged). */
  listPunchClockBreaks(punchClockShiftId: string): Promise<PlandayPunchClockBreak[]>;
  /**
   * The connect proof's scope probes (§5.6 step 3): `limit=1` reads of departments, employee groups, employees and
   * today's shifts (and a one-hour punch clock window with clock mode). Every 403 is collected and reported in one
   * PLANDAY_SCOPE_MISSING naming the scopes; any other failure is thrown as is; every 200 body must parse.
   */
  probeScopes(options: {
    readonly clockMode: boolean;
    /** Today's date in the portal zone, `YYYY-MM-DD`. */
    readonly today: string;
    readonly portalZone: string | null;
  }): Promise<ScopeProbeResult>;
  /** Planday requests sent by this client, token requests and retries included (PhaseStepResult.requests). */
  requestCount(): number;
}

/** sha256 hex of an access token: `RefreshAtomicallyOptions.rejectAccessTokenHash` (§4.3). */
export function accessTokenHash(accessToken: string): string {
  return createHash("sha256").update(accessToken).digest("hex");
}

function storedTokenIsValid(
  credentials: StoredCredentials,
  nowMs: number,
  minValidityMs: number,
): boolean {
  return (
    credentials.accessToken !== null &&
    credentials.accessTokenExpiresAt !== null &&
    credentials.accessTokenExpiresAt.getTime() > nowMs + minValidityMs
  );
}

interface RefreshRequest {
  readonly force: boolean;
  readonly rejectAccessTokenHash: string | undefined;
}

/** Whether an in-flight refresh also satisfies `wanted` (joining it then makes no second token request). */
function satisfies(inFlight: RefreshRequest, wanted: RefreshRequest): boolean {
  if (inFlight.force) return true;
  if (wanted.force) return false;
  if (wanted.rejectAccessTokenHash === undefined) return true;
  return inFlight.rejectAccessTokenHash === wanted.rejectAccessTokenHash;
}

export function createPlandayClient(options: PlandayClientOptions): PlandayClient {
  const store = options.credentialStore;
  const logger = options.logger ?? noopPlandayLogger;
  const now = options.now ?? (() => new Date());
  const budgets = options.budget ?? sharedPlandayBudgets();
  const refreshKey = options.integrationId;

  const http: PlandayHttp = createPlandayHttp({
    transport: options.transport,
    portalKey: options.portalKey,
    ...(options.clientIdKey !== undefined ? { clientIdKey: options.clientIdKey } : {}),
    budgets,
    logger,
    now,
    ...(options.sleep ? { sleep: options.sleep } : {}),
    ...(options.random ? { random: options.random } : {}),
    ...(options.createTimeoutSignal ? { createTimeoutSignal: options.createTimeoutSignal } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.deadline ? { deadline: options.deadline } : {}),
    ...(options.maxRequests !== undefined ? { maxRequests: options.maxRequests } : {}),
    integrationId: options.integrationId,
    ...(options.runId ? { runId: options.runId } : {}),
    auth: {
      current: async () => {
        const credentials = await accessToken();
        return { accessToken: credentials.accessToken as string, clientId: credentials.clientId };
      },
      refreshAfterUnauthorized: async (rejected) => {
        await refresh({ force: false, rejectAccessTokenHash: accessTokenHash(rejected) });
      },
    },
  });

  const tokenDeps: TokenRequestDeps = {
    transport: options.transport,
    logger,
    now,
    onRequest: () => http.countRequest(),
    ...(options.deadline ? { deadline: options.deadline } : {}),
    ...(options.sleep ? { sleep: options.sleep } : {}),
    ...(options.random ? { random: options.random } : {}),
    ...(options.createTimeoutSignal ? { createTimeoutSignal: options.createTimeoutSignal } : {}),
    // Waits before a token request may be cut short; the request itself never is (§7.7).
    ...(options.signal ? { signal: options.signal } : {}),
    integrationId: options.integrationId,
    ...(options.runId ? { runId: options.runId } : {}),
  };

  async function doRefresh(request: RefreshRequest): Promise<StoredCredentials> {
    let rotated = false;
    const exchange = async (current: StoredCredentials): Promise<StoredCredentials> => {
      const requestedAt = now().getTime();
      const set = await refreshToken(
        { clientId: current.clientId, refreshToken: current.refreshToken },
        tokenDeps,
      );
      rotated = set.refreshToken !== null && set.refreshToken !== current.refreshToken;
      logger.info(
        { integrationId: options.integrationId, rotated, expiresInS: set.expiresInS },
        PLANDAY_LOG_EVENTS.tokenRefreshed,
      );
      return {
        clientId: current.clientId,
        refreshToken: set.refreshToken ?? current.refreshToken,
        accessToken: set.accessToken,
        accessTokenExpiresAt: new Date(requestedAt + set.expiresInS * 1000),
      };
    };
    const refreshOptions: RefreshAtomicallyOptions = {
      minValidityMs: request.force ? 0 : REFRESH_MARGIN_MS,
      ...(request.force ? { force: true } : {}),
      ...(request.rejectAccessTokenHash !== undefined
        ? { rejectAccessTokenHash: request.rejectAccessTokenHash }
        : {}),
    };
    try {
      const next = await store.refreshAtomically(exchange, refreshOptions);
      if (!next.accessToken) {
        throw new PlandayError("PLANDAY_INVALID_RESPONSE", { pathTemplate: "/connect/token" });
      }
      return next;
    } catch (err) {
      if (isCredentialPersistError(err)) {
        logger.error(
          {
            integrationId: options.integrationId,
            credentialVersion: store.knownVersion(),
            rotated,
          },
          PLANDAY_LOG_EVENTS.persistFailed,
        );
        throw new PlandayError("CREDENTIAL_PERSIST_FAILED", { cause: err });
      }
      throw err;
    }
  }

  /**
   * At most one token refresh per integration in flight in this process (§4.3, Q16). Only a client reading the same
   * credential store may join one and take its credentials; a client with another store (another connect proof's
   * in-memory store, say) waits for it to finish, then runs its own.
   */
  async function refresh(request: RefreshRequest): Promise<StoredCredentials> {
    for (;;) {
      const inFlight = budgets.refreshes.get(refreshKey);
      if (!inFlight) break;
      if (inFlight.store === store && satisfies(inFlight, request)) {
        const shared = await inFlight.promise;
        // A joined refresh that kept the token just rejected (another caller's store saw it as valid) is not
        // enough: run our own.
        if (
          request.rejectAccessTokenHash === undefined ||
          shared.accessToken === null ||
          accessTokenHash(shared.accessToken) !== request.rejectAccessTokenHash
        ) {
          return shared;
        }
        break;
      }
      await inFlight.promise.catch(() => undefined);
    }
    const promise = doRefresh(request);
    const entry = { promise, store, ...request };
    budgets.refreshes.set(refreshKey, entry);
    const cleanup = () => {
      if (budgets.refreshes.get(refreshKey) === entry) budgets.refreshes.delete(refreshKey);
    };
    promise.then(cleanup, cleanup);
    return promise;
  }

  async function accessToken(opts: { readonly force?: boolean } = {}): Promise<StoredCredentials> {
    if (!opts.force) {
      const current = await store.read();
      if (storedTokenIsValid(current, now().getTime(), REFRESH_MARGIN_MS)) return current;
    }
    return refresh({ force: opts.force === true, rejectAccessTokenHash: undefined });
  }

  const zoneOf = (option: ZoneOption): string | null => option.portalZone;

  async function getById<S extends z.ZodType, T>(
    path: string,
    schema: S,
    map: (data: z.output<S>) => T,
  ): Promise<T> {
    const parsed = await http.getParsed(path, undefined, singleResponseSchema(schema));
    const data = (parsed as { data: z.output<S> | null }).data;
    if (data === null) {
      throw new PlandayError("PLANDAY_NOT_FOUND", { pathTemplate: pathTemplate(path) });
    }
    return map(data);
  }

  const client: PlandayClient = {
    accessToken,

    async getPortalInfo() {
      const parsed = await http.getParsed(
        PLANDAY_PATHS.portalInfo,
        undefined,
        portalInfoResponseSchema,
      );
      return mapPortal(parsed.data);
    },

    listDepartments(page = {}) {
      return fetchPage(http, {
        path: PLANDAY_PATHS.departments,
        offset: page.offset ?? 0,
        limit: page.limit ?? PAGE_LIMITS.hr,
        itemSchema: departmentSchema,
        map: mapDepartment,
      });
    },

    listEmployeeGroups(page = {}) {
      return fetchPage(http, {
        path: PLANDAY_PATHS.employeeGroups,
        offset: page.offset ?? 0,
        limit: page.limit ?? PAGE_LIMITS.hr,
        itemSchema: employeeGroupSchema,
        map: mapEmployeeGroup,
      });
    },

    listEmployees(page) {
      const zone = zoneOf(page);
      return fetchPage(http, {
        path: PLANDAY_PATHS.employees,
        offset: page.offset ?? 0,
        limit: page.limit ?? PAGE_LIMITS.hr,
        itemSchema: employeeSchema,
        map: (raw) => mapEmployee(raw, zone),
      });
    },

    listDeactivatedEmployees(page) {
      const zone = zoneOf(page);
      return fetchPage(http, {
        path: PLANDAY_PATHS.deactivatedEmployees,
        query: {
          deactivatedFrom: page.deactivatedFrom
            ? formatPlandayUtcDateTime(page.deactivatedFrom)
            : undefined,
        },
        offset: page.offset ?? 0,
        limit: page.limit ?? PAGE_LIMITS.hr,
        itemSchema: deactivatedEmployeeSchema,
        map: (raw) => mapDeactivatedEmployee(raw, zone),
      });
    },

    getEmployeeStatus(employeeId, options) {
      return getById(PLANDAY_PATHS.employeeById(employeeId), employeeDetailsSchema, (data) =>
        mapEmployeeStatus(employeeId, data, zoneOf(options)),
      );
    },

    listShifts(page) {
      const zone = zoneOf(page);
      const template = pathTemplate(PLANDAY_PATHS.shifts);
      return fetchPage(http, {
        path: PLANDAY_PATHS.shifts,
        query: { from: page.from, to: page.to },
        offset: page.offset ?? 0,
        limit: page.limit ?? PAGE_LIMITS.shifts,
        itemSchema: shiftSchema,
        map: (raw) => mapShift(raw, zone, template),
      });
    },

    getShift(shiftId, options) {
      const path = PLANDAY_PATHS.shiftById(shiftId);
      return getById(path, shiftSchema, (data) =>
        mapShift(data, zoneOf(options), pathTemplate(path)),
      );
    },

    listDeletedShifts(page) {
      return fetchPage(http, {
        path: PLANDAY_PATHS.deletedShifts,
        query: { deletedFrom: formatPlandayUtcDateTime(page.deletedFrom) },
        offset: page.offset ?? 0,
        limit: page.limit ?? PAGE_LIMITS.deletedShifts,
        itemSchema: deletedShiftSchema,
        map: mapDeletedShift,
      });
    },

    listScheduleDays(page) {
      return fetchPage(http, {
        path: PLANDAY_PATHS.scheduleDay,
        query: { departmentId: page.departmentId, from: page.from, to: page.to },
        offset: page.offset ?? 0,
        limit: page.limit ?? PAGE_LIMITS.scheduleDay,
        itemSchema: scheduleDaySchema,
        map: mapScheduleDay,
      });
    },

    listPunchClockShifts(page) {
      return fetchPage(http, {
        path: PLANDAY_PATHS.punchClockShifts,
        query: {
          from: formatPlandayWallClock(page.from, page.portalZone),
          to: formatPlandayWallClock(page.to, page.portalZone),
        },
        offset: page.offset ?? 0,
        limit: page.limit ?? PAGE_LIMITS.punchClock,
        itemSchema: punchClockShiftSchema,
        map: mapPunchClockShift,
      });
    },

    async listPunchClockBreaks(punchClockShiftId) {
      const parsed = await http.getParsed(
        PLANDAY_PATHS.punchClockBreaks(punchClockShiftId),
        undefined,
        pagedResponseSchema(punchClockBreakSchema),
      );
      return parsed.data.map(mapPunchClockBreak);
    },

    async probeScopes(probe) {
      const zone = probe.portalZone;
      const checks: Array<[PlandayScope, () => Promise<unknown>]> = [
        ["department:read", () => client.listDepartments({ limit: 1 })],
        ["employeegroup:read", () => client.listEmployeeGroups({ limit: 1 })],
        ["employee:read", () => client.listEmployees({ limit: 1, portalZone: zone })],
        [
          "shift:read",
          () =>
            client.listShifts({ from: probe.today, to: probe.today, limit: 1, portalZone: zone }),
        ],
      ];
      if (probe.clockMode) {
        const to = now();
        const from = new Date(to.getTime() - 3_600_000);
        checks.push([
          "punchclockshift:read",
          () => client.listPunchClockShifts({ from, to, limit: 1, portalZone: zone ?? "UTC" }),
        ]);
      }
      const granted: PlandayScope[] = [];
      const missing: string[] = [];
      for (const [scope, check] of checks) {
        try {
          await check();
          granted.push(scope);
        } catch (err) {
          if (err instanceof PlandayError && err.code === "PLANDAY_SCOPE_MISSING") {
            missing.push(scope);
            continue;
          }
          throw err;
        }
      }
      if (missing.length > 0) {
        throw new PlandayError("PLANDAY_SCOPE_MISSING", { missingScopes: missing });
      }
      // Every required scope was probed above; the order follows requiredScopes().
      const required = requiredScopes({ clockMode: probe.clockMode });
      return { grantedScopes: required.filter((scope) => granted.includes(scope)) };
    },

    requestCount: () => http.requestCount(),
  };
  return client;
}

/**
 * A credential store that keeps everything in memory: the connect proof (§4.3, §5.6), where the tokens from the
 * first exchange must not be persisted until the portal has answered with valid data, and tests. It honours the
 * `CredentialStore` contract (minimum validity, forced refresh, rejected-token hash) without a lease.
 */
export interface InMemoryCredentialStore extends CredentialStore {
  /** The credentials now held (after any refresh); what the connect transaction persists. */
  current(): StoredCredentials;
}

export function createInMemoryCredentialStore(
  initial: StoredCredentials,
  now: () => Date = () => new Date(),
): InMemoryCredentialStore {
  let state = initial;
  let version = 0;
  return {
    current: () => state,
    read: async () => state,
    knownVersion: () => version,
    async refreshAtomically(exchange, options) {
      const current = state;
      const rejected =
        options.rejectAccessTokenHash !== undefined &&
        current.accessToken !== null &&
        accessTokenHash(current.accessToken) === options.rejectAccessTokenHash;
      if (
        !options.force &&
        !rejected &&
        storedTokenIsValid(current, now().getTime(), options.minValidityMs)
      ) {
        return current;
      }
      const next = await exchange(current);
      state = next;
      version++;
      return next;
    },
  };
}
