import { describe, expect, it } from "vitest";
import { GET as tickGet, POST as tickPost } from "@/app/api/jobs/tick/route";
import { env } from "@/lib/env";
import { callRoute } from "../helpers";

describe("/api/jobs/tick", () => {
  it("runs a tick for Vercel Cron (GET + Bearer CRON_SECRET) and for external schedulers (POST)", async () => {
    for (const [method, handler] of [
      ["GET", tickGet],
      ["POST", tickPost],
    ] as const) {
      const res = await callRoute<{ ok: boolean; report: unknown }>(handler, {
        method,
        path: "/api/jobs/tick",
        headers: { authorization: `Bearer ${env().CRON_SECRET}` },
        csrf: false,
      });
      expect(res.status, `${method} ${JSON.stringify(res.body)}`).toBe(200);
      expect(res.body.ok).toBe(true);
    }
  });

  it("refuses a missing or wrong secret on both methods", async () => {
    for (const handler of [tickGet, tickPost]) {
      const attempts: Record<string, string>[] = [{}, { authorization: "Bearer nope" }];
      for (const headers of attempts) {
        const res = await callRoute<{ error: { code: string } }>(handler, {
          method: handler === tickGet ? "GET" : "POST",
          path: "/api/jobs/tick",
          headers,
          csrf: false,
        });
        expect(res.status).toBe(401);
        expect(res.body.error.code).toBe("UNAUTHENTICATED");
      }
    }
  });
});
