import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EmptyState } from "@/components/empty-state";
import { InlineAlert } from "@/components/inline-alert";
import { Kbd, KbdGroup } from "@/components/kbd";
import { MetricCard } from "@/components/metric-card";
import { PageHeader } from "@/components/page-header";
import { PlaceholderPage } from "@/components/placeholder-page";
import { Section, SectionCard } from "@/components/section";
import { StatusBadge } from "@/components/status/status-badge";
import { STATUS_ENUM_VALUES, STATUS_KINDS, getStatusMeta } from "@/components/status/statusMeta";
import { EMPTY_STATES, type EmptyStateKey } from "@/config/emptyStates";

/**
 * Server-render smoke tests (node, no DOM): every StatusBadge value and every placeholder page renders, with
 * the accessible text the spec requires. Interactive behaviour is covered in the browser, not here.
 */
describe("StatusBadge rendering", () => {
  it.each(STATUS_KINDS)("renders a labelled badge with an icon for every %s value", (kind) => {
    for (const value of STATUS_ENUM_VALUES[kind]) {
      const html = renderToStaticMarkup(<StatusBadge kind={kind} value={value} />);
      const meta = getStatusMeta(kind, value);
      expect(html, `${kind}.${value}`).toContain(`data-value="${value}"`);
      expect(html).toContain(`data-tone="${meta.tone}"`);
      expect(html).toContain("<svg");
      expect(html).toContain(meta.label.replace(/'/g, "&#x27;"));
    }
  });

  it("supports a custom label, hidden icon and no description", () => {
    const html = renderToStaticMarkup(<StatusBadge kind="role" value="OWNER" label="Owner (you)" hideIcon describe={false} />);
    expect(html).toContain("Owner (you)");
    expect(html).not.toContain("<svg");
    expect(html).not.toContain("title=");
  });
});

describe("PlaceholderPage", () => {
  it.each(Object.keys(EMPTY_STATES) as EmptyStateKey[])("renders the %s empty state inside the page frame", (key) => {
    const copy = EMPTY_STATES[key];
    const html = renderToStaticMarkup(<PlaceholderPage title="Title" description="Description" emptyState={key} />);
    expect(html.match(/<h1/g)?.length).toBe(1);
    expect(html).toContain(copy.title.replace(/'/g, "&#x27;"));
    expect(html).toContain(copy.description.replace(/'/g, "&#x27;"));
    if ("action" in copy && copy.action) expect(html).toContain(copy.action.label);
  });

  it("disables actions whose flow isn't built yet and links the rest", () => {
    const employees = renderToStaticMarkup(<PlaceholderPage title="Employees" emptyState="employees" />);
    expect(employees).toMatch(/<button[^>]*disabled=""[^>]*>Add Employee<\/button>/);
    expect(employees).toContain("This section is being built.");
    const policies = renderToStaticMarkup(<PlaceholderPage title="Policies" emptyState="policies" />);
    expect(policies).toMatch(/<a[^>]*href="\/policies\/new"[^>]*>Create Policy<\/a>/);
  });
});

describe("layout primitives", () => {
  it("render their landmarks and headings", () => {
    expect(renderToStaticMarkup(<PageHeader title="Settings" description="d" actions={<button>Go</button>} />)).toMatch(
      /<h1[^>]*>Settings<\/h1>/,
    );
    const section = renderToStaticMarkup(
      <Section title="Members">
        <p>body</p>
      </Section>,
    );
    expect(section).toMatch(/<section aria-labelledby="([^"]+)"[\s\S]*<h2 id="\1"/);
    const card = renderToStaticMarkup(
      <SectionCard title="Danger" tone="danger" footer={<button>Delete</button>}>
        body
      </SectionCard>,
    );
    expect(card).toContain('role="region"');
    expect(card).toContain("Delete");
    expect(renderToStaticMarkup(<EmptyState title="Nothing" headingLevel={3} />)).toContain("<h3");
    expect(renderToStaticMarkup(<InlineAlert variant="danger">Broken</InlineAlert>)).toContain('role="alert"');
    expect(renderToStaticMarkup(<InlineAlert variant="info">FYI</InlineAlert>)).toContain('role="status"');
    expect(
      renderToStaticMarkup(
        <KbdGroup>
          <Kbd>⌘</Kbd>
          <Kbd>B</Kbd>
        </KbdGroup>,
      ),
    ).toContain("<kbd");
  });

  it("MetricCard shows a skeleton while loading and the value after", () => {
    expect(renderToStaticMarkup(<MetricCard label="Connected" value={12} isLoading />)).toContain('aria-busy="true"');
    const loaded = renderToStaticMarkup(
      <MetricCard label="Connected" value={12} trend={{ direction: "up", label: "+3 today" }} href="/employees" />,
    );
    expect(loaded).toContain(">12<");
    expect(loaded).toContain("+3 today");
    expect(loaded).toContain('href="/employees"');
  });
});
