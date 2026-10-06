import { describe, expect, it } from "vitest";
import { ApiClientError } from "@/lib/api-client";
import { resolveGateState } from "./gate";

const unauthenticated = new ApiClientError({ code: "UNAUTHENTICATED", message: "x", status: 401 });
const serverError = new ApiClientError({ code: "INTERNAL_ERROR", message: "x", status: 500 });

describe("resolveGateState", () => {
  it("is loading until the user is known", () => {
    expect(resolveGateState({ isPending: true, error: null, organisationCount: null })).toBe("loading");
  });

  it("sends signed-out visitors to login, even over cached data", () => {
    expect(resolveGateState({ isPending: false, error: unauthenticated, organisationCount: null })).toBe("unauthenticated");
    expect(resolveGateState({ isPending: false, error: unauthenticated, organisationCount: 2 })).toBe("unauthenticated");
  });

  it("sends managers without an organisation to create one", () => {
    expect(resolveGateState({ isPending: false, error: null, organisationCount: 0 })).toBe("no-organisation");
  });

  it("is ready with at least one organisation", () => {
    expect(resolveGateState({ isPending: false, error: null, organisationCount: 1 })).toBe("ready");
  });

  it("shows an error only when there is no cached user to keep showing", () => {
    expect(resolveGateState({ isPending: false, error: serverError, organisationCount: null })).toBe("error");
    expect(resolveGateState({ isPending: false, error: serverError, organisationCount: 3 })).toBe("ready");
    expect(resolveGateState({ isPending: false, error: new Error("network"), organisationCount: null })).toBe("error");
  });
});
