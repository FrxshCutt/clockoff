// Mock Planday (plan §12): the in-process fake server, its fixture, fault controls, the production guard and
// the HTTP wrapper. Exported only as "@clockoff/integrations/planday/mock"; imported only by the web app's
// transport (tests), the dev routes and scripts/mock-planday.mts. Every factory refuses to run in production
// (`guard.ts`); importing this module never throws.
export * from "./controls";
export * from "./datetime";
export * from "./fixture";
export * from "./guard";
export * from "./httpServer";
export { issueAuthorizationCode, OIDC_SCOPES, type AuthorizationRequestInput } from "./oauth";
export * from "./raw";
export { API_ROUTES, type ApiRoute } from "./routes";
export * from "./server";
export {
  MOCK_ACCESS_TOKEN_TTL_S,
  MOCK_AUTHORIZATION_CODE_TTL_MS,
  MockControlError,
  MockPlandayState,
  type MockAccessToken,
  type MockApp,
  type MockAuthorizationCode,
  type MockFault,
  type MockGrant,
  type MockMalformedMode,
  type MockPortalState,
  type MockSettings,
} from "./state";
