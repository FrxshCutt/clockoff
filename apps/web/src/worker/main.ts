import { runWorkerCli } from "./cli";

/**
 * Worker process entry point (Railway `worker` service): bundled by `scripts/build-worker.mjs` into
 * `dist/worker/main.mjs` (`node main.mjs <command>` in the image) and run with tsx in development
 * (`pnpm worker <command>`). The web process never imports anything under `src/worker`.
 */
void runWorkerCli(process.argv.slice(2));
