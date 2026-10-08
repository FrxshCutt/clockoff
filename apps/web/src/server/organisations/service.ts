import {
  Prisma,
  prisma,
  type CompanyJoinCode,
  type Location,
  type Organisation as OrganisationRow,
  type OrganisationMembership,
} from "@clockoff/db";
import { AppError } from "@clockoff/shared/errors";
import type { CreateOrganisationInput } from "@clockoff/validation/auth";
import {
  ONBOARDING_STEP_KEYS,
  ONBOARDING_STEP_LABELS,
  type OnboardingItem,
  type OnboardingResponse,
  type OnboardingStepKey,
  type Organisation,
  type UpdateOrganisationInput,
} from "@clockoff/validation/organisation";
import { logger } from "@/lib/logger";
import { audit } from "@/server/audit/audit";
import type { ManagerContext } from "@/server/tenancy/context";
import { generateCompanyJoinCode } from "./joinCode";
import {
  onboardingDismissedAt,
  readOnboardingState,
  readOrganisationSettings,
  toOrganisationDto,
  type OnboardingState,
} from "./mappers";
import { countOnboardingSignals, type OnboardingSignals } from "./repository";
import { slugCandidates } from "./slug";

/** Who is creating an organisation: any signed-in manager (a `UserContext` satisfies this). */
export interface OrganisationActor {
  user: { id: string };
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string;
}

export interface CreatedOrganisation {
  organisation: OrganisationRow;
  membership: OrganisationMembership;
  joinCode: CompanyJoinCode;
  location: Location | null;
}

const MAX_CREATE_ATTEMPTS = 8;

function uniqueTarget(err: Prisma.PrismaClientKnownRequestError): string {
  const target = (err.meta as { target?: unknown } | undefined)?.target;
  return Array.isArray(target) ? target.join(",") : String(target ?? "");
}

/**
 * `POST /api/organisations`: create the organisation, the creator's OWNER membership, an optional
 * first location and the ACTIVE company join code, in one transaction. Slug and join code collisions
 * (unique violations) retry with the next candidate.
 */
export async function createOrganisation(
  actor: OrganisationActor,
  input: CreateOrganisationInput,
): Promise<CreatedOrganisation> {
  const slugs = slugCandidates(input.name, { numbered: 5, random: MAX_CREATE_ATTEMPTS });
  let slugIndex = 0;

  for (let attempt = 0; attempt < MAX_CREATE_ATTEMPTS; attempt++) {
    // Skip slugs that are visibly taken before opening the transaction.
    while (slugIndex < slugs.length - 1) {
      const taken = await prisma.organisation.findUnique({
        where: { slug: slugs[slugIndex]! },
        select: { id: true },
      });
      if (!taken) break;
      slugIndex++;
    }
    const slug = slugs[slugIndex]!;
    const code = generateCompanyJoinCode();
    try {
      const created = await prisma.$transaction(async (tx) => {
        const onboardingState: OnboardingState = { createCompany: true, dismissedAt: null };
        const organisation = await tx.organisation.create({
          data: {
            name: input.name,
            slug,
            timezone: input.timezone,
            onboardingState: onboardingState as Prisma.InputJsonValue,
          },
        });
        const membership = await tx.organisationMembership.create({
          data: { organisationId: organisation.id, userId: actor.user.id, role: "OWNER" },
        });
        const location = input.firstLocationName
          ? await tx.location.create({
              data: { organisationId: organisation.id, name: input.firstLocationName },
            })
          : null;
        const joinCode = await tx.companyJoinCode.create({
          data: {
            organisationId: organisation.id,
            code,
            status: "ACTIVE",
            createdById: actor.user.id,
          },
        });
        await audit(
          {
            organisation,
            user: actor.user,
            ip: actor.ip ?? null,
            userAgent: actor.userAgent ?? null,
          },
          {
            action: "organisation.created",
            entityType: "Organisation",
            entityId: organisation.id,
            after: {
              name: organisation.name,
              slug: organisation.slug,
              timezone: organisation.timezone,
              firstLocationId: location?.id ?? null,
            },
          },
          tx,
        );
        return { organisation, membership, joinCode, location };
      });
      logger.info(
        {
          requestId: actor.requestId,
          organisationId: created.organisation.id,
          userId: actor.user.id,
        },
        "organisation created",
      );
      return created;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        const target = uniqueTarget(err);
        if (target.includes("slug")) slugIndex = Math.min(slugIndex + 1, slugs.length - 1);
        // join code collision: the next attempt draws a new code.
        continue;
      }
      throw err;
    }
  }
  throw new AppError(
    "ORGANISATION_SLUG_TAKEN",
    "Could not allocate a unique organisation identifier; try another name",
  );
}

/** Organisations the user belongs to (not soft-deleted), oldest membership first. */
export async function listOrganisationsForUser(userId: string) {
  const memberships = await prisma.organisationMembership.findMany({
    where: { userId, organisation: { deletedAt: null } },
    include: { organisation: true },
    orderBy: { createdAt: "asc" },
  });
  return memberships.map((m) => ({ ...toOrganisationDto(m.organisation), role: m.role }));
}

/** `GET /api/organisations/current`. */
export function getCurrentOrganisation(ctx: ManagerContext): Organisation {
  return toOrganisationDto(ctx.organisation);
}

/** The organisation's ACTIVE company join code (at most one, enforced by a partial unique index). */
export async function getActiveJoinCode(
  organisationId: string,
): Promise<{ id: string; code: string; status: "ACTIVE" } | null> {
  const row = await prisma.companyJoinCode.findFirst({
    where: { organisationId, status: "ACTIVE" },
    select: { id: true, code: true },
  });
  return row ? { id: row.id, code: row.code, status: "ACTIVE" } : null;
}

/** `PATCH /api/organisations/current` (org:manage). Settings are merged key by key. Audited. */
export async function updateCurrentOrganisation(
  ctx: ManagerContext,
  input: UpdateOrganisationInput,
): Promise<Organisation> {
  const organisationId = ctx.organisation.id;
  const updated = await prisma.$transaction(async (tx) => {
    const before = await tx.organisation.findUniqueOrThrow({ where: { id: organisationId } });
    const data: Prisma.OrganisationUpdateInput = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.timezone !== undefined) data.timezone = input.timezone;
    if (input.dateFormat !== undefined) data.dateFormat = input.dateFormat;
    if (input.settings !== undefined) {
      const currentSettings = readOrganisationSettings(before.settings);
      const stored =
        before.settings && typeof before.settings === "object" && !Array.isArray(before.settings)
          ? (before.settings as Record<string, unknown>)
          : {};
      data.settings = { ...stored, ...currentSettings, ...input.settings } as Prisma.InputJsonValue;
    }
    if (Object.keys(data).length === 0) return before;

    const after = await tx.organisation.update({ where: { id: organisationId }, data });
    await audit(
      ctx,
      {
        action: "organisation.updated",
        entityType: "Organisation",
        entityId: organisationId,
        before: pickAuditFields(before),
        after: pickAuditFields(after),
      },
      tx,
    );
    return after;
  });
  return toOrganisationDto(updated);
}

function pickAuditFields(org: OrganisationRow) {
  return {
    name: org.name,
    timezone: org.timezone,
    dateFormat: org.dateFormat,
    settings: readOrganisationSettings(org.settings),
  };
}

// ── Onboarding checklist ────────────────────────────────────────────────────

/** Dashboard routes that complete each step (owned by the dashboard; adjust there if they move). */
export const ONBOARDING_STEP_HREFS: Record<OnboardingStepKey, string> = {
  createCompany: "/settings",
  createPolicy: "/policies/new",
  configureBreakRules: "/break-rules",
  addEmployees: "/employees",
  addSchedules: "/schedule",
  inviteEmployees: "/employees",
  employeesConnect: "/employees",
  goLive: "/overview",
};

export function computeOnboardingSteps(
  signals: OnboardingSignals,
): Record<OnboardingStepKey, boolean> {
  const steps = {
    createCompany: true,
    createPolicy: signals.activePolicies > 0,
    configureBreakRules: signals.activeBreakPolicies > 0,
    addEmployees: signals.employees > 0,
    addSchedules: signals.shifts > 0,
    inviteEmployees: signals.employeeInvites > 0,
    employeesConnect: signals.activeDevices > 0,
  };
  // "Go live" = every preceding step is done (policy + breaks + people + schedule + connected phones).
  const goLive = Object.values(steps).every(Boolean);
  return { ...steps, goLive };
}

export function buildOnboardingResponse(
  steps: Record<OnboardingStepKey, boolean>,
  dismissedAt: string | null,
  rotaSource: OnboardingResponse["rotaSource"] = null,
): OnboardingResponse {
  const items: OnboardingItem[] = ONBOARDING_STEP_KEYS.map((key) => ({
    key,
    label: ONBOARDING_STEP_LABELS[key],
    done: steps[key],
    href: ONBOARDING_STEP_HREFS[key],
  }));
  const completedCount = items.filter((i) => i.done).length;
  return {
    items,
    completedCount,
    totalCount: items.length,
    allDone: completedCount === items.length,
    dismissedAt,
    rotaSource,
  };
}

/** `GET /api/organisations/current/onboarding`: computed from real data, merged with `dismissedAt`. */
export async function getOnboarding(ctx: ManagerContext): Promise<OnboardingResponse> {
  const [signals, org] = await Promise.all([
    countOnboardingSignals(ctx.organisation.id),
    prisma.organisation.findUniqueOrThrow({
      where: { id: ctx.organisation.id },
      select: { onboardingState: true, rotaSource: true },
    }),
  ]);
  return buildOnboardingResponse(
    computeOnboardingSteps(signals),
    onboardingDismissedAt(org.onboardingState),
    org.rotaSource,
  );
}

/** `POST /api/organisations/current/onboarding/dismiss` (org:manage). Idempotent. Audited. */
export async function dismissOnboarding(ctx: ManagerContext): Promise<OnboardingResponse> {
  await prisma.$transaction(async (tx) => {
    const org = await tx.organisation.findUniqueOrThrow({
      where: { id: ctx.organisation.id },
      select: { onboardingState: true },
    });
    const state = readOnboardingState(org.onboardingState);
    if (onboardingDismissedAt(org.onboardingState)) return;
    const next: OnboardingState = { ...state, dismissedAt: new Date().toISOString() };
    await tx.organisation.update({
      where: { id: ctx.organisation.id },
      data: { onboardingState: next as Prisma.InputJsonValue },
    });
    await audit(
      ctx,
      {
        action: "organisation.onboarding_dismissed",
        entityType: "Organisation",
        entityId: ctx.organisation.id,
        after: { dismissedAt: next.dismissedAt },
      },
      tx,
    );
  });
  return getOnboarding(ctx);
}
