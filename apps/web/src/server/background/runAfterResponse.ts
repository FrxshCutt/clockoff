import { after } from "next/server";
import { errorSummary, logger } from "@/lib/logger";

/**
 * Work that must not delay (or be observable in the timing of) the HTTP response — e.g. sending the
 * password-reset email only for accounts that exist, so `forgot-password` answers in the same time for
 * known and unknown addresses.
 *
 * Inside a Next.js request the task is handed to `after()`: it runs once the response has been sent, on
 * the same long-running server process. A graceful shutdown (SIGTERM on deploy) does not drop it: Next's
 * server awaits pending `after()` tasks before it exits (server/lifecycle/webShutdown.ts). Outside a
 * request scope (tests, scripts, the worker process, whose bundle shims `next/server` so `after()` throws)
 * it starts immediately without being awaited; {@link settleBackgroundTasks} waits for those.
 *
 * Failures are logged with the task name and never rethrown (there is no caller left to handle them).
 */

const pending = new Set<Promise<void>>();

function run(name: string, task: () => Promise<unknown>): Promise<void> {
  return task().then(
    () => undefined,
    (err: unknown) => {
      logger.error({ task: name, error: errorSummary(err) }, "background task failed");
    },
  );
}

export function runAfterResponse(name: string, task: () => Promise<unknown>): void {
  try {
    after(() => run(name, task));
    return;
  } catch {
    // Not inside a Next.js request (e.g. a route handler invoked directly by a test): run detached.
  }
  const promise = run(name, task);
  pending.add(promise);
  void promise.finally(() => pending.delete(promise));
}

/**
 * Wait until every detached task started outside a request scope has settled (tests call this before
 * asserting on emails). Tasks scheduled while waiting are awaited too.
 */
export async function settleBackgroundTasks(): Promise<void> {
  while (pending.size > 0) await Promise.all([...pending]);
}

/** Number of detached tasks still running (diagnostics / tests). */
export function pendingBackgroundTaskCount(): number {
  return pending.size;
}
