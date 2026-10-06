import { Prisma, prisma } from "@workmode/db";
import { AppError } from "@workmode/shared/errors";
import { generateJoinCode } from "@workmode/shared/joinCode";
import type { JoinCode, JoinCodeResponse } from "@workmode/validation/organisation";
import { audit } from "@/server/audit/audit";
import type { ManagerContext } from "@/server/tenancy/context";
import {
  createActiveJoinCode,
  findActiveJoinCode,
  findJoinCodes,
  lockOrganisationRow,
  revokeActiveJoinCodes,
  type JoinCodeRow,
} from "./joinCodes.repository";

/**
 * Company join codes (`WORD-####`, §5 join code). One ACTIVE code per organisation lets employees join from
 * the iOS app; regenerating revokes the current code (phones that already joined are unaffected) and
 * revoking leaves the organisation without a usable code until a new one is generated. Every mutation is
 * audited. The organisation creation flow (`@/server/organisations`) creates the first code.
 */

/** Draws per regeneration before giving up on a globally unique code (~2M possible codes). */
const MAX_GENERATE_ATTEMPTS = 8;

export function toJoinCodeDto(row: JoinCodeRow): JoinCode {
  return {
    id: row.id,
    code: row.code,
    status: row.status,
    createdBy: row.createdBy ? { id: row.createdBy.id, name: row.createdBy.name } : null,
    createdAt: row.createdAt.toISOString(),
    revokedAt: row.revokedAt?.toISOString() ?? null,
  };
}

/** `{ current, history }` from the organisation's rows (newest first): ACTIVE → current, REVOKED → history. */
export function buildJoinCodeResponse(rows: readonly JoinCodeRow[]): JoinCodeResponse {
  const current = rows.find((row) => row.status === "ACTIVE") ?? null;
  return {
    current: current ? toJoinCodeDto(current) : null,
    history: rows.filter((row) => row.status === "REVOKED").map(toJoinCodeDto),
  };
}

/** `GET /api/organisations/current/join-code` */
export async function getJoinCodes(ctx: ManagerContext): Promise<JoinCodeResponse> {
  return buildJoinCodeResponse(await findJoinCodes(ctx.organisation.id));
}

/**
 * `POST /api/organisations/current/join-code/regenerate` (org:manage): revoke the active code and create a
 * fresh one in one transaction. A collision on the globally unique `code` (P2002) draws again.
 */
export async function regenerateJoinCode(ctx: ManagerContext): Promise<JoinCodeResponse> {
  const organisationId = ctx.organisation.id;
  for (let attempt = 0; attempt < MAX_GENERATE_ATTEMPTS; attempt++) {
    const code = generateJoinCode();
    try {
      await prisma.$transaction(async (tx) => {
        await lockOrganisationRow(tx, organisationId);
        const previous = await findActiveJoinCode(organisationId, tx);
        const now = new Date();
        await revokeActiveJoinCodes(organisationId, now, tx);
        const created = await createActiveJoinCode(organisationId, code, ctx.user.id, tx);
        await audit(
          ctx,
          {
            action: "join_code.regenerated",
            entityType: "CompanyJoinCode",
            entityId: created.id,
            before: previous ? { id: previous.id, code: previous.code } : null,
            after: { id: created.id, code: created.code },
            occurredAt: now,
          },
          tx,
        );
      });
      return getJoinCodes(ctx);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") continue;
      throw err;
    }
  }
  throw new AppError("CONFLICT", "Could not allocate a unique join code; please try again");
}

/**
 * `POST /api/organisations/current/join-code/revoke` (org:manage). Idempotent: with no active code the
 * current state is returned unchanged and nothing is audited.
 */
export async function revokeJoinCode(ctx: ManagerContext): Promise<JoinCodeResponse> {
  const organisationId = ctx.organisation.id;
  await prisma.$transaction(async (tx) => {
    await lockOrganisationRow(tx, organisationId);
    const active = await findActiveJoinCode(organisationId, tx);
    if (!active) return;
    const now = new Date();
    await revokeActiveJoinCodes(organisationId, now, tx);
    await audit(
      ctx,
      {
        action: "join_code.revoked",
        entityType: "CompanyJoinCode",
        entityId: active.id,
        before: { id: active.id, code: active.code, status: "ACTIVE" },
        after: { id: active.id, code: active.code, status: "REVOKED", revokedAt: now },
        occurredAt: now,
      },
      tx,
    );
  });
  return getJoinCodes(ctx);
}
