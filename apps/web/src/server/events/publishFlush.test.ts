import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * `publishEvent` inside a Next.js request registers an `after()` task that waits for the NOTIFY flush:
 * Next's graceful shutdown awaits pending `after()` tasks before `process.exit(0)`, so the event of one
 * of the last requests before a deploy still leaves the web process.
 */

const after = vi.hoisted(() => ({
  tasks: [] as Array<() => unknown>,
  inRequest: true,
}));

vi.mock("next/server", () => ({
  after: (task: () => unknown) => {
    if (!after.inRequest) throw new Error("`after` was called outside a request scope");
    after.tasks.push(task);
  },
}));

const { InProcessEventBus, PostgresEventBus, publishEvent, setEventBusForTesting } =
  await import("./index");

function slowNotifyBus() {
  const sent: string[] = [];
  const releases: Array<() => void> = [];
  const bus = new PostgresEventBus({
    connectionString: "postgresql://u:p@localhost:5432/never-connected",
    notify: async (_channel, payloads) => {
      await new Promise<void>((resolve) => releases.push(resolve));
      sent.push(...payloads);
    },
  });
  return { bus, sent, release: () => releases.splice(0).forEach((resolve) => resolve()) };
}

afterEach(() => {
  setEventBusForTesting(undefined);
  after.tasks.length = 0;
  after.inRequest = true;
});

describe("publishEvent and the response lifecycle", () => {
  it("inside a request, registers an after() task that resolves only once the NOTIFY was sent", async () => {
    const { bus, sent, release } = slowNotifyBus();
    setEventBusForTesting(bus);
    publishEvent({ type: "OVERRIDE_CREATED", organisationId: "org-1", payload: {} });
    expect(after.tasks).toHaveLength(1);

    let flushed = false;
    const task = Promise.resolve(after.tasks[0]!()).then(() => {
      flushed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(flushed).toBe(false); // the pg_notify round trip is still in flight
    release();
    await task;
    expect(flushed).toBe(true);
    expect(sent).toHaveLength(1);
  });

  it("outside a request (the worker, tests, scripts) publishes normally and registers nothing", async () => {
    after.inRequest = false;
    const { bus, sent, release } = slowNotifyBus();
    setEventBusForTesting(bus);
    expect(() =>
      publishEvent({ type: "OVERRIDE_CREATED", organisationId: "org-1", payload: {} }),
    ).not.toThrow();
    expect(after.tasks).toHaveLength(0);
    await new Promise((resolve) => setTimeout(resolve, 20));
    release();
    await bus.flush(1_000);
    expect(sent).toHaveLength(1);
    await bus.close(500);
  });

  it("an in-process bus has nothing to flush and registers nothing", () => {
    setEventBusForTesting(new InProcessEventBus());
    publishEvent({ type: "OVERRIDE_CREATED", organisationId: "org-1", payload: {} });
    expect(after.tasks).toHaveLength(0);
  });
});
