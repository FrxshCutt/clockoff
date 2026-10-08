/**
 * Mock Planday's identity server (`https://id.planday.com`, notes §3): the token endpoint (authorization code
 * and refresh grants), the revocation endpoint and the authorize endpoint. Only the two documented grant types
 * exist; there is no client secret. Error bodies are undocumented, so the mock answers RFC 6749 shapes and the
 * client must key on the status only.
 */
import { createHash } from "node:crypto";
import { emptyResponse, jsonResponse, oauthErrorResponse } from "./respond";
import type { PlandayJsonTokenResponse } from "./raw";
import {
  MOCK_ACCESS_TOKEN_TTL_S,
  MOCK_AUTHORIZATION_CODE_TTL_MS,
  MockControlError,
  randomToken,
  type MockAuthorizationCode,
  type MockPlandayState,
} from "./state";

/** Scopes the authorize request must carry besides the app's own (notes §3.2 A, §5.1). */
export const OIDC_SCOPES = ["openid", "offline_access"] as const;

export interface AuthorizationRequestInput {
  clientId: string;
  redirectUri: string;
  /** Space-separated, as on the authorize URL. */
  scope: string;
  responseType?: string;
  codeChallenge?: string | null;
  codeChallengeMethod?: string | null;
  /** The portal the administrator picks on Planday's login page (default: the mock's default portal). */
  portalId?: number;
}

type AuthorizationCheck =
  | { ok: true; code: MockAuthorizationCode }
  | { ok: false; error: string; description: string; redirect: boolean };

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

/** Validates an authorization request and, when valid, records a single-use code for it. */
function checkAuthorizationRequest(
  state: MockPlandayState,
  input: AuthorizationRequestInput,
): AuthorizationCheck {
  const app = state.apps.get(input.clientId);
  if (!app) {
    return {
      ok: false,
      error: "invalid_client",
      description: "unknown client_id",
      redirect: false,
    };
  }
  if (!input.redirectUri || !isHttpUrl(input.redirectUri)) {
    return {
      ok: false,
      error: "invalid_request",
      description: "redirect_uri must be an absolute http(s) URL",
      redirect: false,
    };
  }
  if (state.redirectUris && !state.redirectUris.includes(input.redirectUri)) {
    return {
      ok: false,
      error: "invalid_request",
      description: "redirect_uri is not one of the app's Redirection URLs",
      redirect: false,
    };
  }
  if ((input.responseType ?? "code") !== "code") {
    return {
      ok: false,
      error: "unsupported_response_type",
      description: "response_type must be code",
      redirect: true,
    };
  }
  const requested = input.scope.split(" ").filter(Boolean);
  const missingOidc = OIDC_SCOPES.filter((s) => !requested.includes(s));
  const apiScopes = requested.filter((s) => !(OIDC_SCOPES as readonly string[]).includes(s));
  const notOnApp = apiScopes.filter((s) => !app.scopes.includes(s));
  if (missingOidc.length > 0 || notOnApp.length > 0) {
    return {
      ok: false,
      error: "invalid_scope",
      description: missingOidc.length
        ? `scope must include ${missingOidc.join(" ")}`
        : `the app was not created with ${notOnApp.join(" ")}`,
      redirect: true,
    };
  }
  const challenge = input.codeChallenge || null;
  const method = challenge ? (input.codeChallengeMethod ?? "plain") : null;
  if (method !== null && method !== "S256" && method !== "plain") {
    return {
      ok: false,
      error: "invalid_request",
      description: "code_challenge_method must be S256 or plain",
      redirect: true,
    };
  }
  const portalId =
    input.portalId ??
    (app.kind === "CUSTOMER" && app.portalId !== null ? app.portalId : state.defaultPortalId);
  if (!state.portals.has(portalId)) {
    return {
      ok: false,
      error: "invalid_request",
      description: `no portal ${portalId}`,
      redirect: false,
    };
  }
  const code: MockAuthorizationCode = {
    code: randomToken("mock-code-"),
    appId: app.appId,
    portalId,
    redirectUri: input.redirectUri,
    scopes: apiScopes,
    codeChallenge: challenge,
    codeChallengeMethod: method,
    expiresAtMs: state.now() + MOCK_AUTHORIZATION_CODE_TTL_MS,
    used: false,
  };
  state.authorizationCodes.set(code.code, code);
  return { ok: true, code };
}

/**
 * The administrator approved the consent screen: a single-use code for `input` (used by the dev authorize route
 * through `/__control` `issueAuthorizationCode`). Throws `MockControlError` for an invalid request.
 */
export function issueAuthorizationCode(
  state: MockPlandayState,
  input: AuthorizationRequestInput,
): { code: string; portalId: number } {
  const result = checkAuthorizationRequest(state, input);
  if (!result.ok) throw new MockControlError(`${result.error}: ${result.description}`);
  return { code: result.code.code, portalId: result.code.portalId };
}

/** `GET /connect/authorize`: approves at once (the consent page is the dev route's) and redirects with a code. */
export function authorizeEndpoint(state: MockPlandayState, query: URLSearchParams): Response {
  const redirectUri = query.get("redirect_uri") ?? "";
  const clientState = query.get("state");
  const result = checkAuthorizationRequest(state, {
    clientId: query.get("client_id") ?? "",
    redirectUri,
    scope: query.get("scope") ?? "",
    responseType: query.get("response_type") ?? "",
    codeChallenge: query.get("code_challenge"),
    codeChallengeMethod: query.get("code_challenge_method"),
  });
  if (!result.ok && !result.redirect) {
    return jsonResponse(400, { error: result.error, error_description: result.description });
  }
  const location = new URL(redirectUri);
  if (result.ok) location.searchParams.set("code", result.code.code);
  else location.searchParams.set("error", result.error);
  if (clientState !== null) location.searchParams.set("state", clientState);
  return emptyResponse(302, { location: location.toString() });
}

function fakeIdToken(portalId: number): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "none", typ: "JWT" })}.${part({ sub: "mock-administrator", PortalId: portalId })}.`;
}

function pkceMatches(code: MockAuthorizationCode, verifier: string | null): boolean {
  if (code.codeChallenge === null) return true;
  if (!verifier) return false;
  const computed =
    code.codeChallengeMethod === "S256"
      ? createHash("sha256").update(verifier).digest("base64url")
      : verifier;
  return computed === code.codeChallenge;
}

/** `POST /connect/token` (notes §3.2 A step 4, §3.3). */
export function tokenEndpoint(state: MockPlandayState, form: URLSearchParams): Response {
  const clientId = form.get("client_id");
  if (!clientId) return oauthErrorResponse(400, "invalid_request");
  if (!state.apps.has(clientId)) return oauthErrorResponse(400, "invalid_client");

  switch (form.get("grant_type")) {
    case "refresh_token": {
      const refreshToken = form.get("refresh_token");
      if (!refreshToken) return oauthErrorResponse(400, "invalid_request");
      const found = state.grantByRefreshToken(refreshToken);
      // A rotated-away, revoked or unknown token, or one issued to another app ("client_id must own the token").
      if (!found || found.retired || found.grant.revoked || found.grant.appId !== clientId) {
        return oauthErrorResponse(400, "invalid_grant");
      }
      const grant = found.grant;
      let rotated: string | undefined;
      if (state.settings.rotateRefreshTokens) {
        grant.retiredRefreshTokens.push(grant.refreshToken);
        grant.refreshToken = randomToken("mock-rt-");
        rotated = grant.refreshToken;
      }
      const access = state.issueAccessToken(grant);
      // The docs promise only access_token on a refresh (notes §3.3): no scope, refresh_token only on rotation.
      const body: PlandayJsonTokenResponse = {
        access_token: access.token,
        expires_in: MOCK_ACCESS_TOKEN_TTL_S,
        token_type: "Bearer",
        ...(rotated ? { refresh_token: rotated } : {}),
      };
      return jsonResponse(200, body, { "cache-control": "no-store" });
    }
    case "authorization_code": {
      const codeValue = form.get("code");
      const redirectUri = form.get("redirect_uri");
      if (!codeValue || !redirectUri) return oauthErrorResponse(400, "invalid_request");
      const code = state.authorizationCodes.get(codeValue);
      if (
        !code ||
        code.used ||
        code.expiresAtMs <= state.now() ||
        code.appId !== clientId ||
        code.redirectUri !== redirectUri ||
        !pkceMatches(code, form.get("code_verifier"))
      ) {
        return oauthErrorResponse(400, "invalid_grant");
      }
      code.used = true;
      const grant = state.createGrant(code.appId, code.portalId);
      const access = state.issueAccessToken(grant);
      const body: PlandayJsonTokenResponse = {
        id_token: fakeIdToken(code.portalId),
        access_token: access.token,
        expires_in: MOCK_ACCESS_TOKEN_TTL_S,
        token_type: "Bearer",
        refresh_token: grant.refreshToken,
        scope: [...OIDC_SCOPES, ...code.scopes].join(" "),
      };
      return jsonResponse(200, body, { "cache-control": "no-store" });
    }
    default:
      return oauthErrorResponse(400, "unsupported_grant_type");
  }
}

/** `POST /connect/revocation` (notes §3.6): any known or unknown token answers 200 with an empty body. */
export function revocationEndpoint(state: MockPlandayState, form: URLSearchParams): Response {
  const clientId = form.get("client_id");
  const token = form.get("token");
  if (!clientId || !token) return oauthErrorResponse(400, "invalid_request");
  if (!state.apps.has(clientId)) return oauthErrorResponse(400, "invalid_client");
  const found = state.grantByRefreshToken(token);
  if (found && !found.retired) {
    if (found.grant.appId !== clientId) return oauthErrorResponse(400, "invalid_client");
    found.grant.revoked = true;
    found.grant.keepAccessTokens = !state.settings.revocationKillsAccessTokens;
    if (state.settings.revocationKillsAccessTokens) state.revokeAccessTokensOf(found.grant.id);
  }
  return emptyResponse(200);
}
