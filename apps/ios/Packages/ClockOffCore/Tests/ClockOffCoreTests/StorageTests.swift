import XCTest
@testable import ClockOffCore

final class StorageTests: XCTestCase {
    private func makeStore() throws -> AppGroupFileStore {
        try AppGroupFileStore(directory: try makeTemporaryDirectory(self))
    }

    func testFileStoreWritesAtomicallyWithProtectionAndDeletes() throws {
        let store = try makeStore()
        XCTAssertNil(try store.read("x.json"))
        try store.write(Data("one".utf8), to: "x.json")
        XCTAssertEqual(try store.read("x.json"), Data("one".utf8))
        try store.update("x.json") { current in
            XCTAssertEqual(current, Data("one".utf8))
            return Data("two".utf8)
        }
        XCTAssertEqual(try store.read("x.json"), Data("two".utf8))
        try store.delete("x.json")
        XCTAssertNil(try store.read("x.json"))
        XCTAssertNoThrow(try store.delete("x.json"), "deleting a missing file is a no-op")
    }

    func testFallbackLiveStoreIsUsableWithoutAppGroupEntitlement() throws {
        // The test bundle has no App Group entitlement, so this exercises the private fallback.
        let store = try AppGroupFileStore.live(identifier: "group.online.clockoff.tests.\(UUID().uuidString)")
        try store.write(Data("ok".utf8), to: "probe-\(UUID().uuidString).json")
    }

    func testStateCacheLoadSaveUpdateWipe() throws {
        let cache = StateCache(fileStore: try makeStore())
        XCTAssertNil(cache.load())
        try cache.save(CachedState(organisation: Organisation(id: "o", name: "Org", timezone: "Europe/London")))
        XCTAssertEqual(cache.load()?.organisation?.name, "Org")
        let updated = try cache.update { $0.scheduleVersion = 9 }
        XCTAssertEqual(updated.scheduleVersion, 9)
        XCTAssertEqual(cache.load()?.scheduleVersion, 9)
        XCTAssertEqual(cache.load()?.organisation?.name, "Org", "update starts from the stored state")
        try cache.wipe()
        XCTAssertNil(cache.load())
    }

    func testCorruptCacheIsTreatedAsEmpty() throws {
        let store = try makeStore()
        try store.write(Data("{not json".utf8), to: StateCache.defaultFileName)
        let cache = StateCache(fileStore: store)
        XCTAssertNil(cache.load())
        try cache.update { $0.scheduleVersion = 1 }
        XCTAssertEqual(cache.load()?.scheduleVersion, 1)
    }

    func testOutboxDeduplicatesByClientEventId() throws {
        let outbox = EventOutbox(cache: StateCache(fileStore: try makeStore()))
        let event = DeviceEvent(type: .setupCompleted, occurredAt: iso("2026-10-06T09:00:00Z"))
        XCTAssertTrue(try outbox.append(event))
        XCTAssertFalse(try outbox.append(event), "same id is ignored")
        var upper = event
        upper.clientEventId = event.clientEventId.uppercased()
        XCTAssertFalse(try outbox.append(upper), "ids compare case-insensitively")
        XCTAssertEqual(try outbox.append(contentsOf: [event, DeviceEvent(type: .policySynced, occurredAt: Date())]), 1)
        XCTAssertEqual(outbox.pending().map(\.type), [.setupCompleted, .policySynced])
    }

    func testOutboxIsBounded() throws {
        let outbox = EventOutbox(cache: StateCache(fileStore: try makeStore()))
        let events = (0..<(EventOutbox.maxEvents + 5)).map { i in
            DeviceEvent(type: .scheduleSynced, occurredAt: Date(timeIntervalSince1970: TimeInterval(i)))
        }
        try outbox.append(contentsOf: events)
        let pending = outbox.pending()
        XCTAssertEqual(pending.count, EventOutbox.maxEvents)
        XCTAssertEqual(pending.first?.occurredAt, Date(timeIntervalSince1970: 5), "oldest dropped first")
    }

    func testOutboxFlushSendsBatchesAndRemovesOnlySentEvents() async throws {
        let outbox = EventOutbox(cache: StateCache(fileStore: try makeStore()))
        let events = (0..<5).map { DeviceEvent(type: .scheduleSynced, occurredAt: Date(timeIntervalSince1970: TimeInterval($0))) }
        try outbox.append(contentsOf: events)
        var batches: [[DeviceEvent]] = []
        let flushed = try await outbox.flush(batchSize: 2) { batch in
            batches.append(batch)
            if batches.count == 1 {
                // Appended mid-flush: must survive for the next flush.
                try outbox.append(DeviceEvent(type: .policySynced, occurredAt: Date(timeIntervalSince1970: 100)))
            }
        }
        XCTAssertEqual(flushed, 5)
        XCTAssertEqual(batches.map(\.count), [2, 2, 1])
        XCTAssertEqual(outbox.pending().map(\.type), [.policySynced])
    }

    func testOutboxFlushFailureKeepsUnsentEvents() async throws {
        let outbox = EventOutbox(cache: StateCache(fileStore: try makeStore()))
        let events = (0..<4).map { DeviceEvent(type: .scheduleSynced, occurredAt: Date(timeIntervalSince1970: TimeInterval($0))) }
        try outbox.append(contentsOf: events)
        var calls = 0
        do {
            try await outbox.flush(batchSize: 2) { _ in
                calls += 1
                if calls == 2 { throw APIError.network(URLError(.notConnectedToInternet)) }
            }
            XCTFail("expected the second batch to fail")
        } catch let error as APIError {
            XCTAssertEqual(error.code, .networkError)
        }
        XCTAssertEqual(outbox.pending().map(\.clientEventId), events.suffix(2).map(\.clientEventId))
    }

    func testOutboxDropsABatchTheServerRefusesAndKeepsFlushing() async throws {
        let outbox = EventOutbox(cache: StateCache(fileStore: try makeStore()))
        let events = (0..<5).map { DeviceEvent(type: .scheduleSynced, occurredAt: Date(timeIntervalSince1970: TimeInterval($0))) }
        try outbox.append(contentsOf: events)
        var delivered: [DeviceEvent] = []
        var calls = 0
        let removed = try await outbox.flush(batchSize: 2, isPermanentFailure: APIError.isPermanentRejection) { batch in
            calls += 1
            if calls == 1 { throw APIError(code: .validationError, message: "Invalid event", status: 400) }
            delivered.append(contentsOf: batch)
        }
        XCTAssertEqual(removed, 5, "the refused batch is dropped instead of blocking later events forever")
        XCTAssertEqual(delivered.map(\.clientEventId), events.suffix(3).map(\.clientEventId))
        XCTAssertTrue(outbox.pending().isEmpty)
    }

    func testOutboxKeepsABatchAfterATransientFailureEvenWithAPermanentFailurePolicy() async throws {
        let outbox = EventOutbox(cache: StateCache(fileStore: try makeStore()))
        let events = (0..<3).map { DeviceEvent(type: .scheduleSynced, occurredAt: Date(timeIntervalSince1970: TimeInterval($0))) }
        try outbox.append(contentsOf: events)
        for transient in [APIError(code: .internalError, message: "", status: 503),
                          APIError(code: .rateLimited, message: "", status: 429),
                          APIError(code: .unauthenticated, message: "", status: 401),
                          APIError.network(URLError(.notConnectedToInternet))] {
            do {
                try await outbox.flush(isPermanentFailure: APIError.isPermanentRejection) { _ in throw transient }
                XCTFail("expected \(transient.code) to be rethrown")
            } catch let error as APIError {
                XCTAssertEqual(error.code, transient.code)
            }
            XCTAssertEqual(outbox.pending().map(\.clientEventId), events.map(\.clientEventId), transient.code.rawValue)
        }
    }

    func testOutboxHasPendingByType() throws {
        let outbox = EventOutbox(cache: StateCache(fileStore: try makeStore()))
        XCTAssertFalse(outbox.hasPending(.setupCompleted))
        try outbox.append(DeviceEvent(type: .setupCompleted, occurredAt: Date()))
        XCTAssertTrue(outbox.hasPending(.setupCompleted))
        XCTAssertFalse(outbox.hasPending(.permissionGranted))
    }

    func testPlansStoreRoundTripAndLookup() throws {
        let plans = PlansStore(fileStore: try makeStore())
        XCTAssertNil(plans.read())
        let london = try XCTUnwrap(TimeZone(identifier: "Europe/London"))
        let entry = PlanEntry(
            shiftId: "s1",
            plan: RestrictionPlan(shiftId: "s1", policyVersion: "pv", categories: [.socialMedia], shieldMessage: "Paused", requiresBreakSubsetSelection: false),
            activity: ActivityPlan(name: "clockoff.shift.s1", shiftId: "s1",
                                   startComponents: deviceComponents(for: iso("2026-10-06T08:00:00Z"), in: london),
                                   endComponents: deviceComponents(for: iso("2026-10-06T16:00:00Z"), in: london),
                                   warningMinutes: 15, kind: .shift, plannedEnd: iso("2026-10-06T16:00:00Z"))
        )
        try plans.write(PlansFile(generatedAt: Date(), organisationName: "Org", entries: ["clockoff.shift.s1": entry]))
        XCTAssertEqual(plans.entry(forActivityNamed: "clockoff.shift.s1"), entry)
        XCTAssertNil(plans.entry(forActivityNamed: "clockoff.shift.other"))
        XCTAssertEqual(plans.read()?.organisationName, "Org")
        try plans.clear()
        XCTAssertNil(plans.read())
    }

    func testKeyValueStores() throws {
        let memory = InMemoryKeyValueStore()
        memory.set("hello", forKey: "s")
        memory.set(true, forKey: "b")
        try memory.setEncodable(SelectionCounts(categories: 1, applications: 2, webDomains: 3), forKey: "c")
        XCTAssertEqual(memory.string(forKey: "s"), "hello")
        XCTAssertTrue(memory.bool(forKey: "b"))
        XCTAssertEqual(memory.decodable(SelectionCounts.self, forKey: "c")?.applications, 2)
        memory.removeValue(forKey: "s")
        XCTAssertNil(memory.string(forKey: "s"))

        let suite = "ClockOffCoreTests.\(UUID().uuidString)"
        let defaults = try XCTUnwrap(UserDefaultsKeyValueStore(suiteName: suite))
        addTeardownBlock { UserDefaults().removePersistentDomain(forName: suite) }
        defaults.set("x", forKey: "k")
        XCTAssertEqual(defaults.string(forKey: "k"), "x")
        defaults.set(nil as Data?, forKey: "k")
        XCTAssertNil(defaults.data(forKey: "k"))
    }

    func testInMemoryTokenStore() throws {
        let store = InMemoryTokenStore()
        XCTAssertNil(try store.loadTokens())
        try store.saveTokens(Fixture.tokens)
        XCTAssertEqual(try store.loadTokens(), Fixture.tokens)
        try store.deleteTokens()
        XCTAssertNil(try store.loadTokens())
    }
}
