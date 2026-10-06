import { errorSummary, logger } from "@/lib/logger";
import type { EventBus, RealtimeEvent, RealtimeEventHandler, Unsubscribe } from "./EventBus";

/**
 * Single-process event bus. Handlers run synchronously in publish order; a throwing handler is
 * logged and does not affect the others. Multi-instance deployments would swap this for a
 * Redis pub/sub implementation behind the same interface.
 */
export class InProcessEventBus implements EventBus {
  private readonly subscribers = new Map<string, Set<RealtimeEventHandler>>();

  publish(event: RealtimeEvent): void {
    const handlers = this.subscribers.get(event.organisationId);
    if (!handlers || handlers.size === 0) return;
    for (const handler of [...handlers]) {
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

  subscriberCount(organisationId: string): number {
    return this.subscribers.get(organisationId)?.size ?? 0;
  }
}
