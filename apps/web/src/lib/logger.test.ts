import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { child, createLogger, errorSummary, stackFrames } from "./logger";

function capture() {
  const lines: Array<Record<string, unknown>> = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      for (const line of chunk.toString().split("\n").filter(Boolean)) lines.push(JSON.parse(line));
      cb();
    },
  });
  return { lines, logger: createLogger({ level: "info" }, stream) };
}

describe("logger", () => {
  it("redacts secrets and PII-ish fields at any depth and in headers", async () => {
    const { lines, logger } = capture();
    logger.info(
      {
        email: "a@b.c",
        password: "hunter2",
        user: { email: "x@y.z", token: "t", id: "u-1" },
        req: {
          headers: {
            authorization: "Bearer x",
            cookie: "wm_session=s",
            "set-cookie": "wm_session=s",
          },
        },
        deep: { nested: { refreshToken: "r" } },
        organisationId: "org-1",
      },
      "hello",
    );
    await new Promise((r) => setImmediate(r));
    const line = lines[0]!;
    expect(line.email).toBe("[REDACTED]");
    expect(line.password).toBe("[REDACTED]");
    expect(line.user).toEqual({ email: "[REDACTED]", token: "[REDACTED]", id: "u-1" });
    expect(line.req).toEqual({
      headers: { authorization: "[REDACTED]", cookie: "[REDACTED]", "set-cookie": "[REDACTED]" },
    });
    expect(line.deep).toEqual({ nested: { refreshToken: "[REDACTED]" } });
    expect(line.organisationId).toBe("org-1");
    expect(line.level).toBe("info");
  });

  it("child(logger, bindings) carries bindings", async () => {
    const { lines, logger } = capture();
    child(logger, { requestId: "req-1" }).info("x");
    await new Promise((r) => setImmediate(r));
    expect(lines[0]?.requestId).toBe("req-1");
  });

  it("errorSummary is stack-free and keeps the class in `type`", () => {
    const err = Object.assign(new TypeError("boom"), { code: "E_X" });
    expect(errorSummary(err)).toEqual({ type: "TypeError", message: "boom", code: "E_X" });
    expect(errorSummary("text")).toEqual({ type: "NonError", message: "text" });
  });

  it("keeps only the first line of a message, so data-bearing error bodies never reach the log", () => {
    // Shape of a PrismaClientValidationError: the failed invocation, argument values included.
    const prismaLike = Object.assign(
      new Error(
        '\nInvalid `prisma.user.findUnique()` invocation in\n/app/x.ts:10:3\n\n→ 10 prisma.user.findUnique({ where: { email: "alice@example.com" } })\nUnknown argument',
      ),
      { name: "PrismaClientValidationError" },
    );
    const summary = errorSummary(prismaLike);
    expect(summary).toEqual({
      type: "PrismaClientValidationError",
      message: "Invalid `prisma.user.findUnique()` invocation in",
    });
    expect(JSON.stringify(summary)).not.toContain("alice@example.com");
    expect(errorSummary(new Error("x".repeat(1000))).message.length).toBeLessThanOrEqual(301);
  });

  it("stackFrames drops the message text and keeps only call frames", () => {
    const err = new Error("secret value alice@example.com\nsecond line");
    const frames = stackFrames(err)!;
    expect(frames.length).toBeGreaterThan(0);
    expect(frames.every((f) => f.startsWith("at "))).toBe(true);
    expect(frames.join("\n")).not.toContain("alice@example.com");
    expect(stackFrames("not an error")).toBeUndefined();
  });
});
