import { sseEventSchema } from "@workmode/validation/realtime";
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { GET as streamRoute } from "@/app/api/realtime/stream/route";
import { env } from "@/lib/env";
import { recordActivity } from "@/server/activity/recordActivity";
import { getEventBus, publishEvent } from "@/server/events";
import { isOrganisationBridged } from "@/server/realtime/pushBridge";
import { createTestDevice, createTestOrg, loginAs, type CookieJar } from "../helpers";

function streamRequest(jar: CookieJar | null, signal: AbortSignal, query = ""): NextRequest {
  const headers: Record<string, string> = {};
  const cookie = jar?.header();
  if (cookie) headers.cookie = cookie;
  return new NextRequest(new URL(`/api/realtime/stream${query}`, env().APP_URL), { headers, signal });
}

/** Read decoded chunks until `predicate` matches the accumulated text (or time runs out). */
async function readUntil(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  predicate: (text: string) => boolean,
  timeoutMs = 5_000,
): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  const deadline = Date.now() + timeoutMs;
  while (!predicate(text)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`timed out waiting for SSE frame; got: ${JSON.stringify(text)}`);
    const next = await Promise.race([
      reader.read(),
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("read timed out")), remaining)),
    ]);
    if (next.done) break;
    text += decoder.decode(next.value, { stream: true });
  }
  return text;
}

/** Parses the `data:` lines of every complete frame in `text`. */
function frames(text: string): Array<{ event: string; data: unknown }> {
  return text
    .split("\n\n")
    .filter((block) => block.includes("event:"))
    .map((block) => {
      const event = /^event: (.+)$/m.exec(block)?.[1] ?? "";
      const data = /^data: (.+)$/m.exec(block)?.[1];
      return { event, data: data ? JSON.parse(data) : null };
    });
}

describe("GET /api/realtime/stream", () => {
  it("streams the organisation's events as SSE frames, bridges the organisation, and closes on abort", async () => {
    const org = await createTestOrg();
    const other = await createTestOrg();
    const { employee, device } = await createTestDevice(org.organisation.id);
    const jar = await loginAs(org.owner, { organisationId: org.organisation.id });
    const controller = new AbortController();

    const response = await streamRoute(streamRequest(jar, controller.signal), { params: Promise.resolve({}) });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.headers.get("cache-control")).toContain("no-cache");
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    expect(isOrganisationBridged(org.organisation.id)).toBe(true);
    expect(getEventBus().subscriberCount(org.organisation.id)).toBeGreaterThanOrEqual(1);

    const reader = response.body!.getReader();
    const hello = await readUntil(reader, (t) => t.includes("retry: 5000"));
    expect(hello).toContain("retry: 5000");

    // Another tenant's event must never reach this stream; ours must.
    publishEvent({ type: "shift.changed", organisationId: other.organisation.id, payload: { shiftIds: ["x"] } });
    const { event } = await recordActivity({
      organisationId: org.organisation.id,
      employeeId: employee.id,
      deviceId: device.id,
      actorType: "EMPLOYEE_DEVICE",
      type: "WORK_MODE_STARTED",
      metadata: { shiftId: "s-1" },
    });
    const text = await readUntil(reader, (t) => t.includes("event: activity.recorded"));
    const received = frames(text);
    expect(received.map((f) => f.event)).toEqual(["activity.recorded"]);
    const parsed = sseEventSchema.parse(received[0]!.data);
    expect(parsed.organisationId).toBe(org.organisation.id);
    expect(parsed.employeeId).toBe(employee.id);
    expect(parsed.payload).toMatchObject({ eventId: event.id, eventType: "WORK_MODE_STARTED" });
    expect(text).toMatch(/\nid: 1\n/);

    controller.abort();
    expect((await reader.read()).done).toBe(true);
  });

  it("narrows to one employee when ?employeeId is given and still passes organisation-level events", async () => {
    const org = await createTestOrg();
    const a = await createTestDevice(org.organisation.id);
    const b = await createTestDevice(org.organisation.id);
    const jar = await loginAs(org.owner, { organisationId: org.organisation.id });
    const controller = new AbortController();
    const response = await streamRoute(
      streamRequest(jar, controller.signal, `?employeeId=${a.employee.id}`),
      { params: Promise.resolve({}) },
    );
    const reader = response.body!.getReader();
    await readUntil(reader, (t) => t.includes("retry: 5000"));

    publishEvent({ type: "employee.work_state.changed", organisationId: org.organisation.id, employeeId: b.employee.id, payload: { state: "WORKING" } });
    publishEvent({ type: "employee.work_state.changed", organisationId: org.organisation.id, employeeId: a.employee.id, payload: { state: "ON_BREAK" } });
    publishEvent({ type: "import.completed", organisationId: org.organisation.id, payload: { importId: "i-1" } });
    const text = await readUntil(reader, (t) => t.includes("event: import.completed"));
    const received = frames(text);
    expect(received.map((f) => f.event)).toEqual(["employee.work_state.changed", "import.completed"]);
    expect((received[0]!.data as { employeeId: string }).employeeId).toBe(a.employee.id);
    controller.abort();
  });

  it("requires a signed-in manager", async () => {
    const controller = new AbortController();
    const response = await streamRoute(streamRequest(null, controller.signal), { params: Promise.resolve({}) });
    expect(response.status).toBe(401);
    controller.abort();
  });
});
