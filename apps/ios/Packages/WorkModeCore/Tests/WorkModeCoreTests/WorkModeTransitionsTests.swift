import XCTest
@testable import WorkModeCore

/// Port of the key cases of `packages/shared/src/workMode/diffStates.test.ts` and `replay.test.ts`.
final class WorkModeTransitionsTests: XCTestCase {
    private let engine = WorkModeEngine(timezone: "Europe/London", employeeId: "emp-1")
    private let shiftDay = Shift(id: "shift-day", startsAt: iso("2026-01-12T09:00:00Z"), endsAt: iso("2026-01-12T15:00:00Z"), timezone: "Europe/London")

    private struct Rows {
        var shifts: [Shift]?
        var breaks: [BreakSession] = []
        var overrides: [ActiveOverride] = []
        var permission: PermissionState = .approved
    }

    private func at(_ hm: String, day: String = "2026-01-12") -> Date { iso("\(day)T\(hm):00Z") }

    private func brk(_ id: String, _ start: String, _ planned: String, endedAt: String? = nil, status: BreakSessionStatus = .active,
                     behaviour: BreakRestrictionBehaviour = .relaxAll) -> BreakSession {
        BreakSession(id: id, clientBreakId: id, shiftId: "shift-day", startedAt: at(start), plannedEndsAt: at(planned),
                     endedAt: endedAt.map { at($0) }, status: status, restrictionBehaviour: behaviour)
    }

    private func ov(_ id: String, _ type: OverrideType, _ start: String, _ end: String, revokedAt: String? = nil,
                    behaviour: BreakBehaviourSnapshot? = nil) -> ActiveOverride {
        ActiveOverride(id: id, type: type, startsAt: at(start), expiresAt: at(end), breakBehaviour: behaviour, revokedAt: revokedAt.map { at($0) }, employeeId: "emp-1")
    }

    private func state(_ hm: String, _ rows: Rows = Rows()) -> ExpectedState {
        engine.computeExpectedState(now: at(hm), shifts: rows.shifts ?? [shiftDay], breakSessions: rows.breaks, overrides: rows.overrides, permissionState: rows.permission)
    }

    /// Compact view: "EVENT from>to [shift=..] [break=..] [override=..]" ("-" for an event-less transition).
    private func view(_ transitions: [WorkModeTransition]) -> [String] {
        transitions.map { t in
            var parts = ["\(t.eventType?.rawValue ?? "-") \(t.from.rawValue)>\(t.to.rawValue)"]
            if let s = t.shiftId { parts.append("shift=\(s)") }
            if let b = t.breakSessionId { parts.append("break=\(b)") }
            if let o = t.overrideId { parts.append("override=\(o)") }
            return parts.joined(separator: " ")
        }
    }

    private func diff(_ prev: ExpectedState, _ next: ExpectedState) -> [String] {
        view(WorkModeEngine.diffStates(from: .snapshot(prev), to: next))
    }

    func testIsActiveStateIsTrueExactlyForWorkingOnBreakAndShiftEnding() {
        XCTAssertEqual(WorkModeState.allCases.filter(WorkModeEngine.isActiveState), [.working, .onBreak, .shiftEnding])
    }

    func testNothingChangedAndEventLessTransitions() {
        let canon = Rows(breaks: [brk("break-1", "10:15", "10:30")])
        XCTAssertEqual(WorkModeEngine.diffStates(from: .snapshot(state("09:30", canon)), to: state("09:31", canon)), [])
        let soon = state("08:45", canon)
        XCTAssertEqual(WorkModeEngine.diffStates(from: .snapshot(state("08:44", canon)), to: soon),
                       [WorkModeTransition(from: .offShift, to: .shiftStartingSoon, at: soon.computedAt)])
        let ending = state("14:55", canon)
        XCTAssertEqual(WorkModeEngine.diffStates(from: .snapshot(state("14:54", canon)), to: ending),
                       [WorkModeTransition(from: .working, to: .shiftEnding, at: ending.computedAt)])
    }

    func testCanonicalDayEvents() {
        let canon = Rows(breaks: [brk("break-1", "10:15", "10:30")])
        XCTAssertEqual(diff(state("08:59", canon), state("09:00", canon)), ["WORK_MODE_STARTED SHIFT_STARTING_SOON>WORKING shift=shift-day"])
        XCTAssertEqual(diff(state("10:14", canon), state("10:15", canon)), ["BREAK_STARTED WORKING>ON_BREAK shift=shift-day break=break-1"])
        XCTAssertEqual(diff(state("10:29", canon), state("10:30", canon)), ["BREAK_EXPIRED ON_BREAK>WORKING shift=shift-day break=break-1"])
        XCTAssertEqual(diff(state("14:55", canon), state("15:00", canon)), ["WORK_MODE_ENDED SHIFT_ENDING>OFF_SHIFT shift=shift-day"])
        let all = WorkModeEngine.diffStates(from: .snapshot(state("14:55", canon)), to: state("15:00", canon))
        XCTAssertEqual(all.map(\.at), [at("15:00")], "stamped with next.computedAt")
    }

    func testBreakEndedEarlyIsEndedNotExpired() {
        let prev = state("10:19", Rows(breaks: [brk("break-1", "10:15", "10:30")]))
        let next = state("10:21", Rows(breaks: [brk("break-1", "10:15", "10:30", endedAt: "10:20", status: .ended)]))
        XCTAssertEqual(diff(prev, next), ["BREAK_ENDED ON_BREAK>WORKING shift=shift-day break=break-1"])
    }

    func testBreakCutShortByShiftEndEmitsEndedThenWorkModeEnded() {
        let rows = Rows(breaks: [brk("break-late", "14:50", "15:10")])
        XCTAssertEqual(diff(state("14:59", rows), state("15:00", rows)), [
            "BREAK_ENDED ON_BREAK>OFF_SHIFT shift=shift-day break=break-late",
            "WORK_MODE_ENDED ON_BREAK>OFF_SHIFT shift=shift-day",
        ])
    }

    func testBreakExpiringExactlyAtItsShiftEndIsExpired() {
        let rows = Rows(breaks: [brk("break-tie", "14:50", "15:00")])
        XCTAssertEqual(diff(state("14:59", rows), state("15:00", rows)), [
            "BREAK_EXPIRED ON_BREAK>OFF_SHIFT shift=shift-day break=break-tie",
            "WORK_MODE_ENDED ON_BREAK>OFF_SHIFT shift=shift-day",
        ])
    }

    func testNeverFlapsBetweenBackToBackShiftsAndNamesTheRightShift() {
        let rows = Rows(shifts: [
            Shift(id: "am", startsAt: at("09:00"), endsAt: at("13:00"), timezone: "Europe/London"),
            Shift(id: "pm", startsAt: at("13:00"), endsAt: at("17:00"), timezone: "Europe/London"),
        ])
        XCTAssertEqual(WorkModeEngine.diffStates(from: .snapshot(state("12:55", rows)), to: state("12:56", rows)), [])
        XCTAssertEqual(WorkModeEngine.diffStates(from: .snapshot(state("12:59", rows)), to: state("13:00", rows)), [])
        // prev observed during "am", the change happens during "pm": the ended shift is "pm".
        XCTAssertEqual(diff(state("10:00", rows), state("17:00", rows)), ["WORK_MODE_ENDED WORKING>OFF_SHIFT shift=pm"])
        // Two evaluations at the same instant keep prev.activeShift.
        XCTAssertEqual(diff(state("10:00", rows), state("10:00", Rows(shifts: []))), ["WORK_MODE_ENDED WORKING>OFF_SHIFT shift=am"])
    }

    func testLiftingOverrideEndsWorkModeAndItsExpiryRestartsIt() {
        let rows = Rows(overrides: [ov("ov-1", .exemptTemporarily, "11:00", "12:00")])
        XCTAssertEqual(diff(state("10:59", rows), state("11:00", rows)), ["WORK_MODE_ENDED WORKING>MANAGER_OVERRIDE shift=shift-day override=ov-1"])
        XCTAssertEqual(diff(state("11:59", rows), state("12:00", rows)), [
            "OVERRIDE_EXPIRED MANAGER_OVERRIDE>WORKING shift=shift-day override=ov-1",
            "WORK_MODE_STARTED MANAGER_OVERRIDE>WORKING shift=shift-day",
        ])
        let revoked = Rows(overrides: [ov("ov-1", .exemptTemporarily, "11:00", "12:00", revokedAt: "11:30")])
        XCTAssertEqual(diff(state("11:29", revoked), state("11:30", revoked)), ["WORK_MODE_STARTED MANAGER_OVERRIDE>WORKING shift=shift-day"])
    }

    func testBreakKeepsRunningUnderALiftingOverride() {
        let rows = Rows(breaks: [brk("break-1", "10:15", "10:30")], overrides: [ov("ov-1", .endWorkModeEarly, "10:20", "11:00")])
        XCTAssertEqual(diff(state("10:19", rows), state("10:20", rows)), ["WORK_MODE_ENDED ON_BREAK>MANAGER_OVERRIDE shift=shift-day override=ov-1"])
        XCTAssertEqual(diff(state("10:29", rows), state("10:30", rows)), ["BREAK_EXPIRED MANAGER_OVERRIDE>MANAGER_OVERRIDE shift=shift-day break=break-1"])
    }

    func testTemporaryExceptionIsRestrictionOnlyAndItsExpiryEmitsOverrideExpired() {
        let rows = Rows(overrides: [ov("ex-1", .temporaryException, "11:00", "11:30")])
        let start = WorkModeEngine.diffStates(from: .snapshot(state("10:59", rows)), to: state("11:00", rows))
        XCTAssertEqual(start, [WorkModeTransition(from: .working, to: .working, at: at("11:00"))])
        XCTAssertEqual(diff(state("11:29", rows), state("11:30", rows)), ["OVERRIDE_EXPIRED WORKING>WORKING shift=shift-day override=ex-1"])
    }

    func testLosingPermissionMidShift() {
        let lost = Rows(permission: .revoked)
        XCTAssertEqual(diff(state("10:00"), state("10:01", lost)), [
            "PERMISSION_NEEDS_ATTENTION WORKING>PERMISSION_ERROR shift=shift-day",
            "WORK_MODE_ENDED WORKING>PERMISSION_ERROR shift=shift-day",
        ])
        XCTAssertEqual(diff(state("10:01", lost), state("10:02")), ["WORK_MODE_STARTED PERMISSION_ERROR>WORKING shift=shift-day"])
        XCTAssertEqual(diff(state("08:30", lost), state("08:50", lost)), ["PERMISSION_NEEDS_ATTENTION OFF_SHIFT>PERMISSION_ERROR shift=shift-day"])
    }

    func testMovingBetweenSeparateIntervalsEndsOneAndStartsTheOther() {
        let rows = Rows(shifts: [
            Shift(id: "a", startsAt: at("09:00"), endsAt: at("12:00"), timezone: "Europe/London"),
            Shift(id: "b", startsAt: at("12:30"), endsAt: at("15:00"), timezone: "Europe/London"),
        ])
        XCTAssertEqual(diff(state("11:00", rows), state("13:00", rows)), [
            "WORK_MODE_ENDED WORKING>WORKING shift=a",
            "WORK_MODE_STARTED WORKING>WORKING shift=b",
        ])
    }

    func testBareImplementationOnlyDerivesStateLevelEvents() {
        let canon = Rows(breaks: [brk("break-1", "10:15", "10:30")])
        XCTAssertEqual(view(WorkModeEngine.diffStates(from: .state(.working), to: state("10:20", canon))),
                       ["BREAK_STARTED WORKING>ON_BREAK shift=shift-day break=break-1"])
        // A bare previous state knows no break, so the ended break (and its shift) cannot be named.
        XCTAssertEqual(view(WorkModeEngine.diffStates(from: .state(.onBreak), to: state("10:30", canon))),
                       ["BREAK_ENDED ON_BREAK>WORKING"])
        XCTAssertEqual(view(WorkModeEngine.diffStates(from: .state(.offShift), to: state("10:00"))),
                       ["WORK_MODE_STARTED OFF_SHIFT>WORKING shift=shift-day"])
        XCTAssertEqual(WorkModeEngine.diffStates(from: .state(.unknown), to: state("08:00")),
                       [WorkModeTransition(from: .unknown, to: .offShift, at: at("08:00"))])
        XCTAssertEqual(WorkModeEngine.diffStates(from: .state(.offShift), to: state("08:00")), [])
    }

    func testReplayWalksEveryExactInstant() {
        let breaks = [brk("break-1", "10:15", "10:30")]
        let replay = engine.replayTransitions(since: at("08:30"), now: at("15:30"), shifts: [shiftDay], breakSessions: breaks, overrides: [], permissionState: .approved)
        XCTAssertEqual(replay.states.map(\.computedAt), [at("08:30"), at("08:45"), at("09:00"), at("10:15"), at("10:30"), at("14:55"), at("15:00"), at("15:30")])
        XCTAssertEqual(replay.transitions.compactMap(\.eventType).map(\.rawValue), ["WORK_MODE_STARTED", "BREAK_STARTED", "BREAK_EXPIRED", "WORK_MODE_ENDED"])
        XCTAssertEqual(replay.transitions.first { $0.eventType == .breakExpired }?.at, at("10:30"), "exact instant, not the observation time")
        // A change exactly at `since` is not repeated; one exactly at `now` is included.
        let edge = engine.replayTransitions(since: at("09:00"), now: at("15:00"), shifts: [shiftDay], breakSessions: [], overrides: [], permissionState: .approved)
        XCTAssertEqual(edge.transitions.compactMap(\.eventType), [.workModeEnded])
        // `previous` surfaces differences between what was persisted and what today's rows say about `since`.
        let withPrevious = engine.replayTransitions(since: at("09:30"), now: at("09:31"), shifts: [shiftDay], breakSessions: [], overrides: [],
                                                    permissionState: .approved, previous: .state(.offShift))
        XCTAssertEqual(withPrevious.transitions.compactMap(\.eventType), [.workModeStarted])
        XCTAssertEqual(withPrevious.transitions.first?.at, at("09:30"))
    }
}
