import { describe, expect, it, vi } from "vitest";
import { ApiClientError } from "./api-client";
import { QUERY_DEFAULTS, isSessionChangeError, makeQueryClient, queryKeys, shouldRetryQuery } from "./query-client";

const error = (status: number, code: ApiClientError["code"] = "INTERNAL_ERROR") =>
  new ApiClientError({ code, status, message: "x" });

describe("shouldRetryQuery", () => {
  it("retries server and network errors once", () => {
    expect(shouldRetryQuery(0, error(500))).toBe(true);
    expect(shouldRetryQuery(0, error(0, "NETWORK_ERROR"))).toBe(true);
    expect(shouldRetryQuery(0, new Error("unknown"))).toBe(true);
    expect(shouldRetryQuery(1, error(500))).toBe(false);
  });

  it("never retries client errors", () => {
    expect(shouldRetryQuery(0, error(401, "UNAUTHENTICATED"))).toBe(false);
    expect(shouldRetryQuery(0, error(404, "NOT_FOUND"))).toBe(false);
    expect(shouldRetryQuery(0, error(400, "VALIDATION_ERROR"))).toBe(false);
  });
});

describe("makeQueryClient", () => {
  it("applies the dashboard defaults", () => {
    const client = makeQueryClient();
    const { queries, mutations } = client.getDefaultOptions();
    expect(queries?.staleTime).toBe(15_000);
    expect(queries?.refetchOnWindowFocus).toBe(true);
    expect(queries?.retry).toBe(shouldRetryQuery);
    expect(mutations?.retry).toBe(false);
    expect(QUERY_DEFAULTS.maxRetries).toBe(1);
  });

  it("invalidates the current user when any other query reports an ended session", async () => {
    const client = makeQueryClient();
    client.setQueryData(queryKeys.currentUser, { user: { id: "u" } });
    await client
      .fetchQuery({
        queryKey: queryKeys.members,
        queryFn: () => Promise.reject(error(401, "UNAUTHENTICATED")),
        retry: false,
      })
      .catch(() => undefined);
    expect(client.getQueryState(queryKeys.currentUser)?.isInvalidated).toBe(true);
  });

  it("also re-checks the current user when the manager no longer has an organisation", async () => {
    const client = makeQueryClient();
    client.setQueryData(queryKeys.currentUser, { user: { id: "u" } });
    await client
      .fetchQuery({
        queryKey: queryKeys.currentOrganisation,
        queryFn: () => Promise.reject(error(403, "NO_ORGANISATION")),
        retry: false,
      })
      .catch(() => undefined);
    expect(client.getQueryState(queryKeys.currentUser)?.isInvalidated).toBe(true);
  });

  it("does the same for failed mutations, but ignores ordinary errors", async () => {
    const client = makeQueryClient();
    client.setQueryData(queryKeys.currentUser, { user: { id: "u" } });
    const run = (code: ApiClientError["code"], status: number) =>
      client
        .getMutationCache()
        .build(client, { mutationFn: () => Promise.reject(error(status, code)) })
        .execute(undefined)
        .catch(() => undefined);

    await run("FORBIDDEN", 403);
    await run("VALIDATION_ERROR", 400);
    expect(client.getQueryState(queryKeys.currentUser)?.isInvalidated).toBe(false);

    await run("UNAUTHENTICATED", 401);
    expect(client.getQueryState(queryKeys.currentUser)?.isInvalidated).toBe(true);
  });

  it("never invalidates the current user because of its own 401 (that would loop)", async () => {
    const client = makeQueryClient();
    const invalidate = vi.spyOn(client, "invalidateQueries");
    await client
      .fetchQuery({
        queryKey: queryKeys.currentUser,
        queryFn: () => Promise.reject(error(401, "UNAUTHENTICATED")),
        retry: false,
      })
      .catch(() => undefined);
    expect(invalidate).not.toHaveBeenCalled();
  });

  it("scopes organisation data under the `org` key so it can be cleared together", () => {
    for (const key of [queryKeys.currentOrganisation, queryKeys.members, queryKeys.onboarding, queryKeys.billing]) {
      expect(key[0]).toBe("org");
    }
    expect(queryKeys.currentUser[0]).toBe("auth");
  });
});

describe("isSessionChangeError", () => {
  it("matches only codes that change who is signed in or which organisations they have", () => {
    expect(isSessionChangeError(error(401, "UNAUTHENTICATED"))).toBe(true);
    expect(isSessionChangeError(error(403, "NO_ORGANISATION"))).toBe(true);
    expect(isSessionChangeError(error(403, "FORBIDDEN"))).toBe(false);
    expect(isSessionChangeError(error(401, "INVALID_CREDENTIALS"))).toBe(false);
    expect(isSessionChangeError(new Error("UNAUTHENTICATED"))).toBe(false);
  });
});
