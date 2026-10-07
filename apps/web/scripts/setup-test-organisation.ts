/**
 * Creates (or finds) the "ClockOff Test" organisation used for on-device testing (docs/DEVICE_TESTING.md),
 * through the same service functions the dashboard uses: organisation + company join code + first location,
 * a "Standard Staff" Work Policy (Social Media, Games, Entertainment), a "Standard Break" Break Policy
 * (2 × 15 min, relax everything, allowed from the start of a shift so short test shifts can take one), both as
 * organisation defaults, and one employee. Idempotent: re-running reuses what exists and prints the code.
 *
 * Never touches any other organisation. Usage (env from the target deployment, e.g. production):
 *   OWNER_EMAIL=you@example.com TEST_EMPLOYEE_NAME="First Last" tsx scripts/setup-test-organisation.ts
 */
import { prisma } from "@clockoff/db";
import type { Session } from "@clockoff/db";
import { DEFAULT_RESTRICTION_CONFIG } from "@clockoff/shared/policy/restrictionConfig";
import { createBreakPolicySchema } from "@clockoff/validation/breakPolicies";
import { createEmployeeSchema } from "@clockoff/validation/employees";
import { createPolicySchema } from "@clockoff/validation/policies";
import {
  createBreakPolicy,
  setDefaultBreakPolicy,
} from "@/server/breakPolicies/breakPolicies.service";
import { createEmployee } from "@/server/employees/employees.service";
import { createOrganisation } from "@/server/organisations/service";
import { createPolicy, publishPolicy, setDefaultPolicy } from "@/server/policies/policies.service";
import { elevateToManagerContext } from "@/server/tenancy/context";

const ORGANISATION_NAME = "ClockOff Test";
const LOCATION_NAME = "Test site";

async function main() {
  const ownerEmail = process.env.OWNER_EMAIL?.trim().toLowerCase();
  const employeeName = (process.env.TEST_EMPLOYEE_NAME ?? "").trim();
  if (!ownerEmail || !employeeName.includes(" ")) {
    throw new Error('Set OWNER_EMAIL and TEST_EMPLOYEE_NAME ("First Last").');
  }
  const [firstName, ...rest] = employeeName.split(/\s+/);
  const lastName = rest.join(" ");

  const user = await prisma.user.findUnique({ where: { email: ownerEmail } });
  if (!user || user.deletedAt) throw new Error("No active ClockOff user with OWNER_EMAIL.");
  const meta = {
    requestId: `setup-test-organisation-${Date.now()}`,
    ip: null,
    userAgent: "scripts/setup-test-organisation",
  };

  // Reuse an existing "ClockOff Test" organisation this user owns.
  const existing = await prisma.organisationMembership.findFirst({
    where: {
      userId: user.id,
      role: "OWNER",
      organisation: { name: ORGANISATION_NAME, deletedAt: null },
    },
    include: { organisation: true },
  });
  const organisationId =
    existing?.organisationId ??
    (
      await createOrganisation(
        { user, ...meta },
        { name: ORGANISATION_NAME, timezone: "Europe/London", firstLocationName: LOCATION_NAME },
      )
    ).organisation.id;

  const ctx = await elevateToManagerContext(
    {
      kind: "user",
      user,
      session: { id: "script", userId: user.id } as unknown as Session,
      sessionSlid: false,
      ...meta,
    },
    organisationId,
    { requireVerifiedEmail: false },
  );
  if (ctx.organisation.name !== ORGANISATION_NAME)
    throw new Error("Refusing: resolved a different organisation.");

  // Work Policy.
  let policy = await prisma.policy.findFirst({
    where: { organisationId, name: "Standard Staff", deletedAt: null },
  });
  if (!policy) {
    const input = createPolicySchema.parse({
      name: "Standard Staff",
      description:
        "Test organisation default: social media, games and entertainment are shielded during shifts.",
      restrictionConfig: {
        ...DEFAULT_RESTRICTION_CONFIG,
        alwaysAllowedNote: [...DEFAULT_RESTRICTION_CONFIG.alwaysAllowedNote],
        categories: ["SOCIAL_MEDIA", "GAMES", "ENTERTAINMENT"],
        shieldMessage: "Work Mode is on. This app will be available again after your shift.",
        activationMode: "SCHEDULED",
      },
      breakBehaviourDefault: { restrictionBehaviour: "RELAX_ALL", relaxedCategories: [] },
    });
    const created = await createPolicy(ctx, input);
    await publishPolicy(ctx, created.id);
    policy = await prisma.policy.findUniqueOrThrow({ where: { id: created.id } });
  }
  await setDefaultPolicy(ctx, { policyId: policy.id });

  // Break Policy: 2 × 15 min, relax everything, allowed straight away (test shifts are 30 min long).
  let breakPolicy = await prisma.breakPolicy.findFirst({
    where: { organisationId, name: "Standard Break", deletedAt: null },
  });
  if (!breakPolicy) {
    const input = createBreakPolicySchema.parse({
      name: "Standard Break",
      description: "Test organisation: two 15-minute breaks that relax all restrictions.",
      breaksEnabled: true,
      maxBreaksPerShift: 2,
      maxBreakDurationMinutes: 15,
      maxTotalBreakMinutes: 30,
      minGapBetweenBreaksMinutes: 0,
      minMinutesAfterShiftStart: 0,
      employeeTriggeredAllowed: true,
      restrictionBehaviour: "RELAX_ALL",
    });
    const created = await createBreakPolicy(ctx, input);
    breakPolicy = await prisma.breakPolicy.findUniqueOrThrow({ where: { id: created.id } });
  }
  await setDefaultBreakPolicy(ctx, { breakPolicyId: breakPolicy.id });

  // Employee.
  const location = await prisma.location.findFirst({
    where: { organisationId, deletedAt: null },
    orderBy: { createdAt: "asc" },
  });
  let employee = await prisma.employee.findFirst({
    where: { organisationId, firstName, lastName },
  });
  if (!employee) {
    const created = await createEmployee(
      ctx,
      createEmployeeSchema.parse({
        firstName,
        lastName,
        ...(location ? { primaryLocationId: location.id } : {}),
      }),
    );
    employee = await prisma.employee.findUniqueOrThrow({ where: { id: created.id } });
  }

  const joinCode = await prisma.companyJoinCode.findFirst({
    where: { organisationId, status: "ACTIVE" },
    orderBy: { createdAt: "desc" },
  });
  console.log(
    JSON.stringify(
      {
        organisation: { id: organisationId, name: ctx.organisation.name, created: !existing },
        companyCode: joinCode?.code ?? null,
        policy: policy.name,
        breakPolicy: breakPolicy.name,
        employee: `${employee.firstName} ${employee.lastName} (${employee.inviteStatus})`,
        location: location?.name ?? null,
        // The deployment must list the organisation for "Create test shift…" to appear (apps/web/src/lib/env.ts).
        testToolsEnv: `TEST_TOOLS_ORGANISATION_IDS=${organisationId}`,
      },
      null,
      2,
    ),
  );
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
