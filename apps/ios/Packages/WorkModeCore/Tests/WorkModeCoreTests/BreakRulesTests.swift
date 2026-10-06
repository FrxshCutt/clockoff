import XCTest
@testable import WorkModeCore

/// Mirrors the edge cases of `packages/shared/src/breaks/breakRules.test.ts` and the worked examples in
/// docs/BREAK_RULES.md. Shift 09:00–15:00 UTC; default policy: 2 breaks, 15 min each, 30 min total, 60 min gap,
/// 60 min after start.
final class BreakRulesTests: XCTestCase {
    private let shift = ShiftRef(id: "shift-1", startsAt: iso("2026-01-12T09:00:00Z"), endsAt: iso("2026-01-12T15:00:00Z"))

    private func t(_ hms: String) -> Date { iso("2026-01-12T\(hms.count == 5 ? hms + ":00" : hms)Z") }

    private func policy(_ mutate: (inout BreakPolicyRules) -> Void = { _ in }) -> BreakPolicyRules {
        var rules = BreakPolicyRules()
        mutate(&rules)
        return rules
    }

    private func active(_ start: String, minutes: Int, id: String = "b-active") -> BreakSession {
        BreakSession(id: id, clientBreakId: id, shiftId: shift.id, startedAt: t(start), plannedEndsAt: t(start).addingTimeInterval(TimeInterval(minutes * 60)))
    }

    private func ended(_ start: String, minutes: Int, endedAfter: Int? = nil, id: String = "b-ended") -> BreakSession {
        var s = active(start, minutes: minutes, id: id)
        s.status = .ended
        s.endedAt = t(start).addingTimeInterval(TimeInterval((endedAfter ?? minutes) * 60))
        s.endReason = .expired
        return s
    }

    private func attempt(_ now: String, policy: BreakPolicyRules? = nil, sessions: [BreakSession] = [], requested: Int? = nil, trigger: BreakTrigger = .employee) -> CanStartBreakResult {
        BreakRules.canStartBreak(policy: policy ?? self.policy(), shift: shift, existingSessions: sessions, now: t(now), requestedDurationMinutes: requested, trigger: trigger)
    }

    private func refusal(_ result: CanStartBreakResult, _ code: APIErrorCode, file: StaticString = #filePath, line: UInt = #line) -> BreakRefusal? {
        guard let refusal = result.refusal else {
            XCTFail("expected refusal \(code), got approval", file: file, line: line)
            return nil
        }
        XCTAssertEqual(refusal.code, code, file: file, line: line)
        return refusal
    }

    // MARK: Policy gates

    func testDisabledPolicyRefusesEveryTrigger() {
        for trigger in BreakTrigger.allCases {
            let r = refusal(attempt("12:00", policy: policy { $0.breaksEnabled = false }, trigger: trigger), .breaksDisabled)
            XCTAssertEqual(r?.details, .breaksDisabled(reason: .breaksDisabled))
        }
        XCTAssertEqual(refusal(attempt("12:00", policy: policy { $0.maxBreakDurationMinutes = 0 }), .breaksDisabled)?.details, .breaksDisabled(reason: .noBreakDuration))
        // Disabled wins over off-shift, an active break and exhausted limits.
        _ = refusal(attempt("16:00", policy: policy { $0.breaksEnabled = false; $0.maxBreaksPerShift = 0 }, sessions: [active("14:50", minutes: 15)]), .breaksDisabled)
    }

    func testTriggerGates() {
        let noEmployee = policy { $0.employeeTriggeredAllowed = false }
        XCTAssertEqual(refusal(attempt("12:00", policy: noEmployee), .employeeBreaksNotAllowed)?.details, .employeeBreaksNotAllowed)
        XCTAssertTrue(attempt("12:00", policy: noEmployee, trigger: .manager).isOk)
        let noScheduled = policy { $0.scheduledBreaksAllowed = false }
        XCTAssertEqual(refusal(attempt("12:00", policy: noScheduled, trigger: .scheduled), .breaksDisabled)?.details, .breaksDisabled(reason: .scheduledBreaksNotAllowed))
    }

    // MARK: Requested duration

    func testRequestedDuration() throws {
        XCTAssertEqual(try attempt("12:00").get().plannedEndsAt, t("12:15"), "defaults to maxBreakDurationMinutes")
        XCTAssertEqual(try attempt("12:00", requested: 5).get().plannedEndsAt, t("12:05"))
        let tooLong = refusal(attempt("12:00", requested: 16), .breakTooLong)
        XCTAssertEqual(tooLong?.details, .tooLong(requestedDurationMinutes: 16, maxBreakDurationMinutes: 15))
        XCTAssertTrue(attempt("12:00", requested: 15).isOk)
        _ = refusal(attempt("16:00", requested: 99), .breakTooLong) // checked before shift bounds
        XCTAssertEqual(refusal(attempt("12:00", requested: 0), .validationError)?.details, .validation(field: "requestedDurationMinutes", value: "0"))
    }

    // MARK: Shift bounds

    func testShiftBoundsNobodyBypasses() throws {
        XCTAssertEqual(refusal(attempt("08:59", trigger: .manager), .notOnShift)?.details, .notOnShift(reason: .shiftNotStarted, shiftStartsAt: shift.startsAt, shiftEndsAt: shift.endsAt))
        XCTAssertEqual(refusal(attempt("15:00", trigger: .manager), .notOnShift)?.details.reasonCode, "SHIFT_ENDED")
        let lastMinute = try attempt("14:59", trigger: .manager).get()
        XCTAssertEqual(lastMinute.plannedEndsAt, t("15:00"))
        XCTAssertEqual(lastMinute.durationMinutes, 1)
        XCTAssertEqual(refusal(attempt("14:59:01", trigger: .manager), .notOnShift)?.details.reasonCode, "SHIFT_ENDING")
        let clamped = try attempt("14:50", trigger: .manager).get()
        XCTAssertEqual(clamped.plannedEndsAt, t("15:00"))
        XCTAssertEqual(clamped.durationMinutes, 10)
        let ninetySeconds = try attempt("14:58:30", trigger: .manager).get()
        XCTAssertEqual(ninetySeconds.plannedEndsAt, t("15:00"))
        XCTAssertEqual(ninetySeconds.durationMinutes, 2, "90 s rounds up to 2 whole minutes")
        XCTAssertEqual(ninetySeconds.remaining.minutes, 28)
        // Shift bound wins over a stale active row.
        XCTAssertEqual(refusal(attempt("15:01", sessions: [active("14:50", minutes: 15)], trigger: .manager), .notOnShift)?.details.reasonCode, "SHIFT_ENDED")
    }

    // MARK: Active break

    func testActiveBreakBlocksEveryoneUntilItsCap() {
        let session = active("11:00", minutes: 15)
        let r = refusal(attempt("11:05", sessions: [session], trigger: .manager), .breakAlreadyActive)
        XCTAssertEqual(r?.details, .alreadyActive(reason: .breakInProgress, sessionId: session.id, startedAt: t("11:00"), plannedEndsAt: t("11:15")))
        // Expired-but-not-closed row is not active; stops blocking exactly at plannedEndsAt.
        XCTAssertTrue(attempt("12:30", policy: policy { $0.minMinutesAfterShiftStart = 0 }, sessions: [active("10:00", minutes: 15)]).isOk)
        XCTAssertEqual(attempt("11:14:59", sessions: [session]).refusal?.code, .breakAlreadyActive)
        XCTAssertNotEqual(attempt("11:15", sessions: [session]).refusal?.code, .breakAlreadyActive)
        // An ACTIVE row with endedAt is ended.
        var endedEarly = active("11:00", minutes: 15)
        endedEarly.endedAt = t("11:03")
        XCTAssertNotEqual(attempt("11:05", sessions: [endedEarly]).refusal?.code, .breakAlreadyActive)
    }

    func testRevalidatingAPastInstantSeesLaterBreaks() {
        let later = ended("11:05", minutes: 15, id: "later")
        let r = refusal(attempt("11:00", sessions: [later], trigger: .manager), .breakAlreadyActive)
        XCTAssertEqual(r?.details.reasonCode, "LATER_BREAK_RECORDED")
        // Earliest blocking session is reported.
        let first = ended("11:05", minutes: 5, id: "first")
        let second = ended("11:30", minutes: 5, id: "second")
        if case .alreadyActive(_, let sessionId, _, _)? = refusal(attempt("11:00", policy: policy { $0.maxBreaksPerShift = 5 }, sessions: [second, first]), .breakAlreadyActive)?.details {
            XCTAssertEqual(sessionId, "first")
        } else {
            XCTFail("expected alreadyActive details")
        }
    }

    // MARK: Limits

    func testLimits() throws {
        let two = [ended("10:00", minutes: 15, id: "a"), ended("11:15", minutes: 15, id: "b")]
        XCTAssertEqual(refusal(attempt("14:00", sessions: two), .breakLimitReached)?.details.reasonCode, "MAX_BREAKS_PER_SHIFT")
        XCTAssertEqual(refusal(attempt("14:00", sessions: two, trigger: .manager), .breakLimitReached)?.details.reasonCode, "MAX_BREAKS_PER_SHIFT")
        let five = policy { $0.maxBreaksPerShift = 5 }
        XCTAssertEqual(refusal(attempt("14:00", policy: five, sessions: two), .breakLimitReached)?.details.reasonCode, "MAX_TOTAL_BREAK_MINUTES")
        let partial = [ended("10:00", minutes: 15, id: "a"), ended("11:15", minutes: 5, id: "b")]
        let clamped = try attempt("14:00", policy: five, sessions: partial).get()
        XCTAssertEqual(clamped.plannedEndsAt, t("14:10"), "clamped to the remaining total")
        XCTAssertEqual(clamped.remaining, BreakRemaining(breaks: 2, minutes: 0))
        // Sub-minute sessions count a whole minute each.
        let tiny = (0..<3).map { i in ended("10:0\(i)", minutes: 1, endedAfter: 0, id: "tiny\(i)") }
        var tinyRows = tiny
        for i in tinyRows.indices { tinyRows[i].endedAt = tinyRows[i].startedAt.addingTimeInterval(30) }
        let allowance = BreakRules.computeBreakAllowance(policy: five, shift: shift, sessions: tinyRows, now: t("12:00"))
        XCTAssertEqual(allowance.minutesUsed, 3)
        // Limit wins over too-soon (the gap after 11:30 runs to 12:30); maxBreaksPerShift 0 is a limit, not disabled.
        XCTAssertEqual(attempt("12:15", sessions: two).refusal?.code, .breakLimitReached)
        // Re-validating an instant BEFORE recorded breaks is the no-overlap rule, which precedes the limits.
        XCTAssertEqual(attempt("09:30", sessions: two).refusal?.details.reasonCode, "LATER_BREAK_RECORDED")
        XCTAssertEqual(attempt("12:00", policy: policy { $0.maxBreaksPerShift = 0 }).refusal?.code, .breakLimitReached)
        XCTAssertEqual(try attempt("12:00", policy: policy { $0.maxTotalBreakMinutes = 10 }).get().durationMinutes, 10)
    }

    // MARK: Timing

    func testTiming() throws {
        let early = refusal(attempt("09:00"), .breakTooSoon)
        XCTAssertEqual(early?.details, .tooSoon(reason: .minMinutesAfterShiftStart, eligibleAt: t("10:00"), waitMinutes: 60))
        XCTAssertEqual(refusal(attempt("09:59:59.999"), .breakTooSoon)?.details.reasonCode, "MIN_MINUTES_AFTER_SHIFT_START")
        if case .tooSoon(_, _, let wait)? = attempt("09:59:59.999").refusal?.details { XCTAssertEqual(wait, 1, "waitMinutes rounds up") }
        XCTAssertTrue(attempt("10:00").isOk)
        let first = ended("10:00", minutes: 15, id: "a")
        XCTAssertEqual(refusal(attempt("11:00", sessions: [first]), .breakTooSoon)?.details, .tooSoon(reason: .minGapBetweenBreaks, eligibleAt: t("11:15"), waitMinutes: 15))
        XCTAssertTrue(attempt("11:15", sessions: [first]).isOk)
        // Gap measured from the actual end, or from plannedEndsAt for an expired-but-open row.
        XCTAssertTrue(attempt("11:10", sessions: [ended("10:00", minutes: 15, endedAfter: 10, id: "a")]).isOk)
        XCTAssertEqual(attempt("11:14", sessions: [active("10:00", minutes: 15, id: "a")]).refusal?.code, .breakTooSoon)
        XCTAssertTrue(attempt("11:15", sessions: [active("10:00", minutes: 15, id: "a")]).isOk)
        // Late endedAt report is capped at plannedEndsAt.
        var late = ended("10:00", minutes: 15, id: "a")
        late.endedAt = t("10:40")
        XCTAssertEqual(BreakRules.computeBreakAllowance(policy: policy(), shift: shift, sessions: [late], now: t("10:45")).nextEligibleAt, t("11:15"))
        // MANAGER bypasses timing; SCHEDULED does not.
        XCTAssertTrue(attempt("09:00", trigger: .manager).isOk)
        XCTAssertEqual(attempt("09:00", trigger: .scheduled).refusal?.code, .breakTooSoon)
        let backToBack = policy { $0.minGapBetweenBreaksMinutes = 0; $0.minMinutesAfterShiftStart = 0 }
        XCTAssertTrue(attempt("09:15", policy: backToBack, sessions: [ended("09:00", minutes: 15, id: "a")]).isOk)
    }

    // MARK: Robustness and snapshot

    func testScopingAndBehaviourSnapshot() throws {
        var other = ended("10:00", minutes: 15, id: "o")
        other.shiftId = "another-shift"
        XCTAssertTrue(attempt("10:30", sessions: [other]).isOk, "other shifts' sessions are ignored")
        let categories = policy { $0.restrictionBehaviour = .relaxCategories; $0.relaxedCategories = [.games, .socialMedia] }
        XCTAssertEqual(try attempt("12:00", policy: categories).get().behaviour, BreakBehaviourSnapshot(restrictionBehaviour: .relaxCategories, relaxedCategories: [.socialMedia, .games]))
        XCTAssertEqual(try attempt("12:00").get().behaviour, BreakBehaviourSnapshot(restrictionBehaviour: .relaxAll, relaxedCategories: []))
        XCTAssertEqual(BreakRules.resolveBreakBehaviour(policy { $0.restrictionBehaviour = .keepRestrictions; $0.relaxedCategories = [.games] }).relaxedCategories, [])
        for trigger in BreakTrigger.allCases {
            for time in ["00:00", "08:59", "09:00", "10:00", "14:59", "15:00", "23:59"] {
                _ = attempt(time, trigger: trigger) // never traps
            }
        }
    }

    func testClampBreak() {
        XCTAssertEqual(BreakRules.clampBreak(maxBreakDurationMinutes: 15, requestedDurationMinutes: nil, remainingAllowanceMinutes: 30), 15)
        XCTAssertEqual(BreakRules.clampBreak(maxBreakDurationMinutes: 15, requestedDurationMinutes: 10, remainingAllowanceMinutes: 30), 10)
        XCTAssertEqual(BreakRules.clampBreak(maxBreakDurationMinutes: 15, requestedDurationMinutes: 20, remainingAllowanceMinutes: 5), 5)
        XCTAssertEqual(BreakRules.clampBreak(maxBreakDurationMinutes: 15, requestedDurationMinutes: 10, remainingAllowanceMinutes: -3), 0)
    }

    // MARK: Allowance

    func testComputeBreakAllowance() {
        let fresh = BreakRules.computeBreakAllowance(policy: policy(), shift: shift, sessions: [], now: t("09:30"))
        XCTAssertEqual(fresh, BreakAllowance(breaksTaken: 0, breaksRemaining: 2, minutesUsed: 0, minutesRemaining: 30, nextEligibleAt: t("10:00"), canStartNow: false))
        let eligible = BreakRules.computeBreakAllowance(policy: policy(), shift: shift, sessions: [], now: t("10:30"))
        XCTAssertEqual(eligible.nextEligibleAt, t("10:00"))
        XCTAssertTrue(eligible.canStartNow)
        let afterOne = BreakRules.computeBreakAllowance(policy: policy(), shift: shift, sessions: [ended("10:00", minutes: 15, id: "a")], now: t("10:30"))
        XCTAssertEqual(afterOne.breaksRemaining, 1)
        XCTAssertEqual(afterOne.minutesRemaining, 15)
        XCTAssertEqual(afterOne.nextEligibleAt, t("11:15"))
        let running = BreakRules.computeBreakAllowance(policy: policy(), shift: shift, sessions: [active("10:00", minutes: 15, id: "a")], now: t("10:05"))
        XCTAssertEqual(running.minutesUsed, 5, "elapsed so far")
        XCTAssertEqual(running.nextEligibleAt, t("11:15"), "assumes the running break runs to its planned end")
        XCTAssertFalse(running.canStartNow)
        let exhausting = BreakRules.computeBreakAllowance(policy: policy { $0.maxTotalBreakMinutes = 15 }, shift: shift, sessions: [active("10:00", minutes: 15, id: "a")], now: t("10:05"))
        XCTAssertNil(exhausting.nextEligibleAt)
        let lastMinute = BreakRules.computeBreakAllowance(policy: policy(), shift: shift, sessions: [ended("13:50", minutes: 15, id: "a")], now: t("14:10"))
        XCTAssertNil(lastMinute.nextEligibleAt, "the gap lands inside the last minute of the shift")
        let disabled = BreakRules.computeBreakAllowance(policy: policy { $0.breaksEnabled = false }, shift: shift, sessions: [], now: t("12:00"))
        XCTAssertEqual(disabled.breaksRemaining, 0)
        XCTAssertEqual(disabled.minutesRemaining, 0)
        XCTAssertNil(disabled.nextEligibleAt)
        let employeeDisallowed = BreakRules.computeBreakAllowance(policy: policy { $0.employeeTriggeredAllowed = false }, shift: shift, sessions: [], now: t("12:00"))
        XCTAssertEqual(employeeDisallowed.breaksRemaining, 2, "the allowance still exists for scheduled and manager breaks")
        XCTAssertNil(employeeDisallowed.nextEligibleAt)
        let manager = BreakRules.computeBreakAllowance(policy: policy(), shift: shift, sessions: [active("10:00", minutes: 15, id: "a")], now: t("10:05"), trigger: .manager)
        XCTAssertEqual(manager.nextEligibleAt, t("10:15"), "MANAGER ignores timing but never overlaps a running break")
        XCTAssertNil(BreakRules.computeBreakAllowance(policy: policy(), shift: shift, sessions: [], now: t("15:30")).nextEligibleAt)
    }

    func testCanStartNowAgreesWithNextEligibleAtAcrossTheShift() {
        let sessions = [ended("10:00", minutes: 15, id: "a")]
        var instant = t("08:00")
        while instant <= t("16:00") {
            let allowance = BreakRules.computeBreakAllowance(policy: policy(), shift: shift, sessions: sessions, now: instant)
            let expected = allowance.nextEligibleAt.map { $0 <= instant } ?? false
            XCTAssertEqual(allowance.canStartNow, expected, WorkModeDateCoding.format(instant))
            instant = instant.addingTimeInterval(60)
        }
    }

    // MARK: Closures

    func testExpiredBreakSessionClosures() {
        let openExpired = active("10:00", minutes: 15, id: "a")
        let running = active("12:00", minutes: 15, id: "b")
        var alreadyEnded = active("11:00", minutes: 15, id: "c")
        alreadyEnded.endedAt = t("11:10")
        var otherShift = active("10:00", minutes: 15, id: "d")
        otherShift.shiftId = "elsewhere"
        let closures = BreakRules.expiredBreakSessionClosures(shift: shift, sessions: [running, alreadyEnded, openExpired, otherShift], now: t("12:05"))
        XCTAssertEqual(closures, [BreakSessionClosure(sessionId: "a", endedAt: t("10:15"), endReason: .expired)])
        // Boundary is inclusive; a break cut short by a shortened shift closes at the shift end with SHIFT_ENDED.
        XCTAssertEqual(BreakRules.expiredBreakSessionClosures(shift: shift, sessions: [openExpired], now: t("10:15")).count, 1)
        XCTAssertEqual(BreakRules.expiredBreakSessionClosures(shift: shift, sessions: [openExpired], now: t("10:14:59")).count, 0)
        let shortened = ShiftRef(id: shift.id, startsAt: shift.startsAt, endsAt: t("10:10"))
        XCTAssertEqual(BreakRules.expiredBreakSessionClosures(shift: shortened, sessions: [openExpired], now: t("10:20")),
                       [BreakSessionClosure(sessionId: "a", endedAt: t("10:10"), endReason: .shiftEnded)])
    }

    // MARK: Restriction behaviour

    func testBreakRestrictionMapping() {
        XCTAssertEqual(BreakRules.breakRestriction(restrictionBehaviour: .relaxAll, relaxedCategories: []),
                       BreakRestriction(restrictionBehaviour: .relaxAll, relaxedCategories: [], effectiveRestriction: .breakRelaxed, restrictionsShouldBeActive: false, liftedCategories: RestrictionCategory.allCases))
        XCTAssertEqual(BreakRules.breakRestriction(restrictionBehaviour: .keepRestrictions, relaxedCategories: [.games]).effectiveRestriction, .work)
        let some = BreakRules.breakRestriction(restrictionBehaviour: .relaxCategories, relaxedCategories: [.games, .socialMedia])
        XCTAssertEqual(some.effectiveRestriction, .breakRelaxed)
        XCTAssertTrue(some.restrictionsShouldBeActive)
        XCTAssertEqual(some.liftedCategories, [.socialMedia, .games])
        XCTAssertFalse(BreakRules.breakRestriction(restrictionBehaviour: .relaxCategories, relaxedCategories: RestrictionCategory.allCases).restrictionsShouldBeActive)
        XCTAssertEqual(BreakRules.breakRestriction(restrictionBehaviour: .relaxCategories, relaxedCategories: []).effectiveRestriction, .work)
        XCTAssertTrue(BreakRules.isCategoryRelaxedDuringBreak(BreakBehaviourSnapshot(restrictionBehaviour: .relaxAll), .dating))
        XCTAssertFalse(BreakRules.isCategoryRelaxedDuringBreak(BreakBehaviourSnapshot(restrictionBehaviour: .relaxCategories, relaxedCategories: [.games]), .dating))
        XCTAssertTrue(BreakRules.isBelowDeviceActivityInterval(durationMinutes: 14))
        XCTAssertFalse(BreakRules.isBelowDeviceActivityInterval(durationMinutes: 15))
        XCTAssertTrue(BreakRules.clockSkewNeedsAttention(301))
        XCTAssertFalse(BreakRules.clockSkewNeedsAttention(-300))
        XCTAssertFalse(BreakRules.clockSkewNeedsAttention(nil))
    }

    func testParityWithTheStateMachine() {
        // The ON_BREAK output of the engine and breakRestrictionForSession never disagree.
        let shiftRow = Shift(id: shift.id, startsAt: shift.startsAt, endsAt: shift.endsAt, timezone: "UTC")
        for behaviour in BreakRestrictionBehaviour.allCases {
            for categories in [[RestrictionCategory](), [.games], RestrictionCategory.allCases] {
                let session = BreakSession(id: "b", clientBreakId: "b", shiftId: shift.id, startedAt: t("11:00"), plannedEndsAt: t("11:15"),
                                           restrictionBehaviour: behaviour, relaxedCategories: categories)
                let expected = WorkModeEngine().computeExpectedState(now: t("11:05"), shifts: [shiftRow], breakSessions: [session], overrides: [], permissionState: .approved)
                let restriction = BreakRules.breakRestrictionForSession(session)
                XCTAssertEqual(expected.effectiveRestriction, restriction.effectiveRestriction, "\(behaviour) \(categories)")
                XCTAssertEqual(expected.restrictionsShouldBeActive, restriction.restrictionsShouldBeActive, "\(behaviour) \(categories)")
                XCTAssertEqual(expected.relaxation?.liftedCategories ?? [], restriction.liftedCategories, "\(behaviour) \(categories)")
            }
        }
    }
}
