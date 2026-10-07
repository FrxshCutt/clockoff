import { describe, expect, it } from "vitest";
import { resolveDatabaseUrl } from "./env";

const LOCAL = "postgresql://clockoff:clockoff@localhost:5433/clockoff?schema=public";
const REMOTE =
  "postgresql://user:pw@ep-cool-name-123456-pooler.eu-west-2.aws.neon.tech/neondb?sslmode=require";

describe("seed database guard", () => {
  it("allows the local development database", () => {
    expect(resolveDatabaseUrl({ DATABASE_URL: LOCAL } as NodeJS.ProcessEnv)).toBe(LOCAL);
  });

  it("refuses NODE_ENV=production unless ALLOW_SEED=true", () => {
    expect(() =>
      resolveDatabaseUrl({ DATABASE_URL: LOCAL, NODE_ENV: "production" } as NodeJS.ProcessEnv),
    ).toThrow(/NODE_ENV=production/);
    expect(
      resolveDatabaseUrl({
        DATABASE_URL: LOCAL,
        NODE_ENV: "production",
        ALLOW_SEED: "true",
      } as NodeJS.ProcessEnv),
    ).toBe(LOCAL);
  });

  it("refuses a non-local database unless ALLOW_SEED=true", () => {
    expect(() => resolveDatabaseUrl({ DATABASE_URL: REMOTE } as NodeJS.ProcessEnv)).toThrow(
      /non-local database/,
    );
    expect(() =>
      resolveDatabaseUrl({ DATABASE_URL: REMOTE, ALLOW_SEED: "1" } as NodeJS.ProcessEnv),
    ).toThrow();
    expect(
      resolveDatabaseUrl({ DATABASE_URL: REMOTE, ALLOW_SEED: "true" } as NodeJS.ProcessEnv),
    ).toBe(REMOTE);
  });

  it("still refuses the integration-test database unless SEED_ALLOW_TEST_DB=1", () => {
    const test = LOCAL.replace("/clockoff?", "/clockoff_test?");
    expect(() => resolveDatabaseUrl({ DATABASE_URL: test } as NodeJS.ProcessEnv)).toThrow(
      /integration-test/,
    );
  });

  it("requires a valid DATABASE_URL", () => {
    expect(() => resolveDatabaseUrl({} as NodeJS.ProcessEnv)).toThrow(/not set/);
    expect(() => resolveDatabaseUrl({ DATABASE_URL: "nope" } as NodeJS.ProcessEnv)).toThrow(
      /not a valid/,
    );
  });
});
