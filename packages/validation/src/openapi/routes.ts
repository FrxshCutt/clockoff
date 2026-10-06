import { z } from "zod";
import {
  acceptManagerInviteSchema,
  changePasswordSchema,
  createOrganisationSchema,
  forgotPasswordSchema,
  loginSchema,
  registerSchema,
  resendVerificationSchema,
  resetPasswordSchema,
  switchOrganisationSchema,
  verifyEmailSchema,
} from "../auth";
import {
  authSessionResponseSchema,
  changePasswordResponseSchema,
  currentUserResponseSchema,
  healthResponseSchema,
  resendVerificationResponseSchema,
  resetPasswordResponseSchema,
  switchOrganisationResponseSchema,
} from "../authResponses";
import {
  activityQuerySchema,
  employeeActivityQuerySchema,
  listActivityResponseSchema,
} from "../activity";
import { auditLogQuerySchema, listAuditLogsResponseSchema } from "../auditLogs";
import {
  breakPolicyQuerySchema,
  breakPolicyAssignmentResponseSchema,
  breakPolicyResponseSchema,
  createBreakPolicyAssignmentSchema,
  createBreakPolicySchema,
  listBreakPoliciesResponseSchema,
  listBreakPolicyAssignmentsResponseSchema,
  setDefaultBreakPolicySchema,
  updateBreakPolicySchema,
} from "../breakPolicies";
import {
  complianceEmployeesQuerySchema,
  complianceEmployeesResponseSchema,
  complianceSummaryResponseSchema,
} from "../compliance";
import {
  deactivateDeviceSchema,
  deviceQuerySchema,
  deviceResponseSchema,
  listDevicesResponseSchema,
} from "../devices";
import {
  archiveEmployeeSchema,
  assignEmployeeBreakPolicySchema,
  assignEmployeeLocationSchema,
  assignEmployeePolicySchema,
  assignEmployeeTeamSchema,
  bulkEmployeeActionResponseSchema,
  bulkEmployeeActionSchema,
  createEmployeeSchema,
  deactivateEmployeeSchema,
  employeeDetailResponseSchema,
  employeeQuerySchema,
  employeeResponseSchema,
  employeeStateQuerySchema,
  employeeStateResponseSchema,
  listEmployeesResponseSchema,
  reactivateEmployeeSchema,
  updateEmployeeSchema,
} from "../employees";
import {
  commitImportResponseSchema,
  commitImportSchema,
  createImportResponseSchema,
  importMappingSchema,
  importQuerySchema,
  importResponseSchema,
  importRowParamsSchema,
  importRowResponseSchema,
  importRowsQuerySchema,
  importUploadFormSchema,
  listImportRowsResponseSchema,
  listImportsResponseSchema,
  updateImportRowSchema,
  validateImportResponseSchema,
} from "../imports";
import {
  connectIntegrationResponseSchema,
  connectIntegrationSchema,
  integrationActionSchema,
  integrationParamsSchema,
  integrationResponseSchema,
  listIntegrationsResponseSchema,
  syncIntegrationResponseSchema,
} from "../integrations";
import {
  createEmployeeInviteResponseSchema,
  createEmployeeInviteSchema,
  employeeInviteResponseSchema,
  inviteInstructionsResponseSchema,
  resendEmployeeInviteSchema,
  revokeEmployeeInviteSchema,
} from "../invites";
import {
  addTeamMembersSchema,
  createDepartmentSchema,
  createLocationSchema,
  createTeamSchema,
  departmentResponseSchema,
  listDepartmentsResponseSchema,
  listLocationsResponseSchema,
  listTeamsResponseSchema,
  locationResponseSchema,
  teamMemberParamsSchema,
  teamQuerySchema,
  teamResponseSchema,
  updateDepartmentSchema,
  updateLocationSchema,
  updateTeamSchema,
} from "../locationsTeams";
import {
  deviceEventsResponseSchema,
  deviceEventsSchema,
  deviceStateReportSchema,
  deviceStateResponseSchema,
  joinConfirmResponseSchema,
  joinConfirmSchema,
  joinLookupResponseSchema,
  joinLookupSchema,
  leaveWorkplaceSchema,
  MOBILE_API_PREFIX,
  mobileBreakParamsSchema,
  mobileBreakResponseSchema,
  mobileEndBreakSchema,
  mobileLogoutSchema,
  mobileMeResponseSchema,
  mobileRefreshResponseSchema,
  mobileRefreshSchema,
  mobileScheduleQuerySchema,
  mobileScheduleResponseSchema,
  mobileStartBreakSchema,
  mobileSyncQuerySchema,
  mobileSyncResponseSchema,
  pushTokenSchema,
} from "../mobile";
import {
  listNotificationsResponseSchema,
  markAllNotificationsReadResponseSchema,
  notificationQuerySchema,
  notificationResponseSchema,
} from "../notifications";
import {
  acceptManagerInviteResponseSchema,
  createOrganisationResponseSchema,
  currentOrganisationResponseSchema,
  inviteMemberSchema,
  joinCodeResponseSchema,
  listMembersResponseSchema,
  listOrganisationsResponseSchema,
  managerInviteIdParamsSchema,
  managerInviteResponseSchema,
  managerInvitePreviewResponseSchema,
  managerInviteTokenParamsSchema,
  memberResponseSchema,
  membershipIdParamsSchema,
  onboardingResponseSchema,
  organisationResponseSchema,
  removeMemberResponseSchema,
  resendManagerInviteSchema,
  updateMemberRoleSchema,
  updateOrganisationSchema,
  requestDemoSchema,
  requestDemoResponseSchema,
} from "../organisation";
import {
  createOverrideSchema,
  listOverridesResponseSchema,
  overrideQuerySchema,
  overrideResponseSchema,
  revokeOverrideSchema,
} from "../overrides";
import {
  createPolicyAssignmentSchema,
  createPolicySchema,
  duplicatePolicySchema,
  listPoliciesResponseSchema,
  listPolicyAssignmentsResponseSchema,
  policyAssignmentResponseSchema,
  policyQuerySchema,
  policyResponseSchema,
  policyVersionsResponseSchema,
  publishPolicySchema,
  setDefaultPolicySchema,
  updatePolicySchema,
} from "../policies";
import { emptyBodySchema, emptyQuerySchema, idParamsSchema, okResponseSchema } from "../primitives";
import { realtimeStreamQuerySchema, sseEventSchema } from "../realtime";
import { billingResponseSchema, settingsResponseSchema, updateSettingsSchema } from "../settings";
import {
  bulkShiftActionResponseSchema,
  bulkShiftActionSchema,
  cancelShiftSchema,
  createShiftResponseSchema,
  createShiftSchema,
  duplicateShiftSchema,
  employeeShiftsQuerySchema,
  listShiftsResponseSchema,
  shiftQuerySchema,
  shiftResponseSchema,
  updateShiftSchema,
} from "../shifts";
import { defineRoute, registry } from "./registry";

/**
 * Every API endpoint (§5). Handlers are implemented in apps/web/src/app/api/** with
 * `createHandler({ auth, permission, params, query, body }, impl)` using the SAME schemas listed here, so
 * this file is both the OpenAPI source and the checklist of routes to implement.
 */

const m = (path: string) => `${MOBILE_API_PREFIX}${path}`;
const id = idParamsSchema;

// ── Health ──────────────────────────────────────────────────────────────────

defineRoute({
  method: "GET",
  path: "/api/health",
  summary: "Liveness and database reachability",
  description:
    "For load balancers and uptime checks. Reveals no version, configuration or error detail.",
  tags: ["System"],
  auth: "public",
  responses: {
    200: healthResponseSchema,
    503: {
      contentType: "application/json",
      schema: healthResponseSchema,
      description: "Database unreachable (`status: degraded`).",
    },
  },
});

// ── Manager auth ────────────────────────────────────────────────────────────

defineRoute({
  method: "POST",
  path: "/api/auth/register",
  summary: "Create a manager account",
  description:
    "Always returns 201 with the same body for new and already-registered emails (enumeration resistance) and sends a verification (or 'you already have an account') email. When REQUIRE_EMAIL_VERIFICATION is false the new account is signed in immediately (`wm_session` / `wm_csrf` cookies); otherwise the user must verify, then sign in.",
  tags: ["Auth"],
  auth: "public",
  request: { body: registerSchema },
  responses: { 201: authSessionResponseSchema },
  errors: ["RATE_LIMITED"],
  rateLimit: "register",
});

defineRoute({
  method: "POST",
  path: "/api/auth/login",
  summary: "Sign in",
  description: "Rotates the session and CSRF cookies.",
  tags: ["Auth"],
  auth: "public",
  request: { body: loginSchema },
  responses: { 200: authSessionResponseSchema },
  errors: ["INVALID_CREDENTIALS"],
  rateLimit: "login",
});

defineRoute({
  method: "POST",
  path: "/api/auth/logout",
  summary: "Sign out",
  description:
    "Revokes the session and clears every auth cookie. Works with an expired session but still requires the CSRF header.",
  tags: ["Auth"],
  auth: "public",
  csrf: true,
  request: { body: emptyBodySchema },
  responses: { 200: okResponseSchema },
});

defineRoute({
  method: "GET",
  path: "/api/auth/me",
  summary: "The signed-in manager, their organisations and the CSRF token",
  description: "Works for unverified users. Re-issues the CSRF cookie when it is missing.",
  tags: ["Auth"],
  auth: "user",
  responses: { 200: currentUserResponseSchema },
});

defineRoute({
  method: "POST",
  path: "/api/auth/forgot-password",
  summary: "Email a password reset link",
  description: "Always answers `{ ok: true }` so the endpoint cannot be used to discover accounts.",
  tags: ["Auth"],
  auth: "public",
  request: { body: forgotPasswordSchema },
  responses: { 200: okResponseSchema },
  rateLimit: "forgotPassword",
});

defineRoute({
  method: "POST",
  path: "/api/auth/reset-password",
  summary: "Set a new password with a reset token",
  description: "Consumes the token, revokes every existing session and signs in with a fresh one.",
  tags: ["Auth"],
  auth: "public",
  request: { body: resetPasswordSchema },
  responses: { 200: resetPasswordResponseSchema },
  errors: ["INVALID_TOKEN", "TOKEN_EXPIRED"],
  rateLimit: "resetPassword",
});

defineRoute({
  method: "POST",
  path: "/api/auth/verify-email",
  summary: "Verify an email address",
  description: "Public: the link may be opened in a browser without a session.",
  tags: ["Auth"],
  auth: "public",
  request: { body: verifyEmailSchema },
  responses: { 200: okResponseSchema },
  errors: ["INVALID_TOKEN", "TOKEN_EXPIRED"],
  rateLimit: "verifyEmail",
});

defineRoute({
  method: "POST",
  path: "/api/auth/resend-verification",
  summary: "Re-send the verification email",
  tags: ["Auth"],
  auth: "user",
  request: { body: resendVerificationSchema },
  responses: { 200: resendVerificationResponseSchema },
  rateLimit: "resendVerification",
});

defineRoute({
  method: "POST",
  path: "/api/auth/change-password",
  summary: "Change your password",
  description: "Every other session of the user is revoked; the current one stays signed in.",
  tags: ["Auth"],
  auth: "user",
  request: { body: changePasswordSchema },
  responses: { 200: changePasswordResponseSchema },
  errors: ["INVALID_CREDENTIALS"],
  rateLimit: "changePassword",
});

defineRoute({
  method: "POST",
  path: "/api/auth/switch-organisation",
  summary: "Select the current organisation",
  description:
    "Sets the `wm_org` cookie. NOT_FOUND when the caller is not a member of that organisation.",
  tags: ["Auth", "Organisations"],
  auth: "user",
  request: { body: switchOrganisationSchema },
  responses: { 200: switchOrganisationResponseSchema },
  errors: ["NOT_FOUND"],
});

// ── Organisations ───────────────────────────────────────────────────────────

defineRoute({
  method: "GET",
  path: "/api/organisations",
  summary: "List your organisations",
  description:
    "Every organisation the signed-in manager belongs to, with their role, oldest first.",
  tags: ["Organisations"],
  auth: "user",
  responses: { 200: listOrganisationsResponseSchema },
});

defineRoute({
  method: "POST",
  path: "/api/organisations",
  summary: "Create an organisation",
  description:
    "Creates an organisation owned by the signed-in manager (no current organisation required), with an active company join code and, optionally, a first location. Becomes the current organisation (`wm_org` cookie). Requires a verified email when the deployment enforces verification.",
  tags: ["Organisations"],
  auth: "user",
  request: { body: createOrganisationSchema },
  responses: { 201: createOrganisationResponseSchema },
  errors: ["EMAIL_NOT_VERIFIED", "INVALID_TIMEZONE", "ORGANISATION_SLUG_TAKEN"],
});

defineRoute({
  method: "GET",
  path: "/api/organisations/current",
  summary: "Get the current organisation",
  description:
    "Includes the caller's membership (role and effective permissions) and the ACTIVE company join code.",
  tags: ["Organisations"],
  auth: "manager",
  responses: { 200: currentOrganisationResponseSchema },
});

defineRoute({
  method: "PATCH",
  path: "/api/organisations/current",
  summary: "Update the current organisation",
  tags: ["Organisations"],
  auth: "manager",
  permission: "org:manage",
  request: { body: updateOrganisationSchema },
  responses: { 200: organisationResponseSchema },
  errors: ["INVALID_TIMEZONE"],
});

defineRoute({
  method: "GET",
  path: "/api/organisations/current/onboarding",
  summary: "Get the onboarding checklist",
  tags: ["Organisations"],
  auth: "manager",
  responses: { 200: onboardingResponseSchema },
});

defineRoute({
  method: "POST",
  path: "/api/organisations/current/onboarding/dismiss",
  summary: "Dismiss the onboarding checklist",
  tags: ["Organisations"],
  auth: "manager",
  permission: "org:manage",
  request: { body: emptyBodySchema },
  responses: { 200: onboardingResponseSchema },
});

defineRoute({
  method: "POST",
  path: "/api/organisations/current/default-policy",
  summary: "Set (or clear) the organisation default Work Policy",
  tags: ["Organisations", "Policies"],
  auth: "manager",
  permission: "policies:write",
  request: { body: setDefaultPolicySchema },
  responses: { 200: organisationResponseSchema },
  errors: ["POLICY_NOT_PUBLISHED", "POLICY_ARCHIVED"],
});

defineRoute({
  method: "POST",
  path: "/api/organisations/current/default-break-policy",
  summary: "Set (or clear) the organisation default Break Policy",
  tags: ["Organisations", "Break policies"],
  auth: "manager",
  permission: "policies:write",
  request: { body: setDefaultBreakPolicySchema },
  responses: { 200: organisationResponseSchema },
  errors: ["POLICY_ARCHIVED"],
});

// ── Members (managers) ──────────────────────────────────────────────────────

defineRoute({
  method: "GET",
  path: "/api/organisations/current/members",
  summary: "List managers and pending manager invites",
  tags: ["Members"],
  auth: "manager",
  responses: { 200: listMembersResponseSchema },
});

defineRoute({
  method: "POST",
  path: "/api/organisations/current/members",
  summary: "Invite a manager by email",
  description: "Sends an email invite. Only an OWNER may invite another OWNER.",
  tags: ["Members"],
  auth: "manager",
  permission: "members:invite",
  request: { body: inviteMemberSchema },
  responses: { 201: managerInviteResponseSchema },
  errors: ["CONFLICT"],
  rateLimit: "inviteManager",
});

defineRoute({
  method: "PATCH",
  path: "/api/organisations/current/members/:membershipId",
  summary: "Change a manager's role",
  description:
    "Only OWNERs grant or change OWNER; nobody grants a role above their own; the last OWNER cannot be demoted (LAST_OWNER).",
  tags: ["Members"],
  auth: "manager",
  permission: "members:invite",
  request: { params: membershipIdParamsSchema, body: updateMemberRoleSchema },
  responses: { 200: memberResponseSchema },
  errors: ["LAST_OWNER"],
});

defineRoute({
  method: "DELETE",
  path: "/api/organisations/current/members/:membershipId",
  summary: "Remove a manager, or leave the organisation",
  description:
    "Removing yourself (leaving) needs no permission and clears the `wm_org` cookie; removing someone else needs members:invite (FORBIDDEN). The last OWNER cannot be removed (LAST_OWNER).",
  tags: ["Members"],
  auth: "manager",
  request: { params: membershipIdParamsSchema },
  responses: { 200: removeMemberResponseSchema },
  errors: ["FORBIDDEN", "LAST_OWNER"],
});

defineRoute({
  method: "POST",
  path: "/api/organisations/current/members/invite",
  summary: "Re-send a pending manager invite",
  description: "Issues a fresh token (the previous link stops working) and extends the expiry.",
  tags: ["Members"],
  auth: "manager",
  permission: "members:invite",
  request: { body: resendManagerInviteSchema },
  responses: { 200: managerInviteResponseSchema },
  errors: ["NOT_FOUND", "CONFLICT"],
  rateLimit: "inviteManager",
});

defineRoute({
  method: "DELETE",
  path: "/api/organisations/current/members/invites/:inviteId",
  summary: "Revoke a pending manager invite",
  description: "Returns the invite with status REVOKED.",
  tags: ["Members"],
  auth: "manager",
  permission: "members:invite",
  request: { params: managerInviteIdParamsSchema },
  responses: { 200: managerInviteResponseSchema },
  errors: ["CONFLICT"],
});

defineRoute({
  method: "POST",
  path: "/api/organisations/current/members/accept",
  summary: "Accept a manager invite",
  description:
    "Public. A new address supplies name + password and an account is created (already verified); an existing account must be signed in as itself or send its password. Signs the invitee in and selects the organisation.",
  tags: ["Members"],
  auth: "public",
  request: { body: acceptManagerInviteSchema },
  responses: { 200: acceptManagerInviteResponseSchema },
  errors: [
    "INVITE_INVALID",
    "INVITE_EXPIRED",
    "UNAUTHENTICATED",
    "INVALID_CREDENTIALS",
    "EMAIL_ALREADY_REGISTERED",
  ],
  rateLimit: "acceptManagerInvite",
});

defineRoute({
  method: "GET",
  path: "/api/invites/manager/:token",
  summary: "Preview a manager invite",
  tags: ["Members"],
  auth: "public",
  description:
    "Expired, revoked and accepted invites are returned with that `status`; an unknown token is INVITE_INVALID with HTTP 404.",
  request: { params: managerInviteTokenParamsSchema },
  responses: { 200: managerInvitePreviewResponseSchema },
  errors: [{ code: "INVITE_INVALID", status: 404 }],
  rateLimit: "lookupManagerInvite",
});

// ── Company join code ───────────────────────────────────────────────────────

defineRoute({
  method: "GET",
  path: "/api/organisations/current/join-code",
  summary: "Get the active company join code and its history",
  tags: ["Join code"],
  auth: "manager",
  permission: "employees:read",
  responses: { 200: joinCodeResponseSchema },
});

defineRoute({
  method: "POST",
  path: "/api/organisations/current/join-code/regenerate",
  summary: "Replace the company join code",
  description:
    "Revokes the active code and creates a new one. Already-joined phones are unaffected.",
  tags: ["Join code"],
  auth: "manager",
  permission: "org:manage",
  request: { body: emptyBodySchema },
  responses: { 200: joinCodeResponseSchema },
});

defineRoute({
  method: "POST",
  path: "/api/organisations/current/join-code/revoke",
  summary: "Revoke the company join code",
  description: "Nobody can join until a new code is generated.",
  tags: ["Join code"],
  auth: "manager",
  permission: "org:manage",
  request: { body: emptyBodySchema },
  responses: { 200: joinCodeResponseSchema },
});

// ── Employees ───────────────────────────────────────────────────────────────

defineRoute({
  method: "GET",
  path: "/api/employees",
  summary: "List employees",
  description:
    "Repeat a list filter (`?inviteStatus=INVITED&inviteStatus=JOINED`) or comma-separate it.",
  tags: ["Employees"],
  auth: "manager",
  permission: "employees:read",
  request: { query: employeeQuerySchema },
  responses: { 200: listEmployeesResponseSchema },
});

defineRoute({
  method: "POST",
  path: "/api/employees",
  summary: "Create an employee",
  tags: ["Employees"],
  auth: "manager",
  permission: "employees:write",
  request: { body: createEmployeeSchema },
  responses: { 201: employeeResponseSchema },
  errors: ["CONFLICT", "POLICY_ARCHIVED"],
});

defineRoute({
  method: "POST",
  path: "/api/employees/bulk",
  summary: "Apply an action to many employees",
  description:
    "Partial success: failures are reported per employee and the rest of the batch is applied.",
  tags: ["Employees"],
  auth: "manager",
  permission: "employees:write",
  request: { body: bulkEmployeeActionSchema },
  responses: { 200: bulkEmployeeActionResponseSchema },
});

defineRoute({
  method: "GET",
  path: "/api/employees/:id",
  summary: "Get an employee",
  tags: ["Employees"],
  auth: "manager",
  permission: "employees:read",
  request: { params: id },
  responses: { 200: employeeDetailResponseSchema },
  errors: ["EMPLOYEE_NOT_FOUND"],
});

defineRoute({
  method: "PATCH",
  path: "/api/employees/:id",
  summary: "Update an employee",
  tags: ["Employees"],
  auth: "manager",
  permission: "employees:write",
  request: { params: id, body: updateEmployeeSchema },
  responses: { 200: employeeResponseSchema },
  errors: ["EMPLOYEE_NOT_FOUND", "CONFLICT", "POLICY_ARCHIVED"],
});

for (const action of [
  {
    path: "deactivate",
    summary: "Deactivate an employee",
    body: deactivateEmployeeSchema,
    description: "Revokes the employee's devices and pending invites. Reversible.",
  },
  {
    path: "reactivate",
    summary: "Reactivate an employee",
    body: reactivateEmployeeSchema,
    description: "The employee must join again from their phone.",
  },
  {
    path: "archive",
    summary: "Archive an employee",
    body: archiveEmployeeSchema,
    description: "Soft delete: deactivates and hides the employee from every list.",
  },
] as const) {
  defineRoute({
    method: "POST",
    path: `/api/employees/:id/${action.path}`,
    summary: action.summary,
    description: action.description,
    tags: ["Employees"],
    auth: "manager",
    permission: "employees:write",
    request: { params: id, body: action.body },
    responses: { 200: employeeResponseSchema },
    errors: ["EMPLOYEE_NOT_FOUND"],
  });
}

defineRoute({
  method: "POST",
  path: "/api/employees/:id/assign-policy",
  summary: "Set or clear the employee-level Work Policy",
  tags: ["Employees", "Policies"],
  auth: "manager",
  permission: "employees:write",
  request: { params: id, body: assignEmployeePolicySchema },
  responses: { 200: employeeResponseSchema },
  errors: ["EMPLOYEE_NOT_FOUND", "POLICY_ARCHIVED"],
});

defineRoute({
  method: "POST",
  path: "/api/employees/:id/assign-break-policy",
  summary: "Set or clear the employee-level Break Policy",
  tags: ["Employees", "Break policies"],
  auth: "manager",
  permission: "employees:write",
  request: { params: id, body: assignEmployeeBreakPolicySchema },
  responses: { 200: employeeResponseSchema },
  errors: ["EMPLOYEE_NOT_FOUND", "POLICY_ARCHIVED"],
});

defineRoute({
  method: "POST",
  path: "/api/employees/:id/assign-location",
  summary: "Set the employee's primary and additional locations",
  tags: ["Employees", "Locations"],
  auth: "manager",
  permission: "employees:write",
  request: { params: id, body: assignEmployeeLocationSchema },
  responses: { 200: employeeResponseSchema },
  errors: ["EMPLOYEE_NOT_FOUND"],
});

defineRoute({
  method: "POST",
  path: "/api/employees/:id/assign-team",
  summary: "Replace the employee's team memberships",
  tags: ["Employees", "Teams"],
  auth: "manager",
  permission: "employees:write",
  request: { params: id, body: assignEmployeeTeamSchema },
  responses: { 200: employeeResponseSchema },
  errors: ["EMPLOYEE_NOT_FOUND"],
});

defineRoute({
  method: "GET",
  path: "/api/employees/:id/state",
  summary: "Expected vs reported Work Mode state, with a timeline",
  tags: ["Employees", "Compliance"],
  auth: "manager",
  permission: "employees:read",
  request: { params: id, query: employeeStateQuerySchema },
  responses: { 200: employeeStateResponseSchema },
  errors: ["EMPLOYEE_NOT_FOUND"],
});

defineRoute({
  method: "GET",
  path: "/api/employees/:id/shifts",
  summary: "List an employee's shifts",
  tags: ["Employees", "Shifts"],
  auth: "manager",
  permission: "schedule:read",
  request: { params: id, query: employeeShiftsQuerySchema },
  responses: { 200: listShiftsResponseSchema },
  errors: ["EMPLOYEE_NOT_FOUND"],
});

defineRoute({
  method: "GET",
  path: "/api/employees/:id/activity",
  summary: "An employee's activity feed",
  tags: ["Employees", "Activity"],
  auth: "manager",
  permission: "employees:read",
  request: { params: id, query: employeeActivityQuerySchema },
  responses: { 200: listActivityResponseSchema },
  errors: ["EMPLOYEE_NOT_FOUND"],
});

// ── Employee invites ────────────────────────────────────────────────────────

defineRoute({
  method: "POST",
  path: "/api/employees/:id/invites",
  summary: "Invite an employee to join from their phone",
  description:
    "Revokes any previous pending invite. EMAIL/SMS deliver the instructions; LINK only creates them.",
  tags: ["Invites"],
  auth: "manager",
  permission: "employees:write",
  request: { params: id, body: createEmployeeInviteSchema },
  responses: { 201: createEmployeeInviteResponseSchema },
  errors: ["EMPLOYEE_NOT_FOUND", "EMPLOYEE_INACTIVE", "EMPLOYEE_ALREADY_LINKED"],
  rateLimit: "employeeInvite",
});

defineRoute({
  method: "POST",
  path: "/api/invites/:id/resend",
  summary: "Re-send an employee invite",
  tags: ["Invites"],
  auth: "manager",
  permission: "employees:write",
  request: { params: id, body: resendEmployeeInviteSchema },
  responses: { 200: employeeInviteResponseSchema },
  errors: ["INVITE_INVALID", "INVITE_EXPIRED"],
  rateLimit: "employeeInvite",
});

defineRoute({
  method: "POST",
  path: "/api/invites/:id/revoke",
  summary: "Revoke an employee invite",
  tags: ["Invites"],
  auth: "manager",
  permission: "employees:write",
  request: { params: id, body: revokeEmployeeInviteSchema },
  responses: { 200: employeeInviteResponseSchema },
  errors: ["INVITE_INVALID"],
});

defineRoute({
  method: "GET",
  path: "/api/invites/:id/instructions",
  summary: "Setup instructions to share with the employee",
  tags: ["Invites"],
  auth: "manager",
  permission: "employees:read",
  request: { params: id },
  responses: { 200: inviteInstructionsResponseSchema },
  errors: ["INVITE_INVALID"],
});

// ── Devices ─────────────────────────────────────────────────────────────────

defineRoute({
  method: "GET",
  path: "/api/devices",
  summary: "List devices",
  description:
    "Operational signals only (§12) — never identifiers, app lists, push tokens or locations.",
  tags: ["Devices"],
  auth: "manager",
  permission: "employees:read",
  request: { query: deviceQuerySchema },
  responses: { 200: listDevicesResponseSchema },
});

defineRoute({
  method: "GET",
  path: "/api/devices/:id",
  summary: "Get a device",
  tags: ["Devices"],
  auth: "manager",
  permission: "employees:read",
  request: { params: id },
  responses: { 200: deviceResponseSchema },
});

defineRoute({
  method: "POST",
  path: "/api/devices/:id/deactivate",
  summary: "Deactivate a device",
  description: "Revokes its refresh tokens and deletes its push token; the phone must join again.",
  tags: ["Devices"],
  auth: "manager",
  permission: "employees:write",
  request: { params: id, body: deactivateDeviceSchema },
  responses: { 200: deviceResponseSchema },
});

// ── Work policies ───────────────────────────────────────────────────────────

defineRoute({
  method: "GET",
  path: "/api/policies",
  summary: "List Work Policies",
  tags: ["Policies"],
  auth: "manager",
  permission: "policies:read",
  request: { query: policyQuerySchema },
  responses: { 200: listPoliciesResponseSchema },
});

defineRoute({
  method: "POST",
  path: "/api/policies",
  summary: "Create a Work Policy (draft version 1)",
  tags: ["Policies"],
  auth: "manager",
  permission: "policies:write",
  request: { body: createPolicySchema },
  responses: { 201: policyResponseSchema },
});

defineRoute({
  method: "GET",
  path: "/api/policies/:id",
  summary: "Get a Work Policy",
  tags: ["Policies"],
  auth: "manager",
  permission: "policies:read",
  request: { params: id },
  responses: { 200: policyResponseSchema },
});

defineRoute({
  method: "PATCH",
  path: "/api/policies/:id",
  summary: "Update a Work Policy",
  description: "Config changes go into the draft version; publish to roll them out to devices.",
  tags: ["Policies"],
  auth: "manager",
  permission: "policies:write",
  request: { params: id, body: updatePolicySchema },
  responses: { 200: policyResponseSchema },
  errors: ["POLICY_ARCHIVED"],
});

defineRoute({
  method: "DELETE",
  path: "/api/policies/:id",
  summary: "Delete a Work Policy",
  description:
    "Only when nothing is assigned to it and it is not the organisation default (POLICY_ASSIGNED).",
  tags: ["Policies"],
  auth: "manager",
  permission: "policies:write",
  request: { params: id },
  responses: { 204: null },
  errors: ["POLICY_ASSIGNED"],
});

defineRoute({
  method: "POST",
  path: "/api/policies/:id/publish",
  summary: "Publish the draft version",
  description: "Devices pick it up on their next sync (a silent push is sent).",
  tags: ["Policies"],
  auth: "manager",
  permission: "policies:write",
  request: { params: id, body: publishPolicySchema },
  responses: { 200: policyResponseSchema },
  errors: ["POLICY_ARCHIVED", "CONFLICT"],
});

defineRoute({
  method: "POST",
  path: "/api/policies/:id/duplicate",
  summary: "Duplicate a Work Policy as a new draft",
  tags: ["Policies"],
  auth: "manager",
  permission: "policies:write",
  request: { params: id, body: duplicatePolicySchema },
  responses: { 201: policyResponseSchema },
});

defineRoute({
  method: "POST",
  path: "/api/policies/:id/archive",
  summary: "Archive a Work Policy",
  description:
    "Archived policies are skipped by resolution; employees fall back to the next scope.",
  tags: ["Policies"],
  auth: "manager",
  permission: "policies:write",
  request: { params: id, body: emptyBodySchema },
  responses: { 200: policyResponseSchema },
});

defineRoute({
  method: "GET",
  path: "/api/policies/:id/versions",
  summary: "List a Work Policy's versions",
  tags: ["Policies"],
  auth: "manager",
  permission: "policies:read",
  request: { params: id },
  responses: { 200: policyVersionsResponseSchema },
});

defineRoute({
  method: "GET",
  path: "/api/policies/:id/assignments",
  summary: "List a Work Policy's assignments",
  tags: ["Policies"],
  auth: "manager",
  permission: "policies:read",
  request: { params: id },
  responses: { 200: listPolicyAssignmentsResponseSchema },
});

defineRoute({
  method: "POST",
  path: "/api/policies/:id/assignments",
  summary: "Assign a Work Policy to the organisation, a location, a team or an employee",
  description:
    "Replaces any active assignment for the same scope (one active assignment per scope).",
  tags: ["Policies"],
  auth: "manager",
  permission: "policies:write",
  request: { params: id, body: createPolicyAssignmentSchema },
  responses: { 201: policyAssignmentResponseSchema },
  errors: ["POLICY_ARCHIVED", "POLICY_NOT_PUBLISHED"],
});

defineRoute({
  method: "DELETE",
  path: "/api/policy-assignments/:id",
  summary: "Remove a Work Policy assignment",
  tags: ["Policies"],
  auth: "manager",
  permission: "policies:write",
  request: { params: id },
  responses: { 204: null },
});

// ── Break policies ──────────────────────────────────────────────────────────

defineRoute({
  method: "GET",
  path: "/api/break-policies",
  summary: "List Break Policies",
  tags: ["Break policies"],
  auth: "manager",
  permission: "policies:read",
  request: { query: breakPolicyQuerySchema },
  responses: { 200: listBreakPoliciesResponseSchema },
});

defineRoute({
  method: "POST",
  path: "/api/break-policies",
  summary: "Create a Break Policy",
  tags: ["Break policies"],
  auth: "manager",
  permission: "policies:write",
  request: { body: createBreakPolicySchema },
  responses: { 201: breakPolicyResponseSchema },
});

defineRoute({
  method: "GET",
  path: "/api/break-policies/:id",
  summary: "Get a Break Policy",
  tags: ["Break policies"],
  auth: "manager",
  permission: "policies:read",
  request: { params: id },
  responses: { 200: breakPolicyResponseSchema },
});

defineRoute({
  method: "PATCH",
  path: "/api/break-policies/:id",
  summary: "Update a Break Policy",
  description: "Breaks already in progress keep the behaviour they started with.",
  tags: ["Break policies"],
  auth: "manager",
  permission: "policies:write",
  request: { params: id, body: updateBreakPolicySchema },
  responses: { 200: breakPolicyResponseSchema },
  errors: ["POLICY_ARCHIVED"],
});

defineRoute({
  method: "DELETE",
  path: "/api/break-policies/:id",
  summary: "Delete a Break Policy",
  tags: ["Break policies"],
  auth: "manager",
  permission: "policies:write",
  request: { params: id },
  responses: { 204: null },
  errors: ["POLICY_ASSIGNED"],
});

defineRoute({
  method: "GET",
  path: "/api/break-policies/:id/assignments",
  summary: "List a Break Policy's assignments",
  tags: ["Break policies"],
  auth: "manager",
  permission: "policies:read",
  request: { params: id },
  responses: { 200: listBreakPolicyAssignmentsResponseSchema },
});

defineRoute({
  method: "POST",
  path: "/api/break-policies/:id/assignments",
  summary: "Assign a Break Policy to a scope",
  tags: ["Break policies"],
  auth: "manager",
  permission: "policies:write",
  request: { params: id, body: createBreakPolicyAssignmentSchema },
  responses: { 201: breakPolicyAssignmentResponseSchema },
  errors: ["POLICY_ARCHIVED"],
});

defineRoute({
  method: "DELETE",
  path: "/api/break-policy-assignments/:id",
  summary: "Remove a Break Policy assignment",
  tags: ["Break policies"],
  auth: "manager",
  permission: "policies:write",
  request: { params: id },
  responses: { 204: null },
});

// ── Shifts ──────────────────────────────────────────────────────────────────

defineRoute({
  method: "GET",
  path: "/api/shifts",
  summary: "List shifts in a time range",
  description: "`from`/`to` are instants; the range may not exceed 93 days.",
  tags: ["Shifts"],
  auth: "manager",
  permission: "schedule:read",
  request: { query: shiftQuerySchema },
  responses: { 200: listShiftsResponseSchema },
});

defineRoute({
  method: "POST",
  path: "/api/shifts",
  summary: "Create a shift (optionally recurring)",
  description:
    "Either `date` + `startTime` + `endTime` (local wall-clock in `timezone`; an end at or before the start is overnight) or `startsAt` + `endsAt` instants.",
  tags: ["Shifts"],
  auth: "manager",
  permission: "schedule:write",
  request: { body: createShiftSchema },
  responses: { 201: createShiftResponseSchema },
  errors: [
    "EMPLOYEE_NOT_FOUND",
    "EMPLOYEE_INACTIVE",
    "SHIFT_TOO_SHORT",
    "SHIFT_OVERLAP",
    "INVALID_RECURRENCE",
    "INVALID_TIMEZONE",
  ],
});

defineRoute({
  method: "POST",
  path: "/api/shifts/bulk",
  summary: "Move, repeat, cancel or delete many shifts",
  tags: ["Shifts"],
  auth: "manager",
  permission: "schedule:write",
  request: { body: bulkShiftActionSchema },
  responses: { 200: bulkShiftActionResponseSchema },
});

defineRoute({
  method: "GET",
  path: "/api/shifts/:id",
  summary: "Get a shift",
  tags: ["Shifts"],
  auth: "manager",
  permission: "schedule:read",
  request: { params: id },
  responses: { 200: shiftResponseSchema },
});

defineRoute({
  method: "PATCH",
  path: "/api/shifts/:id",
  summary: "Update a shift",
  description:
    "Send `expectedVersion` for optimistic concurrency (CONFLICT when the shift changed meanwhile).",
  tags: ["Shifts"],
  auth: "manager",
  permission: "schedule:write",
  request: { params: id, body: updateShiftSchema },
  responses: { 200: shiftResponseSchema },
  errors: ["CONFLICT", "SHIFT_TOO_SHORT", "SHIFT_OVERLAP", "INVALID_TIMEZONE"],
});

defineRoute({
  method: "DELETE",
  path: "/api/shifts/:id",
  summary: "Delete a shift",
  tags: ["Shifts"],
  auth: "manager",
  permission: "schedule:write",
  request: { params: id },
  responses: { 204: null },
});

defineRoute({
  method: "POST",
  path: "/api/shifts/:id/duplicate",
  summary: "Copy a shift to another date",
  tags: ["Shifts"],
  auth: "manager",
  permission: "schedule:write",
  request: { params: id, body: duplicateShiftSchema },
  responses: { 201: shiftResponseSchema },
  errors: ["SHIFT_OVERLAP"],
});

defineRoute({
  method: "POST",
  path: "/api/shifts/:id/cancel",
  summary: "Cancel a shift",
  description: "Ends Work Mode immediately if the shift is in progress.",
  tags: ["Shifts"],
  auth: "manager",
  permission: "schedule:write",
  request: { params: id, body: cancelShiftSchema },
  responses: { 200: shiftResponseSchema },
});

// ── CSV imports ─────────────────────────────────────────────────────────────

defineRoute({
  method: "GET",
  path: "/api/imports",
  summary: "List recent shift imports",
  tags: ["Imports"],
  auth: "manager",
  permission: "schedule:read",
  request: { query: importQuerySchema },
  responses: { 200: listImportsResponseSchema },
});

defineRoute({
  method: "POST",
  path: "/api/imports",
  summary: "Upload a shift CSV",
  description:
    "multipart/form-data with `file` (≤ 5 MB, ≤ 5000 rows) and optional dateFormat / timezone / locationId.",
  tags: ["Imports"],
  auth: "manager",
  permission: "imports:write",
  request: { body: importUploadFormSchema, bodyContentType: "multipart/form-data" },
  responses: { 201: createImportResponseSchema },
  errors: ["INVALID_CSV", "PAYLOAD_TOO_LARGE", "UNSUPPORTED_MEDIA_TYPE"],
});

defineRoute({
  method: "GET",
  path: "/api/imports/:id",
  summary: "Get a shift import",
  tags: ["Imports"],
  auth: "manager",
  permission: "schedule:read",
  request: { params: id },
  responses: { 200: importResponseSchema },
});

defineRoute({
  method: "POST",
  path: "/api/imports/:id/mapping",
  summary: "Save the column mapping",
  tags: ["Imports"],
  auth: "manager",
  permission: "imports:write",
  request: { params: id, body: importMappingSchema },
  responses: { 200: importResponseSchema },
  errors: ["IMPORT_INVALID_STATE", "IMPORT_MAPPING_INCOMPLETE", "INVALID_TIMEZONE"],
});

defineRoute({
  method: "POST",
  path: "/api/imports/:id/validate",
  summary: "Parse, match and validate every row",
  tags: ["Imports"],
  auth: "manager",
  permission: "imports:write",
  request: { params: id, body: emptyBodySchema },
  responses: { 200: validateImportResponseSchema },
  errors: ["IMPORT_INVALID_STATE", "IMPORT_MAPPING_INCOMPLETE"],
});

defineRoute({
  method: "GET",
  path: "/api/imports/:id/rows",
  summary: "List import rows",
  tags: ["Imports"],
  auth: "manager",
  permission: "schedule:read",
  request: { params: id, query: importRowsQuerySchema },
  responses: { 200: listImportRowsResponseSchema },
});

defineRoute({
  method: "PATCH",
  path: "/api/imports/:id/rows/:rowId",
  summary: "Resolve an import row",
  description:
    "Match an existing employee, create one at commit, or skip the row. The row is re-validated.",
  tags: ["Imports"],
  auth: "manager",
  permission: "imports:write",
  request: { params: importRowParamsSchema, body: updateImportRowSchema },
  responses: { 200: importRowResponseSchema },
  errors: ["IMPORT_INVALID_STATE", "EMPLOYEE_NOT_FOUND"],
});

defineRoute({
  method: "POST",
  path: "/api/imports/:id/commit",
  summary: "Create the shifts",
  tags: ["Imports"],
  auth: "manager",
  permission: "imports:write",
  request: { params: id, body: commitImportSchema },
  responses: { 200: commitImportResponseSchema },
  errors: ["IMPORT_INVALID_STATE", "IMPORT_HAS_ERRORS"],
});

defineRoute({
  method: "GET",
  path: "/api/imports/:id/errors.csv",
  summary: "Download rows with problems as CSV",
  tags: ["Imports"],
  auth: "manager",
  permission: "schedule:read",
  request: { params: id },
  responses: {
    200: {
      contentType: "text/csv",
      schema: z.string(),
      description: "The original columns plus `row_number`, `status` and `problems` (attachment).",
    },
  },
});

// ── Integrations ────────────────────────────────────────────────────────────

defineRoute({
  method: "GET",
  path: "/api/integrations",
  summary: "List workforce integrations",
  tags: ["Integrations"],
  auth: "manager",
  responses: { 200: listIntegrationsResponseSchema },
});

defineRoute({
  method: "POST",
  path: "/api/integrations/:provider/connect",
  summary: "Connect a provider",
  description:
    "Every provider is COMING_SOON in the MVP: this returns 501 until the provider is available.",
  tags: ["Integrations"],
  auth: "manager",
  permission: "integrations:write",
  request: { params: integrationParamsSchema, body: connectIntegrationSchema },
  responses: { 200: connectIntegrationResponseSchema },
  errors: ["COMING_SOON"],
});

defineRoute({
  method: "POST",
  path: "/api/integrations/:provider/disconnect",
  summary: "Disconnect a provider",
  description: "Deletes stored credentials. Imported shifts are kept.",
  tags: ["Integrations"],
  auth: "manager",
  permission: "integrations:write",
  request: { params: integrationParamsSchema, body: integrationActionSchema },
  responses: { 200: integrationResponseSchema },
});

defineRoute({
  method: "POST",
  path: "/api/integrations/:provider/sync",
  summary: "Sync now",
  tags: ["Integrations"],
  auth: "manager",
  permission: "integrations:write",
  request: { params: integrationParamsSchema, body: integrationActionSchema },
  responses: { 200: syncIntegrationResponseSchema },
  errors: ["COMING_SOON", "CONFLICT"],
});

defineRoute({
  method: "POST",
  path: "/api/integrations/:provider/notify-me",
  summary: "Ask to be notified when a provider becomes available",
  tags: ["Integrations"],
  auth: "manager",
  request: { params: integrationParamsSchema, body: integrationActionSchema },
  responses: { 200: integrationResponseSchema },
});

// ── Compliance & activity ───────────────────────────────────────────────────

defineRoute({
  method: "GET",
  path: "/api/compliance/summary",
  summary: "Compliance dashboard metrics",
  tags: ["Compliance"],
  auth: "manager",
  permission: "employees:read",
  responses: { 200: complianceSummaryResponseSchema },
});

defineRoute({
  method: "GET",
  path: "/api/compliance/employees",
  summary: "Employees behind a compliance metric",
  tags: ["Compliance"],
  auth: "manager",
  permission: "employees:read",
  request: { query: complianceEmployeesQuerySchema },
  responses: { 200: complianceEmployeesResponseSchema },
});

defineRoute({
  method: "GET",
  path: "/api/activity",
  summary: "Activity feed",
  tags: ["Activity"],
  auth: "manager",
  permission: "employees:read",
  request: { query: activityQuerySchema },
  responses: { 200: listActivityResponseSchema },
});

// ── Locations, departments, teams ───────────────────────────────────────────

defineRoute({
  method: "GET",
  path: "/api/locations",
  summary: "List locations",
  tags: ["Locations"],
  auth: "manager",
  responses: { 200: listLocationsResponseSchema },
});

defineRoute({
  method: "POST",
  path: "/api/locations",
  summary: "Create a location",
  tags: ["Locations"],
  auth: "manager",
  permission: "org:manage",
  request: { body: createLocationSchema },
  responses: { 201: locationResponseSchema },
  errors: ["INVALID_TIMEZONE", "CONFLICT"],
});

defineRoute({
  method: "GET",
  path: "/api/locations/:id",
  summary: "Get a location",
  tags: ["Locations"],
  auth: "manager",
  request: { params: id },
  responses: { 200: locationResponseSchema },
});

defineRoute({
  method: "PATCH",
  path: "/api/locations/:id",
  summary: "Update a location",
  tags: ["Locations"],
  auth: "manager",
  permission: "org:manage",
  request: { params: id, body: updateLocationSchema },
  responses: { 200: locationResponseSchema },
  errors: ["INVALID_TIMEZONE", "CONFLICT"],
});

defineRoute({
  method: "DELETE",
  path: "/api/locations/:id",
  summary: "Delete a location",
  description: "Soft delete. Employees and shifts keep working without a location.",
  tags: ["Locations"],
  auth: "manager",
  permission: "org:manage",
  request: { params: id },
  responses: { 204: null },
});

defineRoute({
  method: "GET",
  path: "/api/departments",
  summary: "List departments",
  tags: ["Departments"],
  auth: "manager",
  responses: { 200: listDepartmentsResponseSchema },
});

defineRoute({
  method: "POST",
  path: "/api/departments",
  summary: "Create a department",
  tags: ["Departments"],
  auth: "manager",
  permission: "org:manage",
  request: { body: createDepartmentSchema },
  responses: { 201: departmentResponseSchema },
  errors: ["CONFLICT"],
});

defineRoute({
  method: "GET",
  path: "/api/departments/:id",
  summary: "Get a department",
  tags: ["Departments"],
  auth: "manager",
  request: { params: id },
  responses: { 200: departmentResponseSchema },
});

defineRoute({
  method: "PATCH",
  path: "/api/departments/:id",
  summary: "Rename a department",
  tags: ["Departments"],
  auth: "manager",
  permission: "org:manage",
  request: { params: id, body: updateDepartmentSchema },
  responses: { 200: departmentResponseSchema },
  errors: ["CONFLICT"],
});

defineRoute({
  method: "DELETE",
  path: "/api/departments/:id",
  summary: "Delete a department",
  description: "Employees in it are left without a department.",
  tags: ["Departments"],
  auth: "manager",
  permission: "org:manage",
  request: { params: id },
  responses: { 204: null },
});

defineRoute({
  method: "GET",
  path: "/api/teams",
  summary: "List teams",
  tags: ["Teams"],
  auth: "manager",
  request: { query: teamQuerySchema },
  responses: { 200: listTeamsResponseSchema },
});

defineRoute({
  method: "POST",
  path: "/api/teams",
  summary: "Create a team",
  tags: ["Teams"],
  auth: "manager",
  permission: "org:manage",
  request: { body: createTeamSchema },
  responses: { 201: teamResponseSchema },
});

defineRoute({
  method: "GET",
  path: "/api/teams/:id",
  summary: "Get a team",
  tags: ["Teams"],
  auth: "manager",
  request: { params: id },
  responses: { 200: teamResponseSchema },
});

defineRoute({
  method: "PATCH",
  path: "/api/teams/:id",
  summary: "Update a team",
  tags: ["Teams"],
  auth: "manager",
  permission: "org:manage",
  request: { params: id, body: updateTeamSchema },
  responses: { 200: teamResponseSchema },
});

defineRoute({
  method: "DELETE",
  path: "/api/teams/:id",
  summary: "Delete a team",
  tags: ["Teams"],
  auth: "manager",
  permission: "org:manage",
  request: { params: id },
  responses: { 204: null },
});

defineRoute({
  method: "POST",
  path: "/api/teams/:id/members",
  summary: "Add employees to a team",
  description: "Idempotent: employees already in the team are ignored.",
  tags: ["Teams"],
  auth: "manager",
  permission: "employees:write",
  request: { params: id, body: addTeamMembersSchema },
  responses: { 200: teamResponseSchema },
  errors: ["EMPLOYEE_NOT_FOUND"],
});

defineRoute({
  method: "DELETE",
  path: "/api/teams/:id/members/:employeeId",
  summary: "Remove an employee from a team",
  tags: ["Teams"],
  auth: "manager",
  permission: "employees:write",
  request: { params: teamMemberParamsSchema },
  responses: { 204: null },
});

// ── Settings ────────────────────────────────────────────────────────────────

defineRoute({
  method: "GET",
  path: "/api/settings",
  summary: "Organisation settings and your notification preferences",
  tags: ["Settings"],
  auth: "manager",
  responses: { 200: settingsResponseSchema },
});

defineRoute({
  method: "PATCH",
  path: "/api/settings",
  summary: "Update settings",
  description:
    "Changing `organisation` requires org:manage; `notificationPreferences` are your own.",
  tags: ["Settings"],
  auth: "manager",
  request: { body: updateSettingsSchema },
  responses: { 200: settingsResponseSchema },
  errors: ["INVALID_TIMEZONE"],
});

defineRoute({
  method: "GET",
  path: "/api/settings/billing",
  summary: "Plan, limits and usage",
  tags: ["Settings"],
  auth: "manager",
  responses: { 200: billingResponseSchema },
});

// ── Overrides ───────────────────────────────────────────────────────────────

defineRoute({
  method: "GET",
  path: "/api/overrides",
  summary: "List manager overrides",
  tags: ["Overrides"],
  auth: "manager",
  permission: "employees:read",
  request: { query: overrideQuerySchema },
  responses: { 200: listOverridesResponseSchema },
});

defineRoute({
  method: "POST",
  path: "/api/overrides",
  summary: "Create a manager override",
  description:
    "`durationMinutes` defaults to 60. Non-OWNERs are capped at 1440 minutes (24 h), OWNERs at 10080 (7 days): OVERRIDE_TOO_LONG.",
  tags: ["Overrides"],
  auth: "manager",
  permission: "overrides:create",
  request: { body: createOverrideSchema },
  responses: { 201: overrideResponseSchema },
  errors: ["OVERRIDE_TOO_LONG", "EMPLOYEE_NOT_FOUND", "EMPLOYEE_INACTIVE"],
});

defineRoute({
  method: "POST",
  path: "/api/overrides/:id/revoke",
  summary: "Revoke an override",
  tags: ["Overrides"],
  auth: "manager",
  permission: "overrides:create",
  request: { params: id, body: revokeOverrideSchema },
  responses: { 200: overrideResponseSchema },
  errors: ["OVERRIDE_EXPIRED"],
});

// ── Audit logs, notifications, realtime ─────────────────────────────────────

defineRoute({
  method: "GET",
  path: "/api/audit-logs",
  summary: "Audit log of manager actions",
  tags: ["Audit logs"],
  auth: "manager",
  permission: "audit:read",
  request: { query: auditLogQuerySchema },
  responses: { 200: listAuditLogsResponseSchema },
});

defineRoute({
  method: "GET",
  path: "/api/notifications",
  summary: "Your notifications",
  tags: ["Notifications"],
  auth: "manager",
  request: { query: notificationQuerySchema },
  responses: { 200: listNotificationsResponseSchema },
});

defineRoute({
  method: "POST",
  path: "/api/notifications/read-all",
  summary: "Mark all your notifications as read",
  tags: ["Notifications"],
  auth: "manager",
  request: { body: emptyBodySchema },
  responses: { 200: markAllNotificationsReadResponseSchema },
});

defineRoute({
  method: "POST",
  path: "/api/notifications/:id/read",
  summary: "Mark a notification as read",
  tags: ["Notifications"],
  auth: "manager",
  request: { params: id, body: emptyBodySchema },
  responses: { 200: notificationResponseSchema },
});

defineRoute({
  method: "GET",
  path: "/api/realtime/stream",
  summary: "Server-Sent Events stream for the current organisation",
  description:
    "`text/event-stream`. Each frame: `event: <type>`, `id: <n>`, `data: <SseEvent JSON>`. A `: ping` comment is sent every 25 s. Events are invalidation hints; refetch the affected resource.",
  tags: ["Realtime"],
  auth: "manager",
  request: { query: realtimeStreamQuerySchema },
  responses: {
    200: {
      contentType: "text/event-stream",
      schema: sseEventSchema,
      description: "Stream of SseEvent frames.",
    },
  },
});

// ── Mobile API (/api/mobile/v1) ─────────────────────────────────────────────

defineRoute({
  method: "POST",
  path: m("/join/lookup"),
  summary: "Find the employee record to join as",
  description:
    "Public and rate limited. The match is by company code + name (+ invite code when names are ambiguous).",
  tags: ["Mobile"],
  auth: "public",
  request: { body: joinLookupSchema },
  responses: { 200: joinLookupResponseSchema },
  errors: ["INVALID_COMPANY_CODE", "INVALID_INVITE_CODE"],
  rateLimit: "mobileJoin",
});

defineRoute({
  method: "POST",
  path: m("/join/confirm"),
  summary: "Link this phone to the employee and get tokens",
  tags: ["Mobile"],
  auth: "public",
  request: { body: joinConfirmSchema },
  responses: { 201: joinConfirmResponseSchema },
  errors: [
    "INVALID_COMPANY_CODE",
    "AMBIGUOUS_MATCH",
    "INVALID_INVITE_CODE",
    "EMPLOYEE_NOT_FOUND",
    "EMPLOYEE_INACTIVE",
    "EMPLOYEE_ALREADY_LINKED",
  ],
  rateLimit: "mobileJoin",
});

defineRoute({
  method: "POST",
  path: m("/auth/refresh"),
  summary: "Rotate tokens",
  description:
    "Single-use refresh tokens. Presenting a rotated token revokes the whole token family (TOKEN_REUSED).",
  tags: ["Mobile"],
  auth: "public",
  request: { body: mobileRefreshSchema },
  responses: { 200: mobileRefreshResponseSchema },
  errors: ["INVALID_TOKEN", "TOKEN_EXPIRED", "TOKEN_REUSED", "DEVICE_INACTIVE"],
  rateLimit: "mobileRefresh",
});

defineRoute({
  method: "POST",
  path: m("/auth/logout"),
  summary: "Revoke this device's tokens",
  tags: ["Mobile"],
  auth: "mobile",
  request: { body: mobileLogoutSchema },
  responses: { 204: null },
});

defineRoute({
  method: "POST",
  path: m("/leave-workplace"),
  summary: "Unlink this phone from the employer",
  description:
    "Deactivates the device, deletes its push token and revokes its tokens. The app clears its local data.",
  tags: ["Mobile"],
  auth: "mobile",
  request: { body: leaveWorkplaceSchema },
  responses: { 200: okResponseSchema },
});

defineRoute({
  method: "GET",
  path: m("/me"),
  summary: "The employee, organisation and resolved policies",
  tags: ["Mobile"],
  auth: "mobile",
  request: { query: emptyQuerySchema },
  responses: { 200: mobileMeResponseSchema },
  errors: ["EMPLOYEE_INACTIVE"],
});

defineRoute({
  method: "GET",
  path: m("/schedule"),
  summary: "This employee's shifts",
  tags: ["Mobile"],
  auth: "mobile",
  request: { query: mobileScheduleQuerySchema },
  responses: { 200: mobileScheduleResponseSchema },
});

defineRoute({
  method: "GET",
  path: m("/sync"),
  summary: "Everything the device needs to enforce Work Mode offline",
  tags: ["Mobile"],
  auth: "mobile",
  request: { query: mobileSyncQuerySchema },
  responses: { 200: mobileSyncResponseSchema },
  errors: ["EMPLOYEE_INACTIVE"],
});

defineRoute({
  method: "POST",
  path: m("/device/state"),
  summary: "Report device compliance state",
  description:
    "Operational fields only (§12). Records clock skew; returns the server's expected state.",
  tags: ["Mobile"],
  auth: "mobile",
  request: { body: deviceStateReportSchema },
  responses: { 200: deviceStateResponseSchema },
  errors: ["CLOCK_SKEW"],
});

defineRoute({
  method: "POST",
  path: m("/events"),
  summary: "Upload queued device events",
  description:
    "Idempotent per clientEventId. At most 200 events; only DeviceReportableEventType values are accepted.",
  tags: ["Mobile"],
  auth: "mobile",
  request: { body: deviceEventsSchema },
  responses: { 200: deviceEventsResponseSchema },
  errors: ["UNKNOWN_EVENT_TYPE"],
});

defineRoute({
  method: "POST",
  path: m("/breaks/start"),
  summary: "Start a break",
  description: "Idempotent on clientBreakId. Rules are evaluated on the server clock (§6.3).",
  tags: ["Mobile"],
  auth: "mobile",
  request: { body: mobileStartBreakSchema },
  responses: { 201: mobileBreakResponseSchema },
  errors: [
    "BREAKS_DISABLED",
    "EMPLOYEE_BREAKS_NOT_ALLOWED",
    "BREAK_TOO_LONG",
    "NOT_ON_SHIFT",
    "BREAK_ALREADY_ACTIVE",
    "BREAK_LIMIT_REACHED",
    "BREAK_TOO_SOON",
  ],
});

defineRoute({
  method: "POST",
  path: m("/breaks/:id/end"),
  summary: "End a break",
  description: "Idempotent: ending an already-ended break returns it unchanged.",
  tags: ["Mobile"],
  auth: "mobile",
  request: { params: mobileBreakParamsSchema, body: mobileEndBreakSchema },
  responses: { 200: mobileBreakResponseSchema },
  errors: ["BREAK_NOT_ACTIVE"],
});

defineRoute({
  method: "POST",
  path: m("/device/push-token"),
  summary: "Register the APNs push token",
  description:
    "Encrypted at rest; used only to trigger a silent sync. Replaces any previous token for this device.",
  tags: ["Mobile"],
  auth: "mobile",
  request: { body: pushTokenSchema },
  responses: { 200: okResponseSchema },
});

defineRoute({
  method: "POST",
  path: "/api/request-demo",
  summary: "Request a demo (marketing site)",
  description:
    "Public lead capture for the marketing site. Rate limited (5 per hour per IP), Origin-checked, and the optional `website` honeypot field must stay empty.",
  tags: ["Marketing"],
  auth: "public",
  request: { body: requestDemoSchema },
  responses: { 200: requestDemoResponseSchema },
  errors: ["RATE_LIMITED"],
});

/** Every registered route (re-exported for the generator and tests). */
export const routes = registry;
