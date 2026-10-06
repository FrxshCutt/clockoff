import { AppError } from "@workmode/shared/errors";
import { describe, expect, it } from "vitest";
import { errorResponse, json, noContent, sseResponse } from "./responses";

describe("response helpers", () => {
  it("json(data, status) and json(data, init) with cookies", async () => {
    const a = json({ a: 1 }, 201);
    expect(a.status).toBe(201);
    expect(a.headers.get("content-type")).toContain("application/json");
    expect(a.headers.get("cache-control")).toBe("no-store");
    expect(await a.json()).toEqual({ a: 1 });
    const b = json({ ok: true }, { status: 202, headers: { "x-a": "1" }, cookies: ["c=1", "d=2"] });
    expect(b.status).toBe(202);
    expect(b.headers.get("x-a")).toBe("1");
    expect(b.headers.getSetCookie()).toEqual(["c=1", "d=2"]);
  });

  it("noContent is an empty 204", async () => {
    const res = noContent({ cookies: ["x=1"] });
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
    expect(res.headers.getSetCookie()).toEqual(["x=1"]);
  });

  it("errorResponse emits the envelope, status, request id and Retry-After", async () => {
    const res = errorResponse(
      new AppError("RATE_LIMITED", "slow down", { details: { retryAfterSeconds: 12 } }),
      "rid-12345678",
    );
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("12");
    expect(res.headers.get("x-request-id")).toBe("rid-12345678");
    expect(await res.json()).toEqual({
      error: { code: "RATE_LIMITED", message: "slow down", details: { retryAfterSeconds: 12 } },
    });
  });

  it("sseResponse sets streaming headers", () => {
    const res = sseResponse(new ReadableStream());
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    expect(res.headers.get("cache-control")).toContain("no-transform");
  });
});
