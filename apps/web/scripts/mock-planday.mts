/**
 * The shared Mock Planday server for local development and Playwright (docs/integrations/
 * PLANDAY_IMPLEMENTATION_PLAN.md §12.1). Web and the worker are separate processes and must see one portal, so in
 * mock mode both send their Planday traffic here (`PLANDAY_MOCK_URL`, default http://127.0.0.1:4010) and the dev
 * routes drive it through `POST /__control`.
 *
 *   pnpm --filter @clockoff/web mock:planday            # listens on 127.0.0.1:$PLANDAY_MOCK_PORT (4010)
 *   PLANDAY_ENABLED=true PLANDAY_MODE=mock pnpm --filter @clockoff/web dev
 *   PLANDAY_ENABLED=true PLANDAY_MODE=mock pnpm --filter @clockoff/web worker
 *
 * The fixture is laid out around the current date (`buildPlandayFixture({ anchor: now })`). ClockOff's own App
 * IDs (`PLANDAY_CLIENT_ID` for method A, `PLANDAY_APP_ID` for method B), when set, get tokens from the mock.
 * Refuses to start in production (NODE_ENV=production or any Railway deployment).
 */
import {
  assertMockPlandayAllowed,
  buildPlandayFixture,
  MOCK_PLANDAY_DEFAULT_PORT,
  MOCK_TEST_CREDENTIALS,
  startMockPlandayHttpServer,
} from "@clockoff/integrations/planday/mock";

function portFromEnv(value: string | undefined): number {
  if (value === undefined || value.trim() === "") return MOCK_PLANDAY_DEFAULT_PORT;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`PLANDAY_MOCK_PORT must be a port number, got ${JSON.stringify(value)}`);
  }
  return port;
}

async function main(): Promise<void> {
  assertMockPlandayAllowed("scripts/mock-planday.mts");
  const anchor = new Date();
  const server = await startMockPlandayHttpServer({
    port: portFromEnv(process.env.PLANDAY_MOCK_PORT),
    fixture: buildPlandayFixture({ anchor }),
    partnerAppIds: [process.env.PLANDAY_CLIENT_ID, process.env.PLANDAY_APP_ID],
  });
  console.log(
    [
      `Mock Planday listening on ${server.url} (set PLANDAY_MOCK_URL=${server.url} for web and the worker)`,
      `  fixture anchored at ${anchor.toISOString()}; portals ${[...server.mock.state.portals.keys()].join(", ")}`,
      `  method C test credentials: App ID ${MOCK_TEST_CREDENTIALS.appId}, token ${MOCK_TEST_CREDENTIALS.refreshToken}`,
      `  controls: POST ${server.url}/__control { "action": "editShift", ... }; health: GET ${server.url}/__health`,
    ].join("\n"),
  );

  let closing = false;
  const shutdown = (signal: NodeJS.Signals) => {
    if (closing) return;
    closing = true;
    console.log(`Mock Planday stopping (${signal})`);
    server.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
