import { afterEach, describe, expect, it, vi } from "vitest";
import { resetEnvCache } from "@/lib/env";
import { logger } from "@/lib/logger";
import {
  ConsoleEmailProvider,
  DEV_OUTBOX_SIZE,
  clearDevOutbox,
  lastDevOutboxEmail,
} from "./ConsoleEmailProvider";
import { MockEmailProvider } from "./MockEmailProvider";
import { SmtpEmailProvider } from "./SmtpEmailProvider";
import {
  accountExistsEmail,
  createEmailProvider,
  managerInviteEmail,
  passwordResetEmail,
  sendEmailSafely,
  setEmailProviderForTesting,
  verificationEmail,
} from "./index";

afterEach(() => {
  setEmailProviderForTesting(undefined);
  clearDevOutbox();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  delete process.env.EMAIL_PROVIDER;
  resetEnvCache();
});

describe("templates", () => {
  it("build APP_URL links with the token and HTML-escape user content", () => {
    const appUrl = new URL(process.env.APP_URL ?? "http://localhost:3000").origin;
    const verify = verificationEmail({ name: "Sam <script>", token: "tok_123" });
    expect(verify.text).toContain(`${appUrl}/verify-email?token=tok_123`);
    expect(verify.html).toContain("Sam &lt;script&gt;");
    expect(verify.html).not.toContain("<script>");

    expect(passwordResetEmail({ name: "Sam", token: "r1" }).text).toContain(
      `${appUrl}/reset-password?token=r1`,
    );

    const invite = managerInviteEmail({
      organisationName: "Harpenden Coffee Co.",
      inviterName: "Ana",
      role: "ADMIN",
      token: "i1",
    });
    expect(invite.subject).toContain("Harpenden Coffee Co.");
    expect(invite.text).toContain(
      "Ana has invited you to manage Harpenden Coffee Co. on Work Mode as an admin.",
    );
    expect(invite.text).toContain(`${appUrl}/accept-invite?token=i1`);
    const anonymous = managerInviteEmail({
      organisationName: "X",
      inviterName: null,
      role: "MANAGER",
      token: "i2",
    });
    expect(anonymous.text).toContain(
      "You have been invited to manage X on Work Mode as a manager.",
    );

    const exists = accountExistsEmail({ name: "Sam <b>" });
    expect(exists.text).toContain(`${appUrl}/login`);
    expect(exists.text).toContain(`${appUrl}/forgot-password`);
    expect(exists.text).not.toContain("token=");
    expect(exists.html).toContain("Sam &lt;b&gt;");
  });
});

describe("providers", () => {
  it("MockEmailProvider records messages and extracts tokens", async () => {
    const mock = new MockEmailProvider();
    await mock.send({
      to: "A@x.test",
      subject: "s",
      text: "go to http://h/verify-email?token=abc_DEF-1 now",
    });
    expect(mock.last("a@x.test")?.subject).toBe("s");
    expect(MockEmailProvider.extractToken(mock.last(), "/verify-email")).toBe("abc_DEF-1");
    expect(MockEmailProvider.extractToken(mock.last(), "/reset-password")).toBeUndefined();
    mock.clear();
    expect(mock.sent).toHaveLength(0);
  });

  it("ConsoleEmailProvider logs the message in a delimited block at info level", async () => {
    const spy = vi.spyOn(logger, "info").mockImplementation(() => undefined);
    await new ConsoleEmailProvider().send({
      to: "a@x.test",
      subject: "Hello",
      text: "line 1\nhttp://link",
    });
    const block = String(spy.mock.calls[0]?.[0]);
    expect(block).toContain("EMAIL (console provider)");
    expect(block).toContain("│ Subject: Hello");
    expect(block).toContain("│ http://link");
  });

  it("ConsoleEmailProvider withholds recipient and body (links) when suppressContent is set", async () => {
    const info = vi.spyOn(logger, "info").mockImplementation(() => undefined);
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    await new ConsoleEmailProvider({ suppressContent: true }).send({
      to: "alice@x.test",
      subject: "Reset your Work Mode password",
      text: "http://h/reset-password?token=secret-token",
    });
    expect(info).not.toHaveBeenCalled();
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain("Reset your Work Mode password");
    expect(logged).not.toContain("alice@x.test");
    expect(logged).not.toContain("secret-token");
  });

  it("SmtpEmailProvider fails fast on missing configuration and never pretends to send", async () => {
    expect(
      () =>
        new SmtpEmailProvider({
          host: undefined,
          port: 587,
          user: "u",
          password: undefined,
          from: "f",
        }),
    ).toThrow(/SMTP_HOST, SMTP_PASSWORD/);
    const smtp = new SmtpEmailProvider({
      host: "smtp.example",
      port: 587,
      user: "u",
      password: "p",
      from: "f",
    });
    await expect(smtp.send({ to: "a@x.test", subject: "s", text: "t" })).rejects.toThrow(
      /nodemailer/,
    );
  });

  it("createEmailProvider follows EMAIL_PROVIDER", () => {
    process.env.EMAIL_PROVIDER = "console";
    resetEnvCache();
    expect(createEmailProvider()).toBeInstanceOf(ConsoleEmailProvider);
    process.env.EMAIL_PROVIDER = "smtp";
    resetEnvCache();
    expect(() => createEmailProvider()).toThrow(/EMAIL_PROVIDER=smtp requires/);
  });

  it("sendEmailSafely reports failures instead of throwing", async () => {
    vi.spyOn(logger, "error").mockImplementation(() => undefined);
    setEmailProviderForTesting({
      name: "mock",
      send: async () => {
        throw new Error("smtp down");
      },
    });
    expect(await sendEmailSafely({ to: "a@x.test", subject: "s", text: "t" })).toBe(false);
    const mock = new MockEmailProvider();
    setEmailProviderForTesting(mock);
    expect(await sendEmailSafely({ to: "a@x.test", subject: "s", text: "t" })).toBe(true);
    expect(mock.sent).toHaveLength(1);
  });
});

describe("development outbox (GET /api/dev/last-email)", () => {
  it("keeps the latest message per recipient (case-insensitive) when recordOutbox is on", async () => {
    vi.spyOn(logger, "info").mockImplementation(() => undefined);
    const provider = new ConsoleEmailProvider({ recordOutbox: true });
    await provider.send({ to: "Sam@x.test", subject: "first", text: "1" });
    await provider.send({ to: "other@x.test", subject: "other", text: "o" });
    await provider.send({ to: "sam@x.test", subject: "second", text: "2" });
    const last = lastDevOutboxEmail(" SAM@x.test ");
    expect(last).toMatchObject({ to: "sam@x.test", subject: "second", text: "2" });
    expect(Number.isNaN(Date.parse(last!.sentAt))).toBe(false);
    expect(lastDevOutboxEmail("nobody@x.test")).toBeUndefined();
  });

  it("is a bounded ring buffer", async () => {
    vi.spyOn(logger, "info").mockImplementation(() => undefined);
    const provider = new ConsoleEmailProvider({ recordOutbox: true });
    await provider.send({ to: "first@x.test", subject: "s", text: "t" });
    for (let i = 0; i < DEV_OUTBOX_SIZE; i += 1) {
      await provider.send({ to: `n${i}@x.test`, subject: "s", text: "t" });
    }
    expect(lastDevOutboxEmail("first@x.test")).toBeUndefined();
    expect(lastDevOutboxEmail(`n${DEV_OUTBOX_SIZE - 1}@x.test`)).toBeDefined();
  });

  it("records nothing by default or when content is suppressed (production)", async () => {
    vi.spyOn(logger, "info").mockImplementation(() => undefined);
    vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    await new ConsoleEmailProvider().send({ to: "a@x.test", subject: "s", text: "t" });
    await new ConsoleEmailProvider({ suppressContent: true, recordOutbox: true }).send({
      to: "a@x.test",
      subject: "s",
      text: "t",
    });
    expect(lastDevOutboxEmail("a@x.test")).toBeUndefined();
  });

  it("createEmailProvider records only when DEV_TOOLS_ENABLED is on", async () => {
    vi.spyOn(logger, "info").mockImplementation(() => undefined);
    process.env.EMAIL_PROVIDER = "console";
    vi.stubEnv("DEV_TOOLS_ENABLED", "false");
    resetEnvCache();
    await createEmailProvider().send({ to: "off@x.test", subject: "s", text: "t" });
    expect(lastDevOutboxEmail("off@x.test")).toBeUndefined();

    vi.stubEnv("DEV_TOOLS_ENABLED", "true");
    resetEnvCache();
    await createEmailProvider().send({ to: "on@x.test", subject: "s", text: "t" });
    expect(lastDevOutboxEmail("on@x.test")?.subject).toBe("s");
  });
});
