/**
 * Next.js instrumentation hook: `register()` runs once per server process (`next start`, the standalone
 * `server.js`, `next dev`). A production server prepares itself lazily, so it runs when the first
 * request arrives (on Railway: the deploy health check) and completes before that request is handled.
 * It also runs in the edge runtime (middleware), where there is nothing to do.
 *
 * Node.js runtime only:
 * - `installWebShutdown()` — SIGTERM/SIGINT ends every open SSE stream with the reconnect frame so Next's
 *   own graceful shutdown can finish (server/lifecycle/webShutdown.ts);
 * - `startEventBusListener()` — opens this process's Postgres LISTEN session now rather than on the first
 *   SSE subscriber, so `/api/health` reports `realtime.listening` from the start (no-op when the bus is
 *   in-process: tests, or no DIRECT_URL).
 *
 * The web process runs no background jobs and never bridges pushes; both belong to the worker
 * (src/worker). src/deploy/processBoundaries.test.ts keeps this file to exactly these two imports.
 * Imports are dynamic inside the runtime check so the edge bundle never pulls in Node-only modules.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const [{ installWebShutdown }, { startEventBusListener }] = await Promise.all([
      import("@/server/lifecycle/webShutdown"),
      import("@/server/events"),
    ]);
    installWebShutdown();
    startEventBusListener();
  }
}
