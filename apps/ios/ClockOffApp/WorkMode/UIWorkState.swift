import Foundation
import ClockOffCore

/// What the employee sees, derived from the on-device engine output plus local health signals. Published by
/// `WorkModeController.state`; the Home card and status widgets render it.
enum UIWorkState: Equatable {
    enum ActionRequiredReason: Equatable {
        /// Screen Time access is missing (`permission` says whether it was never granted, denied or revoked).
        /// Resolve in Settings › Screen Time (`WorkModeController.settingsURL`) or by re-running onboarding.
        case screenTimeNotAllowed(PermissionState)
        /// No apps have been chosen to block: the work selection is empty.
        case appsNotChosen
        /// The provider could not apply the workplace's settings during a shift (an undecodable selection, a
        /// failed store write): the device is not enforcing and has said so in its reports.
        case enforcementFailed

        var title: String { "Action required" }

        var message: String {
            switch self {
            case .screenTimeNotAllowed(let permission):
                switch permission {
                case .notDetermined, .unknown:
                    return "Allow Screen Time access so ClockOff can block apps during your shifts."
                case .denied, .revoked:
                    return "Screen Time access is off, so ClockOff can't block apps during your shifts. Turn it back on in Settings › Screen Time."
                case .approved:
                    return "ClockOff can't apply your workplace's settings. Check Screen Time access in Settings."
                }
            case .appsNotChosen:
                return "Choose the apps to block during your shifts."
            case .enforcementFailed:
                return "ClockOff couldn't apply your workplace's settings on this iPhone. Open the app again or check Screen Time access in Settings."
            }
        }
    }

    /// Nothing evaluated yet (not joined, or before the first reconcile).
    case unknown
    case offShift(nextShift: ShiftRef?)
    case startingSoon(shift: ShiftRef)
    /// `relaxedByManager` is true while a TEMPORARY_EXCEPTION lifts some categories.
    case working(shift: ShiftRef, endsAt: Date, allowance: BreakAllowance?, relaxedByManager: Bool)
    /// `remaining` is the time left until `endsAt` at the instant of evaluation (never negative).
    case onBreak(session: BreakSession, endsAt: Date, remaining: TimeInterval)
    /// A lifting manager override is in force; `resumesAt` is when the engine next changes (nil when unknown).
    case pausedByManager(override: OverrideRef, resumesAt: Date?)
    case actionRequired(ActionRequiredReason)
    /// No trustworthy schedule: never synced, or off shift with a stale cache.
    case syncDelayed(lastSyncAt: Date?)

    var isWorkModeActive: Bool {
        switch self {
        case .working, .onBreak: return true
        case .unknown, .offShift, .startingSoon, .pausedByManager, .actionRequired, .syncDelayed: return false
        }
    }
}

/// Pure derivation of `UIWorkState` (same rules as the Home card, so the two never disagree).
enum UIWorkStateBuilder {
    /// No successful sync for this long while off shift → SYNC DELAYED.
    static let staleSyncInterval: TimeInterval = 6 * 60 * 60

    static func make(
        expected: ExpectedState?,
        cache: CachedState,
        permission: PermissionState,
        hasSelection: Bool,
        enforcementFailed: Bool,
        allowance: BreakAllowance?,
        now: Date
    ) -> UIWorkState {
        guard cache.isJoined else { return .unknown }
        if !permission.isApproved { return .actionRequired(.screenTimeNotAllowed(permission)) }
        if !hasSelection { return .actionRequired(.appsNotChosen) }
        guard let expected else { return .syncDelayed(lastSyncAt: cache.lastSyncAt) }

        switch expected.state {
        case .working, .shiftEnding:
            if enforcementFailed { return .actionRequired(.enforcementFailed) }
            guard let shift = expected.activeShift else { return .syncDelayed(lastSyncAt: cache.lastSyncAt) }
            let endsAt = expected.workingInterval?.endsAt ?? shift.endsAt
            return .working(shift: shift, endsAt: endsAt, allowance: allowance, relaxedByManager: expected.relaxation?.source == .override)
        case .onBreak:
            guard let activeBreak = expected.activeBreak else { return .syncDelayed(lastSyncAt: cache.lastSyncAt) }
            let session = cache.activeBreakSession.flatMap { $0.id == activeBreak.id ? $0 : nil }
                ?? BreakSession(id: activeBreak.id, clientBreakId: activeBreak.id, shiftId: activeBreak.shiftId, startedAt: activeBreak.startedAt,
                                plannedEndsAt: activeBreak.plannedEndsAt, restrictionBehaviour: expected.relaxation?.restrictionBehaviour ?? .keepRestrictions,
                                relaxedCategories: expected.relaxation?.relaxedCategories ?? [])
            return .onBreak(session: session, endsAt: activeBreak.endsAt, remaining: max(0, activeBreak.endsAt.timeIntervalSince(now)))
        case .shiftStartingSoon:
            guard let shift = expected.workingInterval?.shifts.first ?? expected.upcomingShift else { return .syncDelayed(lastSyncAt: cache.lastSyncAt) }
            return .startingSoon(shift: shift)
        case .managerOverride:
            guard let override = expected.activeOverride else { return .syncDelayed(lastSyncAt: cache.lastSyncAt) }
            return .pausedByManager(override: override, resumesAt: expected.nextTransitionAt)
        case .permissionError:
            return .actionRequired(.screenTimeNotAllowed(expected.permissionState))
        case .syncError, .unknown:
            return .syncDelayed(lastSyncAt: cache.lastSyncAt)
        case .offShift:
            if isSyncStale(cache: cache, now: now) { return .syncDelayed(lastSyncAt: cache.lastSyncAt) }
            return .offShift(nextShift: expected.upcomingShift)
        }
    }

    static func isSyncStale(cache: CachedState, now: Date) -> Bool {
        guard let last = cache.lastSyncAt else { return true }
        return now.timeIntervalSince(last) > staleSyncInterval
    }
}
