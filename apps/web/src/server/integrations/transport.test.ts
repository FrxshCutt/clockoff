import { canonicalJson } from "@clockoff/integrations";
import { describe, expect, it } from "vitest";
import { ENTITY_HASH_INFO, recordHasher } from "./hasher";
import { mockServerFetch } from "./transport";

/**
 * The transport's mock-mode rewrite (docs/integrations/PLANDAY_IMPLEMENTATION_PLAN.md §4.1, §12.1) and the keyed
 * decision-input hash (§6.2).
 */

describe("mockServerFetch (§4.1)", () => {
  it("rewrites the two Planday hosts onto the mock server and refuses every other host", async () => {
    const seen: string[] = [];
    const fetch = mockServerFetch("http://127.0.0.1:4010/", async (url) => {
      seen.push(url);
      return new Response("{}");
    });
    await fetch("https://openapi.planday.com/hr/v1.0/employees?limit=50&offset=0", {});
    await fetch("https://id.planday.com/connect/token", { method: "POST" });
    expect(seen).toEqual([
      "http://127.0.0.1:4010/openapi/hr/v1.0/employees?limit=50&offset=0",
      "http://127.0.0.1:4010/id/connect/token",
    ]);
    await expect(fetch("https://example.com/secret?id=1", {})).rejects.toThrow(
      "Mock Planday transport refused a request to example.com",
    );
  });
});

describe("recordHasher (§6.2)", () => {
  it("is a keyed HMAC: stable, input-sensitive and never a plain digest", async () => {
    const hash = recordHasher();
    const canonical = canonicalJson({ v: 1, kind: "SHIFT", record: { externalId: "500018" } });
    expect(hash(canonical)).toMatch(/^[0-9a-f]{64}$/);
    expect(hash(canonical)).toBe(recordHasher()(canonical));
    expect(hash(canonical)).not.toBe(hash(canonical.replace("500018", "500019")));
    const { createHash } = await import("node:crypto");
    expect(hash(canonical)).not.toBe(createHash("sha256").update(canonical).digest("hex"));
    expect(ENTITY_HASH_INFO).toBe("external-entity-hash:v2");
  });
});
