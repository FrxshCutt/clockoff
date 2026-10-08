import { errorSummary, logger } from "@/lib/logger";
import type { EventBus, RealtimeEvent, RealtimeEventHandler, Unsubscribe } from "./EventBus";

/**
 * Single-process event bus. Handlers run synchronously in publish order — the organisation's subscribers
 * first, then the all-organisations ones; a throwing handler is logged and does not affect the others.
 * Used on its own in tests and in development without `DIRECT_URL`, and as the local half of
 * `PostgresEventBus`, which carries events between processes.
 */
export class InProcessEventBus implements EventBus {
  private readonly subscribers = new Map<string, Set<RealtimeEventHandler>>();
  private readonly allSubscribers = new Set<RealtimeEventHandler>();

  publish(event: RealtimeEvent): void {
    const handlers = this.subscribers.get(event.organisationId);
    if (handlers) for (const handler of [...handlers]) this.deliver(handler, event);
    for (const handler of [...this.allSubscribers]) this.deliver(handler, event);
  }

  subscribe(organisationId: string, handler: RealtimeEventHandler): Unsubscribe {
    let set = this.subscribers.get(organisationId);
    if (!set) {
      set = new Set();
      this.subscribers.set(organisationId, set);
    }
    set.add(handler);
    return () => {
      const current = this.subscribers.get(organisationId);
      if (!current) return;
      current.delete(handler);
      if (current.size === 0) this.subscribers.delete(organisationId);
    };
  }

  subscribeAll(handler: RealtimeEventHandler): Unsubscribe {
    this.allSubscribers.add(handler);
    return () => {
      this.allSubscribers.delete(handler);
    };
  }

  subscriberCount(organisationId: string): number {
    return this.subscribers.get(organisationId)?.size ?? 0;
  }

  private deliver(handler: RealtimeEventHandler, event: RealtimeEvent): void {
    try {
      handler(event);
    } catch (err) {
      logger.error(
        { error: errorSummary(err), eventType: event.type },
        "realtime event handler failed",
      );
    }
  }
}
