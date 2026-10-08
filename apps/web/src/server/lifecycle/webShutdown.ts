import { env } from "@/lib/env";
import { childLogger, errorSummary, type Logger } from "@/lib/logger";
import { shutdownEventStreams } from "@/server/realtime/sse";

/**
 * Graceful shutdown of the web process (SIGTERM from the platform on every deploy / restart, SIGINT
 * locally). Next.js's own server (`next start` and the standalone `server.js`) already handles the
 * signal unless `NEXT_MANUAL_SIG_HANDLE` is set, which this app never sets: it stops accepting
 * connections (`server.close()`), waits for in-flight requests and pending `after()` tasks, then exits 0.
 * Next registers that listener at startup, before `register()` (src/instrumentation.ts, run with the
 * first request) installs this one, so ours runs second in the same signal emit. A signal before the
 * first request finds no listener of ours, and needs none: no stream can be open yet.
 *
 * What Next cannot do on its own is finish a request that never ends: an open SSE stream keeps
 * `server.close()` pending until the platform kills the process. So the first signal here:
 * 1. ends every open realtime stream with the `reconnect` frame (`shutdownEventStreams()`; streams opened
 *    while draining get the same at once), so clients reconnect — to the new deployment — straight away;
 * 2. arms an `unref`'d `SHUTDOWN_GRACE_MS` deadline that exits 0 if Next has not finished by then (a stuck
 *    request must not hold the old deployment until SIGKILL). Keep it below the platform's draining
 *    period (railway/web.json `drainingSeconds`).
 *
 * Realtime events published by the last in-flight requests are not lost either: `publishEvent` registers
 * an `after()` task that waits for the bus's NOTIFY flush, and Next awaits pending `after()` tasks before
 * it exits (server/events/index.ts).
 *
 * Later signals are ignored (Next ignores them too).
 */

export interface WebShutdownDeps {
  /** Ends every open SSE stream with the reconnect frame; returns how many it closed. */
  closeStreams: () => number;
  graceMs: number;
  log: Pick<Logger, "info" | "warn">;
  exit: (code: number) => void;
  /** Test seam (default `setTimeout`); the returned handle is `unref`'d so it never keeps Node alive. */
  setTimer?: (fn: () => void, ms: number) => { unref?(): void };
}

/** The signal listener: first call drains, every later call is a no-op. */
export function createWebShutdownHandler(deps: WebShutdownDeps): (signal: NodeJS.Signals) => void {
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms));
  let started = false;
  return (signal) => {
    if (started) return;
    started = true;
    let streamsClosed = 0;
    try {
      streamsClosed = deps.closeStreams();
    } catch (err) {
      deps.log.warn(
        { signal, error: errorSummary(err) },
        "web shutdown: closing event streams failed",
      );
    }
    deps.log.info(
      { signal, streamsClosed, graceMs: deps.graceMs },
      "web shutdown: draining (no new connections; in-flight requests finish)",
    );
    const deadline = setTimer(() => {
      deps.log.warn(
        { signal, graceMs: deps.graceMs },
        "web shutdown: grace period elapsed, exiting",
      );
      deps.exit(0);
    }, deps.graceMs);
    deadline.unref?.();
  };
}

/** SHUTDOWN_GRACE_MS's schema default, used when the environment cannot be read at install time. */
const DEFAULT_SHUTDOWN_GRACE_MS = 20_000;

declare global {
  var __clockoffWebShutdown: ((signal: NodeJS.Signals) => void) | undefined;
}

/**
 * Install the SIGTERM/SIGINT listener once per process (guarded on `globalThis`: instrumentation and
 * route handlers are separate bundles with separate module state). Never throws, so a configuration
 * problem cannot stop the server from starting here; the grace period falls back to its default.
 */
export function installWebShutdown(): void {
  if (globalThis.__clockoffWebShutdown) return;
  const log = childLogger({ module: "webShutdown" });
  let graceMs = DEFAULT_SHUTDOWN_GRACE_MS;
  try {
    graceMs = env().SHUTDOWN_GRACE_MS;
  } catch (err) {
    log.warn(
      { error: errorSummary(err), graceMs },
      "web shutdown: environment invalid, using the default grace period",
    );
  }
  const handler = createWebShutdownHandler({
    closeStreams: shutdownEventStreams,
    graceMs,
    log,
    exit: (code) => process.exit(code),
  });
  globalThis.__clockoffWebShutdown = handler;
  process.once("SIGTERM", handler);
  process.once("SIGINT", handler);
}

/** Remove the installed listeners and forget the guard (tests only). */
export function resetWebShutdownForTesting(): void {
  const handler = globalThis.__clockoffWebShutdown;
  if (!handler) return;
  process.removeListener("SIGTERM", handler);
  process.removeListener("SIGINT", handler);
  globalThis.__clockoffWebShutdown = undefined;
}
