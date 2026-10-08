import { describe, expect, it } from "vitest";
import { createPlandayHttp, PlandayBudgets, type PlandayFetch } from "./http";
import { fetchAllPages, fetchPage, pageProgress, paginate, type PlandayPage } from "./pagination";
import { departmentSchema } from "./schemas";
import { mapDepartment } from "./mappers";

/**
 * A fake HR list served with Planday's offset semantics: `cap` lowers the requested limit (a server-lowered
 * limit, mock `capPageSize`), `pagingNull` drops the paging object, `ignoreOffset` replays the first page.
 */
function fakeList(
  ids: number[],
  options: {
    cap?: number;
    pagingNull?: boolean;
    reportedTotal?: number;
    ignoreOffset?: boolean;
  } = {},
) {
  const requests: Array<{ limit: number; offset: number }> = [];
  const fetch: PlandayFetch = async (url) => {
    const u = new URL(url);
    const limit = Number(u.searchParams.get("limit"));
    const offset = options.ignoreOffset ? 0 : Number(u.searchParams.get("offset"));
    requests.push({ limit, offset: Number(u.searchParams.get("offset")) });
    const effective = Math.min(limit, options.cap ?? limit);
    const data = ids.slice(offset, offset + effective).map((id) => ({ id, name: `D${id}` }));
    const paging = options.pagingNull
      ? null
      : { offset, limit: effective, total: options.reportedTotal ?? ids.length };
    return new Response(JSON.stringify({ data, paging }), { status: 200 });
  };
  const http = createPlandayHttp({
    transport: { fetch },
    auth: {
      current: async () => ({ accessToken: "at", clientId: "c" }),
      refreshAfterUnauthorized: async () => undefined,
    },
    portalKey: "p",
    budgets: new PlandayBudgets(),
    sleep: async () => undefined,
  });
  const fetchDepartments = (offset: number, limit = 50) =>
    fetchPage(http, {
      path: "/hr/v1.0/departments",
      offset,
      limit,
      itemSchema: departmentSchema,
      map: mapDepartment,
    });
  return { requests, fetchDepartments };
}

const ids = (n: number, from = 1) => Array.from({ length: n }, (_, i) => from + i);
const key = (d: { externalId: string }) => d.externalId;

describe("pageProgress (notes §7 rules 2 and 3)", () => {
  it("advances by the records received and stops on empty data or offset ≥ total", () => {
    expect(pageProgress(0, 50, { total: 120 })).toEqual({ nextOffset: 50, done: false });
    expect(pageProgress(100, 20, { total: 120 })).toEqual({ nextOffset: 120, done: true });
    expect(pageProgress(120, 0, { total: 120 })).toEqual({ nextOffset: 120, done: true });
    expect(pageProgress(0, 0, null)).toEqual({ nextOffset: 0, done: true });
  });

  it("never treats a short page as the end while paging says there is more", () => {
    expect(pageProgress(0, 10, { offset: 0, limit: 10, total: 25 })).toEqual({
      nextOffset: 10,
      done: false,
    });
  });

  it("with paging null, only an empty page ends the list", () => {
    expect(pageProgress(0, 3, null)).toEqual({ nextOffset: 3, done: false });
  });
});

describe("fetchPage", () => {
  it("sends an explicit limit and the offset, and maps the records", async () => {
    const list = fakeList(ids(3, 101));
    const page = await list.fetchDepartments(0);
    expect(list.requests).toEqual([{ limit: 50, offset: 0 }]);
    expect(page).toEqual({
      records: [
        { externalId: "101", name: "D101", number: null },
        { externalId: "102", name: "D102", number: null },
        { externalId: "103", name: "D103", number: null },
      ],
      offset: 0,
      nextOffset: 3,
      total: 3,
      done: true,
    });
  });

  it("refuses a negative offset or a zero limit", async () => {
    const list = fakeList(ids(3));
    await expect(list.fetchDepartments(-1)).rejects.toThrow(RangeError);
    await expect(list.fetchDepartments(0, 0)).rejects.toThrow(RangeError);
  });
});

describe("paginate", () => {
  async function walk(list: ReturnType<typeof fakeList>) {
    const pages: Array<PlandayPage<{ externalId: string }>> = [];
    for await (const page of paginate((offset) => list.fetchDepartments(offset), { key }))
      pages.push(page);
    return pages;
  }

  it("walks to exhaustion with offset += data.length under a server-lowered limit", async () => {
    const list = fakeList(ids(23), { cap: 10 });
    const pages = await walk(list);
    expect(list.requests.map((r) => r.offset)).toEqual([0, 10, 20]);
    expect(list.requests.every((r) => r.limit === 50)).toBe(true);
    expect(pages.flatMap((p) => p.records.map(key))).toEqual(ids(23).map(String));
  });

  it("continues past short pages to an empty page when paging is null", async () => {
    const list = fakeList(ids(7), { cap: 3, pagingNull: true });
    const pages = await walk(list);
    expect(list.requests.map((r) => r.offset)).toEqual([0, 3, 6, 7]);
    expect(pages.at(-1)?.records).toEqual([]);
    expect(pages.flatMap((p) => p.records)).toHaveLength(7);
  });

  it("stops on paging.total without an extra request", async () => {
    const list = fakeList(ids(100));
    await walk(list);
    expect(list.requests.map((r) => r.offset)).toEqual([0, 50]);
  });

  it("handles an empty list", async () => {
    const list = fakeList([]);
    const pages = await walk(list);
    expect(pages).toHaveLength(1);
    expect(pages[0]?.records).toEqual([]);
  });

  it("drops records already seen in this pass (sort order is undocumented)", async () => {
    // The same id shows up on two pages.
    const list = fakeList([1, 2, 3, 3, 4], { cap: 3 });
    const all = await fetchAllPages((offset) => list.fetchDepartments(offset), { key });
    expect(all.map(key)).toEqual(["1", "2", "3", "4"]);
  });

  it("resumes from a persisted offset", async () => {
    const list = fakeList(ids(5), { cap: 2 });
    const pages: string[][] = [];
    for await (const page of paginate((offset) => list.fetchDepartments(offset), {
      key,
      offset: 2,
    })) {
      pages.push(page.records.map(key));
    }
    expect(pages).toEqual([["3", "4"], ["5"]]);
  });

  it("stops a server that ignores offset and never ends", async () => {
    const list = fakeList(ids(5), { pagingNull: true, ignoreOffset: true, cap: 2 });
    await expect(
      fetchAllPages((offset) => list.fetchDepartments(offset), {
        key,
        maxPages: 5,
        path: "/hr/v1.0/departments",
      }),
    ).rejects.toMatchObject({ code: "PLANDAY_INVALID_RESPONSE", reason: "PAGINATION_RUNAWAY" });
    expect(list.requests).toHaveLength(5);
  });
});
