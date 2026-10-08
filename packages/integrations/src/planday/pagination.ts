import type { z } from "zod";
import { MAX_PAGES_PER_LIST } from "./constants";
import { PlandayError } from "./errors";
import type { PlandayHttp, QueryValue } from "./http";
import { pathTemplate } from "./logging";
import { pagedResponseSchema, type PlandayPaging } from "./schemas";

/**
 * Offset pagination (docs/integrations/PLANDAY_IMPLEMENTATION_PLAN.md §4.4, notes §7):
 *
 * 1. Always send an explicit `limit` (PAGE_LIMITS).
 * 2. `offset += data.length`, never `+= limit`: the server may lower the limit.
 * 3. Stop when `data` is empty, or when `paging` is present and `offset >= paging.total`. The requested limit is
 *    never a stop condition: with `paging: null` the loop continues to an empty page, and a short page with
 *    `paging` present is compared with `paging.total` only (a server-lowered `paging.limit` is not an end).
 * 4. Sort order is undocumented, so records are de-duplicated by id within one pass.
 *
 * One page is one step of a sync phase: the executor persists `{ offset: nextOffset }` after the page's records are
 * written, so a crash or a shutdown resumes at the next page and replaying a page is idempotent.
 */

export interface PlandayPage<T> {
  readonly records: T[];
  /** The offset this page was requested at. */
  readonly offset: number;
  /** The offset of the next page: `offset + data.length`. */
  readonly nextOffset: number;
  /** `paging.total`, when Planday sent paging. */
  readonly total: number | null;
  /** True when this was the last page (rule 3). */
  readonly done: boolean;
}

export interface PageRequest {
  readonly offset?: number;
  readonly limit?: number;
}

/** Rule 2 and rule 3 for one received page. */
export function pageProgress(
  offset: number,
  received: number,
  paging: PlandayPaging,
): { readonly nextOffset: number; readonly done: boolean } {
  const nextOffset = offset + received;
  const done = received === 0 || (paging !== null && nextOffset >= paging.total);
  return { nextOffset, done };
}

/**
 * Fetches one page of a list, validates it with the endpoint's allow-list item schema and maps every record.
 * A record failing the schema fails the whole page (PLANDAY_INVALID_RESPONSE), as does a mapper that throws
 * (the shift `date` cross-check): nothing of a page is returned unless all of it was read.
 */
export async function fetchPage<S extends z.ZodType, T>(
  http: PlandayHttp,
  request: {
    readonly path: string;
    readonly query?: Readonly<Record<string, QueryValue>>;
    readonly offset: number;
    readonly limit: number;
    readonly itemSchema: S;
    readonly map: (item: z.output<S>) => T;
  },
): Promise<PlandayPage<T>> {
  if (!Number.isInteger(request.offset) || request.offset < 0) {
    throw new RangeError("offset must be a non-negative integer");
  }
  if (!Number.isInteger(request.limit) || request.limit < 1) {
    throw new RangeError("limit must be a positive integer");
  }
  const parsed = await http.getParsed(
    request.path,
    { ...request.query, limit: request.limit, offset: request.offset },
    pagedResponseSchema(request.itemSchema),
  );
  const data = parsed.data as Array<z.output<S>>;
  const records = data.map((item) => request.map(item));
  const { nextOffset, done } = pageProgress(request.offset, data.length, parsed.paging);
  return {
    records,
    offset: request.offset,
    nextOffset,
    total: parsed.paging?.total ?? null,
    done,
  };
}

/**
 * Walks a list to exhaustion from `offset`, yielding each page with records already seen in this pass removed
 * (rule 4). Stops after MAX_PAGES_PER_LIST pages with PLANDAY_INVALID_RESPONSE (`PAGINATION_RUNAWAY`): a server
 * that ignores `offset` and never sends an empty page must not loop forever.
 */
export async function* paginate<T>(
  fetch: (offset: number) => Promise<PlandayPage<T>>,
  options: {
    readonly key: (record: T) => string;
    readonly offset?: number;
    readonly maxPages?: number;
    /** For the runaway error only. */
    readonly path?: string;
  },
): AsyncGenerator<PlandayPage<T>, void, undefined> {
  const seen = new Set<string>();
  const maxPages = options.maxPages ?? MAX_PAGES_PER_LIST;
  let offset = options.offset ?? 0;
  for (let pages = 0; ; pages++) {
    if (pages >= maxPages) {
      throw new PlandayError("PLANDAY_INVALID_RESPONSE", {
        reason: "PAGINATION_RUNAWAY",
        ...(options.path !== undefined ? { pathTemplate: pathTemplate(options.path) } : {}),
      });
    }
    const page = await fetch(offset);
    const fresh = page.records.filter((record) => {
      const key = options.key(record);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    yield { ...page, records: fresh };
    if (page.done) return;
    offset = page.nextOffset;
  }
}

/** Every record of a list (de-duplicated). For small lists: departments, groups, a connect probe. */
export async function fetchAllPages<T>(
  fetch: (offset: number) => Promise<PlandayPage<T>>,
  options: {
    readonly key: (record: T) => string;
    readonly maxPages?: number;
    readonly path?: string;
  },
): Promise<T[]> {
  const all: T[] = [];
  for await (const page of paginate(fetch, options)) all.push(...page.records);
  return all;
}
