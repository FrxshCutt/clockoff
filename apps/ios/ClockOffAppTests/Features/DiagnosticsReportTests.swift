// The Diagnostics screen exists only in Debug builds (Settings → tap "App version" five times).
#if DEBUG
import XCTest
@testable import ClockOffApp
import ClockOffCore

/// `DiagnosticsReport` (pure) over hand-built snapshots, and `LiveDiagnosticsDataSource` over the mock provider:
/// the copied report carries counts, states, activity names and times — never app or category names.
final class DiagnosticsReportTests: XCTestCase {
    private let london = TimeZone(identifier: "Europe/London")!
    private let now = iso("2026-10-06T09:00:00Z")
    private let shiftRef = ShiftRef(id: Fixtures.shift.id, startsAt: Fixtures.shift.startsAt, endsAt: Fixtures.shift.endsAt)

    // MARK: Live data source over the mock provider

    @MainActor
    func testCopiedReportHasCountsAndStatesButNoAppOrCategoryNames() async throws {
        let env = try TestEnvironment(testCase: self, now: now)
        try await env.setUpCompletedPhone()
        try env.cache.update { state in
            // Breaks relax Social Media only, so the plans carry category lists that must not leak.
            state.breakPolicy = Fixtures.relaxCategoriesBreakPolicy
            state.clockSkewSeconds = 3
            state.lastDeviceStateReportAt = iso("2026-10-06T08:58:00Z")
        }
        let model = env.makeAppModel()
        let outcome = model.controller.reconcile()
        XCTAssertEqual(outcome.appliedState, .working)
        XCTAssertNotNil(try model.controller.replanActivities())
        env.sharedFlags.lastMonitorCallback = SharedFlags.MonitorCallback(
            kind: "intervalDidStart", activityName: "shift-\(Fixtures.shift.id)-v1", at: iso("2026-10-06T08:00:00Z"),
            outcome: "applied work shields for shift \(Fixtures.shift.id)"
        )

        let source = LiveDiagnosticsDataSource(model: model, now: { env.clock.now })
        let snapshot = source.snapshot()
        let text = DiagnosticsReport.text(snapshot)

        XCTAssertTrue(text.hasPrefix("ClockOff Diagnostics\n"), text)
        for line in [
            "Family Controls: Approved",
            "Reported to workplace: APPROVED",
            "Restriction provider: Simulated (development)",
            "Selection saved: Yes",
            "Apps: 4",
            "Categories: 3",
            "Web domains: 1",
            "Kept blocked on breaks: Not chosen (the break policy needs it) [!]",
            "Shown in the app: Work Mode active",
            "Engine state: WORKING",
            "Effective restriction: WORK",
            "Restrictions should be active: Yes",
            "Shield stores read back as: WORKING (source: provider)",
            "Last reconcile result: apply work shields → WORKING · RECONCILE",
            "Work store (.work): Shielding",
            "Work store sets: applications 4 · applicationCategories specific(3) · webDomains 1 · webDomainCategories specific(3)",
            "Break store (.breakRelaxed): Empty",
            "Break store sets: applications nil · applicationCategories nil · webDomains nil · webDomainCategories nil",
            "Engine state in state.json: WORKING · written by app",
            "Last extension callback: intervalDidStart · shift-\(Fixtures.shift.id)-v1 · 2026-10-06 09:00:00 +01:00 (1 h ago) · applied work shields",
            "Outbox: \(snapshot.appGroup.outboxCount) event",
            "Offline breaks queued: 0",
            "Re-registration pending: No",
            "Policy version: \(Fixtures.policy.policyVersionId)",
            "Schedule version: 1",
            "Clock skew: +3 s (device ahead of server)",
            "Last check-in: 2026-10-06 09:58:00 +01:00 (2 min ago)",
            "API host: localhost:3000",
        ] {
            XCTAssertTrue(text.contains(line), "missing \"\(line)\" in\n\(text)")
        }
        XCTAssertTrue(text.contains("Reason: Shift in progress 2026-10-06 09:00 → 17:00 +01:00 · running, ends in 7 h"), text)

        // DeviceActivity: what is registered matches plans.json, and both are listed by name.
        let registered = try XCTUnwrap(snapshot.schedules.registered)
        let planned = try XCTUnwrap(snapshot.schedules.planned)
        XCTAssertFalse(planned.isEmpty)
        XCTAssertEqual(Set(registered.map(\.name)), Set(planned.map(\.name)))
        for entry in planned {
            XCTAssertTrue(text.contains("\(entry.name): shift · 2026-10-06 09:00 → 17:00 +01:00"), text)
        }
        XCTAssertTrue(text.contains("Registered with iOS: \(registered.count) activit"), text)
        XCTAssertFalse(text.contains("not in plans.json"), text)
        XCTAssertFalse(text.contains("not registered with iOS"), text)

        // Never names: categories (raw or label), the shield message, always-allowed apps, who and where.
        for category in RestrictionCategory.allCases {
            XCTAssertFalse(text.contains(category.rawValue), "\(category.rawValue) leaked")
            XCTAssertFalse(text.contains(category.label), "\(category.label) leaked")
        }
        for name in ["socialMedia", "Maps", "On shift", Fixtures.organisation.name, "Patel", "Barista", "High St",
                     Fixtures.policy.policy.name, Fixtures.relaxCategoriesBreakPolicy.name] {
            XCTAssertFalse(text.contains(name), "\(name) leaked")
        }
    }

    @MainActor
    func testActionsReplanAndClearThroughTheProvider() async throws {
        let env = try TestEnvironment(testCase: self, now: now)
        try await env.setUpCompletedPhone()
        let model = env.makeAppModel()
        model.controller.reconcile()
        let source = LiveDiagnosticsDataSource(model: model, now: { env.clock.now })

        XCTAssertEqual(source.replanSchedules(), "Re-planned: plans.json rewritten with 1 entry and DeviceActivity schedules registered again.")
        XCTAssertEqual(env.provider.scheduledActivities.count, 1)
        XCTAssertEqual(source.snapshot().shieldStores?.first?.isShielding, true)

        XCTAssertTrue(source.clearAllShields().hasPrefix("Shields cleared."))
        XCTAssertEqual(env.provider.activeRestriction, .none)
        XCTAssertEqual(source.snapshot().shieldStores?.contains { $0.isShielding }, false)
    }

    // MARK: Pure formatting

    func testEmptyPhoneFlagsWhatIsMissing() {
        let snapshot = makeSnapshot()
        let text = DiagnosticsReport.text(snapshot)
        for line in [
            "Family Controls: Not determined [!]",
            "Reported to workplace: NOT_DETERMINED [!]",
            "Selection saved: No [!]",
            "Apps: 0",
            "Kept blocked on breaks: Not needed by the break policy",
            "Shown in the app: Unknown (not joined or not evaluated)",
            "Engine state: Not evaluated yet",
            "Reason: Not joined to a workplace: nothing to enforce",
            "Last reconcile: Never",
            "Last reconcile result: None yet",
            "Registered with iOS: None",
            "File modified: No file",
            "Entries: None",
            "Container: Private fallback (the extensions can't read it) [!]",
            "Engine state in state.json: None",
            "Last extension callback: None yet",
            "Outbox: Empty",
            "Last sync: Never [!]",
            "Last sync error: None",
            "Clock skew: Unknown (no check-in yet)",
        ] {
            XCTAssertTrue(text.contains(line), "missing \"\(line)\" in\n\(text)")
        }
        XCTAssertFalse(text.contains("Effective restriction"), "no engine output yet")
    }

    func testRegisteredAndPlannedActivitiesAreCrossChecked() {
        var snapshot = makeSnapshot()
        let start = iso("2026-10-06T09:20:00Z")
        let end = iso("2026-10-06T09:50:00Z")
        snapshot.schedules.registered = [
            DiagnosticsSnapshot.RegisteredActivity(name: "shift-a-v1", start: start, end: end, repeats: false, warningMinutes: 10),
            DiagnosticsSnapshot.RegisteredActivity(name: "shift-orphan-v1", start: start, end: end, repeats: false, warningMinutes: nil),
        ]
        snapshot.schedules.planned = [
            DiagnosticsSnapshot.PlannedActivity(name: "shift-a-v1", kind: .shift, start: start, end: end),
            DiagnosticsSnapshot.PlannedActivity(name: "shift-missing-v2", kind: .shift, start: start, end: end),
            DiagnosticsSnapshot.PlannedActivity(name: "break-old", kind: .break, start: iso("2026-10-06T07:00:00Z"), end: iso("2026-10-06T07:15:00Z")),
        ]
        let text = DiagnosticsReport.text(snapshot)
        XCTAssertTrue(text.contains("Registered with iOS: 2 activities"), text)
        XCTAssertTrue(text.contains("shift-a-v1: 2026-10-06 10:20 → 10:50 +01:00 · starts in 20 min · warning 10 min\n"), text)
        XCTAssertTrue(text.contains("shift-orphan-v1: 2026-10-06 10:20 → 10:50 +01:00 · starts in 20 min · not in plans.json [!]"), text)
        XCTAssertTrue(text.contains("Entries: 3"), text)
        XCTAssertTrue(text.contains("shift-a-v1: shift · 2026-10-06 10:20 → 10:50 +01:00 · starts in 20 min\n"), text)
        XCTAssertTrue(text.contains("shift-missing-v2: shift · 2026-10-06 10:20 → 10:50 +01:00 · starts in 20 min · not registered with iOS [!]"), text)
        XCTAssertTrue(text.contains("break-old: break · 2026-10-06 08:00 → 08:15 +01:00 · ended 1 h 45 min ago · not registered (already over)\n"), text)
    }

    func testEngineReasons() {
        let time = DiagnosticsTimeFormat(timeZone: london, now: now)
        func reason(_ expected: ExpectedState) -> String {
            DiagnosticsReport.reason(DiagnosticsSnapshot.Engine(isJoined: true, screenState: .unknown, expected: expected,
                                                                providerState: .unknown, lastReconcile: nil, lastReconcileAt: nil), time: time)
        }
        XCTAssertEqual(reason(ExpectedState(state: .working, effectiveRestriction: .work, restrictionsShouldBeActive: true, computedAt: now,
                                            permissionState: .approved, activeShift: shiftRef)),
                       "Shift in progress 2026-10-06 09:00 → 17:00 +01:00 · running, ends in 7 h")
        let next = ShiftRef(id: "n", startsAt: iso("2026-10-07T06:00:00Z"), endsAt: iso("2026-10-07T14:00:00Z"))
        XCTAssertEqual(reason(ExpectedState(state: .offShift, effectiveRestriction: .none, restrictionsShouldBeActive: false, computedAt: now,
                                            permissionState: .approved, upcomingShift: next)),
                       "No shift now; next shift 2026-10-07 07:00 → 15:00 +01:00 · starts in 21 h")
        XCTAssertEqual(reason(ExpectedState(state: .offShift, effectiveRestriction: .none, restrictionsShouldBeActive: false, computedAt: now,
                                            permissionState: .approved)),
                       "No shift now and none upcoming in the cached schedule")
        let onBreak = BreakRef(id: "b", shiftId: shiftRef.id, startedAt: iso("2026-10-06T08:55:00Z"), plannedEndsAt: iso("2026-10-06T09:10:00Z"),
                               endsAt: iso("2026-10-06T09:10:00Z"))
        XCTAssertEqual(reason(ExpectedState(state: .onBreak, effectiveRestriction: .breakRelaxed, restrictionsShouldBeActive: false, computedAt: now,
                                            permissionState: .approved, activeShift: shiftRef, activeBreak: onBreak,
                                            relaxation: RestrictionRelaxation(source: .breakSession, restrictionBehaviour: .relaxAll,
                                                                              relaxedCategories: [], liftedCategories: RestrictionCategory.allCases))),
                       "Break running 2026-10-06 09:55 → 10:10 +01:00 · running, ends in 10 min, RELAX_ALL")
        XCTAssertEqual(reason(ExpectedState(state: .permissionError, effectiveRestriction: .work, restrictionsShouldBeActive: true, computedAt: now,
                                            permissionState: .revoked)),
                       "Screen Time permission is REVOKED")
    }

    func testRelativeTimesAndClockSkew() {
        let time = DiagnosticsTimeFormat(timeZone: london, now: now)
        XCTAssertEqual(time.relative(now.addingTimeInterval(2)), "now")
        XCTAssertEqual(time.relative(now.addingTimeInterval(45)), "in 45 s")
        XCTAssertEqual(time.relative(now.addingTimeInterval(-180)), "3 min ago")
        XCTAssertEqual(time.relative(now.addingTimeInterval(2 * 3600 + 300)), "in 2 h 5 min")
        XCTAssertEqual(time.relative(now.addingTimeInterval(-(26 * 3600))), "1 d 2 h ago")
        XCTAssertEqual(time.stamp(now), "2026-10-06 10:00:00 +01:00 (now)")
        XCTAssertEqual(DiagnosticsReport.clockSkewText(-42), "-42 s (device behind server)")
        XCTAssertEqual(DiagnosticsReport.clockSkewText(0), "0 s (in step with the server)")
    }

    func testFiveQuickTapsUnlockDiagnostics() {
        var unlock = DiagnosticsUnlock()
        let start = now
        for tap in 0..<4 {
            XCTAssertFalse(unlock.registerTap(at: start.addingTimeInterval(Double(tap) * 0.4)))
        }
        XCTAssertTrue(unlock.registerTap(at: start.addingTimeInterval(1.6)))
        XCTAssertEqual(unlock.count, 0, "the sequence starts again after unlocking")

        // A pause longer than the allowed gap starts the count again.
        var slow = DiagnosticsUnlock()
        for tap in 0..<4 { _ = slow.registerTap(at: start.addingTimeInterval(Double(tap) * 0.4)) }
        XCTAssertFalse(slow.registerTap(at: start.addingTimeInterval(1.2 + DiagnosticsUnlock.maximumGap + 0.5)))
        XCTAssertEqual(slow.count, 1)
    }

    func testShieldStoresAreFlaggedWhenTheyDisagreeWithTheEngine() {
        var snapshot = makeSnapshot()
        snapshot.engine.isJoined = true
        let working = ExpectedState(state: .working, effectiveRestriction: .work, restrictionsShouldBeActive: true, computedAt: now,
                                    permissionState: .approved, activeShift: shiftRef)
        let offShift = ExpectedState(state: .offShift, effectiveRestriction: .none, restrictionsShouldBeActive: false, computedAt: now,
                                     permissionState: .approved)
        let shielding = DiagnosticsSnapshot.ShieldStore(role: .work, applications: 4, applicationCategories: .specific(categories: 3, exceptions: 0),
                                                        webDomains: 1, webDomainCategories: .specific(categories: 3, exceptions: 0))

        // Work Mode failed: a shift is running but the stores are empty.
        snapshot.engine.expected = working
        snapshot.engine.providerState = RestrictionEngineState(state: .unknown, source: .provider, updatedAt: nil)
        XCTAssertTrue(DiagnosticsReport.text(snapshot).contains("Shield stores read back as: UNKNOWN (source: provider) [!]"))

        // Shields left behind after the shift ended.
        snapshot.engine.expected = offShift
        snapshot.engine.providerState = RestrictionEngineState(state: .working, source: .provider, updatedAt: nil)
        snapshot.shieldStores = [shielding, .empty(.breakRelaxed)]
        XCTAssertTrue(DiagnosticsReport.text(snapshot).contains("Shield stores read back as: WORKING (source: provider) [!]"))
        XCTAssertTrue(DiagnosticsReport.text(snapshot).contains("Work store (.work): Shielding\n"))

        // In agreement: nothing flagged.
        snapshot.shieldStores = [.empty(.work), .empty(.breakRelaxed)]
        snapshot.engine.providerState = RestrictionEngineState(state: .offShift, source: .provider, updatedAt: nil)
        XCTAssertTrue(DiagnosticsReport.text(snapshot).contains("Shield stores read back as: OFF_SHIFT (source: provider)\n"))
        snapshot.engine.expected = working
        snapshot.shieldStores = [shielding, .empty(.breakRelaxed)]
        snapshot.engine.providerState = RestrictionEngineState(state: .working, source: .provider, updatedAt: nil)
        XCTAssertTrue(DiagnosticsReport.text(snapshot).contains("Shield stores read back as: WORKING (source: provider)\n"))

        // Same read-back rule as ManagedSettingsShieldStore.isShielding: any non-nil category policy counts.
        let noneOnly = DiagnosticsSnapshot.ShieldStore(role: .work, applications: nil, applicationCategories: DiagnosticsSnapshot.CategoryPolicy.none,
                                                       webDomains: 0, webDomainCategories: nil)
        XCTAssertTrue(noneOnly.isShielding)
        XCTAssertFalse(DiagnosticsSnapshot.ShieldStore(role: .work, applications: 0, applicationCategories: nil, webDomains: 0,
                                                       webDomainCategories: nil).isShielding)
    }

    // MARK: Screen (view model)

    @MainActor
    func testCopyPutsTheFullReportOnThePasteboard() {
        let source = StubDiagnosticsSource(snapshot: makeSnapshot())
        var copied: [String] = []
        let viewModel = DiagnosticsViewModel(source: source, copyToPasteboard: { copied.append($0) })
        source.current.sync.lastSyncAt = now
        viewModel.copyReport()

        XCTAssertEqual(copied, [DiagnosticsReport.text(source.current)], "a fresh snapshot, formatted exactly like the screen")
        let text = copied.first ?? ""
        XCTAssertTrue(text.hasPrefix("ClockOff Diagnostics\nCounts and states only: no app or category names.\n"), text)
        for section in DiagnosticsReport.sections(source.current) {
            XCTAssertTrue(text.contains("== \(section.title) =="), "missing section \(section.title)")
            for row in section.rows {
                XCTAssertTrue(text.contains("\(row.label): \(row.value)"), "missing row \(row.label)")
            }
        }
        XCTAssertTrue(text.contains("Last sync: 2026-10-06 10:00:00 +01:00 (now)\n"), text)
        XCTAssertEqual(viewModel.lastAction, "Diagnostics copied to the clipboard (counts and states only).")
    }

    @MainActor
    func testLiveUpdatesStopWhenTheScreenGoesAway() async {
        let source = StubDiagnosticsSource(snapshot: makeSnapshot())
        let viewModel = DiagnosticsViewModel(source: source, copyToPasteboard: { _ in })
        XCTAssertEqual(source.snapshotCalls, 1)
        let stopped = expectation(description: "the refresh loop ends")
        // What the view's `.task` runs; SwiftUI cancels it when the screen disappears.
        let updates = Task { @MainActor in
            await viewModel.runLiveUpdates()
            stopped.fulfill()
        }
        while source.snapshotCalls < 2 { await Task.yield() }
        updates.cancel()
        await fulfillment(of: [stopped], timeout: 1)
        let calls = source.snapshotCalls
        try? await Task.sleep(nanoseconds: 100_000_000)
        XCTAssertEqual(source.snapshotCalls, calls, "no refresh after cancellation")
    }

    @MainActor
    func testActionsReportTheSourceResultAndRefresh() async {
        let source = StubDiagnosticsSource(snapshot: makeSnapshot())
        let viewModel = DiagnosticsViewModel(source: source, copyToPasteboard: { _ in })
        viewModel.clearAllShields()
        XCTAssertEqual(source.actions, ["clear"])
        XCTAssertEqual(viewModel.lastAction, "cleared")
        viewModel.replanSchedules()
        await viewModel.forceSync()
        XCTAssertEqual(source.actions, ["clear", "replan", "sync"])
        XCTAssertEqual(viewModel.lastAction, "synced")
        XCTAssertFalse(viewModel.isSyncing)
        XCTAssertEqual(source.snapshotCalls, 4, "initial read plus one refresh after each action")
    }

    // MARK: Helpers

    private func makeSnapshot() -> DiagnosticsSnapshot {
        DiagnosticsSnapshot(
            capturedAt: now,
            timeZone: london,
            appVersion: "0.1.0 (1)",
            authorization: DiagnosticsSnapshot.Authorization(familyControls: .notDetermined, reportedPermission: .notDetermined, provider: .screenTime),
            selection: DiagnosticsSnapshot.Selection(work: nil, breakKept: nil, breakKeptRequired: false),
            engine: DiagnosticsSnapshot.Engine(isJoined: false, screenState: .unknown, expected: nil, providerState: .unknown,
                                               lastReconcile: nil, lastReconcileAt: nil),
            schedules: DiagnosticsSnapshot.Schedules(registered: [], planned: nil, needsReschedule: false),
            shieldStores: [.empty(.work), .empty(.breakRelaxed)],
            appGroup: DiagnosticsSnapshot.AppGroupContents(isSharedContainer: false, plansFileModifiedAt: nil, plansGeneratedAt: nil,
                                                           stateFileModifiedAt: nil, recordedEngineState: nil, lastMonitorCallback: nil,
                                                           outboxCount: 0, queuedBreakCount: 0, selectionIncomplete: false),
            sync: DiagnosticsSnapshot.Sync(lastSyncAt: nil, lastServerContactAt: nil, lastSyncErrorCode: nil, policyVersion: nil,
                                           scheduleVersion: nil, clockSkewSeconds: nil, lastCheckInAt: nil, apiHost: "app.clockoff.online")
        )
    }
}

/// A `DiagnosticsDataSource` that serves a fixed snapshot and records what the screen asked it to do.
@MainActor
private final class StubDiagnosticsSource: DiagnosticsDataSource {
    var current: DiagnosticsSnapshot
    private(set) var snapshotCalls = 0
    private(set) var actions: [String] = []

    init(snapshot: DiagnosticsSnapshot) {
        current = snapshot
    }

    func snapshot() -> DiagnosticsSnapshot {
        snapshotCalls += 1
        return current
    }

    func forceSync() async -> String {
        actions.append("sync")
        return "synced"
    }

    func replanSchedules() -> String {
        actions.append("replan")
        return "replanned"
    }

    func clearAllShields() -> String {
        actions.append("clear")
        return "cleared"
    }
}
#endif
