import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * docker/www-redirect/server.mjs — the Railway "www" service (www.clockoff.online → clockoff.online). It must
 * redirect permanently with the same path and query, never let the request choose the destination, and
 * answer Railway's health check.
 */

type Handler = (req: IncomingMessage, res: ServerResponse) => void;
const serverModule = path.resolve(
  import.meta.dirname,
  "../../../../docker/www-redirect/server.mjs",
);
let createRedirectHandler: (target: string) => Handler;
let base = "";
let close: () => Promise<void>;

beforeAll(async () => {
  ({ createRedirectHandler } = (await import(serverModule)) as {
    createRedirectHandler: (target: string) => Handler;
  });
  const server = createServer(createRedirectHandler("https://clockoff.online"));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => new Promise((resolve) => server.close(() => resolve()));
});
afterAll(() => close());

describe("www redirect service", () => {
  it("redirects permanently to the apex with the same path and query", async () => {
    const res = await fetch(`${base}/pricing?plan=team#x`, { redirect: "manual" });
    expect(res.status).toBe(308);
    expect(res.headers.get("location")).toBe("https://clockoff.online/pricing?plan=team");
    const root = await fetch(`${base}/`, { redirect: "manual", method: "POST" });
    expect(root.status).toBe(308);
    expect(root.headers.get("location")).toBe("https://clockoff.online/");
  });

  it("ignores the Host header when building the destination", async () => {
    const res = await fetch(`${base}/login`, {
      redirect: "manual",
      headers: { host: "evil.example" },
    });
    expect(res.headers.get("location")).toBe("https://clockoff.online/login");
  });

  it("answers the health check", async () => {
    const res = await fetch(`${base}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("refuses a target that is not a bare https origin", () => {
    for (const bad of ["http://clockoff.online", "https://clockoff.online/path", "clockoff.online"])
      expect(() => createRedirectHandler(bad)).toThrow();
  });
});
