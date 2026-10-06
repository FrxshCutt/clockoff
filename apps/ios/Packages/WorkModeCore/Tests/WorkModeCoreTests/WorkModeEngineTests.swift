import XCTest
@testable import WorkModeCore

/// Behavioural tests of the §6.2 rules. Written as small named cases so the fixture-driven port
/// (docs/fixtures/workmode-cases.json, a later stage) can be added alongside without rewriting these.
final class WorkModeEngineTests: XCTestCase {
    private let engine = WorkModeEngine(options: WorkModeEngineOptions(preShiftWarningMinutes: 15, shiftEndingWarningMinutes: 5), timezone: "Europe/London")
    private let shift = Fixture.shift("s1", "2026-10-06T08:00:00Z", "2026-10-06T16:00:00Z")

    private func state(
        at now: String,
        shifts: [Shift]? = nil,
        breaks: [BreakSession] = [],
        overrides: [ActiveOverride] = [],
        permission: PermissionState = .approved
    ) -> ExpectedState {
        engine.computeExpectedState(now: iso(now), shifts: shifts ?? [shift], breakSessions: breaks, overrides: overrides, permissionState: permission)
    }

    private func breakSession(_ id: String = "b1", shiftId: String = "s1", start: String, end: String, endedAt: String? = nil,
                              status: BreakSessionStatus = .active, behaviour: BreakRestrictionBehaviour = .relaxAll,
                              categories: [RestrictionCategory] = []) -> BreakSession {
        BreakSession(id: id, clientBreakId: "c-\(id)", shiftId: shiftId, startedAt: iso(start), plannedEndsAt: iso(end),
                     endedAt: endedAt.map { iso($0) }, status: status, restrictionBehaviour: behaviour, relaxedCategories: categories)
    }

    // MARK: Schedule-derived states

    func testOffShiftWithNoShiftsHasNoTransition() {
        let s = state(at: "2026-10-06T09:00:00Z", shifts: [])
        XCTAssertEqual(s.state, .offShift)
        XCTAssertEqual(s.effectiveRestriction, .none)
        XCTAssertFalse(s.restrictionsShouldBeActive)
        XCTAssertNil(s.nextTransitionAt)
        XCTAssertEqual(s.timezone, "Europe/London")
    }

    func testOffShiftBeforeWarningReportsUpcomingAndNextTransition() {
        let s = state(at: "2026-10-06T07:00:00Z")
        XCTAssertEqual(s.state, .offShift)
        XCTAssertEqual(s.upcomingShift?.id, "s1")
        XCTAssertNil(s.workingInterval)
        XCTAssertEqual(s.nextTransitionAt, iso("2026-10-06T07:45:00Z"))
    }

    func testShiftStartingSoonInsideWarningWindow() {
        let s = state(at: "2026-10-06T07:45:00Z")
        XCTAssertEqual(s.state, .shiftStartingSoon)
        XCTAssertEqual(s.effectiveRestriction, .none)
        XCTAssertNil(s.activeShift)
        XCTAssertEqual(s.workingInterval?.shiftIds, ["s1"])
        XCTAssertEqual(s.nextTransitionAt, iso("2026-10-06T08:00:00Z"))
    }

    func testWorkingAtStartInclusive() {
        let s = state(at: "2026-10-06T08:00:00Z")
        XCTAssertEqual(s.state, .working)
        XCTAssertEqual(s.effectiveRestriction, .work)
        XCTAssertTrue(s.restrictionsShouldBeActive)
        XCTAssertEqual(s.activeShift?.id, "s1")
        XCTAssertEqual(s.nextTransitionAt, iso("2026-10-06T15:55:00Z"))
    }

    func testShiftEndingThenOffShiftAtEndExclusive() {
        let ending = state(at: "2026-10-06T15:57:00Z")
        XCTAssertEqual(ending.state, .shiftEnding)
        XCTAssertEqual(ending.effectiveRestriction, .work)
        XCTAssertEqual(ending.nextTransitionAt, iso("2026-10-06T16:00:00Z"))
        XCTAssertEqual(state(at: "2026-10-06T16:00:00Z").state, .offShift)
    }

    func testCancelledAndZeroLengthShiftsAreIgnored() {
        let shifts = [
            Fixture.shift("c", "2026-10-06T08:00:00Z", "2026-10-06T16:00:00Z", status: .cancelled),
            Fixture.shift("z", "2026-10-06T08:00:00Z", "2026-10-06T08:00:00Z"),
            Fixture.shift("done", "2026-10-06T08:00:00Z", "2026-10-06T16:00:00Z", status: .completed),
        ]
        XCTAssertEqual(state(at: "2026-10-06T09:00:00Z", shifts: shifts).state, .offShift)
    }

    func testBackToBackShiftsMergeWithoutFlapping() {
        let shifts = [
            Fixture.shift("a", "2026-10-06T08:00:00Z", "2026-10-06T12:00:00Z"),
            Fixture.shift("b", "2026-10-06T12:00:00Z", "2026-10-06T16:00:00Z"),
        ]
        let intervals = WorkModeEngine.mergeShiftIntervals(shifts)
        XCTAssertEqual(intervals.count, 1)
        XCTAssertEqual(intervals.first?.shiftIds, ["a", "b"])
        let morning = state(at: "2026-10-06T11:58:00Z", shifts: shifts)
        XCTAssertEqual(morning.state, .working, "no SHIFT_ENDING at the seam")
        XCTAssertEqual(morning.nextTransitionAt, iso("2026-10-06T15:55:00Z"), "the seam is not a transition")
        XCTAssertEqual(state(at: "2026-10-06T12:00:00Z", shifts: shifts).activeShift?.id, "b")
    }

    func testBreakEndsAtItsOwnShiftEndInsideAMergedInterval() {
        let shifts = [
            Fixture.shift("a", "2026-10-06T08:00:00Z", "2026-10-06T12:00:00Z"),
            Fixture.shift("b", "2026-10-06T12:00:00Z", "2026-10-06T16:00:00Z"),
        ]
        let seamBreak = breakSession(shiftId: "a", start: "2026-10-06T11:50:00Z", end: "2026-10-06T12:05:00Z")
        let before = state(at: "2026-10-06T11:59:00Z", shifts: shifts, breaks: [seamBreak])
        XCTAssertEqual(before.state, .onBreak)
        XCTAssertEqual(before.activeBreak?.endsAt, iso("2026-10-06T12:00:00Z"))
        XCTAssertEqual(before.nextTransitionAt, iso("2026-10-06T12:00:00Z"), "only the relaxation ends at the seam")
        let after = state(at: "2026-10-06T12:02:00Z", shifts: shifts, breaks: [seamBreak])
        XCTAssertEqual(after.state, .working, "Work Mode never stopped; the next shift is enforced")
        XCTAssertEqual(after.activeShift?.id, "b")
        XCTAssertNil(after.activeBreak)
    }

    func testOvernightShift() {
        let night = Fixture.shift("n", "2026-10-06T21:00:00Z", "2026-10-07T05:00:00Z")
        XCTAssertEqual(state(at: "2026-10-07T02:00:00Z", shifts: [night]).state, .working)
        XCTAssertEqual(state(at: "2026-10-07T04:56:00Z", shifts: [night]).state, .shiftEnding)
    }

    // MARK: Breaks

    func testRelaxAllBreak() {
        let s = state(at: "2026-10-06T11:05:00Z", breaks: [breakSession(start: "2026-10-06T11:00:00Z", end: "2026-10-06T11:15:00Z")])
        XCTAssertEqual(s.state, .onBreak)
        XCTAssertEqual(s.effectiveRestriction, .breakRelaxed)
        XCTAssertFalse(s.restrictionsShouldBeActive)
        XCTAssertEqual(s.relaxation?.source, .breakSession)
        XCTAssertEqual(s.relaxation?.liftedCategories, RestrictionCategory.allCases)
        XCTAssertEqual(s.activeBreak?.endsAt, iso("2026-10-06T11:15:00Z"))
        XCTAssertEqual(s.nextTransitionAt, iso("2026-10-06T11:15:00Z"))
    }

    func testRelaxCategoriesBreakKeepsOthersEnforced() {
        let s = state(at: "2026-10-06T11:05:00Z", breaks: [breakSession(start: "2026-10-06T11:00:00Z", end: "2026-10-06T11:15:00Z",
                                                                         behaviour: .relaxCategories, categories: [.games, .socialMedia])])
        XCTAssertEqual(s.state, .onBreak)
        XCTAssertEqual(s.effectiveRestriction, .breakRelaxed)
        XCTAssertTrue(s.restrictionsShouldBeActive)
        XCTAssertEqual(s.relaxation?.liftedCategories, [.socialMedia, .games])
    }

    func testKeepRestrictionsAndEmptyRelaxCategoriesBreaksStayAtWork() {
        let keep = state(at: "2026-10-06T11:05:00Z", breaks: [breakSession(start: "2026-10-06T11:00:00Z", end: "2026-10-06T11:15:00Z", behaviour: .keepRestrictions)])
        XCTAssertEqual(keep.state, .onBreak)
        XCTAssertEqual(keep.effectiveRestriction, .work)
        XCTAssertNil(keep.relaxation)
        let empty = state(at: "2026-10-06T11:05:00Z", breaks: [breakSession(start: "2026-10-06T11:00:00Z", end: "2026-10-06T11:15:00Z", behaviour: .relaxCategories)])
        XCTAssertEqual(empty.effectiveRestriction, .work)
    }

    func testExpiredEndedAndForeignBreaksDoNotApply() {
        XCTAssertEqual(state(at: "2026-10-06T11:20:00Z", breaks: [breakSession(start: "2026-10-06T11:00:00Z", end: "2026-10-06T11:15:00Z")]).state, .working)
        XCTAssertEqual(state(at: "2026-10-06T11:05:00Z", breaks: [breakSession(start: "2026-10-06T11:00:00Z", end: "2026-10-06T11:15:00Z", status: .ended)]).state, .working)
        XCTAssertEqual(state(at: "2026-10-06T11:05:00Z", breaks: [breakSession(start: "2026-10-06T11:00:00Z", end: "2026-10-06T11:15:00Z", endedAt: "2026-10-06T11:03:00Z")]).state, .working)
        XCTAssertEqual(state(at: "2026-10-06T11:05:00Z", breaks: [breakSession(shiftId: "other", start: "2026-10-06T11:00:00Z", end: "2026-10-06T11:15:00Z")]).state, .working)
    }

    func testEndedBreakCountsUpToItsEndedAtWhenReplayed() {
        let ended = breakSession(start: "2026-10-06T11:00:00Z", end: "2026-10-06T11:15:00Z", endedAt: "2026-10-06T11:10:00Z", status: .ended)
        let during = state(at: "2026-10-06T11:05:00Z", breaks: [ended])
        XCTAssertEqual(during.state, .onBreak)
        XCTAssertEqual(during.activeBreak?.endsAt, iso("2026-10-06T11:10:00Z"))
        XCTAssertEqual(during.nextTransitionAt, iso("2026-10-06T11:10:00Z"))
        XCTAssertEqual(state(at: "2026-10-06T11:10:00Z", breaks: [ended]).state, .working, "end-exclusive")
    }

    func testOverlappingBreaksPreferTheMostRecentlyStarted() {
        let s = state(at: "2026-10-06T11:07:00Z", breaks: [
            breakSession("early", start: "2026-10-06T11:00:00Z", end: "2026-10-06T11:15:00Z", behaviour: .keepRestrictions),
            breakSession("late", start: "2026-10-06T11:05:00Z", end: "2026-10-06T11:20:00Z", behaviour: .relaxAll),
        ])
        XCTAssertEqual(s.activeBreak?.id, "late")
        XCTAssertEqual(s.effectiveRestriction, .breakRelaxed)
    }

    func testBreakIsCutAtIntervalEnd() {
        let s = state(at: "2026-10-06T15:58:00Z", breaks: [breakSession(start: "2026-10-06T15:50:00Z", end: "2026-10-06T16:05:00Z")])
        XCTAssertEqual(s.state, .onBreak)
        XCTAssertEqual(s.activeBreak?.endsAt, iso("2026-10-06T16:00:00Z"))
        XCTAssertEqual(state(at: "2026-10-06T16:01:00Z", breaks: [breakSession(start: "2026-10-06T15:50:00Z", end: "2026-10-06T16:05:00Z")]).state, .offShift)
    }

    // MARK: Overrides

    func testLiftingOverrideDuringShift() {
        let override = ActiveOverride(id: "o1", type: .endWorkModeEarly, startsAt: iso("2026-10-06T14:00:00Z"), expiresAt: iso("2026-10-06T18:00:00Z"))
        let s = state(at: "2026-10-06T14:30:00Z", overrides: [override])
        XCTAssertEqual(s.state, .managerOverride)
        XCTAssertEqual(s.effectiveRestriction, .none)
        XCTAssertFalse(s.restrictionsShouldBeActive)
        XCTAssertEqual(s.activeOverride?.id, "o1")
        XCTAssertEqual(s.nextTransitionAt, iso("2026-10-06T16:00:00Z"))
    }

    func testOverrideIsMootOffShift() {
        let override = ActiveOverride(id: "o1", type: .emergencyPolicyOverride, startsAt: iso("2026-10-06T00:00:00Z"), expiresAt: iso("2026-10-07T00:00:00Z"))
        let s = state(at: "2026-10-06T19:00:00Z", overrides: [override])
        XCTAssertEqual(s.state, .offShift)
        XCTAssertNil(s.activeOverride)
    }

    func testHighestRankingLiftingOverrideWins() {
        let exempt = ActiveOverride(id: "a", type: .exemptTemporarily, startsAt: iso("2026-10-06T09:00:00Z"), expiresAt: iso("2026-10-06T12:00:00Z"))
        let emergency = ActiveOverride(id: "z", type: .emergencyPolicyOverride, startsAt: iso("2026-10-06T10:00:00Z"), expiresAt: iso("2026-10-06T11:00:00Z"))
        XCTAssertEqual(state(at: "2026-10-06T10:30:00Z", overrides: [exempt, emergency]).activeOverride?.id, "z")
    }

    func testTemporaryExceptionRelaxesButKeepsWorkingState() {
        let exception = ActiveOverride(id: "t", type: .temporaryException, startsAt: iso("2026-10-06T12:00:00Z"), expiresAt: iso("2026-10-06T12:30:00Z"),
                                       breakBehaviour: BreakBehaviourSnapshot(restrictionBehaviour: .relaxCategories, relaxedCategories: [.streaming]))
        let s = state(at: "2026-10-06T12:10:00Z", overrides: [exception])
        XCTAssertEqual(s.state, .working)
        XCTAssertEqual(s.effectiveRestriction, .breakRelaxed)
        XCTAssertEqual(s.relaxation?.source, .override)
        XCTAssertEqual(s.relaxation?.liftedCategories, [.streaming])
        XCTAssertEqual(s.activeOverride?.id, "t")
        XCTAssertEqual(s.nextTransitionAt, iso("2026-10-06T12:30:00Z"))

        let keep = ActiveOverride(id: "k", type: .temporaryException, startsAt: iso("2026-10-06T12:00:00Z"), expiresAt: iso("2026-10-06T12:30:00Z"),
                                  breakBehaviour: BreakBehaviourSnapshot(restrictionBehaviour: .keepRestrictions))
        let unchanged = state(at: "2026-10-06T12:10:00Z", overrides: [keep])
        XCTAssertEqual(unchanged.effectiveRestriction, .work)
        XCTAssertNil(unchanged.activeOverride, "an exception that changes nothing is not reported")
    }

    func testNonRelaxingExceptionDoesNotMaskOneThatRelaxes() {
        let keep = ActiveOverride(id: "k", type: .temporaryException, startsAt: iso("2026-10-06T10:00:00Z"), expiresAt: iso("2026-10-06T12:00:00Z"),
                                  breakBehaviour: BreakBehaviourSnapshot(restrictionBehaviour: .keepRestrictions))
        let games = ActiveOverride(id: "g", type: .temporaryException, startsAt: iso("2026-10-06T11:00:00Z"), expiresAt: iso("2026-10-06T11:30:00Z"),
                                   breakBehaviour: BreakBehaviourSnapshot(restrictionBehaviour: .relaxCategories, relaxedCategories: [.games]))
        let s = state(at: "2026-10-06T11:10:00Z", overrides: [keep, games])
        XCTAssertEqual(s.state, .working)
        XCTAssertEqual(s.activeOverride?.id, "g")
        XCTAssertEqual(s.relaxation?.liftedCategories, [.games])
        XCTAssertTrue(s.restrictionsShouldBeActive)
        XCTAssertEqual(s.nextTransitionAt, iso("2026-10-06T11:30:00Z"))
    }

    func testRunningBreakTakesPrecedenceOverTemporaryException() {
        let exception = ActiveOverride(id: "t", type: .temporaryException, startsAt: iso("2026-10-06T11:00:00Z"), expiresAt: iso("2026-10-06T12:00:00Z"))
        let s = state(at: "2026-10-06T11:05:00Z",
                      breaks: [breakSession(start: "2026-10-06T11:00:00Z", end: "2026-10-06T11:15:00Z", behaviour: .keepRestrictions)],
                      overrides: [exception])
        XCTAssertEqual(s.state, .onBreak)
        XCTAssertNil(s.activeOverride)
        XCTAssertEqual(s.effectiveRestriction, .work)
    }

    // MARK: Permission

    func testPermissionErrorWhileShiftActiveOrImminentKeepsIntendedRestriction() {
        let working = state(at: "2026-10-06T09:00:00Z", permission: .denied)
        XCTAssertEqual(working.state, .permissionError)
        XCTAssertEqual(working.effectiveRestriction, .work, "intended restriction still reported")
        XCTAssertEqual(working.permissionState, .denied)
        XCTAssertEqual(state(at: "2026-10-06T07:50:00Z", permission: .revoked).state, .permissionError)
        XCTAssertEqual(state(at: "2026-10-06T07:00:00Z", permission: .notDetermined).state, .offShift, "moot off shift")
    }

    func testOptionsComeFromPolicy() throws {
        let options = WorkModeEngineOptions.forPolicy(try Fixture.policy())
        XCTAssertEqual(options.preShiftWarningMinutes, 10)
        XCTAssertEqual(WorkModeEngineOptions.forPolicy(nil).preShiftWarningMinutes, 15)
        let custom = WorkModeEngine(options: options)
        let s = custom.computeExpectedState(now: iso("2026-10-06T07:48:00Z"), shifts: [shift], breakSessions: [], overrides: [], permissionState: .approved)
        XCTAssertEqual(s.state, .offShift, "10-minute warning starts at 07:50")
    }
}
