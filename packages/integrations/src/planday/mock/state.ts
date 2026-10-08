/**
 * Mutable state of one Mock Planday: the portals' data, the API apps and their grants, issued tokens and codes,
 * queued faults and behaviour switches, and the mock clock. `reset()` restores the fixture in place, so the
 * `state` object a test holds stays valid.
 */
import { randomBytes } from "node:crypto";
import type { MockDateTimeFormat } from "./datetime";
import type {
  MockAppFixture,
  MockDeletedShiftFixture,
  MockEmployeeFixture,
  MockPunchClockBreakFixture,
  MockPunchClockFixture,
  MockShiftFixture,
  PlandayFixture,
} from "./fixture";
import { MOCK_READ_SCOPES } from "./fixture";
import type { PlandayJsonDepartment, PlandayJsonEmployeeGroup, PlandayJsonPortalInfo } from "./raw";

/** Access tokens live one hour on the mock clock (notes §3.5). */
export const MOCK_ACCESS_TOKEN_TTL_S = 3600;
/** Authorization codes are single-use and expire after five minutes on the mock clock. */
export const MOCK_AUTHORIZATION_CODE_TTL_MS = 5 * 60_000;

export interface MockPortalState {
  info: PlandayJsonPortalInfo;
  departments: PlandayJsonDepartment[];
  employeeGroups: PlandayJsonEmployeeGroup[];
  employees: Map<number, MockEmployeeFixture>;
  shifts: Map<number, MockShiftFixture>;
  deletedShifts: Map<number, MockDeletedShiftFixture>;
  /** `${departmentId}|${date}` of days with `isVisible: false`. */
  hiddenDays: Set<string>;
  punchClockShifts: Map<number, MockPunchClockFixture>;
  punchClockBreaks: MockPunchClockBreakFixture[];
}

export interface MockApp {
  appId: string;
  kind: "CUSTOMER" | "PARTNER";
  /** Home portal of a customer app (method C); null for ClockOff's App IDs (methods A and B). */
  portalId: number | null;
  /** Scopes ticked when the app was created; `setScopes` changes them (checked on every request). */
  scopes: string[];
}

/** One authorisation of an app on a portal: the Token column of the API Access page (notes §3.2). */
export interface MockGrant {
  id: string;
  appId: string;
  portalId: number;
  refreshToken: string;
  /** Refresh tokens replaced by rotation; using one answers `invalid_grant`. */
  retiredRefreshTokens: string[];
  revoked: boolean;
  /** Revoked, but the access tokens it issued keep working (the notes §12 Q5 variant). */
  keepAccessTokens: boolean;
}

export interface MockAccessToken {
  token: string;
  grantId: string;
  appId: string;
  portalId: number;
  expiresAtMs: number;
  revoked: boolean;
}

export interface MockAuthorizationCode {
  code: string;
  appId: string;
  portalId: number;
  redirectUri: string;
  scopes: string[];
  codeChallenge: string | null;
  codeChallengeMethod: "S256" | "plain" | null;
  expiresAtMs: number;
  used: boolean;
}

/** A fault queued by a control; it answers the next `remaining` matching requests. */
export type MockFault =
  | {
      kind: "RATE_LIMIT";
      path: string | null;
      remaining: number;
      retryAfterSeconds: number | null;
      resetSeconds: number | null;
    }
  | {
      kind: "ERROR";
      path: string | null;
      remaining: number;
      status: number;
      body: unknown;
    }
  | {
      kind: "MALFORMED";
      path: string | null;
      remaining: number;
      mode: MockMalformedMode;
      field: string | null;
    };

/**
 * How `queueMalformed` breaks a 2xx body: drop a required field (default `id` of the first record, `data`
 * itself for an empty list, `access_token` on the token endpoint), replace the first record's id with an
 * integer beyond `Number.MAX_SAFE_INTEGER`, or answer a body that is not JSON.
 */
export type MockMalformedMode = "missing-field" | "unsafe-id" | "not-json";

export interface MockSettings {
  dateTimeFormat: MockDateTimeFormat;
  /** Server-lowered page size (`capPageSize`). */
  pageSizeCap: number | null;
  pagingNull: boolean;
  rotateRefreshTokens: boolean;
  revocationKillsAccessTokens: boolean;
  /** Longest `/shifts` `from`–`to` range in days before a 400 (unknown in reality, notes §12 Q37). */
  maxShiftRangeDays: number | null;
  /** Overrides the `x-ratelimit-remaining` / `x-ratelimit-reset` values of ordinary API answers. */
  rateLimitHeaders: { remaining: number; resetSeconds: number } | null;
  /** Delay before answering (abortable through the request's signal). */
  latency: { ms: number; path: string | null } | null;
}

function defaultSettings(): MockSettings {
  return {
    dateTimeFormat: "local",
    pageSizeCap: null,
    pagingNull: false,
    rotateRefreshTokens: false,
    revocationKillsAccessTokens: true,
    maxShiftRangeDays: null,
    rateLimitHeaders: null,
    latency: null,
  };
}

/** Random url-safe token material. */
export function randomToken(prefix: string, bytes = 24): string {
  return `${prefix}${randomBytes(bytes).toString("base64url")}`;
}

export interface MockPlandayStateOptions {
  fixture: PlandayFixture;
  /** Base clock; the mock clock is this plus `advanceClock` offsets. */
  now: () => number;
  /** ClockOff's App IDs (PLANDAY_CLIENT_ID for method A, PLANDAY_APP_ID for method B). */
  partnerAppIds: readonly string[];
  /** Portal the authorize endpoint and `issueTokenForApp` pick when none is named. */
  defaultPortalId: number;
  /** Registered Redirection URLs of the partner apps; null accepts any http(s) URL (exchange still matches exactly). */
  redirectUris: readonly string[] | null;
}

export class MockPlandayState {
  readonly portals = new Map<number, MockPortalState>();
  readonly apps = new Map<string, MockApp>();
  readonly grants = new Map<string, MockGrant>();
  readonly accessTokens = new Map<string, MockAccessToken>();
  readonly authorizationCodes = new Map<string, MockAuthorizationCode>();
  readonly faults: MockFault[] = [];
  /** Request instants per portal over the last minute (for the `x-ratelimit-*` headers). */
  readonly requestWindow = new Map<number, number[]>();
  settings: MockSettings = defaultSettings();
  clockOffsetMs = 0;
  readonly partnerAppIds: readonly string[];
  readonly defaultPortalId: number;
  readonly redirectUris: readonly string[] | null;
  private readonly baseNow: () => number;
  private fixture: PlandayFixture;

  constructor(options: MockPlandayStateOptions) {
    this.fixture = options.fixture;
    this.baseNow = options.now;
    this.partnerAppIds = [...options.partnerAppIds];
    this.defaultPortalId = options.defaultPortalId;
    this.redirectUris = options.redirectUris ? [...options.redirectUris] : null;
    this.reset();
  }

  /** The mock clock (epoch ms). */
  now(): number {
    return this.baseNow() + this.clockOffsetMs;
  }

  /** The fixture the state was built from (a copy; the live data is in `portals`). */
  get initialFixture(): PlandayFixture {
    return structuredClone(this.fixture);
  }

  /** Restores the fixture, apps, grants, settings and clock offset in place. */
  reset(): void {
    const fixture = structuredClone(this.fixture);
    this.portals.clear();
    for (const portal of fixture.portals) {
      this.portals.set(portal.info.id, {
        info: portal.info,
        departments: portal.departments,
        employeeGroups: portal.employeeGroups,
        employees: new Map(portal.employees.map((e) => [e.raw.id, e])),
        shifts: new Map(portal.shifts.map((s) => [s.id, s])),
        deletedShifts: new Map(portal.deletedShifts.map((s) => [s.id, s])),
        hiddenDays: new Set(portal.hiddenDays.map((d) => `${d.departmentId}|${d.date}`)),
        punchClockShifts: new Map(portal.punchClockShifts.map((p) => [p.id, p])),
        punchClockBreaks: portal.punchClockBreaks,
      });
    }
    this.apps.clear();
    this.grants.clear();
    this.accessTokens.clear();
    this.authorizationCodes.clear();
    this.faults.length = 0;
    this.requestWindow.clear();
    this.settings = defaultSettings();
    this.clockOffsetMs = 0;
    for (const app of fixture.apps) this.addApp(app);
    for (const appId of this.partnerAppIds) {
      if (!this.apps.has(appId)) {
        this.addApp({
          appId,
          kind: "PARTNER",
          portalId: null,
          scopes: [...MOCK_READ_SCOPES],
          refreshToken: null,
        });
      }
    }
  }

  private addApp(app: MockAppFixture): void {
    this.apps.set(app.appId, {
      appId: app.appId,
      kind: app.kind,
      portalId: app.portalId,
      scopes: [...app.scopes],
    });
    if (app.portalId !== null && app.refreshToken) {
      this.createGrant(app.appId, app.portalId, app.refreshToken);
    }
  }

  /** The portal, or throws (controls name portals explicitly). */
  portal(portalId: number): MockPortalState {
    const portal = this.portals.get(portalId);
    if (!portal) throw new MockControlError(`Mock Planday has no portal ${portalId}`);
    return portal;
  }

  app(appId: string): MockApp {
    const app = this.apps.get(appId);
    if (!app) throw new MockControlError(`Mock Planday knows no app ${appId}`);
    return app;
  }

  /** A new grant (the admin authorised `appId` on `portalId`); returns it. */
  createGrant(appId: string, portalId: number, refreshToken = randomToken("mock-rt-")): MockGrant {
    this.portal(portalId);
    const grant: MockGrant = {
      id: randomToken("grant-", 9),
      appId,
      portalId,
      refreshToken,
      retiredRefreshTokens: [],
      revoked: false,
      keepAccessTokens: false,
    };
    this.grants.set(grant.id, grant);
    return grant;
  }

  /** The grant whose current or retired refresh token is `token`. */
  grantByRefreshToken(token: string): { grant: MockGrant; retired: boolean } | null {
    for (const grant of this.grants.values()) {
      if (grant.refreshToken === token) return { grant, retired: false };
      if (grant.retiredRefreshTokens.includes(token)) return { grant, retired: true };
    }
    return null;
  }

  issueAccessToken(grant: MockGrant): MockAccessToken {
    const token: MockAccessToken = {
      token: randomToken("mock-at-", 32),
      grantId: grant.id,
      appId: grant.appId,
      portalId: grant.portalId,
      expiresAtMs: this.now() + MOCK_ACCESS_TOKEN_TTL_S * 1000,
      revoked: false,
    };
    this.accessTokens.set(token.token, token);
    return token;
  }

  /** Ends every access token a grant issued. */
  revokeAccessTokensOf(grantId: string): void {
    for (const token of this.accessTokens.values()) {
      if (token.grantId === grantId) token.revoked = true;
    }
  }
}

/** A control called with arguments the mock cannot honour (unknown shift, employee, portal, app…). */
export class MockControlError extends Error {
  override readonly name = "MockControlError";
}
