import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetEnvCache } from "@/lib/env";
import { logger } from "@/lib/logger";
import { ConsoleEmailProvider, clearDevOutbox } from "@/server/email";
import { GET } from "./route";

async function get(query: string) {
  const req = new NextRequest(new URL(`/api/dev/last-email${query}`, "http://localhost:3000"));
  const res = await GET(req, { params: Promise.resolve({}) });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

beforeEach(async () => {
  vi.spyOn(logger, "info").mockImplementation(() => undefined);
  vi.stubEnv("DEV_TOOLS_ENABLED", "true");
  resetEnvCache();
  await new ConsoleEmailProvider({ recordOutbox: true }).send({
    to: "manager@x.test",
    subject: "Confirm your ClockOff email",
    text: "http://localhost:3000/verify-email?token=abc",
  });
});

afterEach(() => {
  clearDevOutbox();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  resetEnvCache();
});

describe("GET /api/dev/last-email", () => {
  it("returns the last message sent to the address", async () => {
    const { status, body } = await get("?to=Manager%40x.test");
    expect(status).toBe(200);
    expect(body.email).toMatchObject({
      to: "manager@x.test",
      subject: "Confirm your ClockOff email",
      text: "http://localhost:3000/verify-email?token=abc",
    });
  });

  it("404s for an address with no mail and validates the query", async () => {
    expect((await get("?to=nobody%40x.test")).status).toBe(404);
    expect((await get("")).status).toBe(400);
  });

  it("404s before reading the query when DEV_TOOLS_ENABLED is off", async () => {
    vi.stubEnv("DEV_TOOLS_ENABLED", "false");
    resetEnvCache();
    expect(await get("?to=manager%40x.test")).toMatchObject({
      status: 404,
      body: { error: { code: "NOT_FOUND" } },
    });
    expect((await get("")).status).toBe(404);
  });

  it("404s in production even if DEV_TOOLS_ENABLED is set", async () => {
    vi.stubEnv("NODE_ENV", "production");
    expect((await get("?to=manager%40x.test")).status).toBe(404);
  });
});
