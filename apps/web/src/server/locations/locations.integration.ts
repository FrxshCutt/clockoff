import { randomUUID } from "node:crypto";
import type { Prisma } from "@clockoff/db";
import { AppError } from "@clockoff/shared/errors";
import { PROVIDERS } from "@clockoff/shared/providers/registry";
import { lockOrganisationRow } from "@/server/joinCodes/joinCodes.repository";
import {
  assertIntegrationWriteScope,
  managingProvider,
  notManagedByIntegration,
} from "@/server/shifts/shifts.integration";

/**
 * Integration writers for locations (docs/integrations/PLANDAY_IMPLEMENTATION_PLAN.md §6.3, §6.9): an included
 * Planday department mapped to "new location" becomes a managed location (`source INTEGRATION`, the portal's
 * time zone); one mapped to an existing location only gets a map row (the caller's) and the location stays the
 * manager's, its name never changed. Every query filters on the run's organisation; a writer refuses a
 * location another integration (or nobody) manages.
 *
 * Location names are unique per organisation (case-insensitive, `locations.service.ts`). A department whose
 * name an existing live location already has gets a suffixed name ("Kitchen (Planday)", then
 * "Kitchen (Planday 2)", …) rather than failing a sync. The plan's location limit is the caller's check (the
 * wizard and settings validate their choices before applying them).
 */

/** A sync (or a wizard step applying its choices) acting for one integration. */
export interface IntegrationRecordActor {
  organisationId: string;
  integrationId: string;
}

export interface ManagedLocationInput {
  /** Planday department id (or `"none"`, §6.3): the map row's `externalId`. */
  externalId: string;
  name: string;
  /** The portal's time zone (department zones are not readable, §6.7). */
  timezone: string | null;
  /** Decision-input hash for the map row (§6.2). */
  lastHash: string | null;
}

/** First free name among `taken` (lower-cased): `name`, then "name (Planday)", "name (Planday 2)", … */
function freeName(name: string, taken: Set<string>, providerName: string): string {
  const candidates = [name, `${name} (${providerName})`];
  for (let n = 2; candidates.length < 1000; n++) candidates.push(`${name} (${providerName} ${n})`);
  const free = candidates.find((candidate) => !taken.has(candidate.toLowerCase()));
  if (!free) throw new Error(`No free location name for ${name}`);
  return free;
}

async function liveLocationNames(
  tx: Prisma.TransactionClient,
  organisationId: string,
  excludeId?: string,
): Promise<Set<string>> {
  const rows = await tx.location.findMany({
    where: {
      organisationId,
      deletedAt: null,
      ...(excludeId ? { id: { not: excludeId } } : {}),
    },
    select: { name: true },
  });
  return new Set(rows.map((r) => r.name.toLowerCase()));
}

/**
 * "Included, target new location, no map row" (§6.3): creates `Location { name, timezone, source:
 * INTEGRATION, managedByIntegrationId }` and its `LOCATION` map row per input, under the organisation row lock
 * (name uniqueness, as `createLocation`). A map row of the same department that points at a location this
 * integration manages answers CONFLICT `EXTERNAL_ID_MAPPED` (rename it instead); one that points at a
 * manager's location or a deleted one is replaced. Returns the new ids and the names given, in input order.
 */
export async function createManagedLocations(
  tx: Prisma.TransactionClient,
  actor: IntegrationRecordActor,
  inputs: readonly ManagedLocationInput[],
  now: Date,
): Promise<Array<{ externalId: string; locationId: string; name: string }>> {
  if (inputs.length === 0) return [];
  const { organisationId, integrationId } = actor;
  const externalIds = new Set(inputs.map((i) => i.externalId));
  if (externalIds.size !== inputs.length) {
    throw new Error("createManagedLocations: a department appears twice");
  }
  const { provider } = await assertIntegrationWriteScope(tx, organisationId, { integrationId });
  const providerId = provider ?? managingProvider(integrationId);
  await lockOrganisationRow(tx, organisationId);
  const mapRows = await tx.externalEntityMap.findMany({
    where: {
      organisationId,
      integrationId,
      entityType: "LOCATION",
      externalId: { in: [...externalIds] },
    },
    select: { id: true, externalId: true, internalId: true },
  });
  if (mapRows.length > 0) {
    const managed = await tx.location.findMany({
      where: {
        organisationId,
        id: { in: mapRows.map((m) => m.internalId) },
        managedByIntegrationId: integrationId,
        deletedAt: null,
      },
      select: { id: true },
    });
    if (managed.length > 0) {
      const ids = new Set(managed.map((l) => l.id));
      throw new AppError("CONFLICT", "This Planday department already has a location", {
        details: {
          reason: "EXTERNAL_ID_MAPPED",
          externalIds: mapRows.filter((m) => ids.has(m.internalId)).map((m) => m.externalId),
        },
      });
    }
    await tx.externalEntityMap.deleteMany({ where: { id: { in: mapRows.map((m) => m.id) } } });
  }

  const taken = await liveLocationNames(tx, organisationId);
  const planned = inputs.map((input) => {
    const name = freeName(input.name, taken, PROVIDERS[providerId].displayName);
    taken.add(name.toLowerCase());
    return { input, id: randomUUID() as string, name };
  });
  await tx.location.createMany({
    data: planned.map(({ input, id, name }) => ({
      id,
      organisationId,
      name,
      timezone: input.timezone,
      source: "INTEGRATION" as const,
      managedByIntegrationId: integrationId,
    })),
  });
  await tx.externalEntityMap.createMany({
    data: planned.map(({ input, id }) => ({
      organisationId,
      integrationId,
      provider: providerId,
      entityType: "LOCATION" as const,
      externalId: input.externalId,
      internalId: id,
      lastSeenAt: now,
      lastHash: input.lastHash,
    })),
  });
  return planned.map(({ input, id, name }) => ({
    externalId: input.externalId,
    locationId: id,
    name,
  }));
}

/**
 * "Renamed in Planday, managed location" (§6.3): renames a location this integration manages (a suffixed name
 * when another live location already has it). Returns whether the name changed and the name given; refuses a
 * location it does not manage, including a manager's location used as a mapping target.
 */
export async function renameManagedLocation(
  tx: Prisma.TransactionClient,
  actor: IntegrationRecordActor,
  input: { locationId: string; name: string },
): Promise<{ renamed: boolean; name: string }> {
  const where = {
    id: input.locationId,
    organisationId: actor.organisationId,
    managedByIntegrationId: actor.integrationId,
    deletedAt: null,
  };
  const location = await tx.location.findFirst({ where, select: { id: true, name: true } });
  if (!location) throw notManagedByIntegration("Location", input.locationId);
  if (location.name === input.name) return { renamed: false, name: location.name };
  await lockOrganisationRow(tx, actor.organisationId);
  const taken = await liveLocationNames(tx, actor.organisationId, location.id);
  const name = freeName(
    input.name,
    taken,
    PROVIDERS[managingProvider(actor.integrationId)].displayName,
  );
  if (name === location.name) return { renamed: false, name };
  const result = await tx.location.updateMany({ where, data: { name } });
  if (result.count === 0) throw notManagedByIntegration("Location", input.locationId);
  return { renamed: true, name };
}
