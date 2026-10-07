import { afterEach, describe, expect, it, vi } from "vitest";
import { resetEnvCache } from "@/lib/env";
import { logger } from "@/lib/logger";
import type { EmailMessage } from "./EmailProvider";
import {
  RESEND_API_URL,
  RESEND_TIMEOUT_MS,
  ResendEmailError,
  ResendEmailProvider,
  type FetchLike,
} from "./ResendEmailProvider";
import { createEmailProvider, sendEmailSafely, setEmailProviderForTesting } from "./index";

const API_KEY = "re_test_Sup3rSecretKey_123";
const FROM = "ClockOff <noreply@clockoff.online>";
const RECIPIENT = "alice.recipient@example.test";

const MESSAGE: EmailMessage = {
  to: RECIPIENT,
  subject: "Reset your ClockOff password",
  text: "Hi Alice,\nhttps://app.clockoff.online/reset-password?token=secret-token-value",
  html: "<p>Hi Alice</p>",
};

afterEach(() => {
  setEmailProviderForTesting(undefined);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  resetEnvCache();
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** A mock fetch answering every call with `respond()`; records the calls. */
function mockFetch(respond: () => Response | Promise<Response>) {
  return vi.fn<FetchLike>(async () => respond());
}

function provider(fetch: FetchLike, timeoutMs?: number): ResendEmailProvider {
  return new ResendEmailProvider({
    apiKey: API_KEY,
    from: FROM,
    fetch,
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
  });
}

/** Run `send` and return what it threw (fails the test when it resolves). */
async function sendError(p: ResendEmailProvider, message: EmailMessage = MESSAGE): Promise<Error> {
  try {
    await p.send(message);
  } catch (err) {
    expect(err).toBeInstanceOf(ResendEmailError);
    return err as Error;
  }
  throw new Error("expected send() to throw");
}

/** Everything observable about an error, for leak checks. */
function dump(err: Error): string {
  return [
    err.message,
    String(err.stack),
    JSON.stringify(err),
    JSON.stringify(Object.entries(err)),
  ].join("\n");
}

function expectNoLeak(text: string): void {
  expect(text).not.toContain(API_KEY);
  expect(text.toLowerCase()).not.toContain(RECIPIENT);
  expect(text).not.toContain("secret-token-value");
}

describe("ResendEmailProvider request", () => {
  it("POSTs the message to Resend with bearer auth, JSON body and the EMAIL_FROM sender", async () => {
    vi.spyOn(logger, "info").mockImplementation(() => undefined);
    const fetch = mockFetch(() =>
      jsonResponse(200, { id: "49a3999c-0ce1-4ea6-ab68-afcd6dc2e794" }),
    );
    await provider(fetch).send(MESSAGE);

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://api.resend.com/emails");
    expect(url).toBe(RESEND_API_URL);
    expect(init.method).toBe("POST");
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe(`Bearer ${API_KEY}`);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("idempotency-key")).toBeNull();
    // Never follow a redirect: it would downgrade the POST to a GET and report a landing page as sent.
    expect(init.redirect).toBe("error");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(init.body))).toEqual({
      from: FROM,
      to: [RECIPIENT],
      subject: MESSAGE.subject,
      text: MESSAGE.text,
      html: MESSAGE.html,
    });
  });

  it("omits html when the message has none", async () => {
    vi.spyOn(logger, "info").mockImplementation(() => undefined);
    const fetch = mockFetch(() => jsonResponse(200, { id: "abc" }));
    await provider(fetch).send({ to: RECIPIENT, subject: "s", text: "t" });
    const body = JSON.parse(String(fetch.mock.calls[0]![1].body)) as Record<string, unknown>;
    expect(body).toEqual({ from: FROM, to: [RECIPIENT], subject: "s", text: "t" });
    expect("html" in body).toBe(false);
  });

  it("applies a 10 s AbortSignal.timeout by default", async () => {
    vi.spyOn(logger, "info").mockImplementation(() => undefined);
    const timeout = vi.spyOn(AbortSignal, "timeout");
    await provider(mockFetch(() => jsonResponse(200, { id: "abc" }))).send(MESSAGE);
    expect(RESEND_TIMEOUT_MS).toBe(10_000);
    expect(timeout).toHaveBeenCalledWith(10_000);
  });

  it("uses the global fetch when none is injected", async () => {
    vi.spyOn(logger, "info").mockImplementation(() => undefined);
    const fetch = mockFetch(() => jsonResponse(200, { id: "abc" }));
    vi.stubGlobal("fetch", fetch);
    await new ResendEmailProvider({ apiKey: API_KEY, from: FROM }).send(MESSAGE);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]![0]).toBe(RESEND_API_URL);
  });

  it("trims the key and never exposes it on the provider object", async () => {
    vi.spyOn(logger, "info").mockImplementation(() => undefined);
    const fetch = mockFetch(() => jsonResponse(200, { id: "abc" }));
    const p = new ResendEmailProvider({ apiKey: `  ${API_KEY}\n`, from: FROM, fetch });
    await p.send(MESSAGE);
    expect(new Headers(fetch.mock.calls[0]![1].headers).get("authorization")).toBe(
      `Bearer ${API_KEY}`,
    );
    expect(p.name).toBe("resend");
    expect(JSON.stringify(p)).not.toContain(API_KEY);
    expect(Object.values(p).join(" ")).not.toContain(API_KEY);
  });

  it("refuses incomplete configuration without echoing the key", () => {
    expect(() => new ResendEmailProvider({ apiKey: undefined, from: FROM })).toThrow(
      /EMAIL_PROVIDER=resend requires RESEND_API_KEY/,
    );
    expect(() => new ResendEmailProvider({ apiKey: "   ", from: FROM })).toThrow(/RESEND_API_KEY/);
    let message = "";
    try {
      new ResendEmailProvider({ apiKey: "re_abc def_secret", from: FROM });
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/must not contain whitespace/);
    expect(message).not.toContain("def_secret");
    expect(() => new ResendEmailProvider({ apiKey: API_KEY, from: " " })).toThrow(/EMAIL_FROM/);
  });
});

describe("ResendEmailProvider success logging", () => {
  it("logs only the provider and Resend's message id at info level", async () => {
    const info = vi.spyOn(logger, "info").mockImplementation(() => undefined);
    await provider(mockFetch(() => jsonResponse(200, { id: "msg_0123-abcd" }))).send(MESSAGE);
    expect(info).toHaveBeenCalledTimes(1);
    expect(info.mock.calls[0]![0]).toEqual({ provider: "resend", id: "msg_0123-abcd" });
    const logged = JSON.stringify(info.mock.calls);
    expectNoLeak(logged);
    expect(logged).not.toContain(MESSAGE.subject);
    expect(logged).not.toContain("Hi Alice");
  });

  it("treats a 2xx with an unreadable body as sent (id unknown)", async () => {
    const info = vi.spyOn(logger, "info").mockImplementation(() => undefined);
    await provider(mockFetch(() => new Response("not json", { status: 200 }))).send(MESSAGE);
    expect(info.mock.calls[0]![0]).toEqual({ provider: "resend", id: null });
  });

  it("does not log an id that looks like anything but an identifier", async () => {
    const info = vi.spyOn(logger, "info").mockImplementation(() => undefined);
    await provider(mockFetch(() => jsonResponse(200, { id: RECIPIENT }))).send(MESSAGE);
    expect(info.mock.calls[0]![0]).toEqual({ provider: "resend", id: null });
  });
});

describe("ResendEmailProvider error mapping", () => {
  it("maps a 4xx JSON error to status + Resend name/message, without the recipient or key", async () => {
    const info = vi.spyOn(logger, "info").mockImplementation(() => undefined);
    const err = await sendError(
      provider(
        mockFetch(() =>
          jsonResponse(422, {
            statusCode: 422,
            name: "validation_error",
            message: `Invalid \`to\` field: ${RECIPIENT.toUpperCase()} rejected (key ${API_KEY}); see owner@clockoff.online`,
          }),
        ),
      ),
    );
    expect(err.message).toMatch(/^Resend API error: HTTP 422 validation_error: Invalid `to` field/);
    expect(err.message).toContain("[recipient]");
    expect(err.message).toContain("[redacted]");
    expect(err.message).toContain("[email]");
    expect(err).toMatchObject({ name: "ResendEmailError", status: 422, code: "validation_error" });
    expectNoLeak(dump(err));
    expect(err.message).not.toContain("owner@clockoff.online");
    expect(info).not.toHaveBeenCalled();
  });

  it("maps auth errors and redacts anything shaped like a Resend key", async () => {
    const err = await sendError(
      provider(
        mockFetch(() =>
          jsonResponse(403, {
            name: "invalid_api_key",
            message: "API key re_other_key_999 is invalid",
          }),
        ),
      ),
    );
    expect(err.message).toBe(
      "Resend API error: HTTP 403 invalid_api_key: API key [redacted] is invalid",
    );
    expect(err.message).not.toContain("re_other_key_999");
  });

  it("maps a 5xx with a non-JSON body to the status alone", async () => {
    const err = await sendError(
      provider(
        mockFetch(
          () =>
            new Response(`<html>Bad gateway for ${RECIPIENT} Bearer ${API_KEY}</html>`, {
              status: 502,
            }),
        ),
      ),
    );
    expect(err.message).toBe("Resend API error: HTTP 502 (no JSON error body)");
    expect(err).toMatchObject({ status: 502, code: undefined });
    expectNoLeak(dump(err));
  });

  it("maps a 5xx JSON error and a 429 rate limit", async () => {
    const server = await sendError(
      provider(
        mockFetch(() =>
          jsonResponse(500, {
            name: "internal_server_error",
            message: "An unexpected error occurred.",
          }),
        ),
      ),
    );
    expect(server.message).toBe(
      "Resend API error: HTTP 500 internal_server_error: An unexpected error occurred.",
    );
    const limited = await sendError(
      provider(
        mockFetch(() =>
          jsonResponse(429, { name: "rate_limit_exceeded", message: "Too many requests." }),
        ),
      ),
    );
    expect(limited).toMatchObject({ status: 429, code: "rate_limit_exceeded" });
  });

  it("bounds an oversized error message and still strips the key and recipient", async () => {
    const huge = `${"x".repeat(50_000)} ${RECIPIENT} ${"y".repeat(50_000)} ${API_KEY} ${"z@".repeat(50_000)}`;
    const started = Date.now();
    const err = await sendError(
      provider(mockFetch(() => jsonResponse(400, { name: "validation_error", message: huge }))),
    );
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(err.message.length).toBeLessThan(300);
    expect(err.message).toMatch(/^Resend API error: HTTP 400 validation_error: x+…$/);
    expectNoLeak(dump(err));
  });

  it("maps an empty JSON error object", async () => {
    const err = await sendError(provider(mockFetch(() => jsonResponse(400, {}))));
    expect(err.message).toBe("Resend API error: HTTP 400 no error details");
  });

  it("maps a network failure to its type and cause code, without the key or recipient", async () => {
    const cause = Object.assign(
      new Error(`connect ECONNREFUSED for ${RECIPIENT} with ${API_KEY}`),
      { code: "ECONNREFUSED" },
    );
    const err = await sendError(
      provider(
        vi.fn<FetchLike>(async () => {
          throw new TypeError(`fetch failed (${RECIPIENT}, Bearer ${API_KEY})`, { cause });
        }),
      ),
    );
    expect(err.message).toMatch(/^Resend API request failed: TypeError: fetch failed/);
    expect(err.message).toContain("(ECONNREFUSED)");
    expect(err).toMatchObject({ code: "ECONNREFUSED", status: undefined });
    expectNoLeak(dump(err));
    expect((err as Error & { cause?: unknown }).cause).toBeUndefined();
  });

  it("reports a refused redirect (no cause code) by its sanitised cause message", async () => {
    const err = await sendError(
      provider(
        vi.fn<FetchLike>(async () => {
          throw new TypeError("fetch failed", { cause: new Error("unexpected redirect") });
        }),
      ),
    );
    expect(err.message).toBe(
      "Resend API request failed: TypeError: fetch failed (unexpected redirect)",
    );
    expect(err).toMatchObject({ code: undefined, status: undefined });

    const leaky = await sendError(
      provider(
        vi.fn<FetchLike>(async () => {
          throw new TypeError("fetch failed", {
            cause: new Error(`socket closed for ${RECIPIENT} using ${API_KEY}`),
          });
        }),
      ),
    );
    expect(leaky.message).toBe(
      "Resend API request failed: TypeError: fetch failed (socket closed for [recipient] using [redacted])",
    );
    expectNoLeak(dump(leaky));
  });

  it("aborts a request that outlives the timeout", async () => {
    const hanging = vi.fn<FetchLike>(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    );
    const err = await sendError(provider(hanging, 20));
    expect(err.message).toBe("Resend API request timed out after 20 ms");
    expect(err).toMatchObject({ code: "TIMEOUT" });
  });
});

describe("Resend through createEmailProvider / sendEmailSafely", () => {
  it("createEmailProvider selects Resend when EMAIL_PROVIDER=resend", async () => {
    vi.stubEnv("EMAIL_PROVIDER", "resend");
    vi.stubEnv("RESEND_API_KEY", API_KEY);
    vi.stubEnv("EMAIL_FROM", FROM);
    resetEnvCache();
    const selected = createEmailProvider();
    expect(selected).toBeInstanceOf(ResendEmailProvider);
    expect(selected.name).toBe("resend");

    vi.spyOn(logger, "info").mockImplementation(() => undefined);
    const fetch = mockFetch(() => jsonResponse(200, { id: "abc" }));
    vi.stubGlobal("fetch", fetch);
    await selected.send(MESSAGE);
    expect(JSON.parse(String(fetch.mock.calls[0]![1].body))).toMatchObject({ from: FROM });
  });

  it("without a key outside production: the provider fails at first send and sendEmailSafely reports it", async () => {
    vi.stubEnv("EMAIL_PROVIDER", "resend");
    vi.stubEnv("RESEND_API_KEY", "");
    vi.stubEnv("NODE_ENV", "test");
    resetEnvCache();
    setEmailProviderForTesting(undefined);
    expect(() => createEmailProvider()).toThrow(/RESEND_API_KEY/);
    const error = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    expect(await sendEmailSafely(MESSAGE)).toBe(false);
    expect(JSON.stringify(error.mock.calls)).toMatch(/RESEND_API_KEY/);
  });

  it("sendEmailSafely logs a Resend failure without the key, recipient or body", async () => {
    const error = vi.spyOn(logger, "error").mockImplementation(() => undefined);
    setEmailProviderForTesting(
      provider(
        mockFetch(() =>
          jsonResponse(422, { name: "validation_error", message: `Bad recipient ${RECIPIENT}` }),
        ),
      ),
    );
    expect(await sendEmailSafely(MESSAGE)).toBe(false);
    expect(error).toHaveBeenCalledTimes(1);
    const logged = JSON.stringify(error.mock.calls);
    expect(logged).toContain("HTTP 422 validation_error");
    expect(logged).toContain('"code":"validation_error"');
    expectNoLeak(logged);
  });
});
