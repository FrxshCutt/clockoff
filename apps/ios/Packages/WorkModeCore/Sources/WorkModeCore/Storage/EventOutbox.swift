import Foundation

/// Append-only queue of `DeviceEvent`s awaiting upload, stored in `CachedState.outbox` so the app and the
/// DeviceActivityMonitor extension can both enqueue. Events are de-duplicated by `clientEventId` (the server
/// is idempotent on it too) and removed only after the server accepted the batch that contained them.
public final class EventOutbox {
    /// Upper bound on queued events; the oldest are dropped beyond it (a device offline for weeks must not
    /// grow the cache without limit — the server re-derives state from the schedule anyway).
    public static let maxEvents = 500

    private let cache: StateCache

    public init(cache: StateCache) {
        self.cache = cache
    }

    /// Queues `event`. Returns false (and changes nothing) when an event with the same id is already queued.
    @discardableResult
    public func append(_ event: DeviceEvent) throws -> Bool {
        try append(contentsOf: [event]) == 1
    }

    /// Queues every event whose id is not already queued; returns how many were added.
    @discardableResult
    public func append(contentsOf events: [DeviceEvent]) throws -> Int {
        var added = 0
        try cache.update { state in
            var known = Set(state.outbox.map { $0.clientEventId.lowercased() })
            for event in events where !known.contains(event.clientEventId.lowercased()) {
                known.insert(event.clientEventId.lowercased())
                state.outbox.append(event)
                added += 1
            }
            if state.outbox.count > EventOutbox.maxEvents {
                state.outbox.removeFirst(state.outbox.count - EventOutbox.maxEvents)
            }
        }
        return added
    }

    /// Queued events, oldest first.
    public func pending() -> [DeviceEvent] {
        cache.load()?.outbox ?? []
    }

    /// True when an event of `type` is queued and not yet uploaded. Used for one-off events (setup steps) so a
    /// retried action does not queue a second copy under a fresh `clientEventId`.
    public func hasPending(_ type: ActivityEventType) -> Bool {
        pending().contains { $0.type == type }
    }

    /// Uploads queued events in batches of at most `batchSize` (≤ 200, the API limit) through the `batch`
    /// hook (the app passes `POST /events`), removing each batch only after the hook returns. Events appended
    /// while flushing are left for the next flush.
    ///
    /// When the hook throws, the batch is normally kept and the error rethrown (earlier batches stay removed,
    /// the failed batch and later ones stay queued for the next flush). If `isPermanentFailure(error)` is true,
    /// the server refused the batch itself (for example 400 VALIDATION_ERROR): resending it can never
    /// succeed and would block every later event, so the batch is dropped and flushing continues.
    /// Returns the number of events removed (uploaded or dropped).
    @discardableResult
    public func flush(
        batchSize: Int = DeviceEventsRequest.maxEventsPerBatch,
        isPermanentFailure: (Error) -> Bool = { _ in false },
        batch send: ([DeviceEvent]) async throws -> Void
    ) async throws -> Int {
        let size = min(max(1, batchSize), DeviceEventsRequest.maxEventsPerBatch)
        let snapshot = pending()
        var removed = 0
        var index = 0
        while index < snapshot.count {
            let batch = Array(snapshot[index..<min(index + size, snapshot.count)])
            do {
                try await send(batch)
            } catch let error where isPermanentFailure(error) {
                WorkModeLog.sync.error("dropping \(batch.count) queued events the server refused: \(String(describing: error), privacy: .public)")
            }
            let sent = Set(batch.map { $0.clientEventId.lowercased() })
            try cache.update { state in
                state.outbox.removeAll { sent.contains($0.clientEventId.lowercased()) }
            }
            removed += batch.count
            index += size
        }
        return removed
    }
}
