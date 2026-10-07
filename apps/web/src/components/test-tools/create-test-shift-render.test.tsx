import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Dialog } from "@/components/ui/dialog";
import { useCanCreateTestShift, type CurrentUser } from "@/hooks/use-current-user";
import { queryKeys } from "@/lib/query-client";
import { CreateTestShiftForm } from "./create-test-shift-dialog";

/** Server-render the dialog body against a seeded query cache (no network, no DOM). */
const ORG_ID = "6f1c2c1e-4d1b-4a8e-9b51-2f6f0f1c9a10";
const EMPLOYEE = {
  id: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
  firstName: "Zach",
  lastName: "Stephens",
};

const OTHER_ORG_ID = "9b2e7c4d-1f3a-4c5b-8d6e-7f8a9b0c1d2e";

function organisation(id: string, testToolsEnabled: boolean): CurrentUser["organisations"][number] {
  return {
    id,
    name: id === ORG_ID ? "ClockOff Test" : "Customer",
    slug: id === ORG_ID ? "clockoff-test" : "customer",
    role: "OWNER",
    timezone: "Europe/London",
    testToolsEnabled,
  };
}

function clientWith(
  organisations: CurrentUser["organisations"] = [organisation(ORG_ID, true)],
  currentOrganisationId: string | null = ORG_ID,
): QueryClient {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData<CurrentUser>(queryKeys.currentUser, {
    user: {
      id: "0b3c9a6e-8a55-4f0e-a3f8-7f3c1d2e4b5a",
      email: "owner@example.com",
      name: "Owner",
      emailVerified: true,
      createdAt: "2026-10-01T09:00:00Z",
    },
    organisations,
    currentOrganisationId,
    csrfToken: "csrf",
  });
  return client;
}

function render(chooseEmployee: boolean, employee: typeof EMPLOYEE | null = EMPLOYEE): string {
  const client = clientWith();
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <Dialog open>
        <CreateTestShiftForm
          employee={employee}
          chooseEmployee={chooseEmployee}
          onClose={() => undefined}
        />
      </Dialog>
    </QueryClientProvider>,
  );
}

describe("CreateTestShiftForm", () => {
  it("renders both minute fields with their defaults, Apple's note and the submit button", () => {
    const html = render(false);
    expect(html).toContain("Create test shift for Zach Stephens");
    expect(html).toContain("Starts in (minutes)");
    expect(html).toContain("Lasts (minutes)");
    expect(html).toMatch(/type="number"[^>]*value="20"/);
    expect(html).toMatch(/type="number"[^>]*value="30"/);
    expect(html).toMatch(/min="15"/);
    expect(html).toContain(
      "Apple requires at least 15 minutes; leave time for the phone to sync before it starts.",
    );
    expect(html).toContain(">Create test shift<");
    expect(html).not.toContain(">Employee<");
  });

  it("offers an employee picker on the schedule page", () => {
    const html = render(true, null);
    expect(html).toContain(">Employee<");
    expect(html).toContain("Choose an employee");
    expect(html).not.toContain("Create test shift for");
  });
});

/** What the employee and schedule pages check before showing "Create test shift…". */
function CanCreateProbe() {
  return <output>{useCanCreateTestShift() ? "shown" : "hidden"}</output>;
}

function probe(client: QueryClient): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <CanCreateProbe />
    </QueryClientProvider>,
  );
}

describe("useCanCreateTestShift", () => {
  it("shows the action only when the CURRENT organisation has the test tools", () => {
    expect(probe(clientWith())).toContain(">shown<");
    expect(probe(clientWith([organisation(ORG_ID, false)]))).toContain(">hidden<");
    // Another organisation of the same manager having the tools does not count.
    expect(
      probe(clientWith([organisation(ORG_ID, false), organisation(OTHER_ORG_ID, true)], ORG_ID)),
    ).toContain(">hidden<");
    expect(
      probe(
        clientWith([organisation(ORG_ID, false), organisation(OTHER_ORG_ID, true)], OTHER_ORG_ID),
      ),
    ).toContain(">shown<");
  });

  it("hides the action while the signed-in manager is unknown", () => {
    // Nothing cached yet: server rendering never fetches, so `/api/auth/me` has not answered.
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    expect(probe(client)).toContain(">hidden<");
  });
});
