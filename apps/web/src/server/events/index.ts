import { InProcessEventBus } from "./InProcessEventBus";
import type { EventBus, RealtimeEvent } from "./EventBus";

export { InProcessEventBus } from "./InProcessEventBus";
export { REALTIME_EVENT_TYPES } from "./EventBus";
export type {
  EventBus,
  KnownRealtimeEventType,
  RealtimeEvent,
  RealtimeEventHandler,
  Unsubscribe,
} from "./EventBus";

declare global {
  var __workmodeEventBus: EventBus | undefined;
}

/** Process-wide bus (cached on globalThis so Next dev HMR keeps SSE subscriptions alive). */
export function getEventBus(): EventBus {
  if (!globalThis.__workmodeEventBus) globalThis.__workmodeEventBus = new InProcessEventBus();
  return globalThis.__workmodeEventBus;
}

export function setEventBusForTesting(bus: EventBus | undefined): void {
  globalThis.__workmodeEventBus = bus;
}

/** Convenience for publishing with `at` defaulted to now. */
export function publishEvent(event: Omit<RealtimeEvent, "at"> & { at?: string }): void {
  getEventBus().publish({ ...event, at: event.at ?? new Date().toISOString() });
}
