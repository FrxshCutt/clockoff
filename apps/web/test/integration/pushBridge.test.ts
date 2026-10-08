import { randomUUID } from "node:crypto";
import { prisma } from "@clockoff/db";
import { afterEach, describe, expect, it } from "vitest";
import { encrypt } from "@/lib/crypto";
import {
  InProcessEventBus,
  getEventBus,
  publishEvent,
  setEventBusForTesting,
} from "@/server/events";
import type { AlertPushPayload, PushProvider, PushReport, SilentPushPayload } from "@/server/push";
import { setPushProviderForTesting } from "@/server/push";
import {
  disablePushBridge,
  enablePushBridge,
  flushPushBridge,
  isPushBridgeEnabled,
  pushBridgeDiagnostics,
  resetPushBridgeForTesting,
} from "@/server/realtime/pushBridge";
import { createTestDevice, createTestOrg } from "../helpers";

/**
 * The bus → silent push bridge, as the worker's push-bridge leader runs it (`enablePushBridge`: one
 * all-organisations subscription). The web process never enables it.
 */

/** Test-only push double: records what would have been sent. */
class MockPushProvider implements PushProvider {
  readonly name = "noop" as const;
  readonly silent: Array<{ tokens: string[]; payload: SilentPushPayload }> = [];
  async sendSilent(deviceTokens: string[], payload: SilentPushPayload): Promise<PushReport> {
    this.silent.push({ tokens: deviceTokens, payload });
    return {
      provider: "noop",
      requested: deviceTokens.length,
      sent: deviceTokens.length,
      failed: 0,
      invalidTokens: [],
      failures: [],
    };
  }
  async sendAlert(deviceTokens: string[], _payload: AlertPushPayload): Promise<PushReport> {
    return {
      provider: "noop",
      requested: deviceTokens.length,
      sent: 0,
      failed: 0,
      invalidTokens: [],
      failures: [],
    };
  }
}

afterEach(() => {
  resetPushBridgeForTesting();
  setPushProviderForTesting(undefined);
});

async function withToken(deviceId: string, token: string): Promise<void> {
  await prisma.device.update({
    where: { id: deviceId },
    data: {
      pushTokenEncrypted: new Uint8Array(
        encrypt(JSON.stringify({ token, environment: "sandbox" })),
      ),
    },
  });
}

/** An organisation with two phones that have push tokens. */
async function fixture() {
  const provider = new MockPushProvider();
  setPushProviderForTesting(provider);
  const org = await createTestOrg();
  const first = await createTestDevice(org.organisation.id);
  const second = await createTestDevice(org.organisation.id);
  const tokens = { first: "ab".repeat(32), second: "cd".repeat(32) };
  await withToken(first.device.id, tokens.first);
  await withToken(second.device.id, tokens.second);
  return { provider, org, first, second, tokens };
}

describe("push bridge", () => {
  it("sends one debounced silent push per affected device with the decrypted token", async () => {
    const { provider, org, first, tokens } = await fixture();
    enablePushBridge();
    expect(isPushBridgeEnabled()).toBe(true);

    publishEvent({
      type: "POLICY_CHANGED",
      organisationId: org.organisation.id,
      payload: {
        policyId: randomUUID(),
        reason: "PUBLISHED",
        affectedEmployeeIds: [first.employee.id],
      },
    });
    publishEvent({
      type: "SCHEDULE_CHANGED",
      organisationId: org.organisation.id,
      employeeId: first.employee.id,
      payload: { employeeId: first.employee.id, shiftIds: [randomUUID()], reason: "UPDATED" },
    });
    await flushPushBridge();
    expect(provider.silent).toHaveLength(1);
    expect(provider.silent[0]!.tokens).toEqual([tokens.first]);
    expect(provider.silent[0]!.payload.reason).toBe("policy_changed,schedule_changed");

    // Organisation-wide override → every device with a token.
    publishEvent({
      type: "OVERRIDE_CREATED",
      organisationId: org.organisation.id,
      payload: { overrideId: randomUUID(), type: "EMERGENCY_POLICY_OVERRIDE", employeeId: null },
    });
    await flushPushBridge();
    expect(provider.silent).toHaveLength(3);
    const sent = provider.silent
      .slice(1)
      .flatMap((s) => s.tokens)
      .sort();
    expect(sent).toEqual([tokens.first, tokens.second].sort());

    // Unrelated event kinds are ignored.
    publishEvent({ type: "activity.recorded", organisationId: org.organisation.id, payload: {} });
    await flushPushBridge();
    expect(provider.silent).toHaveLength(3);
    expect(pushBridgeDiagnostics()).toEqual({ enabled: true, pending: 0, delivered: 3 });
  });

  it("bridges every organisation through one subscription, including organisations it has never seen", async () => {
    const a = await fixture();
    const otherOrg = await createTestOrg();
    const other = await createTestDevice(otherOrg.organisation.id);
    const otherToken = "ef".repeat(32);
    await withToken(other.device.id, otherToken);
    enablePushBridge();

    publishEvent({
      type: "OVERRIDE_REVOKED",
      organisationId: otherOrg.organisation.id,
      employeeId: other.employee.id,
      payload: { overrideId: randomUUID(), type: "BREAK_EXTENSION", employeeId: other.employee.id },
    });
    await flushPushBridge();
    expect(a.provider.silent.map((s) => s.tokens)).toEqual([[otherToken]]);
  });

  it("sends nothing while disabled, and stops after disablePushBridge", async () => {
    const { provider, org, first } = await fixture();
    const policyChanged = () =>
      publishEvent({
        type: "POLICY_CHANGED",
        organisationId: org.organisation.id,
        payload: {
          policyId: null,
          reason: "DEFAULT_CHANGED",
          affectedEmployeeIds: [first.employee.id],
        },
      });

    expect(isPushBridgeEnabled()).toBe(false);
    policyChanged();
    await flushPushBridge();
    expect(provider.silent).toHaveLength(0);

    enablePushBridge();
    policyChanged();
    // Hand-over: the pending (debounced) push is delivered before disable resolves.
    await disablePushBridge({ flush: true });
    expect(provider.silent).toHaveLength(1);
    expect(isPushBridgeEnabled()).toBe(false);

    policyChanged();
    await flushPushBridge();
    expect(provider.silent).toHaveLength(1);
    expect(pushBridgeDiagnostics().enabled).toBe(false);
  });

  it("drops pending pushes on disablePushBridge({ flush: false })", async () => {
    const { provider, org } = await fixture();
    enablePushBridge();
    publishEvent({
      type: "BREAK_POLICY_CHANGED",
      organisationId: org.organisation.id,
      payload: { breakPolicyId: null, reason: "DEFAULT_CHANGED", affectedEmployeeIds: [] },
    });
    publishEvent({
      type: "OVERRIDE_EXPIRED",
      organisationId: org.organisation.id,
      payload: { overrideId: randomUUID(), type: "EMERGENCY_POLICY_OVERRIDE", employeeId: null },
    });
    // Let the device lookup queue the debounced pushes, then drop them.
    const deadline = Date.now() + 5_000;
    while (pushBridgeDiagnostics().pending < 2 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(pushBridgeDiagnostics().pending).toBe(2);
    await disablePushBridge({ flush: false });
    expect(pushBridgeDiagnostics().pending).toBe(0);
    await flushPushBridge();
    expect(provider.silent).toHaveLength(0);
  });

  it("sends nothing once stillLeader turns false (lease lost), even before the bridge is disabled", async () => {
    const { provider, org, first } = await fixture();
    let leader = true;
    enablePushBridge(getEventBus(), { stillLeader: () => leader });
    const scheduleChanged = () =>
      publishEvent({
        type: "SCHEDULE_CHANGED",
        organisationId: org.organisation.id,
        employeeId: first.employee.id,
        payload: { employeeId: first.employee.id, shiftIds: [randomUUID()], reason: "UPDATED" },
      });

    // Queued while leading, lease lost before the debounce fires: not sent.
    scheduleChanged();
    const deadline = Date.now() + 5_000;
    while (pushBridgeDiagnostics().pending < 1 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    leader = false;
    await flushPushBridge();
    expect(provider.silent).toHaveLength(0);

    // New events are not even looked up.
    scheduleChanged();
    await flushPushBridge();
    expect(provider.silent).toHaveLength(0);
    expect(pushBridgeDiagnostics().pending).toBe(0);
  });

  it("a device lookup still running at a flush:false disable queues nothing afterwards", async () => {
    const { provider, org } = await fixture();
    enablePushBridge();
    publishEvent({
      type: "OVERRIDE_EXPIRED",
      organisationId: org.organisation.id,
      payload: { overrideId: randomUUID(), type: "EMERGENCY_POLICY_OVERRIDE", employeeId: null },
    });
    // The lookup started synchronously and is still on its way to Postgres.
    await disablePushBridge({ flush: false });
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(pushBridgeDiagnostics().pending).toBe(0);
    await flushPushBridge();
    expect(provider.silent).toHaveLength(0);
  });

  it("treats a truncated POLICY_CHANGED (employee list lost in transit) as every device", async () => {
    const { provider, org, tokens } = await fixture();
    enablePushBridge();
    getEventBus().publish({
      type: "POLICY_CHANGED",
      organisationId: org.organisation.id,
      payload: { truncated: true },
      at: new Date().toISOString(),
    });
    await flushPushBridge();
    expect(provider.silent.flatMap((s) => s.tokens).sort()).toEqual(
      [tokens.first, tokens.second].sort(),
    );
  });

  it("subscribes once however often it is enabled (one push per device), and follows a new bus", async () => {
    const { provider, org, first, tokens } = await fixture();
    enablePushBridge();
    enablePushBridge();
    enablePushBridge(getEventBus());
    publishEvent({
      type: "SCHEDULE_CHANGED",
      organisationId: org.organisation.id,
      employeeId: first.employee.id,
      payload: { employeeId: first.employee.id, shiftIds: [randomUUID()], reason: "CREATED" },
    });
    await flushPushBridge();
    expect(provider.silent).toEqual([
      { tokens: [tokens.first], payload: expect.objectContaining({ reason: "schedule_changed" }) },
    ]);

    // Enabling on another bus moves the subscription: the old bus no longer reaches the bridge.
    const oldBus = getEventBus();
    const newBus = new InProcessEventBus();
    setEventBusForTesting(newBus);
    enablePushBridge(newBus);
    const scheduleChanged = {
      type: "SCHEDULE_CHANGED",
      organisationId: org.organisation.id,
      employeeId: first.employee.id,
      payload: { employeeId: first.employee.id, shiftIds: [randomUUID()], reason: "UPDATED" },
      at: new Date().toISOString(),
    };
    oldBus.publish(scheduleChanged);
    await flushPushBridge();
    expect(provider.silent).toHaveLength(1);
    newBus.publish(scheduleChanged);
    await flushPushBridge();
    expect(provider.silent).toHaveLength(2);
  });
});
