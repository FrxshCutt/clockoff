import type { ColumnDef } from "@tanstack/react-table";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EmptyState } from "@/components/empty-state";
import { DataTable } from "./data-table";
import { DataTableColumnHeader } from "./data-table-column-header";
import { createSelectColumn, facetedFilter, facetedFilterFn } from "./data-table-helpers";

interface Person {
  id: string;
  name: string;
  role: "OWNER" | "ADMIN" | "MANAGER";
}

const PEOPLE: Person[] = Array.from({ length: 30 }, (_, i) => ({
  id: `p${i + 1}`,
  name: `Person ${String(i + 1).padStart(2, "0")}`,
  role: i % 3 === 0 ? "OWNER" : i % 3 === 1 ? "ADMIN" : "MANAGER",
}));

const columns: ColumnDef<Person>[] = [
  createSelectColumn<Person>({ getRowLabel: (p) => p.name }),
  {
    accessorKey: "name",
    header: ({ column }) => <DataTableColumnHeader column={column} title="Name" />,
  },
  { accessorKey: "role", header: "Role", filterFn: facetedFilter<Person>() },
];

function render(props: Partial<Parameters<typeof DataTable<Person>>[0]> = {}) {
  return renderToStaticMarkup(
    <DataTable<Person>
      label="People"
      columns={columns}
      data={PEOPLE}
      getRowId={(p) => p.id}
      {...props}
    />,
  );
}

function bodyRowCount(html: string): number {
  return (html.match(/<tr[^>]*aria-rowindex="\d+"/g) ?? []).length - 1; // minus the header row
}

describe("DataTable (server render)", () => {
  it("renders a captioned table with a sticky header and the first page of rows", () => {
    const html = render({ initialPageSize: 10 });
    expect(html).toMatch(/<caption[^>]*class="[^"]*sr-only[^"]*">People<\/caption>/);
    // Only the selection column declares a width.
    expect(html.match(/style="width:\d+px"/g)).toEqual(['style="width:40px"']);
    expect(html).toContain("sticky top-0");
    expect(bodyRowCount(html)).toBe(10);
    expect(html).toContain("Person 01");
    expect(html).not.toContain("Person 11");
    expect(html).toContain("30 results");
    expect(html).toContain('aria-rowcount="31"');
    expect(html).toContain("Page 1 of 3");
  });

  it("applies initial sorting and numbers rows for assistive tech", () => {
    const html = render({ initialPageSize: 10, initialSorting: [{ id: "name", desc: true }] });
    expect(html.indexOf("Person 30")).toBeGreaterThan(-1);
    expect(html).not.toContain("Person 01");
    expect(html).toContain('aria-sort="descending"');
    expect(html).toMatch(/aria-rowindex="2"[\s\S]*Person 30/);
  });

  it("filters with a controlled global search and shows the no-results state", () => {
    const filtered = render({ searchable: true, globalFilter: "Person 0" });
    expect(bodyRowCount(filtered)).toBe(9);
    expect(filtered).toContain('aria-label="Search people"');
    const none = render({ searchable: true, globalFilter: "nobody" });
    expect(none).toContain("No matching results");
    expect(none).toContain("Clear filters");
  });

  it("filters a column with the faceted filter fn", () => {
    const html = render({ columnFilters: [{ id: "role", value: ["OWNER"] }], paginate: false });
    expect(bodyRowCount(html)).toBe(10);
    expect(html).not.toContain(">ADMIN<");
  });

  it("shows skeleton rows while loading", () => {
    const html = render({ data: undefined, loadingRows: 4 });
    expect(html).toContain('aria-busy="true"');
    expect((html.match(/data-slot="skeleton"/g) ?? []).length).toBe(4 * columns.length);
    expect(html).not.toContain("results");
  });

  it("renders the empty-state slot when there is no data at all", () => {
    const html = render({ data: [], emptyState: <EmptyState title="No people yet" /> });
    expect(html).toContain("No people yet");
    expect(html).not.toContain("<table");
  });

  it("labels selection checkboxes per row", () => {
    const html = render({ enableRowSelection: true, initialPageSize: 10 });
    expect(html).toContain('aria-label="Select all rows on this page"');
    expect(html).toContain('aria-label="Select Person 01"');
  });

  it("makes rows keyboard-focusable when they are clickable", () => {
    const html = render({
      onRowClick: () => undefined,
      getRowLabel: (p) => `Open ${p.name}`,
      initialPageSize: 10,
    });
    expect(html).toContain('tabindex="0"');
    expect(html).toContain('aria-label="Open Person 01"');
  });
});

describe("facetedFilterFn", () => {
  const row = (value: unknown) =>
    ({ getValue: () => value }) as unknown as Parameters<typeof facetedFilterFn<Person>>[0];

  it("keeps rows whose value (or any array value) is selected", () => {
    expect(facetedFilterFn(row("OWNER"), "role", ["OWNER", "ADMIN"])).toBe(true);
    expect(facetedFilterFn(row("MANAGER"), "role", ["OWNER"])).toBe(false);
    expect(facetedFilterFn(row(["A", "B"]), "tags", ["B"])).toBe(true);
    expect(facetedFilterFn(row("MANAGER"), "role", [])).toBe(true);
    expect(facetedFilterFn.autoRemove?.([])).toBe(true);
    expect(facetedFilterFn.autoRemove?.(["x"])).toBe(false);
  });
});
