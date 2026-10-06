/**
 * Guards shared by the integration global setup and per-file setup: the integration suite may only ever
 * talk to a dedicated test database, i.e. one whose name ENDS in `_test` (e.g. `workmode_test`) and that
 * differs from the development `DATABASE_URL`. The global setup additionally checks the name the server
 * reports (`current_database()`) before it drops anything — see {@link assertTestDatabaseName}.
 */

const TEST_DATABASE_SUFFIX = "_test";

export function assertTestDatabaseName(dbName: string): void {
  if (!dbName.endsWith(TEST_DATABASE_SUFFIX) || dbName.length <= TEST_DATABASE_SUFFIX.length) {
    throw new Error(
      `Refusing to run integration tests against database "${dbName}": the test database name must end with "${TEST_DATABASE_SUFFIX}" (e.g. workmode_test).`,
    );
  }
}

export function assertTestDatabaseUrl(url: string | undefined, developmentUrl?: string): string {
  if (!url) {
    throw new Error(
      "TEST_DATABASE_URL is not set. Integration tests need a dedicated test database (see docs/TESTING.md).",
    );
  }
  let dbName: string;
  try {
    dbName = decodeURIComponent(new URL(url).pathname.replace(/^\//, ""));
  } catch {
    throw new Error("TEST_DATABASE_URL is not a valid connection URL.");
  }
  assertTestDatabaseName(dbName);
  if (developmentUrl && sameDatabase(developmentUrl, url)) {
    throw new Error("TEST_DATABASE_URL must differ from the development DATABASE_URL.");
  }
  return url;
}

/** Same host, port and database name (query parameters such as `?schema=` and credentials ignored). */
function sameDatabase(a: string, b: string): boolean {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return ua.hostname === ub.hostname && ua.port === ub.port && ua.pathname === ub.pathname;
  } catch {
    return a === b;
  }
}
