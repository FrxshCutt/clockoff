import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { OverrideStatusBadge } from "@/components/overrides/overrides-table";
import { TooltipProvider } from "@/components/ui/tooltip";
import { EmployeeDetailSkeleton } from "./employee-detail-skeleton";
import { DeviceStatusBadge, EmployeeStatusBadges } from "./employee-status-badges";

/** Server-render smoke tests (node, no DOM) for the badge components other pages import. */
describe("EmployeeStatusBadges", () => {
  it("renders the lifecycle badge, the device badge with its reason, and the inactive marker", () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <EmployeeStatusBadges
          employee={{
            inviteStatus: "CONNECTED",
            employmentStatus: "ACTIVE",
            deviceStatus: {
              badge: "SYNC_DELAYED",
              reason: "Last device sync 3 h ago",
              severity: "warning",
              since: null,
            },
          }}
        />
      </TooltipProvider>,
    );
    expect(html).toContain('data-value="CONNECTED"');
    expect(html).toContain('data-value="SYNC_DELAYED"');
    expect(html).toContain("Last device sync 3 h ago");
    expect(html).not.toContain(">Inactive<");

    const inactive = renderToStaticMarkup(
      <TooltipProvider>
        <EmployeeStatusBadges
          employee={{
            inviteStatus: "NOT_INVITED",
            employmentStatus: "INACTIVE",
            deviceStatus: null,
          }}
        />
      </TooltipProvider>,
    );
    expect(inactive).toContain("Inactive");
  });

  it("falls back to the enum description when the API gives no reason", () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <DeviceStatusBadge
          status={{
            badge: "OFFLINE",
            reason: null,
            severity: "error",
            since: "2026-10-01T09:00:00.000Z",
          }}
          timeZone="UTC"
        />
      </TooltipProvider>,
    );
    expect(html).toContain("72 hours");
    expect(html).toContain("Since");
    expect(renderToStaticMarkup(<DeviceStatusBadge status={null} fallback="n/a" />)).toContain(
      "n/a",
    );
  });
});

describe("EmployeeDetailSkeleton", () => {
  it("keeps exactly one h1 (the page title slot) and a back link while loading", () => {
    const html = renderToStaticMarkup(<EmployeeDetailSkeleton />);
    expect(html.match(/<h1/g)?.length).toBe(1);
    expect(html).toContain("Loading employee…");
    expect(html).toContain('href="/employees"');
    expect(html).toContain('aria-busy="true"');
  });
});

describe("OverrideStatusBadge", () => {
  it("renders a labelled badge for every override status", () => {
    for (const status of ["SCHEDULED", "ACTIVE", "EXPIRED", "REVOKED"] as const) {
      const html = renderToStaticMarkup(<OverrideStatusBadge status={status} />);
      expect(html.toLowerCase()).toContain(status.toLowerCase());
    }
  });
});
