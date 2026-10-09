import { randomUUID } from "node:crypto";
import { prisma, Prisma } from "@clockoff/db";
import {
  isCredentialsWipedError,
  isLeaseLostError,
} from "@clockoff/shared/providers/workforceProvider";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createPrismaCredentialStore,
  decryptCredentialColumns,
  setCredentialStoreFaultsForTesting,
} from "@/server/integrations/credentials";
import { acquireLease, releaseLease } from "@/server/integrations/runs/runs.repository";
import {
  completeOnboarding,
  connectionOf,
  connectViaMethod,
  createPlandayOrg,
  driveRunToCompletion,
  enqueue,
  installPlanday,
  PORTAL,
  runKind,
  runSync,
  uninstallPlanday,
  type PlandayOrg,
  type PlandayTestContext,
} from "./plandayHarness";

/**
 * Tokens (docs/integrations/PLANDAY_IMPLEMENTATION_PLAN.md §4.3, §13.2 `tokenRefresh.test.ts`): proactive refresh 5
 * minutes before expiry, the forced refresh at every SYNC's PORTAL_CHECK, rotation persisted in the same UPDATE as the
 * access token, and the five persistence cases with injected store faults, asserted on the real final states.
 */

let t: PlandayTestContext;
let org: PlandayOrg;

const MINUTE = 60_000;

beforeEach(async () => {
  t = installPlanday();
  org = await createPlandayOrg();
  await connectViaMethod(org);
});

afterEach(() => {
  setCredentialStoreFaultsForTesting(null);
  expect(t.mock.unexpectedRequests).toEqual([]);
  uninstallPlanday();
});

const tokenRequests = () =>
  t.mock.requestLog.filter((e) => e.host === "id.planday.com" && e.path === "/connect/token");
const apiRequests = () => t.mock.requestLog.filter((e) => e.host === "openapi.planday.com");

async function stored() {
  const row = await connectionOf(org);
  return {
    row,
    credentials: decryptCredentialColumns(org.integrationId, {
      encryptedClientId: row.encryptedClientId!,
      encryptedRefreshToken: row.encryptedRefreshToken!,
      encryptedAccessToken: row.encryptedAccessToken,
      accessTokenExpiresAt: row.accessTokenExpiresAt,
    }),
  };
}

function transientDatabaseError(): Error {
  return new Prisma.PrismaClientKnownRequestError("Can't reach database server", {
    code: "P1001",
    clientVersion: "test",
  });
}

describe("when tokens are refreshed (§4.3)", () => {
  it("refreshes 5 minutes before expiry, not earlier, outside SYNC runs", async () => {
    await runKind(org, "STRUCTURE", "INITIAL"); // uses the token the connect proof stored
    const afterFirst = tokenRequests().length;
    t.advance(50 * MINUTE); // 10 minutes of validity left
    await runKind(org, "STRUCTURE", "INITIAL");
    expect(tokenRequests().length).toBe(afterFirst);
    t.advance(6 * MINUTE); // 4 minutes left
    await runKind(org, "STRUCTURE", "INITIAL");
    expect(tokenRequests().length).toBe(afterFirst + 1);
  });

  it("forces a refresh at every SYNC's PORTAL_CHECK, even with a valid token", async () => {
    await completeOnboarding(org);
    const before = tokenRequests().length;
    await runSync(org);
    await runSync(org);
    expect(tokenRequests().length).toBe(before + 2);
  });

  it("answers an API 401 with exactly one forced refresh and one retry", async () => {
    await runKind(org, "STRUCTURE", "INITIAL");
    const before = tokenRequests().length;
    t.mock.controls.expireAccessTokens();
    const { run } = await runKind(org, "STRUCTURE", "INITIAL");
    expect(run.status).toBe("SUCCEEDED");
    expect(tokenRequests().length).toBe(before + 1);
    expect(apiRequests().filter((e) => e.status === 401)).toHaveLength(1);
  });

  it("persists a rotated refresh token in the same UPDATE as the access token", async () => {
    await completeOnboarding(org);
    t.mock.controls.setRotateRefreshTokens(true);
    const before = await stored();
    await runSync(org);
    const after = await stored();
    expect(after.credentials.refreshToken).not.toBe(before.credentials.refreshToken);
    expect(after.credentials.accessToken).not.toBe(before.credentials.accessToken);
    expect(after.row.credentialHint).toBe(after.credentials.refreshToken.slice(-4));
    expect(after.row.refreshTokenRotatedAt).not.toBeNull();
    expect(after.row.credentialVersion).toBe(before.row.credentialVersion + 1);
    // The old refresh token is dead at Planday: the next SYNC must use the new one, and does.
    const { run } = await runSync(org);
    expect(run.status).toBe("SUCCEEDED");
  });
});

describe("persistence failures (§4.3 failure path)", () => {
  beforeEach(async () => {
    await completeOnboarding(org);
  });

  it("(1) one transient P1001, then success: the rotated token is persisted after one token request", async () => {
    t.mock.controls.setRotateRefreshTokens(true);
    let attempts = 0;
    setCredentialStoreFaultsForTesting({
      beforePersist: (attempt) => {
        attempts += 1;
        if (attempt === 1) throw transientDatabaseError();
      },
    });
    const before = tokenRequests().length;
    const { run } = await runSync(org);
    expect(run.status).toBe("SUCCEEDED");
    expect(tokenRequests().length).toBe(before + 1);
    expect(attempts).toBe(2);
    const after = await stored();
    expect(t.mock.state.grants.size).toBeGreaterThan(0);
    // The rotated token works: a further forced refresh succeeds.
    setCredentialStoreFaultsForTesting(null);
    expect((await runSync(org)).run.status).toBe("SUCCEEDED");
    expect(after.row.credentialHint).toBe(after.credentials.refreshToken.slice(-4));
  });

  it("(2) every attempt fails with a rotating mock: the unpersisted token is never used; AUTH_ERROR follows", async () => {
    t.mock.controls.setRotateRefreshTokens(true);
    setCredentialStoreFaultsForTesting({
      beforePersist: () => {
        throw transientDatabaseError();
      },
    });
    const before = await stored();
    const apiBefore = apiRequests().length;
    const issuedBefore = new Set(t.mock.state.accessTokens.keys());
    const queued = await enqueue(org, "SYNC", "MANUAL");
    const runId = queued.outcome === "QUEUED" ? queued.run.id : "";
    const first = await driveRunToCompletion(runId, { maxSlices: 1 });
    expect(first.outcomes[0]).toMatchObject({ state: "PARKED", reason: "RETRY_BACKOFF" });
    const parked = await stored();
    expect(Buffer.from(parked.row.encryptedRefreshToken!)).toEqual(
      Buffer.from(before.row.encryptedRefreshToken!),
    );
    expect(Buffer.from(parked.row.encryptedAccessToken!)).toEqual(
      Buffer.from(before.row.encryptedAccessToken!),
    );
    expect(parked.row.credentialVersion).toBe(before.row.credentialVersion);
    // The token Planday issued in that refresh never reached an API request.
    const unpersisted = [...t.mock.state.accessTokens.keys()].filter(
      (token) => !issuedBefore.has(token),
    );
    expect(unpersisted.length).toBeGreaterThan(0);
    expect(apiRequests().some((e) => e.accessToken && unpersisted.includes(e.accessToken))).toBe(
      false,
    );

    const { run } = await driveRunToCompletion(runId);
    expect(run.status).toBe("FAILED");
    expect(run.errorCode).toBe("PLANDAY_AUTH_FAILED");
    expect((await connectionOf(org)).status).toBe("AUTH_ERROR");
    expect(apiRequests().length).toBe(apiBefore);
  });

  it("(3) every attempt fails with a non-rotating mock: parked, then FAILED CREDENTIAL_PERSIST_FAILED; still CONNECTED", async () => {
    setCredentialStoreFaultsForTesting({
      beforePersist: () => {
        throw transientDatabaseError();
      },
    });
    const queued = await enqueue(org, "SYNC", "MANUAL");
    const runId = queued.outcome === "QUEUED" ? queued.run.id : "";
    const { run, outcomes } = await driveRunToCompletion(runId);
    expect(outcomes.slice(0, 2).map((o) => o.state)).toEqual(["PARKED", "PARKED"]);
    expect(run.status).toBe("FAILED");
    expect(run.errorCode).toBe("CREDENTIAL_PERSIST_FAILED");
    const connection = await connectionOf(org);
    expect(connection.status).toBe("CONNECTED");
    expect(connection.consecutiveFailureCount).toBe(1);
    expect(connection.lastErrorCode).toBe("CREDENTIAL_PERSIST_FAILED");
    expect(connection.nextSyncAt).not.toBeNull();
  });

  it("(4) a holder without the lease cannot refresh, and nothing is written", async () => {
    const before = await stored();
    const owner = randomUUID();
    await acquireLease(org.integrationId, owner);
    const intruder = createPrismaCredentialStore({
      integrationId: org.integrationId,
      holder: randomUUID(),
      now: t.now,
    });
    const err = await intruder
      .refreshAtomically(async (current) => ({ ...current, accessToken: "x" }), {
        minValidityMs: 0,
        force: true,
      })
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(isLeaseLostError(err)).toBe(true);
    const after = await stored();
    expect(after.row.credentialVersion).toBe(before.row.credentialVersion);
    expect(after.credentials).toEqual(before.credentials);

    // The lease taken over between the read and the write: the exchange ran, the UPDATE refuses.
    const store = createPrismaCredentialStore({
      integrationId: org.integrationId,
      holder: owner,
      now: t.now,
    });
    const err2 = await store
      .refreshAtomically(
        async (current) => {
          await prisma.integrationConnection.update({
            where: { integrationId: org.integrationId },
            data: { syncLeaseId: randomUUID() },
          });
          return { ...current, accessToken: "never-stored" };
        },
        { minValidityMs: 0, force: true },
      )
      .then(
        () => null,
        (e: unknown) => e,
      );
    expect(isLeaseLostError(err2)).toBe(true);
    expect((await stored()).credentials.accessToken).toBe(before.credentials.accessToken);
  });

  it("(5) credentials wiped: the store refuses and the run stops; the connection stays DISCONNECTED", async () => {
    const queued = await enqueue(org, "SYNC", "MANUAL");
    const runId = queued.outcome === "QUEUED" ? queued.run.id : "";
    await prisma.integrationConnection.update({
      where: { integrationId: org.integrationId },
      data: {
        status: "DISCONNECTED",
        encryptedClientId: null,
        encryptedRefreshToken: null,
        encryptedAccessToken: null,
        credentialVersion: { increment: 1 },
      },
    });
    const holder = randomUUID();
    await acquireLease(org.integrationId, holder);
    const store = createPrismaCredentialStore({
      integrationId: org.integrationId,
      holder,
      now: t.now,
    });
    const err = await store.read().then(
      () => null,
      (e: unknown) => e,
    );
    expect(isCredentialsWipedError(err)).toBe(true);
    await releaseLease(org.integrationId, holder);
    const { run } = await driveRunToCompletion(runId);
    expect(run.status).toBe("FAILED");
    expect(run.errorCode).toBe("DISCONNECTED");
    const connection = await connectionOf(org);
    expect(connection.status).toBe("DISCONNECTED");
    expect(connection.consecutiveFailureCount).toBe(0);
  });
});

describe("one refresh per integration in flight (§4.3)", () => {
  it("concurrent callers under one lease share one token request", async () => {
    const holder = randomUUID();
    await acquireLease(org.integrationId, holder);
    const store = createPrismaCredentialStore({
      integrationId: org.integrationId,
      holder,
      now: t.now,
    });
    const ctx = {
      organisationId: org.organisationId,
      integrationId: org.integrationId,
      settings: { portalId: PORTAL, portalTimezone: "Europe/London" },
      now: t.now(),
      credentialStore: store,
    };
    const before = tokenRequests().length;
    await Promise.all([
      t.provider.refreshAuthentication(ctx),
      t.provider.refreshAuthentication(ctx),
      t.provider.refreshAuthentication(ctx),
    ]);
    expect(tokenRequests().length).toBe(before + 1);
    await releaseLease(org.integrationId, holder);
  });
});

describe("auth failures and retryAuth (§7.2, §7.10, §8.1)", () => {
  it("a transient token-endpoint 400 moves the connection to AUTH_ERROR; a retryAuth run passing PORTAL_CHECK returns it to CONNECTED", async () => {
    await completeOnboarding(org);
    t.mock.controls.queueError({
      path: "/connect/token",
      count: 1,
      status: 400,
      body: { error: "invalid_grant" },
    });
    const failed = await runSync(org);
    expect(failed.run.status).toBe("FAILED");
    expect(failed.run.errorCode).toBe("PLANDAY_AUTH_FAILED");
    const broken = await connectionOf(org);
    expect(broken.status).toBe("AUTH_ERROR");
    expect(broken.lastErrorCode).toBe("PLANDAY_AUTH_FAILED");
    expect(broken.authErrorNotifiedAt).not.toBeNull();
    expect(broken.nextSyncAt!.getTime()).toBeGreaterThan(t.now().getTime());
    expect(
      (await prisma.integration.findUniqueOrThrow({ where: { id: org.integrationId } })).status,
    ).toBe("ERROR");

    // An ordinary run never starts on AUTH_ERROR.
    const blocked = await runSync(org);
    expect(blocked.run.errorCode).toBe("AUTH_ERROR");

    const { run } = await runSync(org, { trigger: "RECOVERY", retryAuth: true });
    expect(run.status).toBe("SUCCEEDED");
    const recovered = await connectionOf(org);
    expect(recovered.status).toBe("CONNECTED");
    expect(recovered.authErrorNotifiedAt).toBeNull();
    expect(recovered.authProbeAttempts).toBe(0);
    expect(recovered.lastErrorCode).toBeNull();
    expect(
      (await prisma.integration.findUniqueOrThrow({ where: { id: org.integrationId } })).status,
    ).toBe("CONNECTED");
  });

  it("a portal mismatch fails the run and moves the connection to AUTH_ERROR", async () => {
    await completeOnboarding(org);
    await prisma.integrationConnection.update({
      where: { integrationId: org.integrationId },
      data: { externalPortalId: "4100002" },
    });
    const { run } = await runSync(org);
    expect(run.status).toBe("FAILED");
    expect(run.errorCode).toBe("INTEGRATION_PORTAL_MISMATCH");
    expect((await connectionOf(org)).status).toBe("AUTH_ERROR");
  });
});
