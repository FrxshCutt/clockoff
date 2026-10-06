/**
 * Netlify Scheduled Function — runs the Work Mode tick every minute (docs/WORK_MODE_SERVER_JOB.md).
 *
 * It calls the app's own cron endpoint (`POST /api/jobs/tick` with `Authorization: Bearer $CRON_SECRET`) on
 * `APP_URL`, so the tick runs inside the Next.js server bundle with the same Prisma client and code as every
 * other request. Scheduled functions only run on published production deploys and have a 30-second limit.
 * Kept dependency-free so Netlify can bundle it on its own.
 */

/** Reads APP_URL (falls back to Netlify's URL) and CRON_SECRET. */
export type TickEnv = Record<string, string | undefined>;

export async function runScheduledTick(
  env: TickEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<Response> {
  const base = env.APP_URL || env.URL;
  const secret = env.CRON_SECRET;
  if (!base || !secret) {
    console.error("work-mode-tick: APP_URL (or URL) and CRON_SECRET must be set");
    return new Response(null, { status: 500 });
  }
  try {
    const res = await fetchImpl(new URL("/api/jobs/tick", base), {
      method: "POST",
      headers: { authorization: `Bearer ${secret}` },
      signal: AbortSignal.timeout(25_000),
    });
    if (!res.ok) console.error(`work-mode-tick: tick endpoint answered ${res.status}`);
    return new Response(null, { status: res.ok ? 204 : 502 });
  } catch (err) {
    console.error(
      `work-mode-tick: request failed (${err instanceof Error ? err.name : "unknown error"})`,
    );
    return new Response(null, { status: 502 });
  }
}

export default async function handler(): Promise<Response> {
  return runScheduledTick();
}

export const config = { schedule: "* * * * *" };
