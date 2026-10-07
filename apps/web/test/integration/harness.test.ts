import { prisma } from "@clockoff/db";
import { describe, expect, it } from "vitest";
import { assertTestDatabaseName, assertTestDatabaseUrl } from "../helpers/testDatabase";

/** The integration harness must never be able to reset anything but a dedicated `_test` database. */
describe("integration harness database guard", () => {
  it("only accepts database names that end in _test", () => {
    expect(
      assertTestDatabaseUrl("postgresql://u:p@localhost:5433/clockoff_test?schema=public"),
    ).toContain("clockoff_test");
    for (const url of [
      "postgresql://u:p@localhost:5433/clockoff",
      "postgresql://u:p@localhost:5433/clockoff_testing",
      "postgresql://u:p@localhost:5433/my_test_prod",
      "postgresql://u:p@localhost:5433/_test",
      "postgresql://u:p@localhost:5433/",
    ]) {
      expect(() => assertTestDatabaseUrl(url), url).toThrow(/must end with "_test"/);
    }
    expect(() => assertTestDatabaseUrl(undefined)).toThrow(/TEST_DATABASE_URL is not set/);
    expect(() => assertTestDatabaseUrl("not a url")).toThrow(/not a valid connection URL/);
    expect(() => assertTestDatabaseName("production")).toThrow();
  });

  it("refuses a TEST_DATABASE_URL that points at the development database", () => {
    expect(() =>
      assertTestDatabaseUrl(
        "postgresql://a:b@localhost:5433/clockoff_test?schema=public",
        "postgresql://other:creds@localhost:5433/clockoff_test",
      ),
    ).toThrow(/must differ/);
    expect(
      assertTestDatabaseUrl(
        "postgresql://u:p@localhost:5433/clockoff_test",
        "postgresql://u:p@localhost:5433/clockoff",
      ),
    ).toBeTruthy();
  });

  it("the suite is connected to the test database", async () => {
    const [row] = await prisma.$queryRaw<
      Array<{ name: string }>
    >`SELECT current_database() AS name`;
    expect(row?.name.endsWith("_test")).toBe(true);
  });
});
