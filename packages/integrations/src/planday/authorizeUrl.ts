import { createHash } from "node:crypto";
import { PLANDAY_AUTHORIZE_URL, PLANDAY_OAUTH_SCOPES } from "./constants";

/**
 * Method A's authorize URL (docs/integrations/PLANDAY_IMPLEMENTATION_PLAN.md §5.2, notes §3.2 A):
 *
 * `https://id.planday.com/connect/authorize?client_id=…&response_type=code&redirect_uri=…&scope=…&state=…`
 *
 * `scope` is the production app's full scope list plus `openid offline_access`, space-separated and URL-encoded;
 * `redirect_uri` is the one exact callback URL, built once from APP_URL and sent identically in the exchange.
 * PKCE (`code_challenge`, `code_challenge_method=S256`) is added only when a challenge is given
 * (`PLANDAY_OAUTH_PKCE=true`, off until verified on a demo portal, Q2). Web builds this URL; the provider never
 * returns REDIRECT_REQUIRED.
 */
export interface AuthorizeUrlParams {
  readonly clientId: string;
  readonly redirectUri: string;
  /** The signed, single-use state token (§5.2). */
  readonly state: string;
  /** `base64url(sha256(code_verifier))`, only with PKCE. */
  readonly codeChallenge?: string;
  /** `transport.authorizeBaseUrl`: Planday's live, the dev route in mock mode. */
  readonly authorizeBaseUrl?: string;
  readonly scopes?: readonly string[];
}

export function buildAuthorizeUrl(params: AuthorizeUrlParams): string {
  for (const [name, value] of [
    ["clientId", params.clientId],
    ["redirectUri", params.redirectUri],
    ["state", params.state],
  ] as const) {
    if (!value) throw new TypeError(`buildAuthorizeUrl: ${name} is required`);
  }
  const query: Array<[string, string]> = [
    ["client_id", params.clientId],
    ["response_type", "code"],
    ["redirect_uri", params.redirectUri],
    ["scope", (params.scopes ?? PLANDAY_OAUTH_SCOPES).join(" ")],
    ["state", params.state],
  ];
  if (params.codeChallenge) {
    query.push(["code_challenge", params.codeChallenge], ["code_challenge_method", "S256"]);
  }
  const base = params.authorizeBaseUrl ?? PLANDAY_AUTHORIZE_URL;
  const encoded = query.map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join("&");
  return `${base}${base.includes("?") ? "&" : "?"}${encoded}`;
}

/** The S256 PKCE challenge for a verifier: `base64url(sha256(verifier))` (RFC 7636 §4.2). */
export function pkceCodeChallenge(codeVerifier: string): string {
  return createHash("sha256").update(codeVerifier, "ascii").digest("base64url");
}
