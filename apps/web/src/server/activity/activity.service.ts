import { AppError } from "@workmode/shared/errors";
import type { ActivityQuery, ListActivityResponse } from "@workmode/validation/activity";
import { toActivityEventDto, toEmployeeSummary } from "@/server/employees/employees.mappers";
import type { ManagerContext } from "@/server/tenancy/context";
import { findActivityEvents, findActorUsers, type ActivityEventRow } from "./activity.repository";

/**
 * Organisation activity feed (§5 `GET /api/activity`): cursor-paginated newest first, the same DTO and the
 * same opaque cursor format as `GET /api/employees/:id/activity` (base64url `{ t: occurredAt, id }`), so the
 * dashboard can page either feed with one component. Metadata is passed through untouched — it only ever
 * holds operational values (§12), enforced where events are recorded.
 */

interface ActivityCursor {
  t: string;
  id: string;
}

export function encodeActivityCursor(row: Pick<ActivityEventRow, "occurredAt" | "id">): string {
  const cursor: ActivityCursor = { t: row.occurredAt.toISOString(), id: row.id };
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeActivityCursor(value: string | undefined): ActivityCursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as Partial<ActivityCursor>;
    if (
      typeof parsed.t === "string" &&
      !Number.isNaN(Date.parse(parsed.t)) &&
      typeof parsed.id === "string"
    ) {
      return { t: parsed.t, id: parsed.id };
    }
  } catch {
    // fall through
  }
  throw new AppError("VALIDATION_ERROR", "Invalid cursor", {
    details: { source: "query", formErrors: [], fieldErrors: { cursor: ["Invalid cursor"] } },
  });
}

export async function listActivity(
  ctx: ManagerContext,
  query: ActivityQuery,
): Promise<ListActivityResponse> {
  const cursor = decodeActivityCursor(query.cursor);
  const rows = await findActivityEvents(
    ctx.organisation.id,
    {
      employeeId: query.employeeId,
      types: query.type,
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
      locationId: query.locationId,
      after: cursor ? { occurredAt: new Date(cursor.t), id: cursor.id } : undefined,
    },
    query.limit + 1,
  );
  const page = rows.slice(0, query.limit);
  const nextCursor =
    rows.length > query.limit ? encodeActivityCursor(page[page.length - 1]!) : null;

  const actorIds = [
    ...new Set(page.map((e) => e.actorUserId).filter((id): id is string => id !== null)),
  ];
  const actors = await findActorUsers(actorIds);
  const actorById = new Map(actors.map((u) => [u.id, u]));

  return {
    items: page.map((row) =>
      toActivityEventDto(
        row,
        row.employee ? toEmployeeSummary(row.employee) : null,
        row.actorUserId ? (actorById.get(row.actorUserId) ?? null) : null,
      ),
    ),
    nextCursor,
  };
}
