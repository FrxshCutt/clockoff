import { describe, expect, it } from "vitest";
import {
  pendingBackgroundTaskCount,
  runAfterResponse,
  settleBackgroundTasks,
} from "./runAfterResponse";

describe("runAfterResponse", () => {
  it("runs the task detached outside a request scope and settleBackgroundTasks waits for it", async () => {
    const events: string[] = [];
    runAfterResponse("unit:test", async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      events.push("done");
    });
    // The caller is not blocked by the task.
    expect(events).toEqual([]);
    expect(pendingBackgroundTaskCount()).toBe(1);
    await settleBackgroundTasks();
    expect(events).toEqual(["done"]);
    expect(pendingBackgroundTaskCount()).toBe(0);
  });

  it("swallows (logs) task failures instead of producing unhandled rejections", async () => {
    runAfterResponse("unit:failing", async () => {
      throw new Error("smtp down");
    });
    await expect(settleBackgroundTasks()).resolves.toBeUndefined();
  });

  it("waits for tasks scheduled by other tasks", async () => {
    const events: string[] = [];
    runAfterResponse("unit:outer", async () => {
      runAfterResponse("unit:inner", async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        events.push("inner");
      });
      events.push("outer");
    });
    await settleBackgroundTasks();
    expect(events).toEqual(["outer", "inner"]);
  });
});
