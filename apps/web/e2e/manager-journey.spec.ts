import path from "node:path";
import { randomUUID } from "node:crypto";
import { expect as baseExpect, test, type APIRequestContext, type Page } from "@playwright/test";

/**
 * Manager web journey smoke test (DoD): register → verify email → create organisation → Work Policy →
 * Break Rules → employee + invite → shift → awaiting-setup panel → the "phone" joins and reports its state
 * through the real mobile API → the dashboard follows along without a reload.
 *
 * Needs the dev server (`pnpm dev`, reused or started by playwright.config.ts) with EMAIL_PROVIDER=console and
 * DEV_TOOLS_ENABLED=true: the verification link is read from `GET /api/dev/last-email`. Every run creates its
 * own manager and organisation, so it can run against a seeded dev database repeatedly (mind the per-IP
 * register / mobile-join rate limits of the in-memory limiter: 5 and 10 per hour; restart the dev server to
 * reset them).
 */

const expect = baseExpect.configure({ timeout: 20_000 });

const ORG_TIME_ZONE = "Europe/London";
const SCREENSHOTS = path.join(__dirname, "screenshots");
/** The SSE stream normally updates the dashboard at once; the polling fallback invalidates every 30 s. */
const REALTIME_TIMEOUT = 35_000;
const MOBILE = "/api/mobile/v1";
const DEVICE = {
  platform: "IOS",
  appVersion: "1.0.0",
  osVersion: "17.5",
  model: "iPhone",
} as const;

test.use({ timezoneId: ORG_TIME_ZONE, locale: "en-GB" });

/** `YYYY-MM-DD` and minutes since midnight for `date` in `timeZone`. */
function localDateParts(date: Date, timeZone: string): { isoDate: string; minutes: number } {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  return {
    isoDate: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

/** Polls the development outbox until a message to `to` arrives (emails are sent after the response). */
async function waitForEmailText(request: APIRequestContext, to: string): Promise<string> {
  let text: string | null = null;
  await expect
    .poll(
      async () => {
        const res = await request.get(`/api/dev/last-email?to=${encodeURIComponent(to)}`);
        if (res.status() === 404) return null;
        expect(res.ok(), `GET /api/dev/last-email → ${res.status()}`).toBe(true);
        const body = (await res.json()) as { email: { text: string } };
        text = body.email.text;
        return text;
      },
      { timeout: 15_000, message: "verification email in the dev outbox" },
    )
    .not.toBeNull();
  return text!;
}

/**
 * Whole-page screenshot. `fullPage: true` paints the sticky top bar and sidebar halfway down long pages, so
 * the viewport is grown to the content height for the capture instead (and restored afterwards).
 */
async function screenshot(page: Page, name: string): Promise<void> {
  const viewport = page.viewportSize();
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  if (viewport && height > viewport.height) {
    await page.setViewportSize({ width: viewport.width, height });
  }
  await page.screenshot({ path: path.join(SCREENSHOTS, name) });
  if (viewport) await page.setViewportSize(viewport);
}

test.describe("manager web journey", () => {
  test("register → set up → invite → schedule → employee joins and connects", async ({
    page,
    context,
    request,
  }) => {
    test.setTimeout(300_000);
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);

    const runId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    const email = `e2e-manager-${runId}@clockoff.test`;
    const password = `E2e-${runId}-Passw0rd`;
    const orgName = `E2E Coffee ${runId}`;
    const employeeName = "Zach Stephens";
    let joinCode = "";
    let employeeUrl = "";

    await test.step("1. register, verify email, create organisation", async () => {
      await page.goto("/register");
      await page.getByLabel("Your name").fill("E2E Manager");
      await page.getByLabel("Work email").fill(email);
      await page.getByLabel("Password", { exact: true }).fill(password);
      await page.getByRole("button", { name: "Create account" }).click();
      // REQUIRE_EMAIL_VERIFICATION=false locally: the new account is signed in and sent on to set up.
      await expect(page).toHaveURL(/\/create-organisation$/);

      const emailText = await waitForEmailText(request, email);
      const link = /https?:\/\/\S+\/verify-email\?token=[A-Za-z0-9_-]+/.exec(emailText)?.[0];
      expect(link, "verification link in the email").toBeTruthy();
      await page.goto(link!);
      await expect(page.getByRole("heading", { name: "Email verified" })).toBeVisible();
      const next = page.getByRole("link", { name: "Continue to ClockOff" });
      await expect(next).toHaveAttribute("href", "/create-organisation");
      await next.click();

      await expect(page.getByRole("heading", { name: "Set up your organisation" })).toBeVisible();
      await page.getByLabel("Organisation name").fill(orgName);
      await page.getByRole("combobox", { name: "Time zone" }).click();
      await page.getByRole("combobox", { name: "Search time zones" }).fill("London");
      await page
        .getByRole("option", { name: /Europe \/ London/ })
        .first()
        .click();
      await expect(page.getByRole("combobox", { name: "Time zone" })).toContainText(
        "Europe / London",
      );
      await page.getByRole("button", { name: "Create organisation" }).click();

      await expect(page).toHaveURL(/\/overview$/);
      await expect(page.getByRole("heading", { name: "Overview", level: 1 })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Get your team set up" })).toBeVisible();
      await expect(
        page.getByRole("link", { name: "Employees connect their phones (to do)" }),
      ).toBeVisible();
      const joinCodeCard = page.getByRole("region", { name: "Company join code" });
      const code = joinCodeCard.getByText(/^[A-Z]{4,5}-\d{4}$/);
      await expect(code).toBeVisible();
      joinCode = (await code.textContent())!.trim();
      expect(joinCode).toMatch(/^[A-Z]{4,5}-\d{4}$/);
      await screenshot(page, "01-overview-onboarding.png");
    });

    await test.step("2. Work Policy: create, publish, organisation default", async () => {
      await page.goto("/policies");
      await page.getByRole("link", { name: "Create policy" }).first().click();
      await expect(page.getByRole("heading", { name: "New Work Policy" })).toBeVisible();
      await page.getByLabel("Name", { exact: true }).fill("Standard Staff");
      const categories = page.getByRole("group", { name: "Restricted categories" });
      const wanted = new Set(["Social Media", "Games", "Entertainment"]);
      for (const label of [
        "Social Media",
        "Games",
        "Entertainment",
        "Streaming",
        "Video",
        "Shopping",
        "Dating",
        "Other selected apps",
      ]) {
        await categories
          .getByRole("checkbox", { name: new RegExp(`^${label}\\b`) })
          .setChecked(wanted.has(label));
      }
      await page.getByRole("button", { name: "Create policy" }).click();

      await expect(page).toHaveURL(/\/policies\/[0-9a-f-]{36}$/);
      await expect(page.getByRole("heading", { name: "Standard Staff", level: 1 })).toBeVisible();
      await expect(page.getByText("Draft — not on any device yet")).toBeVisible();
      for (const label of wanted) {
        await expect(
          categories.getByRole("checkbox", { name: new RegExp(`^${label}\\b`) }),
        ).toBeChecked();
      }
      await expect(categories.getByRole("checkbox", { name: /^Streaming\b/ })).not.toBeChecked();

      await page.getByRole("button", { name: "Publish v1" }).click();
      const publish = page.getByRole("dialog", { name: "Publish v1?" });
      await publish.getByRole("button", { name: "Publish v1" }).click();
      await expect(publish).toBeHidden();
      await expect(page.getByText("Draft — not on any device yet")).toBeHidden();

      const orgDefault = page.getByRole("switch", { name: "Organisation default" });
      await expect(orgDefault).toBeEnabled();
      await orgDefault.click();
      await expect(orgDefault).toBeChecked();
      await expect(page.getByText("Now the organisation default policy")).toBeVisible();
    });

    await test.step("3. Break Rules: 2 × 15 min relax-all preset, organisation default", async () => {
      await page.goto("/break-rules/new");
      await expect(page.getByRole("heading", { name: "New Break Rules" })).toBeVisible();
      await page.getByRole("radio", { name: /^Standard Break/ }).check();
      await expect(page.getByLabel("Name", { exact: true })).toHaveValue("Standard Break");
      await expect(page.getByRole("spinbutton", { name: "Breaks per shift" })).toHaveValue("2");
      await expect(page.getByRole("spinbutton", { name: "Longest single break" })).toHaveValue(
        "15",
      );
      await expect(page.getByRole("radio", { name: /^Relax everything/ })).toBeChecked();
      await page.getByRole("button", { name: "Create Break Rules" }).click();

      await expect(page).toHaveURL(/\/break-rules\/[0-9a-f-]{36}$/);
      await expect(page.getByRole("heading", { name: "Standard Break", level: 1 })).toBeVisible();
      const orgDefault = page.getByRole("switch", { name: "Organisation default" });
      await expect(orgDefault).toBeEnabled();
      await orgDefault.click();
      await expect(orgDefault).toBeChecked();
      await expect(page.getByText("Now the organisation default Break Rules")).toBeVisible();
    });

    await test.step("4. add employee, invite by link, instructions show the company code", async () => {
      await page.goto("/employees");
      await page.getByRole("button", { name: "Add employee" }).first().click();
      const sheet = page.getByRole("dialog", { name: "Add employee" });
      await sheet.getByLabel("First name").fill("Zach");
      await sheet.getByLabel("Last name").fill("Stephens");
      await sheet.getByRole("button", { name: "Add employee" }).click();
      await expect(sheet).toBeHidden();

      await page.getByRole("row", { name: `Open ${employeeName}` }).click();
      await expect(page).toHaveURL(/\/employees\/[0-9a-f-]{36}/);
      employeeUrl = new URL(page.url()).pathname;
      await expect(page.getByRole("heading", { name: employeeName, level: 1 })).toBeVisible();
      const inviteBadge = page
        .locator('[data-slot="status-badge"][data-kind="inviteStatus"]')
        .first();
      await expect(inviteBadge).toHaveText(/Not invited/);
      await expect(inviteBadge).toHaveAttribute("data-value", "NOT_INVITED");

      await page.getByRole("button", { name: "Invite", exact: true }).click();
      const inviteDialog = page.getByRole("dialog", { name: `Invite ${employeeName}` });
      await expect(
        inviteDialog.getByRole("radio", { name: /Share instructions myself/ }),
      ).toBeChecked();
      await inviteDialog.getByRole("button", { name: "Create invite" }).click();

      const instructions = page.getByRole("dialog", {
        name: `Setup instructions for ${employeeName}`,
      });
      await expect(instructions).toBeVisible();
      await expect(instructions.getByText(joinCode, { exact: true })).toBeVisible();
      await expect(instructions.getByLabel("Ready-to-send instructions")).toContainText(joinCode);
      await instructions.getByRole("button", { name: "Close" }).first().click();
      await expect(instructions).toBeHidden();

      await expect(inviteBadge).toHaveAttribute("data-value", "INVITED");
      await expect(inviteBadge).toHaveText(/Invited/);
      await expect(page.getByRole("button", { name: "Resend invite" })).toBeVisible();
      await screenshot(page, "02-employee-detail-invited.png");
    });

    const now = localDateParts(new Date(), ORG_TIME_ZONE);
    const shiftActive = now.minutes >= 9 * 60 && now.minutes < 15 * 60;

    await test.step("5. shift today 09:00–15:00 on the employee page and /schedule", async () => {
      await page.getByRole("tab", { name: "Schedule" }).click();
      await page.getByRole("button", { name: "Add shift" }).first().click();
      const dialog = page.getByRole("dialog", { name: `Add a shift for ${employeeName}` });
      await dialog.getByLabel("Date").fill(now.isoDate);
      await dialog.getByLabel("Starts").fill("09:00");
      await dialog.getByLabel("Ends").fill("15:00");
      await dialog.getByRole("button", { name: "Add shift" }).click();
      await expect(dialog).toBeHidden();
      const upcoming = page.getByRole("table", { name: "Upcoming shifts" });
      await expect(upcoming.getByText("09:00–15:00")).toBeVisible();

      await page.goto("/schedule");
      const week = page.getByRole("table", { name: "Weekly schedule" });
      const row = week
        .getByRole("row")
        .filter({ has: page.getByRole("rowheader", { name: new RegExp(employeeName) }) });
      await expect(row.getByRole("button", { name: /^09:00–15:00/ })).toBeVisible();
      await screenshot(page, "03-schedule-week.png");
    });

    await test.step("6. overview lists him under awaiting setup with Copy invite", async () => {
      await page.goto("/overview");
      const awaiting = page.getByRole("list", { name: "Employees awaiting setup" });
      const item = awaiting.getByRole("listitem").filter({ hasText: employeeName });
      await expect(item).toBeVisible();
      await expect(item).toContainText("Invite sent · waiting for them to join");
      const copy = item.getByRole("button", {
        name: `Copy invite instructions for ${employeeName}`,
      });
      await copy.click();
      await expect(
        page.getByText(`Setup instructions for ${employeeName} copied. Paste them into a message.`),
      ).toBeVisible();
      const clipboard = await page.evaluate(() => navigator.clipboard.readText());
      expect(clipboard).toContain(joinCode);
    });

    let accessToken = "";
    await test.step("7. the phone joins through the mobile API; overview updates live", async () => {
      const lookup = await request.post(`${MOBILE}/join/lookup`, {
        data: { companyCode: joinCode, firstName: "Zach", lastName: "Stephens" },
      });
      expect(lookup.status(), await lookup.text()).toBe(200);
      const found = (await lookup.json()) as {
        match: string;
        organisation: { name: string };
        employeePreview: { id: string } | null;
      };
      expect(found.match).toBe("SINGLE");
      expect(found.organisation.name).toBe(orgName);
      expect(found.employeePreview?.id).toBe(employeeUrl.split("/").pop());

      const confirm = await request.post(`${MOBILE}/join/confirm`, {
        data: {
          companyCode: joinCode,
          employeeId: found.employeePreview!.id,
          firstName: "Zach",
          lastName: "Stephens",
          device: DEVICE,
        },
      });
      expect(confirm.status(), await confirm.text()).toBe(201);
      const tokens = (await confirm.json()) as { accessToken: string; refreshToken: string };
      expect(tokens.accessToken).toBeTruthy();
      expect(tokens.refreshToken).toBeTruthy();
      accessToken = tokens.accessToken;

      // No reload: the realtime stream (or its 30 s polling fallback) must move him to "joined".
      const item = page
        .getByRole("list", { name: "Employees awaiting setup" })
        .getByRole("listitem")
        .filter({ hasText: employeeName });
      await expect(item).toContainText(
        /Joined · (Screen Time setup not started|setup incomplete)/,
        {
          timeout: REALTIME_TIMEOUT,
        },
      );
      await expect(item.locator('[data-kind="inviteStatus"]')).toHaveAttribute(
        "data-value",
        /^(JOINED|SETUP_INCOMPLETE)$/,
      );
      await expect(item.getByRole("button", { name: /^Copy invite/ })).toBeHidden();
      // A linked phone completes the last two setup steps, so the checklist turns into "You're all set".
      await expect(page.getByRole("heading", { name: "You're all set" })).toBeVisible({
        timeout: REALTIME_TIMEOUT,
      });
    });

    await test.step("8. device reports a configured state; dashboard shows CONNECTED; event in /activity", async () => {
      const auth = { Authorization: `Bearer ${accessToken}` };
      const sync = await request.get(`${MOBILE}/sync`, { headers: auth });
      expect(sync.status(), await sync.text()).toBe(200);
      const synced = (await sync.json()) as {
        policy: { policy: { name: string } } | null;
        breakPolicy: { name: string } | null;
        policyVersion: string | null;
        scheduleVersion: number;
        shifts: unknown[];
      };
      expect(synced.policy?.policy.name).toBe("Standard Staff");
      expect(synced.breakPolicy?.name).toBe("Standard Break");
      expect(synced.shifts.length).toBeGreaterThanOrEqual(1);

      const state = await request.post(`${MOBILE}/device/state`, {
        headers: auth,
        data: {
          permissionState: "APPROVED",
          selectionState: "CONFIGURED",
          selectionCounts: { categories: 3, applications: 0, webDomains: 0 },
          restrictionEngineState: shiftActive ? "WORKING" : "OFF_SHIFT",
          appVersion: DEVICE.appVersion,
          osVersion: DEVICE.osVersion,
          ...(synced.policyVersion ? { policyVersionApplied: synced.policyVersion } : {}),
          scheduleVersionApplied: synced.scheduleVersion,
          localTime: new Date().toISOString(),
          timezone: ORG_TIME_ZONE,
        },
      });
      expect(state.status(), await state.text()).toBe(200);

      // Still no reload: the connected count goes up and he leaves the awaiting-setup panel.
      await expect(page.locator('[data-metric="connected"]')).toHaveText("1", {
        timeout: REALTIME_TIMEOUT,
      });
      await expect(
        page
          .getByRole("list", { name: "Employees awaiting setup" })
          .getByRole("listitem")
          .filter({ hasText: employeeName }),
      ).toHaveCount(0, { timeout: REALTIME_TIMEOUT });
      await screenshot(page, "04-overview-connected.png");

      const events = await request.post(`${MOBILE}/events`, {
        headers: auth,
        data: {
          events: [
            {
              clientEventId: randomUUID(),
              type: "SETUP_COMPLETED",
              occurredAt: new Date().toISOString(),
              metadata: {
                permissionState: "APPROVED",
                selectionCounts: { categories: 3, applications: 0, webDomains: 0 },
              },
            },
          ],
        },
      });
      expect(events.status(), await events.text()).toBe(200);
      expect(await events.json()).toMatchObject({ accepted: 1, duplicates: 0, rejected: [] });

      await page.goto(employeeUrl);
      const inviteBadge = page
        .locator('[data-slot="status-badge"][data-kind="inviteStatus"]')
        .first();
      await expect(inviteBadge).toHaveAttribute("data-value", "CONNECTED");
      await expect(inviteBadge).toHaveText(/Connected/);

      await page.goto("/activity");
      const feed = page.getByRole("list", { name: "Activity feed" });
      const entryFor = (typeLabel: string) =>
        feed
          .getByRole("listitem")
          .filter({ hasText: typeLabel })
          .filter({ has: page.getByRole("link", { name: employeeName }) });
      // The event the phone posted (feed copy: "<name> completed Screen Time setup", type label "Setup complete").
      await expect(entryFor("Setup complete")).toHaveCount(1);
      await expect(entryFor("Setup complete")).toContainText(`${employeeName} completed`);
      await expect(entryFor("Joined")).toContainText(
        `${employeeName} joined from the ClockOff app`,
      );
    });
  });
});
