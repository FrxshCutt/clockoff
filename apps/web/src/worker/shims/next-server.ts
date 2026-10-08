/**
 * `next/server` inside the worker bundle (`scripts/build-worker.mjs` maps the import here, so Next.js is
 * never bundled into the worker). The only server-side user reachable from the worker is
 * `runAfterResponse`, which calls `after()` and falls back to running the task detached when it throws —
 * exactly right outside a request. Any other named import of `next/server` fails the build on purpose.
 */
export function after(_task: unknown): never {
  throw new Error("next/server after() is not available in the worker");
}
