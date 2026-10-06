/**
 * Response security headers (§13). Edge-safe. Applied by `middleware.ts` to API and page responses.
 *
 * CSP notes: Next.js injects inline bootstrap scripts and Tailwind/shadcn rely on inline styles, so
 * `'unsafe-inline'` is allowed for scripts and styles. Upgrading to a per-request nonce requires the
 * root layout to read an `x-nonce` request header; `buildContentSecurityPolicy({ nonce })` already
 * emits the nonce form when one is supplied. Development additionally needs `'unsafe-eval'` for React
 * Refresh.
 */
export interface SecurityHeaderOptions {
  isProduction: boolean;
  nonce?: string;
}

export function buildContentSecurityPolicy(options: SecurityHeaderOptions): string {
  const scriptSrc = options.nonce
    ? `'self' 'nonce-${options.nonce}' 'strict-dynamic'`
    : `'self' 'unsafe-inline'${options.isProduction ? "" : " 'unsafe-eval'"}`;
  const directives = [
    `default-src 'self'`,
    `script-src ${scriptSrc}`,
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' data: blob:`,
    `font-src 'self' data:`,
    `connect-src 'self'${options.isProduction ? "" : " ws: wss:"}`,
    `frame-ancestors 'none'`,
    `base-uri 'self'`,
    `form-action 'self'`,
    `object-src 'none'`,
  ];
  if (options.isProduction) directives.push("upgrade-insecure-requests");
  return directives.join("; ");
}

export function securityHeaders(options: SecurityHeaderOptions): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Security-Policy": buildContentSecurityPolicy(options),
    "X-Frame-Options": "DENY",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy":
      "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()",
    "X-DNS-Prefetch-Control": "off",
    "Cross-Origin-Opener-Policy": "same-origin",
  };
  if (options.isProduction) {
    headers["Strict-Transport-Security"] = "max-age=63072000; includeSubDomains";
  }
  return headers;
}

export function applySecurityHeaders(target: Headers, options: SecurityHeaderOptions): void {
  for (const [name, value] of Object.entries(securityHeaders(options))) target.set(name, value);
}
