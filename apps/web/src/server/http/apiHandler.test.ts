import { Prisma } from "@clockoff/db";
import { AppError } from "@clockoff/shared/errors";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { env } from "@/lib/env";
import { MemoryRateLimiter, setRateLimiterForTesting } from "@/server/rateLimit";
import { createHandler, json, redactPathForLog, type RouteHandler } from "./apiHandler";

function request(
  path: string,
  init: { method?: string; body?: string; headers?: Record<string, string> } = {},
): NextRequest {
  return new NextRequest(new URL(path, "http://localhost:3000"), {
    method: init.method ?? "GET",
    headers: init.headers ?? {},
    ...(init.body !== undefined ? { body: init.body } : {}),
  });
}

async function call(handler: RouteHandler, req: NextRequest, params: Record<string, string> = {}) {
  const res = await handler(req, { params: Promise.resolve(params) });
  const text = await res.text();
  return { res, body: text ? (JSON.parse(text) as Record<string, unknown>) : null };
}

beforeEach(() => {
  setRateLimiterForTesting(new MemoryRateLimiter());
});

describe("createHandler", () => {
  const echo = createHandler(
    {
      auth: "public",
      params: z.object({ id: z.uuid() }),
      query: z.object({ limit: z.coerce.number().int().max(10).default(5) }),
      body: z.object({ name: z.string().min(1) }).strict(),
    },
    async ({ params, query, body, requestId }) => ({ params, query, body, requestId }),
  );
  const id = "7d1b5a8e-2f7c-4c35-9a53-2b8f6f0e4a11";

  it("parses params (Next 15 Promise), query and JSON body and echoes x-request-id", async () => {
    const { res, body } = await call(
      echo,
      request("/api/things?limit=3", {
        method: "POST",
        body: JSON.stringify({ name: "x" }),
        headers: { "content-type": "application/json", "x-request-id": "req-abcdef12" },
      }),
      { id },
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("x-request-id")).toBe("req-abcdef12");
    expect(body).toEqual({
      params: { id },
      query: { limit: 3 },
      body: { name: "x" },
      requestId: "req-abcdef12",
    });
  });

  it("returns VALIDATION_ERROR with flattened issues and the failing source", async () => {
    const { res, body } = await call(
      echo,
      request("/api/things", {
        method: "POST",
        body: JSON.stringify({ name: "", extra: 1 }),
        headers: { "content-type": "application/json" },
      }),
      { id },
    );
    expect(res.status).toBe(400);
    const error = body?.error as {
      code: string;
      details: { source: string; fieldErrors: Record<string, string[]>; formErrors: string[] };
    };
    expect(error.code).toBe("VALIDATION_ERROR");
    expect(error.details.source).toBe("body");
    expect(error.details.fieldErrors.name).toBeDefined();
    expect(error.details.formErrors.join(" ")).toMatch(/extra/);

    const badParams = await call(
      echo,
      request("/api/things", {
        method: "POST",
        body: "{}",
        headers: { "content-type": "application/json" },
      }),
      {
        id: "nope",
      },
    );
    expect((badParams.body?.error as { details: { source: string } }).details.source).toBe(
      "params",
    );
  });

  it("rejects non-JSON, malformed JSON and oversized bodies", async () => {
    const wrongType = await call(
      echo,
      request("/api/x", {
        method: "POST",
        body: "name=x",
        headers: { "content-type": "text/plain" },
      }),
      { id },
    );
    expect(wrongType.res.status).toBe(415);
    const malformed = await call(
      echo,
      request("/api/x", {
        method: "POST",
        body: "{",
        headers: { "content-type": "application/json" },
      }),
      { id },
    );
    expect((malformed.body?.error as { code: string }).code).toBe("VALIDATION_ERROR");

    const small = createHandler(
      { auth: "public", body: z.object({ s: z.string() }), maxBodyBytes: 16 },
      async () => ({ ok: true }),
    );
    const big = await call(
      small,
      request("/api/x", {
        method: "POST",
        body: JSON.stringify({ s: "x".repeat(100) }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(big.res.status).toBe(413);
    expect((big.body?.error as { code: string }).code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("maps AppError, Prisma and unknown errors to the envelope without leaking internals", async () => {
    const appErr = createHandler({ auth: "public" }, async () => {
      throw new AppError("SHIFT_OVERLAP", "Overlaps another shift", { details: { shiftId: "s1" } });
    });
    const a = await call(appErr, request("/api/x"));
    expect(a.res.status).toBe(409);
    expect(a.body).toEqual({
      error: {
        code: "SHIFT_OVERLAP",
        message: "Overlaps another shift",
        details: { shiftId: "s1" },
      },
    });

    const duckTyped = createHandler({ auth: "public" }, async () => {
      throw Object.assign(new Error("dup"), { name: "AppError", code: "CONFLICT", status: 409 });
    });
    expect((await call(duckTyped, request("/api/x"))).res.status).toBe(409);

    const unique = createHandler({ auth: "public" }, async () => {
      throw new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
        code: "P2002",
        clientVersion: "6.19.3",
      });
    });
    const u = await call(unique, request("/api/x"));
    expect(u.res.status).toBe(409);
    expect((u.body?.error as { code: string }).code).toBe("CONFLICT");

    const boom = createHandler({ auth: "public" }, async () => {
      throw new Error("db password is hunter2");
    });
    const b = await call(boom, request("/api/x", { headers: { "x-request-id": "req-boom-0001" } }));
    expect(b.res.status).toBe(500);
    expect(b.body).toEqual({
      error: {
        code: "INTERNAL_ERROR",
        message: "Something went wrong",
        details: { requestId: "req-boom-0001" },
      },
    });
    expect(JSON.stringify(b.body)).not.toContain("hunter2");
  });

  it("passes Responses through, turns undefined into 204, survives immutable headers", async () => {
    const passthrough = createHandler({ auth: "public" }, async () => json({ created: true }, 201));
    expect((await call(passthrough, request("/api/x"))).res.status).toBe(201);
    const empty = createHandler({ auth: "public" }, async () => undefined);
    expect((await call(empty, request("/api/x"))).res.status).toBe(204);
    const redirect = createHandler({ auth: "public" }, async () =>
      Response.redirect("http://localhost:3000/login", 302),
    );
    const r = await redirect(request("/api/x"), { params: Promise.resolve({}) });
    expect(r.status).toBe(302);
  });

  it("applies rate limits with Retry-After, keyed by ip (+ body field)", async () => {
    const limited = createHandler(
      {
        auth: "public",
        body: z.object({ email: z.string() }),
        rateLimit: { key: "unit:test", limit: 2, windowSeconds: 60, by: "ip+body:email" },
      },
      async () => ({ ok: true }),
    );
    const send = (email: string, ip: string) =>
      call(
        limited,
        request("/api/x", {
          method: "POST",
          body: JSON.stringify({ email }),
          headers: { "content-type": "application/json", "x-forwarded-for": ip },
        }),
      );
    expect((await send("a@x.test", "1.1.1.1")).res.status).toBe(200);
    expect((await send("A@X.TEST", "1.1.1.1")).res.status).toBe(200);
    const blocked = await send("a@x.test", "1.1.1.1");
    expect(blocked.res.status).toBe(429);
    expect(Number(blocked.res.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await send("b@x.test", "1.1.1.1")).res.status).toBe(200);
    expect((await send("a@x.test", "2.2.2.2")).res.status).toBe(200);
  });

  it("cron mode requires the CRON_SECRET bearer", async () => {
    const cron = createHandler({ auth: "cron" }, async ({ ctx }) => ({ kind: ctx.kind }));
    expect((await call(cron, request("/api/jobs/tick", { method: "POST" }))).res.status).toBe(401);
    expect(
      (
        await call(
          cron,
          request("/api/jobs/tick", { method: "POST", headers: { authorization: "Bearer wrong" } }),
        )
      ).res.status,
    ).toBe(401);
    const ok = await call(
      cron,
      request("/api/jobs/tick", {
        method: "POST",
        headers: { authorization: `Bearer ${env().CRON_SECRET}` },
      }),
    );
    expect(ok.body).toEqual({ kind: "cron" });
  });

  it("manager / user / mobile modes reject anonymous callers with UNAUTHENTICATED before CSRF", async () => {
    for (const auth of ["manager", "user", "mobile"] as const) {
      const handler = createHandler({ auth }, async () => ({ ok: true }));
      const { res, body } = await call(handler, request("/api/x", { method: "POST" }));
      expect(res.status).toBe(401);
      expect((body?.error as { code: string }).code).toBe("UNAUTHENTICATED");
    }
  });

  it("public mode can opt into the CSRF double-submit check", async () => {
    const handler = createHandler({ auth: "public", csrf: true }, async () => ({ ok: true }));
    const { res, body } = await call(handler, request("/api/x", { method: "POST" }));
    expect(res.status).toBe(403);
    expect((body?.error as { code: string }).code).toBe("CSRF_FAILED");
  });

  it("refuses `permission` outside manager mode at definition time", () => {
    expect(() =>
      createHandler({ auth: "public", permission: "org:manage" }, async () => null),
    ).toThrow(/permission/);
  });

  it("refuses `available` outside manager mode at definition time", () => {
    expect(() => createHandler({ auth: "user", available: () => true }, async () => null)).toThrow(
      /available/,
    );
  });

  it("refuses to disable CSRF for cookie-authenticated modes, or to enable it for bearer modes", () => {
    expect(() => createHandler({ auth: "manager", csrf: false }, async () => null)).toThrow(
      /cannot be disabled/,
    );
    expect(() => createHandler({ auth: "user", csrf: false }, async () => null)).toThrow(
      /cannot be disabled/,
    );
    expect(() => createHandler({ auth: "mobile", csrf: true }, async () => null)).toThrow(
      /does not apply/,
    );
    expect(() => createHandler({ auth: "cron", csrf: true }, async () => null)).toThrow(
      /does not apply/,
    );
  });

  it("public mutating routes reject a foreign (or opaque null) Origin but allow none or the app's own", async () => {
    const handler = createHandler({ auth: "public", body: z.object({}).strict() }, async () => ({
      ok: true,
    }));
    const post = (headers: Record<string, string>, path = "/api/auth/login") =>
      call(
        handler,
        request(path, {
          method: "POST",
          body: "{}",
          headers: { "content-type": "application/json", ...headers },
        }),
      );

    const foreign = await post({ origin: "https://evil.example" });
    expect(foreign.res.status).toBe(403);
    expect((foreign.body?.error as { code: string }).code).toBe("CSRF_FAILED");
    expect((await post({ origin: "null" })).res.status).toBe(403);
    expect((await post({ origin: env().APP_ORIGIN })).res.status).toBe(200);
    expect((await post({})).res.status).toBe(200);
    // Bearer-token clients (native app, scheduler) are exempt by path.
    expect((await post({ origin: "https://evil.example" }, "/api/mobile/v1/join")).res.status).toBe(
      200,
    );
    // Safe methods are never origin-checked.
    const get = createHandler({ auth: "public" }, async () => ({ ok: true }));
    expect(
      (await call(get, request("/api/x", { headers: { origin: "https://evil.example" } }))).res
        .status,
    ).toBe(200);
  });

  it("mobile mode never asks for a CSRF token (bearer auth), even with a foreign Origin", async () => {
    const handler = createHandler({ auth: "mobile" }, async () => ({ ok: true }));
    const { body } = await call(
      handler,
      request("/api/mobile/v1/sync", {
        method: "POST",
        headers: { origin: "https://evil.example", authorization: "Bearer x.y.z" },
      }),
    );
    // Fails on the bogus token (401), not on CSRF (403).
    expect((body?.error as { code: string }).code).toBe("UNAUTHENTICATED");
  });

  it("only validated input reaches the implementation: no schema means undefined", async () => {
    const handler = createHandler({ auth: "public" }, async ({ params, query, body }) => ({
      params: params ?? "none",
      query: query ?? "none",
      body: body ?? "none",
    }));
    const { body } = await call(
      handler,
      request("/api/x?admin=true", {
        method: "POST",
        body: JSON.stringify({ role: "OWNER" }),
        headers: { "content-type": "application/json" },
      }),
      { id: "anything" },
    );
    expect(body).toEqual({ params: "none", query: "none", body: "none" });

    // Rate-limit rules may read a raw body field, but the implementation still does not see it unvalidated.
    const limited = createHandler(
      {
        auth: "public",
        rateLimit: { key: "unit:raw", limit: 5, windowSeconds: 60, by: "ip+body:email" },
      },
      async ({ body: b }) => ({ body: b ?? "none" }),
    );
    const res = await call(
      limited,
      request("/api/x", {
        method: "POST",
        body: JSON.stringify({ email: "a@x.test" }),
        headers: { "content-type": "application/json" },
      }),
    );
    expect(res.body).toEqual({ body: "none" });
  });

  it("validates the query string with its schema (400 with source: query)", async () => {
    const handler = createHandler(
      { auth: "public", query: z.object({ limit: z.coerce.number().int().max(10) }).strict() },
      async ({ query }) => query,
    );
    const ok = await call(handler, request("/api/x?limit=4"));
    expect(ok.body).toEqual({ limit: 4 });
    const bad = await call(handler, request("/api/x?limit=99&extra=1"));
    expect(bad.res.status).toBe(400);
    expect((bad.body?.error as { details: { source: string } }).details.source).toBe("query");
  });

  it("an error that merely calls itself AppError cannot pick its status or leak its message", async () => {
    const impostor = createHandler({ auth: "public" }, async () => {
      throw Object.assign(new Error("connect ECONNREFUSED 10.0.0.5:5432 user=admin"), {
        name: "AppError",
        code: "ECONNREFUSED",
      });
    });
    const res = await call(impostor, request("/api/x"));
    expect(res.res.status).toBe(500);
    expect((res.body?.error as { code: string }).code).toBe("INTERNAL_ERROR");
    expect(JSON.stringify(res.body)).not.toContain("10.0.0.5");

    const badStatus = createHandler({ auth: "public" }, async () => {
      throw Object.assign(new Error("nope"), { name: "AppError", code: "NOT_FOUND", status: 200 });
    });
    expect((await call(badStatus, request("/api/x"))).res.status).toBe(404);
  });
});

describe("redactPathForLog", () => {
  it("hides token-like segments but keeps ids", () => {
    expect(
      redactPathForLog("/api/invites/manager/AbCdEfGhIjKlMnOpQrStUvWxYz0123456789_-abcde"),
    ).toBe("/api/invites/manager/:redacted");
    expect(
      redactPathForLog("/api/organisations/current/members/7d1b5a8e-2f7c-4c35-9a53-2b8f6f0e4a11"),
    ).toBe("/api/organisations/current/members/7d1b5a8e-2f7c-4c35-9a53-2b8f6f0e4a11");
    expect(redactPathForLog("/api/auth/forgot-password")).toBe("/api/auth/forgot-password");
    expect(redactPathForLog("/api/organisations/current/default-break-policy")).toBe(
      "/api/organisations/current/default-break-policy",
    );
  });
});
