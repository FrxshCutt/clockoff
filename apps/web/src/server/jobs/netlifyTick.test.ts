import { describe, expect, it, vi } from "vitest";
import { config, runScheduledTick } from "../../../netlify/functions/work-mode-tick.mts";

describe("Netlify scheduled tick", () => {
  it("is scheduled every minute", () => {
    expect(config.schedule).toBe("* * * * *");
  });

  it("POSTs the tick endpoint on APP_URL with the cron bearer secret", async () => {
    const fetchImpl = vi.fn(async () => new Response("{}", { status: 200 }));
    const res = await runScheduledTick(
      {
        APP_URL: "https://app.example.com",
        URL: "https://example.netlify.app",
        CRON_SECRET: "s3cret",
      },
      fetchImpl as unknown as typeof fetch,
    );
    expect(res.status).toBe(204);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [URL, RequestInit];
    expect(url.toString()).toBe("https://app.example.com/api/jobs/tick");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer s3cret");
  });

  it("reports failures without throwing and refuses to run unconfigured", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const failing = vi.fn(async () => new Response("no", { status: 401 }));
    expect(
      (await runScheduledTick({ APP_URL: "https://a.example", CRON_SECRET: "x" }, failing as never))
        .status,
    ).toBe(502);
    const throwing = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    expect(
      (
        await runScheduledTick(
          { APP_URL: "https://a.example", CRON_SECRET: "x" },
          throwing as never,
        )
      ).status,
    ).toBe(502);
    expect((await runScheduledTick({}, failing as never)).status).toBe(500);
    expect(errors).toHaveBeenCalledTimes(3);
    errors.mockRestore();
  });
});
