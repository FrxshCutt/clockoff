import { describe, expect, it } from "vitest";
import {
  getBearerToken,
  getClientIp,
  getCookie,
  getRequestId,
  getUserAgent,
  isMutatingMethod,
} from "./request";

function req(headers: Record<string, string>, method = "GET"): Request {
  return new Request("http://localhost/api/x", { method, headers });
}

describe("request helpers", () => {
  it("keeps a well-formed incoming request id and replaces anything else", () => {
    expect(getRequestId(req({ "x-request-id": "abc-123-def" }))).toBe("abc-123-def");
    const generated = getRequestId(req({ "x-request-id": "bad id with spaces" }));
    expect(generated).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("reads the client IP from x-forwarded-for counting trusted proxy hops from the right, then x-real-ip", () => {
    // One trusted proxy (default): the entry it appended is the client; anything left of it is client-supplied.
    expect(getClientIp(req({ "x-forwarded-for": "203.0.113.1" }), 1)).toBe("203.0.113.1");
    expect(getClientIp(req({ "x-forwarded-for": "6.6.6.6, 203.0.113.1" }), 1)).toBe("203.0.113.1");
    // Two trusted proxies (e.g. CDN → load balancer): skip the last hop.
    expect(getClientIp(req({ "x-forwarded-for": "6.6.6.6, 203.0.113.1, 10.0.0.1" }), 2)).toBe(
      "203.0.113.1",
    );
    // Fewer entries than hops: the leftmost one.
    expect(getClientIp(req({ "x-forwarded-for": "203.0.113.1" }), 3)).toBe("203.0.113.1");
    expect(getClientIp(req({ "x-forwarded-for": " , " }), 1)).toBeNull();
    expect(getClientIp(req({ "x-real-ip": "198.51.100.2" }), 1)).toBe("198.51.100.2");
    expect(getClientIp(req({}), 1)).toBeNull();
  });

  it("a spoofed leftmost x-forwarded-for entry cannot change the rate-limit identity", () => {
    const a = getClientIp(req({ "x-forwarded-for": "1.1.1.1, 203.0.113.9" }), 1);
    const b = getClientIp(req({ "x-forwarded-for": "2.2.2.2, 203.0.113.9" }), 1);
    expect(a).toBe(b);
  });

  it("parses bearer tokens, cookies and user agents", () => {
    expect(getBearerToken(req({ authorization: "Bearer abc.def" }))).toBe("abc.def");
    expect(getBearerToken(req({ authorization: "Basic xyz" }))).toBeNull();
    expect(getCookie(req({ cookie: "wm_session=s; wm_csrf=c" }), "wm_csrf")).toBe("c");
    expect(getUserAgent(req({ "user-agent": "x".repeat(1000) }))).toHaveLength(512);
  });

  it("classifies mutating methods", () => {
    expect(isMutatingMethod("POST")).toBe(true);
    expect(isMutatingMethod("delete")).toBe(true);
    expect(isMutatingMethod("GET")).toBe(false);
    expect(isMutatingMethod("OPTIONS")).toBe(false);
  });
});
