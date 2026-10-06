import type {
  BreakEndReason,
  BreakRestrictionBehaviour,
  EmployeeInviteStatus,
  EmploymentStatus,
  InviteChannel,
  PermissionState,
  PolicyStatus,
  RestrictionCategory,
  SelectionState,
} from "@workmode/shared/enums";
import { generateEmployeeInviteCode } from "@workmode/shared/joinCode";
import {
  fromBreakPolicyAssignment,
  indexPoliciesById,
  isRestrictionConfig,
  resolvePolicy,
  type AssignmentLike,
  type RestrictionConfig,
} from "@workmode/shared/policy/resolvePolicy";
import { deriveInviteStatus } from "@workmode/shared/status/deriveDeviceStatus";
import { expandShiftSeries, validateRecurrenceRule } from "@workmode/shared/time/time";
import {
  OrgBuilder,
  type ActorMeta,
  type BuiltDevice,
  type BuiltEmployee,
  type BuiltShift,
} from "./builder";
import type { SeedClock } from "./clock";
import type { SeedRows } from "./collector";
import { HARPENDEN, organisationIdFor, userIdFor } from "./constants";
import { addMinutes, addSeconds, invariant, randomTokenHash, toDmy, toJson } from "./util";

/**
 * Harpenden Coffee Co. — the demo organisation (§15). Three cafés, six Work Policies, three Break Policies,
 * sixteen employees covering every lifecycle state and status badge, two weeks of shifts around `now`, a
 * committed CSV import, an expired override, an activity feed and an audit trail. See seed/README.md.
 */

const DAY = 24 * 60;
const UA_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_6) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15";
const UA_WIN =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";
const UA_IPAD =
  "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

type ManagerKey = keyof typeof HARPENDEN.managers;
type LocationKey = "harpenden" | "stalbans" | "luton";
type DepartmentKey = "foh" | "kitchen" | "management";
type TeamDepartment = Exclude<DepartmentKey, "management">;
type WorkPolicyKey = "standard" | "foh" | "kitchen" | "management" | "social" | "warehouse";
type BreakPolicyKey = "standardBreak" | "lunch" | "noPhone";
type EmployeeKey =
  | "zach"
  | "jack"
  | "sarah"
  | "tom"
  | "amelia"
  | "oliver"
  | "mia"
  | "noah"
  | "isla"
  | "leo"
  | "grace"
  | "harry"
  | "charlotte"
  | "james"
  | "ethan"
  | "sophie";

interface DeviceSpec {
  permission: PermissionState;
  selection: SelectionState;
  counts: { categories: number; applications: number; webDomains: number };
  model: string;
  os: string;
  appVersion: string;
  /** EmployeeUserLink.linkedAt and Device.createdAt. */
  linkedMinutesAgo: number;
  /** Device.lastDeviceSyncAt; null = never synced. */
  lastSyncMinutesAgo: number | null;
  /** Whether the device has ever reported an engine state. */
  reports: boolean;
  /** SETUP_COMPLETED (preceded by PERMISSION_GRANTED and SELECTION_CONFIGURED). */
  setupCompletedMinutesAgo?: number;
  /** PERMISSION_GRANTED without finishing app selection. */
  permissionGrantedMinutesAgo?: number;
  /** PERMISSION_NEEDS_ATTENTION after Screen Time was denied. */
  permissionDeniedMinutesAgo?: number;
  lastSeenMinutesAgo?: number;
  deactivatedMinutesAgo?: number;
  /** Device.lastClockSkewSeconds; null = never measured. */
  skewSeconds?: number | null;
  scheduleVersion?: number;
}

interface InviteSpec {
  channel: InviteChannel;
  status: EmployeeInviteStatus;
  code?: string;
  createdMinutesAgo: number;
  acceptedMinutesAgo?: number;
}

interface EmployeeSpec {
  key: EmployeeKey;
  firstName: string;
  lastName: string;
  email?: string;
  phone?: string;
  externalId?: string;
  jobTitle: string;
  department: DepartmentKey;
  location: LocationKey;
  /** Front of House / Kitchen staff belong to their location's team; management does not. */
  inTeam: boolean;
  secondaryLocations?: LocationKey[];
  createdMinutesAgo: number;
  employmentStatus: EmploymentStatus;
  deactivatedMinutesAgo?: number;
  device?: DeviceSpec;
  invite?: InviteSpec;
  /** What this employee demonstrates. */
  scenario: string;
}

interface ShiftPattern {
  emp: EmployeeKey;
  days: readonly number[];
  start: string;
  end: string;
  location?: LocationKey;
  breaks?: ReadonlyArray<readonly [number, number]>;
  /** Created yesterday by the supervisor (SHIFT_CREATED + audit) instead of with the published rota. */
  recent?: boolean;
}

interface BreakRules {
  breaksEnabled: boolean;
  maxBreaksPerShift: number;
  maxBreakDurationMinutes: number;
  maxTotalBreakMinutes: number;
  minGapBetweenBreaksMinutes: number;
  minMinutesAfterShiftStart: number;
  employeeTriggeredAllowed: boolean;
  scheduledBreaksAllowed: boolean;
  restrictionBehaviour: BreakRestrictionBehaviour;
  relaxedCategories: RestrictionCategory[];
}

interface PolicyVersionDef {
  config: RestrictionConfig;
  breakBehaviourDefault: { restrictionBehaviour: BreakRestrictionBehaviour; relaxedCategories: RestrictionCategory[] };
  createdAt: Date;
  publishedAt: Date | null;
  changeNote: string | null;
}

interface WorkPolicyDef {
  key: WorkPolicyKey;
  name: string;
  description: string;
  status: PolicyStatus;
  versions: PolicyVersionDef[];
}

interface BreakPolicyDef {
  key: BreakPolicyKey;
  name: string;
  description: string;
  rules: BreakRules;
  createdAt: Date;
}

export interface EmployeeSummary {
  name: string;
  scenario: string;
  inviteStatus: string;
  workPolicy: string;
  breakPolicy: string;
  badge: string;
  state: string;
  expected: string;
}

export interface HarpendenSeed {
  rows: SeedRows;
  organisationId: string;
  employees: EmployeeSummary[];
}

const ALWAYS_ALLOWED = [
  "Phone, Messages and FaceTime",
  "Maps, Camera and Clock",
  "Emergency SOS and Medical ID",
];

/** Builds a `PolicyVersion.restrictionConfig`, checked against the limits of `restrictionConfigSchema`. */
function restrictionConfig(input: {
  categories: RestrictionCategory[];
  shieldMessage: string;
  preShiftWarningMinutes: number;
  alwaysAllowedNote?: string[];
}): RestrictionConfig {
  const config: RestrictionConfig = {
    categories: input.categories,
    requireEmployeeAppSelection: true,
    alwaysAllowedNote: input.alwaysAllowedNote ?? ALWAYS_ALLOWED,
    shieldMessage: input.shieldMessage,
    activationMode: "SCHEDULED",
    preShiftWarningMinutes: input.preShiftWarningMinutes,
  };
  // The seed cannot import @workmode/validation, so the schema's limits are asserted by hand.
  invariant(isRestrictionConfig(config), "restriction config has the shared shape");
  invariant(
    config.categories.length >= 1 && new Set(config.categories).size === config.categories.length,
    "restriction categories must be unique and non-empty",
  );
  invariant(
    config.shieldMessage !== undefined && config.shieldMessage.length >= 1 && config.shieldMessage.length <= 120,
    "shield message must be 1–120 characters",
  );
  invariant(
    config.preShiftWarningMinutes >= 0 && config.preShiftWarningMinutes <= 120,
    "preShiftWarningMinutes must be 0–120",
  );
  invariant(
    config.alwaysAllowedNote.length <= 20 &&
      config.alwaysAllowedNote.every((note) => note.length >= 1 && note.length <= 200),
    "alwaysAllowedNote limits",
  );
  return config;
}

function breakRules(overrides: Partial<BreakRules>): BreakRules {
  const rules: BreakRules = {
    breaksEnabled: true,
    maxBreaksPerShift: 2,
    maxBreakDurationMinutes: 15,
    maxTotalBreakMinutes: 30,
    minGapBetweenBreaksMinutes: 60,
    minMinutesAfterShiftStart: 60,
    employeeTriggeredAllowed: true,
    scheduledBreaksAllowed: true,
    restrictionBehaviour: "RELAX_ALL",
    relaxedCategories: [],
    ...overrides,
  };
  invariant(
    rules.maxBreakDurationMinutes <= rules.maxTotalBreakMinutes,
    "a single break cannot be longer than the total allowance",
  );
  invariant(
    !rules.breaksEnabled || (rules.maxBreaksPerShift >= 1 && rules.maxTotalBreakMinutes >= 1),
    "enabled breaks need an allowance",
  );
  return rules;
}

const RELAX_ALL_DEFAULT = { restrictionBehaviour: "RELAX_ALL" as const, relaxedCategories: [] };

export function buildHarpenden(clock: SeedClock, hashFor: (email: string) => string): HarpendenSeed {
  const org = HARPENDEN;
  const organisationId = organisationIdFor(org.key);
  const b = new OrgBuilder(clock, org.key, organisationId, org.timezone);
  const { rows } = b;
  const now = clock.now;
  const tz = org.timezone;
  const sevenDaysAgo = clock.daysAgo(7);

  // ── Managers ───────────────────────────────────────────────────────────────
  const managerCreatedAt: Record<ManagerKey, Date> = {
    owner: clock.daysAgo(30),
    admin: clock.daysAgo(28),
    manager: clock.daysAgo(28),
  };
  const managerLastLogin: Record<ManagerKey, Date> = {
    owner: clock.hoursAgo(2),
    admin: clock.daysAgo(1),
    manager: clock.minutesAgo(35),
  };
  const actors: Record<ManagerKey, ActorMeta> = {
    owner: { userId: userIdFor(org.managers.owner.email), ip: "203.0.113.10", userAgent: UA_MAC },
    admin: { userId: userIdFor(org.managers.admin.email), ip: "203.0.113.24", userAgent: UA_WIN },
    manager: { userId: userIdFor(org.managers.manager.email), ip: "198.51.100.7", userAgent: UA_IPAD },
  };
  for (const key of Object.keys(org.managers) as ManagerKey[]) {
    const manager = org.managers[key];
    rows.users.push({
      id: actors[key].userId,
      email: manager.email,
      name: manager.name,
      passwordHash: hashFor(manager.email),
      emailVerifiedAt: managerCreatedAt[key],
      lastLoginAt: managerLastLogin[key],
      createdAt: managerCreatedAt[key],
    });
    rows.memberships.push({
      id: b.id(`membership:${key}`),
      userId: actors[key].userId,
      organisationId,
      role: manager.role,
      notificationPreferences: {},
      createdAt: managerCreatedAt[key],
    });
    if (key !== "owner") {
      const invitedAt = addMinutes(managerCreatedAt[key], -90);
      b.audit(actors.owner, "member.invited", "ManagerInvite", b.id(`manager-invite:${key}`), invitedAt, {
        after: { email: manager.email, role: manager.role, expiresAt: addMinutes(invitedAt, 7 * DAY) },
      });
      b.audit(
        { ...actors[key] },
        "member.joined",
        "OrganisationMembership",
        b.id(`membership:${key}`),
        managerCreatedAt[key],
        { after: { userId: actors[key].userId, role: manager.role, createdAccount: true } },
      );
    }
  }

  // ── Organisation, join codes ───────────────────────────────────────────────
  const orgCreatedAt = managerCreatedAt.owner;
  rows.organisations.push({
    id: organisationId,
    name: org.name,
    slug: org.slug,
    timezone: tz,
    dateFormat: "DMY",
    billingStatus: "ACTIVE",
    plan: "BUSINESS",
    onboardingState: toJson({ createCompany: true, dismissedAt: clock.daysAgo(20) }),
    settings: toJson({ weekStartsOn: "MONDAY", timeFormat: "H24", requireInviteCodeToJoin: false }),
    createdAt: orgCreatedAt,
  });
  b.audit(actors.owner, "organisation.created", "Organisation", organisationId, orgCreatedAt, {
    after: { name: org.name, slug: org.slug, timezone: tz },
  });
  b.audit(actors.owner, "organisation.updated", "Organisation", organisationId, clock.daysAgo(27), {
    before: { settings: { requireInviteCodeToJoin: false, weekStartsOn: "MONDAY", timeFormat: "H24" } },
    after: { dateFormat: "DMY", settings: { requireInviteCodeToJoin: false, weekStartsOn: "MONDAY", timeFormat: "H24" } },
  });
  b.audit(actors.owner, "organisation.onboarding_dismissed", "Organisation", organisationId, clock.daysAgo(20), {
    after: { dismissedAt: clock.daysAgo(20) },
  });

  const revokedJoinCodeId = b.id("join-code:revoked");
  const activeJoinCodeId = b.id("join-code:active");
  rows.joinCodes.push(
    {
      id: revokedJoinCodeId,
      organisationId,
      code: org.revokedJoinCode,
      status: "REVOKED",
      createdById: actors.owner.userId,
      createdAt: orgCreatedAt,
      revokedAt: clock.daysAgo(12),
    },
    {
      id: activeJoinCodeId,
      organisationId,
      code: org.joinCode,
      status: "ACTIVE",
      createdById: actors.owner.userId,
      createdAt: clock.daysAgo(12),
    },
  );
  b.audit(actors.owner, "join_code.regenerated", "CompanyJoinCode", activeJoinCodeId, clock.daysAgo(12), {
    before: { id: revokedJoinCodeId, code: org.revokedJoinCode, status: "REVOKED" },
    after: { id: activeJoinCodeId, code: org.joinCode, status: "ACTIVE" },
  });

  // ── Locations, departments, teams ──────────────────────────────────────────
  const LOCATIONS: Record<LocationKey, { name: string; address: string }> = {
    harpenden: { name: "Harpenden", address: "12 High Street, Harpenden AL5 2RT" },
    stalbans: { name: "St Albans", address: "3 Market Place, St Albans AL3 5DG" },
    luton: { name: "Luton", address: "45 George Street, Luton LU1 2AF" },
  };
  const DEPARTMENTS: Record<DepartmentKey, string> = {
    foh: "Front of House",
    kitchen: "Kitchen",
    management: "Management",
  };
  const locationId = (key: LocationKey): string => b.id(`location:${key}`);
  const departmentId = (key: DepartmentKey): string => b.id(`department:${key}`);
  const teamId = (location: LocationKey, department: TeamDepartment): string =>
    b.id(`team:${location}:${department}`);
  const structureCreatedAt = clock.daysAgo(29);
  for (const key of Object.keys(LOCATIONS) as LocationKey[]) {
    const location = LOCATIONS[key];
    rows.locations.push({
      id: locationId(key),
      organisationId,
      name: location.name,
      address: location.address,
      timezone: null,
      createdAt: structureCreatedAt,
    });
    b.audit(actors.owner, "location.created", "Location", locationId(key), structureCreatedAt, {
      after: { name: location.name, address: location.address, timezone: null },
    });
  }
  for (const key of Object.keys(DEPARTMENTS) as DepartmentKey[]) {
    rows.departments.push({
      id: departmentId(key),
      organisationId,
      name: DEPARTMENTS[key],
      createdAt: structureCreatedAt,
    });
  }
  for (const location of Object.keys(LOCATIONS) as LocationKey[]) {
    for (const department of ["foh", "kitchen"] as const) {
      const name = `${LOCATIONS[location].name} ${DEPARTMENTS[department]}`;
      rows.teams.push({
        id: teamId(location, department),
        organisationId,
        name,
        locationId: locationId(location),
        createdAt: structureCreatedAt,
      });
      b.audit(actors.owner, "team.created", "Team", teamId(location, department), structureCreatedAt, {
        after: { name, locationId: locationId(location) },
      });
    }
  }

  // ── Work Policies ──────────────────────────────────────────────────────────
  const policyId = (key: WorkPolicyKey): string => b.id(`policy:${key}`);
  const versionId = (key: WorkPolicyKey, n: number): string => b.id(`policy-version:${key}:${n}`);
  const published = (createdAt: Date, afterMinutes: number) => addMinutes(createdAt, afterMinutes);

  const standardCreatedAt = clock.daysAgo(25);
  const managementCreatedAt = clock.daysAgo(6);
  const socialCreatedAt = clock.daysAgo(4);
  const policyDefs: WorkPolicyDef[] = [
    {
      key: "standard",
      name: "Standard Staff",
      description: "Organisation default: social media, games and entertainment are shielded during shifts.",
      status: "ACTIVE",
      versions: [
        {
          config: restrictionConfig({
            categories: ["SOCIAL_MEDIA", "GAMES", "ENTERTAINMENT"],
            shieldMessage: "Work Mode is on. This app will be available again after your shift.",
            preShiftWarningMinutes: 10,
          }),
          breakBehaviourDefault: RELAX_ALL_DEFAULT,
          createdAt: standardCreatedAt,
          publishedAt: published(standardCreatedAt, 20),
          changeNote: "Initial version",
        },
      ],
    },
    {
      key: "foh",
      name: "Front of House",
      description: "Counter and floor staff: also shields video and streaming apps while serving customers.",
      status: "ACTIVE",
      versions: [
        {
          config: restrictionConfig({
            categories: ["SOCIAL_MEDIA", "GAMES", "ENTERTAINMENT", "VIDEO", "STREAMING"],
            shieldMessage: "Work Mode is on while you're on the floor. See you after your shift!",
            preShiftWarningMinutes: 15,
          }),
          breakBehaviourDefault: RELAX_ALL_DEFAULT,
          createdAt: addMinutes(standardCreatedAt, 35),
          publishedAt: published(standardCreatedAt, 60),
          changeNote: "Initial version",
        },
      ],
    },
    {
      key: "kitchen",
      name: "Kitchen",
      description: "Kitchen and prep teams: shopping apps are shielded too; breaks keep restrictions by default.",
      status: "ACTIVE",
      versions: [
        {
          config: restrictionConfig({
            categories: ["SOCIAL_MEDIA", "GAMES", "VIDEO", "STREAMING", "SHOPPING"],
            shieldMessage: "Phones down in the kitchen. Work Mode lifts when your shift ends.",
            preShiftWarningMinutes: 10,
            alwaysAllowedNote: [...ALWAYS_ALLOWED, "Timer and Calculator"],
          }),
          breakBehaviourDefault: { restrictionBehaviour: "KEEP_RESTRICTIONS", relaxedCategories: [] },
          createdAt: addMinutes(standardCreatedAt, 70),
          publishedAt: published(standardCreatedAt, 95),
          changeNote: "Initial version",
        },
      ],
    },
    {
      key: "management",
      name: "Management",
      description: "Light-touch policy for store and assistant managers: only games are shielded.",
      status: "ACTIVE",
      versions: [
        {
          config: restrictionConfig({
            categories: ["GAMES"],
            shieldMessage: "Work Mode is on. Games are paused until the end of your shift.",
            preShiftWarningMinutes: 5,
            alwaysAllowedNote: [...ALWAYS_ALLOWED, "Email, Slack and the rota app"],
          }),
          breakBehaviourDefault: RELAX_ALL_DEFAULT,
          createdAt: managementCreatedAt,
          publishedAt: published(managementCreatedAt, 15),
          changeNote: "Initial version",
        },
      ],
    },
    {
      key: "social",
      name: "Social Media Team",
      description: "Marketing staff who post on behalf of the brand: social apps stay available; games, entertainment and streaming do not.",
      status: "ACTIVE",
      versions: [
        {
          config: restrictionConfig({
            categories: ["GAMES", "ENTERTAINMENT", "STREAMING"],
            shieldMessage: "Work Mode is on. Social apps stay open for posting; this one waits until later.",
            preShiftWarningMinutes: 10,
            alwaysAllowedNote: [...ALWAYS_ALLOWED, "Instagram, TikTok and X for brand posting"],
          }),
          breakBehaviourDefault: RELAX_ALL_DEFAULT,
          createdAt: socialCreatedAt,
          publishedAt: published(socialCreatedAt, 30),
          changeNote: "Initial version",
        },
      ],
    },
    {
      key: "warehouse",
      name: "Warehouse Staff",
      description: "Draft for the planned roastery warehouse. Not published and not assigned to anyone yet.",
      status: "DRAFT",
      versions: [
        {
          config: restrictionConfig({
            categories: ["SOCIAL_MEDIA", "GAMES"],
            shieldMessage: "Work Mode is on in the warehouse.",
            preShiftWarningMinutes: 10,
          }),
          breakBehaviourDefault: RELAX_ALL_DEFAULT,
          createdAt: clock.daysAgo(5),
          publishedAt: null,
          changeNote: null,
        },
        {
          config: restrictionConfig({
            categories: ["SOCIAL_MEDIA", "GAMES", "VIDEO", "SHOPPING"],
            shieldMessage: "Work Mode is on in the warehouse. Stay safe around the forklifts!",
            preShiftWarningMinutes: 15,
            alwaysAllowedNote: [...ALWAYS_ALLOWED, "Stock scanner app"],
          }),
          breakBehaviourDefault: RELAX_ALL_DEFAULT,
          createdAt: clock.daysAgo(2),
          publishedAt: null,
          changeNote: null,
        },
      ],
    },
  ];

  const currentVersionOf = new Map<WorkPolicyKey, { id: string; config: RestrictionConfig }>();
  for (const def of policyDefs) {
    const first = def.versions[0];
    invariant(first, `policy ${def.key} needs at least one version`);
    const pid = policyId(def.key);
    rows.policies.push({
      id: pid,
      organisationId,
      name: def.name,
      description: def.description,
      status: def.status,
      createdAt: first.createdAt,
    });
    let current: { id: string; config: RestrictionConfig } | null = null;
    def.versions.forEach((version, index) => {
      const n = index + 1;
      const vid = versionId(def.key, n);
      rows.policyVersions.push({
        id: vid,
        policyId: pid,
        versionNumber: n,
        restrictionConfig: toJson(version.config),
        breakBehaviourDefault: toJson(version.breakBehaviourDefault),
        createdById: actors.owner.userId,
        changeNote: version.changeNote,
        publishedAt: version.publishedAt,
        createdAt: version.createdAt,
      });
      const snapshot = {
        versionId: vid,
        versionNumber: n,
        restrictionConfig: version.config,
        breakBehaviourDefault: version.breakBehaviourDefault,
      };
      if (n === 1) {
        b.audit(actors.owner, "policy.created", "Policy", pid, version.createdAt, {
          after: { name: def.name, description: def.description, status: "DRAFT", ...snapshot },
        });
      } else {
        b.audit(actors.owner, "policy.updated", "Policy", pid, version.createdAt, {
          before: {
            name: def.name,
            description: def.description,
            status: def.status,
            currentVersionId: current?.id ?? null,
            draftVersionId: versionId(def.key, n - 1),
          },
          after: {
            name: def.name,
            description: def.description,
            status: def.status,
            currentVersionId: current?.id ?? null,
            draftVersionId: vid,
            ...snapshot,
          },
        });
      }
      if (version.publishedAt) {
        current = { id: vid, config: version.config };
        rows.policyCurrentVersions.push({ policyId: pid, versionId: vid });
        b.audit(actors.owner, "policy.published", "Policy", pid, version.publishedAt, {
          before: { name: def.name, description: def.description, status: "DRAFT", currentVersionId: null, draftVersionId: vid },
          after: {
            status: "ACTIVE",
            currentVersionId: vid,
            versionNumber: n,
            changeNote: version.changeNote,
            publishedAt: version.publishedAt,
          },
        });
        b.activity({
          type: "POLICY_UPDATED",
          at: version.publishedAt,
          actor: "MANAGER",
          actorUserId: actors.owner.userId,
          metadata: { policyId: pid, versionId: vid, versionNumber: n },
        });
      }
    });
    invariant(
      (def.status === "ACTIVE") === (current !== null),
      `policy ${def.key}: ACTIVE policies have a published version and drafts do not`,
    );
    if (current) currentVersionOf.set(def.key, current);
  }

  // ── Break Policies ─────────────────────────────────────────────────────────
  const breakPolicyId = (key: BreakPolicyKey): string => b.id(`break-policy:${key}`);
  const breakPolicyDefs: BreakPolicyDef[] = [
    {
      key: "standardBreak",
      name: "Standard Break 2×15",
      description: "Two 15-minute breaks per shift, at least an hour in and an hour apart. Restrictions relax during breaks.",
      rules: breakRules({}),
      createdAt: addMinutes(standardCreatedAt, 120),
    },
    {
      key: "lunch",
      name: "Lunch Shift 1×30",
      description: "One 30-minute lunch break after at least three hours on shift (Luton, longer day shifts).",
      rules: breakRules({
        maxBreaksPerShift: 1,
        maxBreakDurationMinutes: 30,
        maxTotalBreakMinutes: 30,
        minMinutesAfterShiftStart: 180,
      }),
      createdAt: addMinutes(standardCreatedAt, 140),
    },
    {
      key: "noPhone",
      name: "No Phone Break Unlock",
      description: "Kitchen teams: breaks are recorded but Work Mode restrictions stay on throughout the shift.",
      rules: breakRules({ restrictionBehaviour: "KEEP_RESTRICTIONS" }),
      createdAt: addMinutes(standardCreatedAt, 160),
    },
  ];
  for (const def of breakPolicyDefs) {
    rows.breakPolicies.push({
      id: breakPolicyId(def.key),
      organisationId,
      name: def.name,
      description: def.description,
      ...def.rules,
      relaxedCategories: toJson(def.rules.relaxedCategories),
      status: "ACTIVE",
      createdAt: def.createdAt,
    });
    b.audit(actors.owner, "break_policy.created", "BreakPolicy", breakPolicyId(def.key), def.createdAt, {
      after: { name: def.name, description: def.description, ...def.rules },
    });
  }

  // ── Assignments & defaults ─────────────────────────────────────────────────
  const employeeId = (key: EmployeeKey): string => b.id(`employee:${key}`);
  const workAssignments: AssignmentLike[] = [];
  const breakAssignments: AssignmentLike[] = [];
  const assignWork = (
    policy: WorkPolicyKey,
    scopeType: "LOCATION" | "TEAM" | "EMPLOYEE",
    scopeId: string,
    scopeKey: string,
    at: Date,
  ): void => {
    const id = b.id(`policy-assignment:${policy}:${scopeKey}`);
    rows.policyAssignments.push({
      id,
      organisationId,
      policyId: policyId(policy),
      scopeType,
      scopeId,
      createdById: actors.owner.userId,
      createdAt: at,
    });
    workAssignments.push({ id, scopeType, scopeId, policyId: policyId(policy), effectiveFrom: null, effectiveTo: null, createdAt: at });
    b.audit(actors.owner, "policy_assignment.created", "PolicyAssignment", id, at, {
      after: { scopeType, scopeId, effectiveFrom: null, effectiveTo: null, policyId: policyId(policy), replacedAssignmentIds: [] },
    });
  };
  const assignBreak = (
    policy: BreakPolicyKey,
    scopeType: "LOCATION" | "TEAM" | "EMPLOYEE",
    scopeId: string,
    scopeKey: string,
    at: Date,
  ): void => {
    const id = b.id(`break-policy-assignment:${policy}:${scopeKey}`);
    rows.breakPolicyAssignments.push({
      id,
      organisationId,
      breakPolicyId: breakPolicyId(policy),
      scopeType,
      scopeId,
      createdById: actors.owner.userId,
      createdAt: at,
    });
    breakAssignments.push(
      fromBreakPolicyAssignment({ id, scopeType, scopeId, breakPolicyId: breakPolicyId(policy), effectiveFrom: null, effectiveTo: null, createdAt: at }),
    );
    b.audit(actors.owner, "break_policy_assignment.created", "BreakPolicyAssignment", id, at, {
      after: { scopeType, scopeId, effectiveFrom: null, effectiveTo: null, breakPolicyId: breakPolicyId(policy), replacedAssignmentIds: [] },
    });
  };

  const assignmentsAt = addMinutes(standardCreatedAt, 200);
  for (const location of Object.keys(LOCATIONS) as LocationKey[]) {
    assignWork("foh", "TEAM", teamId(location, "foh"), `team:${location}:foh`, assignmentsAt);
    assignWork("kitchen", "TEAM", teamId(location, "kitchen"), `team:${location}:kitchen`, addMinutes(assignmentsAt, 5));
    assignBreak("noPhone", "TEAM", teamId(location, "kitchen"), `team:${location}:kitchen`, addMinutes(assignmentsAt, 10));
  }
  assignBreak("lunch", "LOCATION", locationId("luton"), "location:luton", addMinutes(assignmentsAt, 15));
  assignWork("management", "EMPLOYEE", employeeId("charlotte"), "employee:charlotte", published(managementCreatedAt, 40));
  assignWork("management", "EMPLOYEE", employeeId("james"), "employee:james", published(managementCreatedAt, 42));
  assignWork("social", "EMPLOYEE", employeeId("grace"), "employee:grace", published(socialCreatedAt, 45));

  rows.organisationDefaults.push({
    organisationId,
    defaultPolicyId: policyId("standard"),
    defaultBreakPolicyId: breakPolicyId("standardBreak"),
  });
  b.audit(actors.owner, "organisation.default_policy_changed", "Organisation", organisationId, addMinutes(standardCreatedAt, 25), {
    before: { defaultPolicyId: null },
    after: { defaultPolicyId: policyId("standard") },
  });
  b.audit(actors.owner, "organisation.default_break_policy_changed", "Organisation", organisationId, addMinutes(standardCreatedAt, 125), {
    before: { defaultBreakPolicyId: null },
    after: { defaultBreakPolicyId: breakPolicyId("standardBreak") },
  });

  // ── Policy resolution (the same shared function the API uses) ─────────────
  const workPoliciesById = indexPoliciesById(
    policyDefs.map((d) => ({ id: policyId(d.key), status: d.status, deletedAt: null, organisationId, key: d.key })),
  );
  const breakPoliciesById = indexPoliciesById(
    breakPolicyDefs.map((d) => ({
      id: breakPolicyId(d.key),
      status: "ACTIVE" as PolicyStatus,
      deletedAt: null,
      organisationId,
      key: d.key,
    })),
  );
  const resolveFor = (employee: { id: string; teamIds: string[]; primaryLocationId: string }) => {
    const context = {
      employeeId: employee.id,
      organisationId,
      teamIds: employee.teamIds,
      primaryLocationId: employee.primaryLocationId,
    };
    const work = resolvePolicy({
      employee: context,
      assignments: workAssignments,
      policiesById: workPoliciesById,
      organisationDefaultPolicyId: policyId("standard"),
      now,
    });
    const breaks = resolvePolicy({
      employee: context,
      assignments: breakAssignments,
      policiesById: breakPoliciesById,
      organisationDefaultPolicyId: breakPolicyId("standardBreak"),
      now,
    });
    invariant(work.warnings.length === 0 && breaks.warnings.length === 0, `policy resolution warnings for ${employee.id}`);
    invariant(work.policy && breaks.policy, `every employee resolves a work and a break policy (${employee.id})`);
    return { work: work.policy.key, breaks: breaks.policy.key };
  };

  // ── Employees ──────────────────────────────────────────────────────────────
  const connectedDevice = (
    overrides: Partial<DeviceSpec> & Pick<DeviceSpec, "linkedMinutesAgo" | "lastSyncMinutesAgo" | "counts" | "model" | "os">,
  ): DeviceSpec => ({
    permission: "APPROVED",
    selection: "CONFIGURED",
    appVersion: "1.4.0",
    reports: true,
    setupCompletedMinutesAgo: overrides.linkedMinutesAgo - 12,
    skewSeconds: 2,
    scheduleVersion: 7,
    ...overrides,
  });

  const specs: EmployeeSpec[] = [
    {
      key: "zach",
      firstName: "Zach",
      lastName: "Stephens",
      email: "zach.stephens@harpendencoffee.test",
      phone: "+44 7700 900101",
      externalId: "E1010",
      jobTitle: "Barista",
      department: "foh",
      location: "harpenden",
      inTeam: true,
      createdMinutesAgo: 27 * DAY,
      employmentStatus: "ACTIVE",
      device: connectedDevice({ linkedMinutesAgo: 24 * DAY, lastSyncMinutesAgo: 3, counts: { categories: 3, applications: 0, webDomains: 0 }, model: "iPhone 15", os: "18.6", scheduleVersion: 8 }),
      invite: { channel: "LINK", status: "ACCEPTED", createdMinutesAgo: 24 * DAY + 60, acceptedMinutesAgo: 24 * DAY },
      scenario: "CONNECTED and working right now: shift today 09:00–15:00 with a scheduled break at +180 min, one expired break earlier, device synced 3 minutes ago.",
    },
    {
      key: "jack",
      firstName: "Jack",
      lastName: "Smith",
      email: "jack.smith@harpendencoffee.test",
      externalId: "E1011",
      jobTitle: "Barista",
      department: "foh",
      location: "harpenden",
      inTeam: true,
      createdMinutesAgo: 27 * DAY,
      employmentStatus: "ACTIVE",
      device: connectedDevice({ linkedMinutesAgo: 22 * DAY, lastSyncMinutesAgo: 25, counts: { categories: 2, applications: 4, webDomains: 0 }, model: "iPhone 14", os: "18.5", skewSeconds: -4 }),
      scenario: "CONNECTED, off shift: next shift tomorrow 10:00–18:00; had an EXEMPT_TEMPORARILY override yesterday that has expired.",
    },
    {
      key: "sarah",
      firstName: "Sarah",
      lastName: "Jones",
      email: "sarah.jones@harpendencoffee.test",
      jobTitle: "Barista",
      department: "foh",
      location: "stalbans",
      inTeam: true,
      createdMinutesAgo: 9 * DAY,
      employmentStatus: "ACTIVE",
      device: {
        permission: "DENIED",
        selection: "NONE",
        counts: { categories: 0, applications: 0, webDomains: 0 },
        model: "iPhone 13",
        os: "18.6",
        appVersion: "1.4.0",
        linkedMinutesAgo: 2 * DAY,
        lastSyncMinutesAgo: 40,
        reports: true,
        permissionDeniedMinutesAgo: 2 * DAY - 10,
        skewSeconds: 1,
      },
      scenario: "Joined but denied Screen Time: PERMISSIONS_MISSING badge, PERMISSION_NEEDS_ATTENTION activity, shift today 12:00–20:00 that cannot be enforced (lifecycle derives SETUP_INCOMPLETE).",
    },
    {
      key: "tom",
      firstName: "Tom",
      lastName: "Brown",
      email: "tom.brown@harpendencoffee.test",
      jobTitle: "Kitchen Porter",
      department: "kitchen",
      location: "harpenden",
      inTeam: true,
      createdMinutesAgo: 3 * DAY,
      employmentStatus: "ACTIVE",
      invite: { channel: "LINK", status: "SENT", code: "TBRWN7", createdMinutesAgo: 2 * DAY },
      scenario: "INVITED two days ago (invite link sent, code TBRWN7), has not joined; first shifts next week.",
    },
    {
      key: "amelia",
      firstName: "Amelia",
      lastName: "Clarke",
      email: "amelia.clarke@harpendencoffee.test",
      phone: "+44 7700 900142",
      externalId: "E1004",
      jobTitle: "Shift Supervisor",
      department: "foh",
      location: "harpenden",
      inTeam: true,
      secondaryLocations: ["stalbans"],
      createdMinutesAgo: 27 * DAY,
      employmentStatus: "ACTIVE",
      device: connectedDevice({ linkedMinutesAgo: 21 * DAY, lastSyncMinutesAgo: 2, counts: { categories: 4, applications: 2, webDomains: 1 }, model: "iPhone 15 Pro", os: "26.0" }),
      invite: { channel: "LINK", status: "ACCEPTED", createdMinutesAgo: 21 * DAY + 60, acceptedMinutesAgo: 21 * DAY },
      scenario: "CONNECTED and ON_BREAK right now: shift from 3 hours ago until 3 hours from now, break started 5 minutes ago (ends in 10).",
    },
    {
      key: "oliver",
      firstName: "Oliver",
      lastName: "Patel",
      email: "oliver.patel@harpendencoffee.test",
      externalId: "E1023",
      jobTitle: "Night Baker",
      department: "kitchen",
      location: "luton",
      inTeam: true,
      createdMinutesAgo: 26 * DAY,
      employmentStatus: "ACTIVE",
      device: connectedDevice({ linkedMinutesAgo: 19 * DAY, lastSyncMinutesAgo: 55, counts: { categories: 3, applications: 1, webDomains: 0 }, model: "iPhone 12", os: "18.4", appVersion: "1.3.2" }),
      scenario: "CONNECTED night baker at Luton: overnight shift tonight 22:00→06:00 (Kitchen policy, breaks keep restrictions).",
    },
    {
      key: "mia",
      firstName: "Mia",
      lastName: "Khan",
      email: "mia.khan@harpendencoffee.test",
      jobTitle: "Barista",
      department: "foh",
      location: "stalbans",
      inTeam: true,
      createdMinutesAgo: 9 * DAY,
      employmentStatus: "ACTIVE",
      device: {
        permission: "APPROVED",
        selection: "NONE",
        counts: { categories: 0, applications: 0, webDomains: 0 },
        model: "iPhone 14",
        os: "18.6",
        appVersion: "1.4.0",
        linkedMinutesAgo: 6 * 60,
        lastSyncMinutesAgo: 5 * 60,
        reports: false,
        permissionGrantedMinutesAgo: 6 * 60 - 5,
        skewSeconds: 0,
      },
      scenario: "SETUP_INCOMPLETE: joined 6 hours ago and approved Screen Time but has not selected any apps yet; the device has never reported an engine state.",
    },
    {
      key: "noah",
      firstName: "Noah",
      lastName: "Wright",
      email: "noah.wright@harpendencoffee.test",
      externalId: "E1031",
      jobTitle: "Line Cook",
      department: "kitchen",
      location: "stalbans",
      inTeam: true,
      createdMinutesAgo: 26 * DAY,
      employmentStatus: "ACTIVE",
      device: connectedDevice({ linkedMinutesAgo: 18 * DAY, lastSyncMinutesAgo: 30 * 60, counts: { categories: 3, applications: 0, webDomains: 0 }, model: "iPhone 13", os: "18.3", appVersion: "1.3.2" }),
      scenario: "CONNECTED but the phone last synced 30 hours ago: SYNC_DELAYED badge, DEVICE_SYNC_DELAYED activity and an unread notification for the owner.",
    },
    {
      key: "isla",
      firstName: "Isla",
      lastName: "Murphy",
      email: "isla.murphy@harpendencoffee.test",
      externalId: "E1045",
      jobTitle: "Barista",
      department: "foh",
      location: "luton",
      inTeam: true,
      createdMinutesAgo: 20 * DAY,
      employmentStatus: "ACTIVE",
      scenario: "NOT_INVITED: on the rota (two of her shifts came from the CSV import) but never invited.",
    },
    {
      key: "leo",
      firstName: "Leo",
      lastName: "Garcia",
      email: "leo.garcia@harpendencoffee.test",
      externalId: "E1002",
      jobTitle: "Line Cook",
      department: "kitchen",
      location: "harpenden",
      inTeam: true,
      createdMinutesAgo: 28 * DAY,
      employmentStatus: "INACTIVE",
      deactivatedMinutesAgo: 4 * DAY,
      device: connectedDevice({ linkedMinutesAgo: 26 * DAY, lastSyncMinutesAgo: 4 * DAY + 30, counts: { categories: 2, applications: 0, webDomains: 0 }, model: "iPhone 11", os: "17.6", appVersion: "1.2.0", deactivatedMinutesAgo: 4 * DAY }),
      scenario: "DEACTIVATED: left four days ago; employment INACTIVE, device deactivated, past shifts kept for history.",
    },
    {
      key: "grace",
      firstName: "Grace",
      lastName: "Evans",
      email: "grace.evans@harpendencoffee.test",
      externalId: "E1007",
      jobTitle: "Marketing Lead",
      department: "management",
      location: "harpenden",
      inTeam: false,
      createdMinutesAgo: 26 * DAY,
      employmentStatus: "ACTIVE",
      device: connectedDevice({ linkedMinutesAgo: 20 * DAY, lastSyncMinutesAgo: 12, counts: { categories: 2, applications: 3, webDomains: 0 }, model: "iPhone 16", os: "26.0" }),
      scenario: "CONNECTED, Management department on the Social Media Team policy (EMPLOYEE assignment); her shifts are a weekly Mon/Wed/Fri recurrence.",
    },
    {
      key: "harry",
      firstName: "Harry",
      lastName: "Wilson",
      email: "harry.wilson@harpendencoffee.test",
      phone: "+44 7700 900177",
      externalId: "E1042",
      jobTitle: "Head Chef",
      department: "kitchen",
      location: "stalbans",
      inTeam: true,
      createdMinutesAgo: 27 * DAY,
      employmentStatus: "ACTIVE",
      device: connectedDevice({ linkedMinutesAgo: 23 * DAY, lastSyncMinutesAgo: 8, counts: { categories: 5, applications: 0, webDomains: 0 }, model: "iPhone 15", os: "18.6" }),
      invite: { channel: "LINK", status: "ACCEPTED", createdMinutesAgo: 23 * DAY + 60, acceptedMinutesAgo: 23 * DAY },
      scenario: "CONNECTED Kitchen at St Albans: Kitchen policy + No Phone Break Unlock; early shifts 06:30–14:30 including today.",
    },
    {
      key: "charlotte",
      firstName: "Charlotte",
      lastName: "Davies",
      email: "charlotte.davies@harpendencoffee.test",
      externalId: "E1001",
      jobTitle: "Store Manager",
      department: "management",
      location: "harpenden",
      inTeam: false,
      createdMinutesAgo: 29 * DAY,
      employmentStatus: "ACTIVE",
      device: connectedDevice({ linkedMinutesAgo: 25 * DAY, lastSyncMinutesAgo: 18, counts: { categories: 1, applications: 2, webDomains: 0 }, model: "iPhone 16 Pro", os: "26.0" }),
      scenario: "CONNECTED store manager on the light Management policy (EMPLOYEE assignment).",
    },
    {
      key: "james",
      firstName: "James",
      lastName: "Taylor",
      email: "james.taylor@harpendencoffee.test",
      externalId: "E1050",
      jobTitle: "Assistant Manager",
      department: "management",
      location: "stalbans",
      inTeam: false,
      createdMinutesAgo: 5 * DAY,
      employmentStatus: "ACTIVE",
      invite: { channel: "EMAIL", status: "SENT", createdMinutesAgo: 1 * DAY },
      scenario: "INVITED by email yesterday (Management policy assigned ahead of joining).",
    },
    {
      key: "ethan",
      firstName: "Ethan",
      lastName: "Hughes",
      email: "ethan.hughes@harpendencoffee.test",
      jobTitle: "Barista",
      department: "foh",
      location: "luton",
      inTeam: true,
      createdMinutesAgo: 10 * DAY,
      employmentStatus: "ACTIVE",
      device: {
        permission: "NOT_DETERMINED",
        selection: "NONE",
        counts: { categories: 0, applications: 0, webDomains: 0 },
        model: "iPhone 13",
        os: "18.6",
        appVersion: "1.4.0",
        linkedMinutesAgo: 20,
        lastSyncMinutesAgo: null,
        lastSeenMinutesAgo: 20,
        reports: false,
        skewSeconds: null,
      },
      scenario: "JOINED 20 minutes ago with the company code; Screen Time setup not started yet.",
    },
    {
      key: "sophie",
      firstName: "Sophie",
      lastName: "Martin",
      email: "sophie.martin@harpendencoffee.test",
      externalId: "E1077",
      jobTitle: "Barista",
      department: "foh",
      location: "luton",
      inTeam: true,
      createdMinutesAgo: 12 * DAY,
      employmentStatus: "ACTIVE",
      device: connectedDevice({ linkedMinutesAgo: 5 * DAY, lastSyncMinutesAgo: 35, counts: { categories: 3, applications: 0, webDomains: 2 }, model: "iPhone 14", os: "18.6" }),
      scenario: "CONNECTED at Luton five days ago (recent EMPLOYEE_JOINED / SETUP_COMPLETED); Lunch Shift break policy via the location; three shifts came from the CSV import.",
    },
  ];

  const employees = new Map<EmployeeKey, BuiltEmployee>();
  const devicesByEmployee = new Map<EmployeeKey, BuiltDevice>();
  const breakPolicyOf = new Map<EmployeeKey, BreakPolicyKey>();
  const workPolicyOf = new Map<EmployeeKey, WorkPolicyKey>();
  const inviteIdOf = new Map<EmployeeKey, string>();
  const specOf = new Map<EmployeeKey, EmployeeSpec>();

  for (const spec of specs) {
    specOf.set(spec.key, spec);
    const id = employeeId(spec.key);
    const createdAt = clock.minutesAgo(spec.createdMinutesAgo);
    const teamIds = spec.inTeam && spec.department !== "management" ? [teamId(spec.location, spec.department)] : [];
    const primaryLocationId = locationId(spec.location);
    const resolution = resolveFor({ id, teamIds, primaryLocationId });
    workPolicyOf.set(spec.key, resolution.work);
    breakPolicyOf.set(spec.key, resolution.breaks);
    const currentVersion = currentVersionOf.get(resolution.work) ?? null;

    let inviteLive = false;
    if (spec.invite) {
      const inviteId = b.id(`invite:${spec.key}`);
      inviteIdOf.set(spec.key, inviteId);
      const inviteCreatedAt = clock.minutesAgo(spec.invite.createdMinutesAgo);
      const inviteExpiresAt = addMinutes(inviteCreatedAt, 14 * DAY);
      const sent = spec.invite.status === "SENT" || spec.invite.status === "ACCEPTED";
      const acceptedAt =
        spec.invite.acceptedMinutesAgo !== undefined ? clock.minutesAgo(spec.invite.acceptedMinutesAgo) : null;
      rows.employeeInvites.push({
        id: inviteId,
        organisationId,
        employeeId: id,
        code: spec.invite.code ?? generateEmployeeInviteCode(),
        tokenHash: randomTokenHash(),
        channel: spec.invite.channel,
        status: spec.invite.status,
        sentAt: sent ? inviteCreatedAt : null,
        acceptedAt,
        expiresAt: inviteExpiresAt,
        createdAt: inviteCreatedAt,
      });
      inviteLive =
        (spec.invite.status === "PENDING" || spec.invite.status === "SENT") && inviteExpiresAt.getTime() > now.getTime();
      b.audit(actors.admin, "employee.invite_created", "EmployeeInvite", inviteId, inviteCreatedAt, {
        after: { employeeId: id, channel: spec.invite.channel, status: sent ? "SENT" : "PENDING", expiresAt: inviteExpiresAt },
      });
    }

    const deviceSpec = spec.device;
    const inviteStatus = deriveInviteStatus({
      hasLink: deviceSpec !== undefined,
      device: deviceSpec
        ? {
            permissionState: deviceSpec.permission,
            selectionState: deviceSpec.selection,
            isActive: deviceSpec.deactivatedMinutesAgo === undefined,
          }
        : null,
      employmentStatus: spec.employmentStatus,
      hasPendingInvite: inviteLive,
    });

    const employee: BuiltEmployee = {
      key: spec.key,
      id,
      firstName: spec.firstName,
      lastName: spec.lastName,
      inviteStatus,
      employmentStatus: spec.employmentStatus,
      teamIds,
      primaryLocationId,
      preShiftWarningMinutes: currentVersion?.config.preShiftWarningMinutes ?? 15,
      workPolicyVersionId: currentVersion?.id ?? null,
    };
    employees.set(spec.key, employee);

    rows.employees.push({
      id,
      organisationId,
      firstName: spec.firstName,
      lastName: spec.lastName,
      email: spec.email ?? null,
      phone: spec.phone ?? null,
      externalEmployeeId: spec.externalId ?? null,
      jobTitle: spec.jobTitle,
      departmentId: departmentId(spec.department),
      primaryLocationId,
      employmentStatus: spec.employmentStatus,
      inviteStatus,
      createdAt,
    });
    for (const team of teamIds) rows.employeeTeams.push({ employeeId: id, teamId: team, createdAt });
    const locationIds = [spec.location, ...(spec.secondaryLocations ?? [])].map(locationId);
    for (const location of locationIds) rows.employeeLocations.push({ employeeId: id, locationId: location, createdAt });
    b.audit(actors.admin, "employee.created", "Employee", id, createdAt, {
      after: {
        firstName: spec.firstName,
        lastName: spec.lastName,
        email: spec.email ?? null,
        phone: spec.phone ?? null,
        externalEmployeeId: spec.externalId ?? null,
        jobTitle: spec.jobTitle,
        departmentId: departmentId(spec.department),
        primaryLocationId,
        locationIds,
        teamIds,
        employmentStatus: "ACTIVE",
        inviteStatus: "NOT_INVITED",
        policyId: null,
        breakPolicyId: null,
      },
    });
    if (spec.employmentStatus === "INACTIVE" && spec.deactivatedMinutesAgo !== undefined) {
      const deactivatedAt = clock.minutesAgo(spec.deactivatedMinutesAgo);
      b.audit(actors.admin, "employee.deactivated", "Employee", id, deactivatedAt, {
        before: { employmentStatus: "ACTIVE", inviteStatus: "CONNECTED" },
        after: { employmentStatus: "INACTIVE", inviteStatus: "DEACTIVATED", devicesDeactivated: 1 },
      });
    }

    if (deviceSpec) {
      const device: BuiltDevice = {
        id: b.id(`device:${spec.key}`),
        mobileUserId: b.id(`mobile-user:${spec.key}`),
        employee,
        linkedAt: clock.minutesAgo(deviceSpec.linkedMinutesAgo),
        lastDeviceSyncAt: deviceSpec.lastSyncMinutesAgo === null ? null : clock.minutesAgo(deviceSpec.lastSyncMinutesAgo),
        lastSeenAt: deviceSpec.lastSeenMinutesAgo !== undefined ? clock.minutesAgo(deviceSpec.lastSeenMinutesAgo) : null,
        isActive: deviceSpec.deactivatedMinutesAgo === undefined,
        deactivatedAt: deviceSpec.deactivatedMinutesAgo !== undefined ? clock.minutesAgo(deviceSpec.deactivatedMinutesAgo) : null,
        permissionState: deviceSpec.permission,
        selectionState: deviceSpec.selection,
        counts: deviceSpec.counts,
        model: deviceSpec.model,
        os: deviceSpec.os,
        appVersion: deviceSpec.appVersion,
        reports: deviceSpec.reports,
        skewSeconds: deviceSpec.skewSeconds ?? null,
        scheduleVersion: deviceSpec.scheduleVersion ?? 7,
      };
      invariant(device.linkedAt.getTime() >= createdAt.getTime(), `${spec.key}: device linked after the employee was created`);
      devicesByEmployee.set(spec.key, device);
      b.addDevice(device);
    }
  }

  const employee = (key: EmployeeKey): BuiltEmployee => {
    const found = employees.get(key);
    invariant(found, `unknown employee ${key}`);
    return found;
  };

  // ── Shifts: two weeks around today ─────────────────────────────────────────
  const rotaPublishedAt = clock.at(-8, "17:00");
  const recentlyCreatedAt = clock.at(-1, "17:30");
  const shiftByKey = new Map<string, BuiltShift>();
  const patterns: ShiftPattern[] = [
    { emp: "zach", days: [-7, -6, -5, -2, -1, 0], start: "09:00", end: "15:00", breaks: [[180, 15]] },
    { emp: "zach", days: [1, 3, 4, 6, 7], start: "09:00", end: "15:00", breaks: [[180, 15]], recent: true },
    { emp: "jack", days: [-6, -5, -2, -1, 1, 3, 4, 6], start: "10:00", end: "18:00", breaks: [[240, 15]] },
    { emp: "sarah", days: [-7, -5, -3, -1, 0, 2, 4, 6], start: "12:00", end: "20:00" },
    { emp: "tom", days: [1, 3, 5], start: "07:00", end: "15:00", recent: true },
    { emp: "amelia", days: [-7, -6, -4, -2, 1, 3, 5, 7], start: "08:00", end: "16:00", breaks: [[180, 15]] },
    { emp: "oliver", days: [-7, -5, -3, -1, 0, 2, 4, 6], start: "22:00", end: "06:00" },
    { emp: "mia", days: [-6, -4, -2, 1, 2, 5], start: "12:00", end: "18:00" },
    { emp: "noah", days: [-7, -6, -5, -3, -2, 1, 2, 4, 6], start: "07:00", end: "15:00", breaks: [[240, 15]] },
    { emp: "isla", days: [-6, -4], start: "09:00", end: "17:00" },
    { emp: "leo", days: [-7, -6], start: "07:00", end: "15:00" },
    { emp: "harry", days: [-7, -5, -4, -2, -1, 0, 1, 3, 4, 6], start: "06:30", end: "14:30", breaks: [[240, 15]] },
    { emp: "charlotte", days: [-6, -5, -3, -2, 1, 2, 4, 5], start: "08:30", end: "17:30", breaks: [[270, 15]] },
    { emp: "james", days: [1, 3, 5], start: "09:00", end: "17:00", recent: true },
    { emp: "ethan", days: [2, 3], start: "11:00", end: "19:00", recent: true },
    { emp: "sophie", days: [-3, -1], start: "09:00", end: "17:00", breaks: [[240, 30]] },
  ];
  for (const pattern of patterns) {
    const emp = employee(pattern.emp);
    const spec = specOf.get(pattern.emp);
    invariant(spec, `spec for ${pattern.emp}`);
    for (const day of pattern.days) {
      const window = clock.shiftWindow(day, pattern.start, pattern.end);
      const key = `${pattern.emp}:${day}`;
      const shift = b.addShift({
        key,
        employee: emp,
        startsAt: window.startsAt,
        endsAt: window.endsAt,
        locationId: locationId(pattern.location ?? spec.location),
        breaks: pattern.breaks ?? [],
        createdAt: pattern.recent ? recentlyCreatedAt : rotaPublishedAt,
        createdBy: pattern.recent ? actors.manager : actors.owner,
      });
      shiftByKey.set(key, shift);
    }
  }

  // Amelia: a shift centred on now so she is mid-shift (and on a break) whenever the seed runs.
  const ameliaToday = b.addShift({
    key: "amelia:today",
    employee: employee("amelia"),
    startsAt: addMinutes(now, -180),
    endsAt: addMinutes(now, 180),
    locationId: locationId("harpenden"),
    createdAt: rotaPublishedAt,
    createdBy: actors.owner,
    notes: "Covering the afternoon rush",
  });

  // Grace: a weekly Mon/Wed/Fri series — the anchor shift carries the rule, the occurrences point at it.
  let firstSeriesDay = -7;
  while (![1, 3, 5].includes(clock.weekdayOf(firstSeriesDay))) firstSeriesDay += 1;
  const seriesRule = "FREQ=WEEKLY;BYDAY=MO,WE,FR";
  const seriesValidation = validateRecurrenceRule(seriesRule);
  invariant(seriesValidation.ok, "series rule is valid");
  const occurrences = expandShiftSeries({
    date: clock.day(firstSeriesDay),
    startTime: "10:00",
    endTime: "16:00",
    timezone: tz,
    rule: seriesRule,
    untilDate: clock.day(7),
  });
  const anchorOccurrence = occurrences[0];
  invariant(anchorOccurrence, "the series has an anchor occurrence");
  const seriesAnchor = b.addShift({
    key: "grace:series:0",
    employee: employee("grace"),
    startsAt: anchorOccurrence.startsAt,
    endsAt: anchorOccurrence.endsAt,
    locationId: locationId("harpenden"),
    breaks: [[180, 15]],
    recurrenceRule: seriesValidation.normalised,
    createdAt: rotaPublishedAt,
    createdBy: actors.owner,
  });
  occurrences.slice(1).forEach((occurrence, index) => {
    b.addShift({
      key: `grace:series:${index + 1}`,
      employee: employee("grace"),
      startsAt: occurrence.startsAt,
      endsAt: occurrence.endsAt,
      locationId: locationId("harpenden"),
      breaks: [[180, 15]],
      parentRecurrenceId: seriesAnchor.id,
      createdAt: rotaPublishedAt,
      createdBy: actors.owner,
    });
  });
  b.audit(actors.owner, "shift.created", "Shift", seriesAnchor.id, rotaPublishedAt, {
    after: {
      employeeId: seriesAnchor.employee.id,
      locationId: seriesAnchor.locationId,
      startsAt: seriesAnchor.startsAt,
      endsAt: seriesAnchor.endsAt,
      timezone: tz,
      status: "SCHEDULED",
      notes: null,
      version: 1,
      recurrenceRule: seriesAnchor.recurrenceRule,
      parentRecurrenceId: null,
      scheduledBreaks: [{ offsetMinutesFromStart: 180, durationMinutes: 15 }],
      occurrences: occurrences.length,
    },
  });

  // ── CSV import (committed three days ago) ──────────────────────────────────
  const importId = b.id("import:luton-rota");
  const importedAt = clock.at(-3, "14:20");
  const uploadedAt = addMinutes(importedAt, -12);
  const importFilename = "luton-rota-week.csv";
  const importHeaders = ["Employee", "Employee ID", "Date", "Start", "End", "Location", "Break (mins)"];
  const importMapping = {
    Employee: "employee_name",
    "Employee ID": "employee_id",
    Date: "date",
    Start: "start_time",
    End: "end_time",
    Location: "location",
    "Break (mins)": "break_minutes",
  };
  interface ImportRowSpec {
    rowNumber: number;
    employee: EmployeeKey | null;
    name: string;
    externalId: string;
    day: number;
    start: string;
    end: string;
    breakMinutes: number;
    status: "IMPORTED" | "ERROR" | "SKIPPED";
    problems: Array<Record<string, unknown>>;
  }
  const importRowSpecs: ImportRowSpec[] = [
    { rowNumber: 2, employee: "sophie", name: "Sophie Martin", externalId: "E1077", day: 1, start: "09:00", end: "17:00", breakMinutes: 30, status: "IMPORTED", problems: [] },
    { rowNumber: 3, employee: "sophie", name: "Sophie Martin", externalId: "E1077", day: 4, start: "09:00", end: "17:00", breakMinutes: 30, status: "IMPORTED", problems: [] },
    { rowNumber: 4, employee: "sophie", name: "Sophie Martin", externalId: "E1077", day: 6, start: "09:00", end: "17:00", breakMinutes: 30, status: "IMPORTED", problems: [] },
    { rowNumber: 5, employee: "isla", name: "Isla Murphy", externalId: "E1045", day: 1, start: "09:00", end: "17:00", breakMinutes: 0, status: "IMPORTED", problems: [] },
    { rowNumber: 6, employee: "isla", name: "Isla Murphy", externalId: "E1045", day: 3, start: "09:00", end: "17:00", breakMinutes: 0, status: "IMPORTED", problems: [] },
    {
      rowNumber: 7,
      employee: null,
      name: "Unknown Person",
      externalId: "E9999",
      day: 2,
      start: "09:00",
      end: "17:00",
      breakMinutes: 0,
      status: "ERROR",
      problems: [
        {
          code: "EMPLOYEE_NOT_FOUND",
          severity: "ERROR",
          field: "employee_name",
          message: 'No employee matches "Unknown Person" (ID E9999).',
          details: { candidates: [] },
        },
      ],
    },
    {
      rowNumber: 8,
      employee: "isla",
      name: "Isla Murphy",
      externalId: "E1045",
      day: 5,
      start: "25:00",
      end: "17:00",
      breakMinutes: 0,
      status: "ERROR",
      problems: [
        {
          code: "INVALID_TIME",
          severity: "ERROR",
          field: "start_time",
          message: 'Start time "25:00" is not a valid time of day.',
        },
      ],
    },
    {
      rowNumber: 9,
      employee: "sophie",
      name: "Sophie Martin",
      externalId: "E1077",
      day: 1,
      start: "09:00",
      end: "17:00",
      breakMinutes: 30,
      status: "SKIPPED",
      problems: [
        {
          code: "DUPLICATE_SHIFT",
          severity: "WARNING",
          message: "Identical to row 2 (same employee, start and end); the row was skipped.",
          details: { duplicateOfRowNumber: 2 },
        },
      ],
    },
  ];
  let importedCount = 0;
  for (const row of importRowSpecs) {
    const emp = row.employee ? employee(row.employee) : null;
    let createdShift: BuiltShift | null = null;
    if (row.status === "IMPORTED" && emp) {
      createdShift = b.addShift({
        key: `${row.employee}:import:${row.day}`,
        employee: emp,
        startsAt: clock.shiftWindow(row.day, row.start, row.end).startsAt,
        endsAt: clock.shiftWindow(row.day, row.start, row.end).endsAt,
        locationId: locationId("luton"),
        breaks: row.breakMinutes > 0 ? [[240, row.breakMinutes]] : [],
        source: "CSV_IMPORT",
        createdAt: importedAt,
        createdBy: actors.admin,
        importId,
      });
      importedCount += 1;
    }
    const validTime = row.start !== "25:00";
    const window = validTime ? clock.shiftWindow(row.day, row.start, row.end) : null;
    const parsed = {
      employeeName: row.name,
      employeeExternalId: row.externalId,
      date: clock.day(row.day),
      ...(validTime ? { startTime: row.start } : {}),
      endTime: row.end,
      ...(window ? { startsAt: window.startsAt.toISOString(), endsAt: window.endsAt.toISOString() } : {}),
      timezone: tz,
      overnight: false,
      locationName: "Luton",
      ...(row.breakMinutes > 0 ? { breakMinutes: row.breakMinutes } : {}),
    };
    rows.shiftImportRows.push({
      id: b.id(`import-row:${row.rowNumber}`),
      importId,
      rowNumber: row.rowNumber,
      raw: toJson({
        Employee: row.name,
        "Employee ID": row.externalId,
        Date: toDmy(clock.day(row.day)),
        Start: row.start,
        End: row.end,
        Location: "Luton",
        "Break (mins)": row.breakMinutes > 0 ? String(row.breakMinutes) : "",
      }),
      parsed: toJson(parsed),
      status: row.status,
      problems: toJson(row.problems),
      matchedEmployeeId: emp?.id ?? null,
      createdShiftId: createdShift?.id ?? null,
      createdAt: uploadedAt,
    });
  }
  const errorCount = importRowSpecs.filter((r) => r.status === "ERROR").length;
  const skippedCount = importRowSpecs.filter((r) => r.status === "SKIPPED").length;
  rows.shiftImports.push({
    id: importId,
    organisationId,
    uploadedById: actors.admin.userId,
    filename: importFilename,
    fileSizeBytes: 1472,
    status: "IMPORTED",
    columnMapping: toJson(importMapping),
    options: toJson({ dateFormat: "DMY", timezone: tz, locationId: locationId("luton") }),
    headers: toJson(importHeaders),
    rowCount: importRowSpecs.length,
    validCount: importedCount,
    warningCount: skippedCount,
    errorCount,
    importedCount,
    importedAt,
    createdAt: uploadedAt,
  });
  b.audit(actors.admin, "import.uploaded", "ShiftImport", importId, uploadedAt, {
    after: { filename: importFilename, fileSizeBytes: 1472, rowCount: importRowSpecs.length, headers: importHeaders },
  });
  b.audit(actors.admin, "import.committed", "ShiftImport", importId, importedAt, {
    before: { status: "VALIDATED" },
    after: {
      status: "IMPORTED",
      shiftsCreated: importedCount,
      employeesCreated: 0,
      rowsSkipped: skippedCount,
      includeWarnings: true,
      skipErrors: true,
    },
  });
  b.activity({
    type: "IMPORT_COMPLETED",
    at: importedAt,
    actor: "MANAGER",
    actorUserId: actors.admin.userId,
    // Same shape the imports service records on commit.
    metadata: {
      importId,
      shiftsCreated: importedCount,
      rowsSkipped: skippedCount,
      rowsWithErrors: errorCount,
      employeesCreated: 0,
      employeeCount: new Set(importRowSpecs.filter((r) => r.status === "IMPORTED").map((r) => r.employee)).size,
    },
  });

  b.assertNoShiftOverlaps();

  // ── Recently created shifts: SHIFT_CREATED activity + audit, as the schedule API records them ────────
  for (const shift of b.shifts) {
    if (shift.createdAt.getTime() < sevenDaysAgo.getTime()) continue;
    b.activity({
      type: "SHIFT_CREATED",
      at: shift.createdAt,
      actor: "MANAGER",
      actorUserId: shift.createdBy.userId,
      employeeId: shift.employee.id,
      metadata: {
        shiftId: shift.id,
        startsAt: shift.startsAt.toISOString(),
        endsAt: shift.endsAt.toISOString(),
        timezone: tz,
        version: 1,
        status: "SCHEDULED",
        source: shift.source,
        ...(shift.parentRecurrenceId ? { parentRecurrenceId: shift.parentRecurrenceId } : {}),
        ...(shift.importId ? { importId: shift.importId } : {}),
      },
    });
    if (shift.source === "MANUAL") {
      b.audit(shift.createdBy, "shift.created", "Shift", shift.id, shift.createdAt, {
        after: {
          employeeId: shift.employee.id,
          locationId: shift.locationId,
          startsAt: shift.startsAt,
          endsAt: shift.endsAt,
          timezone: tz,
          status: "SCHEDULED",
          notes: shift.notes,
          version: 1,
          recurrenceRule: null,
          parentRecurrenceId: null,
          scheduledBreaks: shift.breaks.map(([offsetMinutesFromStart, durationMinutes]) => ({ offsetMinutesFromStart, durationMinutes })),
        },
      });
    }
  }

  // ── Break sessions ─────────────────────────────────────────────────────────
  const breakBehaviourOf = (key: BreakPolicyKey): BreakRestrictionBehaviour => {
    const def = breakPolicyDefs.find((d) => d.key === key);
    invariant(def, `break policy ${key}`);
    return def.rules.restrictionBehaviour;
  };
  const session = (
    key: string,
    shift: BuiltShift | undefined,
    startedAt: Date,
    plannedEndsAt: Date,
    endedAt: Date | null,
    endReason: BreakEndReason | null,
  ): void => {
    invariant(shift, `shift for break ${key}`);
    const empKey = shift.employee.key as EmployeeKey;
    const breakPolicy = breakPolicyOf.get(empKey);
    invariant(breakPolicy, `break policy for ${empKey}`);
    invariant(
      startedAt >= shift.startsAt && plannedEndsAt <= shift.endsAt && plannedEndsAt > startedAt,
      `break ${key} fits inside its shift`,
    );
    b.addSession({
      key,
      shift,
      device: devicesByEmployee.get(empKey) ?? null,
      startedAt,
      plannedEndsAt,
      endedAt,
      endReason,
      breakPolicyId: breakPolicyId(breakPolicy),
      restrictionBehaviour: breakBehaviourOf(breakPolicy),
    });
  };
  // Zach's 10:15–10:30 break is today's when it is already over, otherwise yesterday's (same shift pattern).
  const zachBreakDay = clock.isPast(clock.at(0, "10:30")) ? 0 : -1;
  session("zach:expired", shiftByKey.get(`zach:${zachBreakDay}`), clock.at(zachBreakDay, "10:15"), clock.at(zachBreakDay, "10:30"), clock.at(zachBreakDay, "10:30"), "EXPIRED");
  session("harry:ended", shiftByKey.get("harry:-1"), clock.at(-1, "09:45"), clock.at(-1, "10:00"), clock.at(-1, "09:57"), "EMPLOYEE_ENDED");
  session("amelia:expired", shiftByKey.get("amelia:-2"), clock.at(-2, "11:00"), clock.at(-2, "11:15"), clock.at(-2, "11:15"), "EXPIRED");
  session("charlotte:expired", shiftByKey.get("charlotte:-3"), clock.at(-3, "13:00"), clock.at(-3, "13:15"), clock.at(-3, "13:15"), "EXPIRED");
  session("sophie:ended", shiftByKey.get("sophie:-3"), clock.at(-3, "13:00"), clock.at(-3, "13:30"), clock.at(-3, "13:28"), "EMPLOYEE_ENDED");
  session("amelia:active", ameliaToday, clock.minutesAgo(5), clock.minutesFromNow(10), null, null);

  // ── Manager override (expired): Jack was exempted for two hours yesterday ───────────────────────────
  const overrideId = b.id("override:jack");
  const overrideStartsAt = clock.at(-1, "13:00");
  const overrideExpiresAt = clock.at(-1, "15:00");
  const jack = employee("jack");
  b.addOverride({
    id: overrideId,
    type: "EXEMPT_TEMPORARILY",
    startsAt: overrideStartsAt,
    expiresAt: overrideExpiresAt,
    revokedAt: null,
    employeeId: jack.id,
    payload: {},
  });
  rows.overrides.push({
    id: overrideId,
    organisationId,
    employeeId: jack.id,
    type: "EXEMPT_TEMPORARILY",
    reason: "Family emergency: needs the phone available this afternoon.",
    createdById: actors.manager.userId,
    startsAt: overrideStartsAt,
    expiresAt: overrideExpiresAt,
    expiredEventEmittedAt: addSeconds(overrideExpiresAt, 20),
    payload: toJson({}),
    createdAt: overrideStartsAt,
  });
  b.audit(actors.manager, "override.created", "ManagerOverride", overrideId, overrideStartsAt, {
    after: {
      type: "EXEMPT_TEMPORARILY",
      employeeId: jack.id,
      startsAt: overrideStartsAt,
      expiresAt: overrideExpiresAt,
      durationMinutes: 120,
      payload: {},
    },
  });
  b.activity({
    type: "OVERRIDE_CREATED",
    at: overrideStartsAt,
    actor: "MANAGER",
    actorUserId: actors.manager.userId,
    employeeId: jack.id,
    metadata: {
      overrideId,
      type: "EXEMPT_TEMPORARILY",
      startsAt: overrideStartsAt.toISOString(),
      expiresAt: overrideExpiresAt.toISOString(),
      durationMinutes: 120,
      orgWide: false,
    },
  });
  b.activity({
    type: "OVERRIDE_EXPIRED",
    at: addSeconds(overrideExpiresAt, 20),
    actor: "SYSTEM",
    employeeId: jack.id,
    metadata: {
      overrideId,
      type: "EXEMPT_TEMPORARILY",
      startsAt: overrideStartsAt.toISOString(),
      expiresAt: overrideExpiresAt.toISOString(),
      orgWide: false,
    },
  });

  // ── Devices + work states (state machine), then the device-reported history ─────────────────────────
  const evaluations = b.materialiseDevices();
  for (const device of b.devices) {
    const spec = specOf.get(device.employee.key as EmployeeKey);
    invariant(spec?.device, `device spec for ${device.employee.key}`);
    const d = spec.device;
    const base = { actor: "EMPLOYEE_DEVICE" as const, employeeId: device.employee.id, deviceId: device.id };
    const inviteId = inviteIdOf.get(spec.key) ?? null;
    b.activity({
      ...base,
      type: "EMPLOYEE_JOINED",
      at: device.linkedAt,
      clientEventId: "join",
      // Same shape the mobile join service records.
      metadata: {
        deviceId: device.id,
        platform: "IOS",
        viaInviteCode: inviteId !== null,
        ...(inviteId ? { inviteId } : {}),
        acceptedInvites: inviteId ? 1 : 0,
        retiredDevices: 0,
      },
    });
    if (d.setupCompletedMinutesAgo !== undefined) {
      const completedAt = clock.minutesAgo(d.setupCompletedMinutesAgo);
      b.activity({ ...base, type: "PERMISSION_GRANTED", at: addMinutes(completedAt, -2), clientEventId: "setup:permission", metadata: { permissionState: "APPROVED" } });
      b.activity({
        ...base,
        type: "SELECTION_CONFIGURED",
        at: addMinutes(completedAt, -1),
        clientEventId: "setup:selection",
        metadata: { selectionState: "CONFIGURED", selectionCounts: device.counts },
      });
      b.activity({
        ...base,
        type: "SETUP_COMPLETED",
        at: completedAt,
        clientEventId: "setup:completed",
        metadata: { permissionState: "APPROVED", selectionState: "CONFIGURED", selectionCounts: device.counts },
      });
    }
    if (d.permissionGrantedMinutesAgo !== undefined) {
      b.activity({ ...base, type: "PERMISSION_GRANTED", at: clock.minutesAgo(d.permissionGrantedMinutesAgo), clientEventId: "setup:permission", metadata: { permissionState: "APPROVED" } });
    }
    if (d.permissionDeniedMinutesAgo !== undefined) {
      b.activity({
        ...base,
        type: "PERMISSION_NEEDS_ATTENTION",
        at: clock.minutesAgo(d.permissionDeniedMinutesAgo),
        clientEventId: "permission:denied",
        metadata: { permissionState: "DENIED", previousPermissionState: "NOT_DETERMINED", engineState: "PERMISSION_ERROR" },
      });
    }
    b.recordWorkModeEvents(device);
  }

  // Sync history: Zach picked up the supervisor's new shifts; Grace received the Social Media Team policy.
  const zachDevice = devicesByEmployee.get("zach");
  if (zachDevice?.lastDeviceSyncAt) {
    b.activity({
      type: "SCHEDULE_SYNCED",
      at: zachDevice.lastDeviceSyncAt,
      actor: "EMPLOYEE_DEVICE",
      employeeId: zachDevice.employee.id,
      deviceId: zachDevice.id,
      clientEventId: `schedule:${zachDevice.scheduleVersion}`,
      metadata: { scheduleVersion: zachDevice.scheduleVersion },
    });
  }
  const graceDevice = devicesByEmployee.get("grace");
  const socialVersion = currentVersionOf.get("social");
  if (graceDevice && socialVersion) {
    b.activity({
      type: "POLICY_SYNCED",
      at: addMinutes(published(socialCreatedAt, 30), 10),
      actor: "EMPLOYEE_DEVICE",
      employeeId: graceDevice.employee.id,
      deviceId: graceDevice.id,
      clientEventId: `policy:${socialVersion.id}`,
      metadata: { policyVersion: socialVersion.id },
    });
  }

  // Noah: the sync-delayed sweep flagged the device when the 24 h threshold passed, and told the owner.
  const noahDevice = devicesByEmployee.get("noah");
  invariant(noahDevice?.lastDeviceSyncAt, "Noah's device has a last sync");
  const noahDelayedAt = addMinutes(noahDevice.lastDeviceSyncAt, 24 * 60);
  const noahEvaluation = evaluations.find((e) => e.device.id === noahDevice.id);
  invariant(noahEvaluation?.badge?.badge === "SYNC_DELAYED", "Noah's device evaluates to SYNC_DELAYED");
  // Same shape the work-state job records when a sync-delayed episode starts.
  b.activity({
    type: "DEVICE_SYNC_DELAYED",
    at: noahDelayedAt,
    actor: "SYSTEM",
    employeeId: noahDevice.employee.id,
    deviceId: noahDevice.id,
    metadata: {
      badge: noahEvaluation.badge.badge,
      reason: noahEvaluation.badge.reason ?? null,
      lastDeviceSyncAt: noahDevice.lastDeviceSyncAt.toISOString(),
      expectedState: noahEvaluation.expected.state,
      activeShiftId: noahEvaluation.expected.activeShift?.id ?? null,
    },
  });

  // ── Notifications for the owner (3, one unread) ────────────────────────────
  const sophie = employee("sophie");
  const sophieDevice = devicesByEmployee.get("sophie");
  invariant(sophieDevice, "Sophie has a device");
  const notification = (p: {
    type: string;
    title: string;
    body: string;
    href: string;
    metadata: Record<string, unknown>;
    at: Date;
    readAt: Date | null;
  }): void => {
    rows.notifications.push({
      organisationId,
      recipientType: "MANAGER_USER",
      recipientId: actors.owner.userId,
      type: p.type,
      title: p.title,
      body: p.body,
      metadata: toJson({ ...p.metadata, href: p.href }),
      channel: "IN_APP",
      readAt: p.readAt,
      sentAt: p.at,
      createdAt: p.at,
    });
  };
  notification({
    type: "EMPLOYEE_JOINED",
    title: "Sophie Martin joined Work Mode",
    body: "Sophie Martin connected a phone with the company join code and completed Screen Time setup.",
    href: `/employees/${sophie.id}`,
    metadata: { employeeId: sophie.id, deviceId: sophieDevice.id },
    at: sophieDevice.linkedAt,
    readAt: addMinutes(sophieDevice.linkedAt, 95),
  });
  notification({
    type: "IMPORT_COMPLETED",
    title: "Rota import finished",
    body: `${importFilename}: ${importedCount} shifts imported, ${skippedCount} row skipped, ${errorCount} rows with errors.`,
    href: "/schedule/import",
    metadata: { importId, shiftsCreated: importedCount, rowsSkipped: skippedCount, errorCount },
    at: importedAt,
    readAt: addMinutes(importedAt, 40),
  });
  notification({
    type: "DEVICE_SYNC_DELAYED",
    title: "Noah Wright's phone has not synced for 30 hours",
    body: "The last device sync was 30 hours ago. Work Mode may not activate for Noah's next shift until the app is opened.",
    href: `/employees/${noahDevice.employee.id}`,
    metadata: { employeeId: noahDevice.employee.id, deviceId: noahDevice.id, lastDeviceSyncAt: noahDevice.lastDeviceSyncAt.toISOString() },
    at: noahDelayedAt,
    readAt: null,
  });

  // ── Integration interest ───────────────────────────────────────────────────
  rows.integrations.push({
    id: b.id("integration:planday"),
    organisationId,
    provider: "PLANDAY",
    status: "NOT_CONNECTED",
    settings: toJson({}),
    activationMode: "SCHEDULED",
    notifyRequested: true,
    createdAt: clock.daysAgo(10),
  });
  b.audit(actors.owner, "integration.notify_requested", "Integration", b.id("integration:planday"), clock.daysAgo(10), {
    after: { provider: "PLANDAY", notifyRequested: true },
  });

  // ── Summary ────────────────────────────────────────────────────────────────
  const policyNameOf = (key: WorkPolicyKey): string => policyDefs.find((d) => d.key === key)?.name ?? key;
  const breakPolicyNameOf = (key: BreakPolicyKey): string => breakPolicyDefs.find((d) => d.key === key)?.name ?? key;
  const summaries: EmployeeSummary[] = specs.map((spec) => {
    const built = employee(spec.key);
    const evaluation = evaluations.find((e) => e.device.employee.id === built.id);
    const work = workPolicyOf.get(spec.key);
    const breaks = breakPolicyOf.get(spec.key);
    return {
      name: `${spec.firstName} ${spec.lastName}`,
      scenario: spec.scenario,
      inviteStatus: built.inviteStatus,
      workPolicy: work ? policyNameOf(work) : "—",
      breakPolicy: breaks ? breakPolicyNameOf(breaks) : "—",
      badge: evaluation ? (evaluation.badge?.badge ?? "—") : "—",
      state: evaluation ? String(evaluation.row.state) : "—",
      expected: evaluation ? evaluation.expected.state : "—",
    };
  });

  return { rows, organisationId, employees: summaries };
}
