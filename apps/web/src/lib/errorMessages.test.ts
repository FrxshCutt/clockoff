import { API_ERROR_CODES } from "@clockoff/shared/errors";
import { describe, expect, it } from "vitest";
import { ApiClientError, CLIENT_ERROR_CODES } from "@/lib/api-client";
import {
  API_ERROR_MESSAGES,
  CLIENT_ERROR_MESSAGES,
  DEFAULT_ERROR_MESSAGE,
  ERROR_MESSAGES,
  getErrorMessage,
  getFieldErrors,
} from "@/lib/errorMessages";

function apiError(code: ApiClientError["code"], details?: unknown, message = "raw server message") {
  return new ApiClientError({ code, message, status: 400, details });
}

describe("API_ERROR_MESSAGES", () => {
  it("has human copy for every API error code", () => {
    for (const code of API_ERROR_CODES) {
      const message = API_ERROR_MESSAGES[code];
      expect(message, code).toBeTypeOf("string");
      expect(message.trim().length, code).toBeGreaterThan(10);
    }
  });

  it("has no entries for codes that don't exist", () => {
    expect(Object.keys(API_ERROR_MESSAGES).sort()).toEqual([...API_ERROR_CODES].sort());
  });

  it("covers the client-only codes too", () => {
    expect(Object.keys(CLIENT_ERROR_MESSAGES).sort()).toEqual([...CLIENT_ERROR_CODES].sort());
    for (const code of [...API_ERROR_CODES, ...CLIENT_ERROR_CODES]) {
      expect(ERROR_MESSAGES[code], code).toBeTruthy();
    }
  });

  it("reads like product copy: sentence case, ends with punctuation, never echoes the code", () => {
    for (const [code, message] of Object.entries(ERROR_MESSAGES)) {
      expect(message, code).toMatch(/^[A-Z]/);
      expect(message, code).toMatch(/[.!?]$/);
      expect(message, code).not.toContain(code);
    }
  });
});

describe("getErrorMessage", () => {
  it("maps API errors to their human copy, not the raw server message", () => {
    expect(getErrorMessage(apiError("INVALID_CREDENTIALS"))).toBe(
      API_ERROR_MESSAGES.INVALID_CREDENTIALS,
    );
    expect(getErrorMessage(apiError("INVALID_CREDENTIALS"))).not.toContain("raw server message");
  });

  it("uses the fallback for anything that isn't an ApiClientError (never error.message)", () => {
    expect(getErrorMessage(new Error("TypeError: x is undefined at foo.ts:12"))).toBe(
      DEFAULT_ERROR_MESSAGE,
    );
    expect(getErrorMessage("boom", "Custom fallback.")).toBe("Custom fallback.");
    expect(getErrorMessage(null)).toBe(DEFAULT_ERROR_MESSAGE);
  });

  it("tells the user how long to wait when the API says so", () => {
    expect(getErrorMessage(apiError("RATE_LIMITED", { retryAfterSeconds: 1 }))).toBe(
      "Too many attempts. Try again in 1 second.",
    );
    expect(getErrorMessage(apiError("RATE_LIMITED", { retryAfterSeconds: 30 }))).toBe(
      "Too many attempts. Try again in 30 seconds.",
    );
    expect(getErrorMessage(apiError("RATE_LIMITED", { retryAfterSeconds: 61 }))).toBe(
      "Too many attempts. Try again in 2 minutes.",
    );
    expect(getErrorMessage(apiError("RATE_LIMITED", { retryAfterSeconds: "soon" }))).toBe(
      API_ERROR_MESSAGES.RATE_LIMITED,
    );
  });

  it("maps client codes", () => {
    expect(getErrorMessage(apiError("NETWORK_ERROR"))).toBe(CLIENT_ERROR_MESSAGES.NETWORK_ERROR);
  });
});

describe("getFieldErrors", () => {
  it("returns the first message per field from z.flattenError details", () => {
    const error = apiError("VALIDATION_ERROR", {
      formErrors: [],
      fieldErrors: { email: ["Invalid email", "Too long"], password: [], name: ["Required"] },
    });
    expect(getFieldErrors(error)).toEqual({ email: "Invalid email", name: "Required" });
  });

  it("ignores other codes and malformed details", () => {
    expect(getFieldErrors(apiError("CONFLICT", { fieldErrors: { email: ["x"] } }))).toEqual({});
    expect(getFieldErrors(apiError("VALIDATION_ERROR", "nope"))).toEqual({});
    expect(
      getFieldErrors(apiError("VALIDATION_ERROR", { fieldErrors: { a: "not-an-array" } })),
    ).toEqual({});
    expect(getFieldErrors(new Error("x"))).toEqual({});
  });
});
