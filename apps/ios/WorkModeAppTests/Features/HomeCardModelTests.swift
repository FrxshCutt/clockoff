import XCTest
@testable import WorkModeApp
import WorkModeCore

/// The Home card for every `WorkModeController` state (pure mapping, no provider or network).
final class HomeCardModelTests: XCTestCase {
    private let london = TimeZone(identifier: "Europe/London")!
    private let now = iso("2026-10-06T10:00:00Z")
    private var time: TimeFormatting { TimeFormatting(timeZone: london, now: now) }
    private let shiftRef = ShiftRef(id: Fixtures.shift.id, startsAt: Fixtures.shift.startsAt, endsAt: Fixtures.shift.endsAt)

    private func cache(breakPolicy: BreakPolicy? = Fixtures.breakPolicy, policy: PolicySummary? = Fixtures.policy) -> CachedState {
        CachedState(organisation: Fixtures.organisation, employee: Fixtures.employee, policy: policy, breakPolicy: breakPolicy,
                    shifts: [Fixtures.shift], lastSyncAt: iso("2026-10-06T09:55:00Z"))
    }

    private func allowance(canStart: Bool, remaining: Int = 2, minutes: Int = 30, next: Date? = nil) -> BreakAllowance {
        BreakAllowance(breaksTaken: 2 - remaining, breaksRemaining: remaining, minutesUsed: 30 - minutes, minutesRemaining: minutes,
                       nextEligibleAt: next, canStartNow: canStart)
    }

    private func card(_ state: UIWorkState, cache: CachedState? = nil, at instant: Date? = nil) -> HomeCardModel {
        HomeCardModel.make(state: state, cache: cache ?? self.cache(), now: instant ?? now, timeZone: london)
    }

    func testOffShiftShowsTheNextShift() {
        let next = ShiftRef(id: "n", startsAt: iso("2026-10-07T08:00:00Z"), endsAt: iso("2026-10-07T14:00:00Z"))
        let model = card(.offShift(nextShift: next))
        XCTAssertEqual(model.kind, .offShift)
        XCTAssertEqual(model.title, "OFF SHIFT")
        XCTAssertEqual(model.headline, "Next shift tomorrow \(time.range(next.startsAt, next.endsAt)) · Work Mode inactive")
        XCTAssertNil(model.action)
        XCTAssertNil(model.countdownTo)

        let none = card(.offShift(nextShift: nil))
        XCTAssertEqual(none.headline, "No upcoming shifts · Work Mode inactive")
    }

    func testStartingSoonCountsDownToTheShift() {
        let at = iso("2026-10-06T07:50:00Z")
        let model = card(.startingSoon(shift: shiftRef), at: at)
        XCTAssertEqual(model.kind, .startingSoon)
        XCTAssertEqual(model.title, "STARTING SOON")
        XCTAssertEqual(model.countdownTo, Fixtures.shift.startsAt)
        XCTAssertEqual(model.countdownLabel, "Work Mode starts in")
        XCTAssertEqual(HomeCardModel.countdown(to: Fixtures.shift.startsAt, from: at), "10:00")
    }

    func testWorkingOffersStartBreakWhenThePolicyAndAllowanceAllow() {
        let model = card(.working(shift: shiftRef, endsAt: shiftRef.endsAt, allowance: allowance(canStart: true), relaxedByManager: false))
        XCTAssertEqual(model.kind, .working)
        XCTAssertEqual(model.title, "WORK MODE ACTIVE")
        XCTAssertEqual(model.headline, "Distracting apps are blocked until \(time.clock(shiftRef.endsAt)).")
        XCTAssertEqual(model.details, [
            "Shift \(time.range(shiftRef.startsAt, shiftRef.endsAt))",
            "Restricted: Social Media, Games",
            "Breaks: 2 of 2 left · 30 min remaining",
        ])
        XCTAssertEqual(model.action, .startBreak)
        XCTAssertEqual(model.actionTitle, "Start Break")
        XCTAssertNil(model.note)
    }

    func testWorkingShowsTheManagerRelaxation() {
        let model = card(.working(shift: shiftRef, endsAt: shiftRef.endsAt, allowance: nil, relaxedByManager: true))
        XCTAssertTrue(model.details.contains("Your manager has temporarily allowed some apps."))
    }

    func testWorkingExplainsWhyABreakCannotStart() {
        let next = iso("2026-10-06T11:15:00Z")
        let tooSoon = card(.working(shift: shiftRef, endsAt: shiftRef.endsAt, allowance: allowance(canStart: false, next: next), relaxedByManager: false))
        XCTAssertNil(tooSoon.action)
        XCTAssertEqual(tooSoon.note, "Next break available at \(time.clock(next)).")

        let exhausted = card(.working(shift: shiftRef, endsAt: shiftRef.endsAt, allowance: allowance(canStart: false, remaining: 0), relaxedByManager: false))
        XCTAssertEqual(exhausted.note, "No breaks left this shift.")

        let noMinutes = card(.working(shift: shiftRef, endsAt: shiftRef.endsAt, allowance: allowance(canStart: false, remaining: 1, minutes: 0), relaxedByManager: false))
        XCTAssertEqual(noMinutes.note, "No break minutes left this shift.")

        let managerOnly = BreakPolicy(id: "m", name: "Manager", rules: BreakPolicyRules(employeeTriggeredAllowed: false))
        let notAllowed = card(.working(shift: shiftRef, endsAt: shiftRef.endsAt, allowance: allowance(canStart: true), relaxedByManager: false),
                              cache: cache(breakPolicy: managerOnly))
        XCTAssertNil(notAllowed.action, "the allowance may say yes, the policy says employees cannot start breaks")
        XCTAssertEqual(notAllowed.note, "Only scheduled or manager breaks are allowed at your workplace.")

        let disabled = BreakPolicy(id: "d", name: "None", rules: BreakPolicyRules(breaksEnabled: false))
        let noBreaks = card(.working(shift: shiftRef, endsAt: shiftRef.endsAt, allowance: allowance(canStart: true), relaxedByManager: false),
                            cache: cache(breakPolicy: disabled))
        XCTAssertEqual(noBreaks.note, "Breaks aren't available in Work Mode at your workplace.")
        XCTAssertFalse(noBreaks.details.contains { $0.hasPrefix("Breaks:") })

        let unsynced = card(.working(shift: shiftRef, endsAt: shiftRef.endsAt, allowance: nil, relaxedByManager: false))
        XCTAssertEqual(unsynced.note, "Break allowance not available yet — pull down to sync.")
    }

    func testOnBreakCountsDownAndOffersEndEarly() {
        let session = BreakSession(id: "b", clientBreakId: "c", shiftId: shiftRef.id, startedAt: iso("2026-10-06T10:00:00Z"),
                                   plannedEndsAt: iso("2026-10-06T10:15:00Z"), restrictionBehaviour: .relaxAll)
        let model = card(.onBreak(session: session, endsAt: session.plannedEndsAt, remaining: 15 * 60))
        XCTAssertEqual(model.kind, .onBreak)
        XCTAssertEqual(model.title, "BREAK ACTIVE")
        XCTAssertEqual(model.countdownTo, session.plannedEndsAt)
        XCTAssertEqual(model.countdownLabel, "Break ends in")
        XCTAssertEqual(model.details, ["Relaxed: all apps are allowed during this break."])
        XCTAssertEqual(model.action, .endBreak)
        XCTAssertEqual(model.actionTitle, "End Break Early")
        XCTAssertEqual(HomeCardModel.countdown(to: session.plannedEndsAt, from: iso("2026-10-06T10:04:30Z")), "10:30")

        let short = BreakSession(id: "s", clientBreakId: "s", shiftId: shiftRef.id, startedAt: iso("2026-10-06T10:00:00Z"),
                                 plannedEndsAt: iso("2026-10-06T10:10:00Z"), restrictionBehaviour: .relaxCategories, relaxedCategories: [.socialMedia])
        let shortCard = card(.onBreak(session: short, endsAt: short.plannedEndsAt, remaining: 600))
        XCTAssertEqual(shortCard.details, ["Relaxed: Social Media", "Keep the app open to end your break exactly on time."])

        let kept = BreakSession(id: "k", clientBreakId: "k", shiftId: shiftRef.id, startedAt: iso("2026-10-06T10:00:00Z"),
                                plannedEndsAt: iso("2026-10-06T10:15:00Z"), restrictionBehaviour: .keepRestrictions)
        XCTAssertEqual(card(.onBreak(session: kept, endsAt: kept.plannedEndsAt, remaining: 900)).details, ["Apps stay blocked during this break."])
    }

    func testPausedByManager() {
        let override = OverrideRef(id: "ov", type: .exemptTemporarily, startsAt: iso("2026-10-06T09:00:00Z"), expiresAt: iso("2026-10-06T10:30:00Z"))
        let model = card(.pausedByManager(override: override, resumesAt: override.expiresAt))
        XCTAssertEqual(model.kind, .pausedByManager)
        XCTAssertEqual(model.title, "WORK MODE PAUSED")
        XCTAssertEqual(model.details, ["Apps are not blocked right now. Resumes at \(time.clock(override.expiresAt))."])
        XCTAssertNil(model.action)
    }

    func testActionRequiredMapsToSetupOrRepair() {
        let revoked = card(.actionRequired(.screenTimeNotAllowed(.revoked)))
        XCTAssertEqual(revoked.kind, .actionRequired)
        XCTAssertEqual(revoked.title, "ACTION REQUIRED")
        XCTAssertEqual(revoked.action, .openSetup)
        XCTAssertEqual(revoked.actionTitle, "Open Setup")
        XCTAssertEqual(revoked.headline, UIWorkState.ActionRequiredReason.screenTimeNotAllowed(.revoked).message)

        XCTAssertEqual(card(.actionRequired(.appsNotChosen)).action, .openSetup)
        let failed = card(.actionRequired(.enforcementFailed))
        XCTAssertEqual(failed.action, .repair)
        XCTAssertEqual(failed.actionTitle, "Try again")
    }

    func testSyncDelayedAndUnknown() {
        let delayed = card(.syncDelayed(lastSyncAt: nil))
        XCTAssertEqual(delayed.kind, .syncDelayed)
        XCTAssertEqual(delayed.title, "SYNC DELAYED")
        XCTAssertEqual(delayed.headline, "This phone hasn't synced yet.")
        XCTAssertNil(delayed.action)

        let unknown = card(.unknown)
        XCTAssertEqual(unknown.kind, .unknown)
        XCTAssertNil(unknown.action)
    }

    func testCountdownFormatting() {
        let base = iso("2026-10-06T10:00:00Z")
        XCTAssertEqual(HomeCardModel.countdown(to: base.addingTimeInterval(3661), from: base), "1:01:01")
        XCTAssertEqual(HomeCardModel.countdown(to: base.addingTimeInterval(59), from: base), "00:59")
        XCTAssertEqual(HomeCardModel.countdown(to: base.addingTimeInterval(-5), from: base), "00:00")
    }

    func testRepairPromptOnlyWhenShieldsShouldBeUpButCannotBeProven() {
        let expected = ExpectedState(state: .working, effectiveRestriction: .work, restrictionsShouldBeActive: true, computedAt: now, permissionState: .approved)
        XCTAssertEqual(HomeRepairPrompt.make(outcome: .init(expected: expected, appliedState: .unknown, note: "x"))?.message, HomeRepairPrompt.message)
        XCTAssertNil(HomeRepairPrompt.make(outcome: .init(expected: expected, appliedState: .working, note: "x")))
        let off = ExpectedState(state: .offShift, effectiveRestriction: .none, restrictionsShouldBeActive: false, computedAt: now, permissionState: .approved)
        XCTAssertNil(HomeRepairPrompt.make(outcome: .init(expected: off, appliedState: .unknown, note: "x")))
        XCTAssertNil(HomeRepairPrompt.make(outcome: nil))
    }

    func testBreakErrorMessages() {
        let refusal = BreakRefusal(code: .breakTooSoon, message: "Breaks can start at 10:00.", details: .breaksDisabled(reason: .breaksDisabled))
        XCTAssertEqual(BreakErrorMessages.message(for: refusal), "Breaks can start at 10:00.")
        XCTAssertEqual(BreakErrorMessages.message(for: APIError(code: .breakLimitReached, message: "No breaks left.", status: 409)), "No breaks left.")
        XCTAssertEqual(BreakErrorMessages.message(for: APIError.network(URLError(.timedOut))),
                       "Couldn't reach Work Mode. Your break was recorded on this phone and will sync later.")
    }
}
