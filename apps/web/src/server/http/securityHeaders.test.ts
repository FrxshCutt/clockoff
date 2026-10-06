import { describe, expect, it } from "vitest";
import { buildContentSecurityPolicy, securityHeaders } from "./securityHeaders";

describe("security headers", () => {
  it("sets the §13 baseline", () => {
    const headers = securityHeaders({ isProduction: true });
    expect(headers).toMatchObject({
      "X-Frame-Options": "DENY",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "Strict-Transport-Security": "max-age=63072000; includeSubDomains",
    });
    expect(headers["Permissions-Policy"]).toContain("camera=()");
  });

  it("only sends HSTS in production", () => {
    expect(securityHeaders({ isProduction: false })["Strict-Transport-Security"]).toBeUndefined();
  });

  it("CSP: self by default, inline styles allowed, no framing, eval only in development", () => {
    const prod = buildContentSecurityPolicy({ isProduction: true });
    expect(prod).toContain("default-src 'self'");
    expect(prod).toContain("style-src 'self' 'unsafe-inline'");
    expect(prod).toContain("frame-ancestors 'none'");
    expect(prod).toContain("object-src 'none'");
    expect(prod).not.toContain("unsafe-eval");
    expect(buildContentSecurityPolicy({ isProduction: false })).toContain("'unsafe-eval'");
    expect(buildContentSecurityPolicy({ isProduction: true, nonce: "abc" })).toContain(
      "'nonce-abc' 'strict-dynamic'",
    );
  });
});
