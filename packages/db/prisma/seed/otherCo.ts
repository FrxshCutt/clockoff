import type { RestrictionConfig } from "@workmode/shared/policy/resolvePolicy";
import { isRestrictionConfig } from "@workmode/shared/policy/resolvePolicy";
import { deriveInviteStatus } from "@workmode/shared/status/deriveDeviceStatus";
import { OrgBuilder, type ActorMeta, type BuiltDevice, type BuiltEmployee } from "./builder";
import type { SeedClock } from "./clock";
import type { SeedRows } from "./collector";
import { OTHER_CO, organisationIdFor, userIdFor } from "./constants";
import { addMinutes, invariant, toJson } from "./util";

/**
 * "Other Co" — a second, deliberately small organisation so tenant-isolation checks (and manual testing of
 * the organisation switcher) have a foreign tenant with every row type that has a by-id endpoint.
 */

export interface OtherCoSeed {
  rows: SeedRows;
  organisationId: string;
}

export function buildOtherCo(clock: SeedClock, hashFor: (email: string) => string): OtherCoSeed {
  const org = OTHER_CO;
  const organisationId = organisationIdFor(org.key);
  const b = new OrgBuilder(clock, org.key, organisationId, org.timezone);
  const { rows } = b;
  const tz = org.timezone;

  const createdAt = clock.daysAgo(9);
  const owner: ActorMeta = {
    userId: userIdFor(org.managers.owner.email),
    ip: "192.0.2.44",
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36",
  };
  rows.users.push({
    id: owner.userId,
    email: org.managers.owner.email,
    name: org.managers.owner.name,
    passwordHash: hashFor(org.managers.owner.email),
    emailVerifiedAt: createdAt,
    lastLoginAt: clock.daysAgo(1),
    createdAt,
  });
  rows.organisations.push({
    id: organisationId,
    name: org.name,
    slug: org.slug,
    timezone: tz,
    dateFormat: "DMY",
    billingStatus: "TRIAL",
    plan: "STARTER",
    onboardingState: toJson({ createCompany: true, dismissedAt: null }),
    settings: toJson({ weekStartsOn: "MONDAY", timeFormat: "H24", requireInviteCodeToJoin: true }),
    createdAt,
  });
  rows.memberships.push({
    id: b.id("membership:owner"),
    userId: owner.userId,
    organisationId,
    role: "OWNER",
    notificationPreferences: {},
    createdAt,
  });
  b.audit(owner, "organisation.created", "Organisation", organisationId, createdAt, {
    after: { name: org.name, slug: org.slug, timezone: tz },
  });

  rows.joinCodes.push({
    id: b.id("join-code:active"),
    organisationId,
    code: org.joinCode,
    status: "ACTIVE",
    createdById: owner.userId,
    createdAt,
  });

  const locationId = b.id("location:hq");
  rows.locations.push({
    id: locationId,
    organisationId,
    name: "Other Co HQ",
    address: "1 Example Way, Reading RG1 1AA",
    timezone: null,
    createdAt,
  });
  b.audit(owner, "location.created", "Location", locationId, createdAt, {
    after: { name: "Other Co HQ", address: "1 Example Way, Reading RG1 1AA", timezone: null },
  });

  // One ACTIVE Work Policy, the organisation default.
  const policyId = b.id("policy:standard");
  const versionId = b.id("policy-version:standard:1");
  const config: RestrictionConfig = {
    categories: [
      "SOCIAL_MEDIA",
      "GAMES",
      "ENTERTAINMENT",
      "STREAMING",
      "VIDEO",
      "SHOPPING",
      "DATING",
    ],
    requireEmployeeAppSelection: true,
    alwaysAllowedNote: [
      "Phone, Messages and FaceTime",
      "Maps, Camera and Clock",
      "Emergency SOS and Medical ID",
    ],
    shieldMessage: "Work Mode is on. This app will be available again after your shift.",
    activationMode: "SCHEDULED",
    preShiftWarningMinutes: 10,
  };
  invariant(isRestrictionConfig(config), "Other Co restriction config has the shared shape");
  const policyCreatedAt = addMinutes(createdAt, 30);
  const publishedAt = addMinutes(createdAt, 45);
  rows.policies.push({
    id: policyId,
    organisationId,
    name: "Other Co Standard",
    description: "Default policy for all Other Co staff.",
    status: "ACTIVE",
    createdAt: policyCreatedAt,
  });
  rows.policyVersions.push({
    id: versionId,
    policyId,
    versionNumber: 1,
    restrictionConfig: toJson(config),
    breakBehaviourDefault: toJson({ restrictionBehaviour: "RELAX_ALL", relaxedCategories: [] }),
    createdById: owner.userId,
    changeNote: "Initial version",
    publishedAt,
    createdAt: policyCreatedAt,
  });
  rows.policyCurrentVersions.push({ policyId, versionId });
  rows.organisationDefaults.push({
    organisationId,
    defaultPolicyId: policyId,
    defaultBreakPolicyId: null,
  });
  b.audit(owner, "policy.created", "Policy", policyId, policyCreatedAt, {
    after: {
      name: "Other Co Standard",
      description: "Default policy for all Other Co staff.",
      status: "DRAFT",
      versionId,
      versionNumber: 1,
      restrictionConfig: config,
    },
  });
  b.audit(owner, "policy.published", "Policy", policyId, publishedAt, {
    before: { status: "DRAFT", currentVersionId: null, draftVersionId: versionId },
    after: {
      status: "ACTIVE",
      currentVersionId: versionId,
      versionNumber: 1,
      changeNote: "Initial version",
      publishedAt,
    },
  });
  b.audit(
    owner,
    "organisation.default_policy_changed",
    "Organisation",
    organisationId,
    addMinutes(publishedAt, 1),
    {
      before: { defaultPolicyId: null },
      after: { defaultPolicyId: policyId },
    },
  );
  b.activity({
    type: "POLICY_UPDATED",
    at: publishedAt,
    actor: "MANAGER",
    actorUserId: owner.userId,
    metadata: { policyId, versionId, versionNumber: 1 },
  });

  // Two employees: one connected, one never invited.
  const alexDevice = {
    permission: "APPROVED" as const,
    selection: "CONFIGURED" as const,
    isActive: true,
  };
  const alex: BuiltEmployee = {
    key: "alex",
    id: b.id("employee:alex"),
    firstName: "Alex",
    lastName: "Rivera",
    inviteStatus: deriveInviteStatus({
      hasLink: true,
      device: {
        permissionState: alexDevice.permission,
        selectionState: alexDevice.selection,
        isActive: true,
      },
      employmentStatus: "ACTIVE",
      hasPendingInvite: false,
    }),
    employmentStatus: "ACTIVE",
    teamIds: [],
    primaryLocationId: locationId,
    preShiftWarningMinutes: config.preShiftWarningMinutes,
    workPolicyVersionId: versionId,
  };
  const jordan: BuiltEmployee = {
    key: "jordan",
    id: b.id("employee:jordan"),
    firstName: "Jordan",
    lastName: "Blake",
    inviteStatus: deriveInviteStatus({
      hasLink: false,
      device: null,
      employmentStatus: "ACTIVE",
      hasPendingInvite: false,
    }),
    employmentStatus: "ACTIVE",
    teamIds: [],
    primaryLocationId: locationId,
    preShiftWarningMinutes: config.preShiftWarningMinutes,
    workPolicyVersionId: versionId,
  };
  const employeesCreatedAt = addMinutes(createdAt, 90);
  for (const [employee, email, externalId] of [
    [alex, "alex.rivera@otherco.test", "OC-001"],
    [jordan, "jordan.blake@otherco.test", "OC-002"],
  ] as const) {
    rows.employees.push({
      id: employee.id,
      organisationId,
      firstName: employee.firstName,
      lastName: employee.lastName,
      email,
      externalEmployeeId: externalId,
      jobTitle: "Associate",
      primaryLocationId: locationId,
      employmentStatus: "ACTIVE",
      inviteStatus: employee.inviteStatus,
      createdAt: employeesCreatedAt,
    });
    rows.employeeLocations.push({
      employeeId: employee.id,
      locationId,
      createdAt: employeesCreatedAt,
    });
    b.audit(owner, "employee.created", "Employee", employee.id, employeesCreatedAt, {
      after: {
        firstName: employee.firstName,
        lastName: employee.lastName,
        email,
        externalEmployeeId: externalId,
        jobTitle: "Associate",
        primaryLocationId: locationId,
        locationIds: [locationId],
        teamIds: [],
        employmentStatus: "ACTIVE",
        inviteStatus: "NOT_INVITED",
      },
    });
  }

  const device: BuiltDevice = {
    id: b.id("device:alex"),
    mobileUserId: b.id("mobile-user:alex"),
    employee: alex,
    linkedAt: clock.daysAgo(7),
    lastDeviceSyncAt: clock.minutesAgo(10),
    lastSeenAt: null,
    isActive: true,
    deactivatedAt: null,
    permissionState: alexDevice.permission,
    selectionState: alexDevice.selection,
    counts: { categories: 4, applications: 0, webDomains: 0 },
    model: "iPhone 14",
    os: "18.6",
    appVersion: "1.4.0",
    reports: true,
    skewSeconds: 3,
    scheduleVersion: 2,
  };
  b.addDevice(device);

  // A few shifts: one completed, one tomorrow, one later in the week, one for the uninvited employee.
  const rotaAt = clock.daysAgo(4);
  for (const [employee, day] of [
    [alex, -2],
    [alex, 1],
    [alex, 3],
    [jordan, 2],
  ] as const) {
    const window = clock.shiftWindow(day, "09:00", "17:00");
    b.addShift({
      key: `${employee.key}:${day}`,
      employee,
      startsAt: window.startsAt,
      endsAt: window.endsAt,
      locationId,
      createdAt: rotaAt,
      createdBy: owner,
      breaks: [[240, 30]],
    });
  }
  b.assertNoShiftOverlaps();

  const evaluations = b.materialiseDevices();
  invariant(evaluations.length === 1, "Other Co has one device");
  b.activity({
    type: "EMPLOYEE_JOINED",
    at: device.linkedAt,
    actor: "EMPLOYEE_DEVICE",
    employeeId: alex.id,
    deviceId: device.id,
    clientEventId: "join",
    metadata: {
      deviceId: device.id,
      platform: "IOS",
      viaInviteCode: false,
      acceptedInvites: 0,
      retiredDevices: 0,
    },
  });
  b.activity({
    type: "SETUP_COMPLETED",
    at: addMinutes(device.linkedAt, 9),
    actor: "EMPLOYEE_DEVICE",
    employeeId: alex.id,
    deviceId: device.id,
    clientEventId: "setup:completed",
    metadata: {
      permissionState: "APPROVED",
      selectionState: "CONFIGURED",
      selectionCounts: device.counts,
    },
  });
  b.recordWorkModeEvents(device);

  return { rows, organisationId };
}
